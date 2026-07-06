# Design: ADR-029 全流程 Workflow 接管 coding-execute

> **基于**：[ADR-029](../../../docs/adr/029-full-workflow-takeover-with-worktree.md)
> **状态**：Draft（待 review 后实现）
> **范围**：跨 pi-subagents + pi-workflow + pi-coding-workflow 三包

## 设计总览

```
┌─────────────────────────────────────────────────────────────┐
│ 主 agent（CW topic session 持有者）                          │
│   cw(create) → cw(plan) → workflow run execute-full-wf      │
│                                            ↓                │
│   workflow return ←─────────────────────────┘                │
│   cw(action=dev, tasks=return.commits)                      │
│   cw(action=test, cases=return.testResults)                 │
└─────────────────────────────────────────────────────────────┘
                            ↓ (workflow run)
┌─────────────────────────────────────────────────────────────┐
│ execute-full-workflow.js（Worker 线程，纯执行器）             │
│                                                              │
│  Phase 0: worktree-setup                                     │
│    read plan.json → 算 worktree 数 → git worktree add        │
│                                                              │
│  Phase 1: dev waves（二维数组，每 wave 1 implementer agent） │
│    for wave in devWaves:                                     │
│      parallel(wave.map(c => agent({cwd: c.wt, ...})))        │
│    收集 commitHash[]                                         │
│                                                              │
│  Phase 2: test + review（每 case 1 agent + 2 reviewer）     │
│    parallel([                                                │
│      ...testWaves.flatMap(w => w.map(c => agent({cwd:wt,...}))),│
│      agent({cwd: reviewWt, ...review-correctness}),         │
│      agent({cwd: reviewWt, ...review-quality}),             │
│    ])                                                        │
│    收集 testResults[] + reviewMustFix                        │
│                                                              │
│  Phase 3: worktree-cleanup（finally）                        │
│    git worktree remove <each>                                │
│                                                              │
│  return { commits, testResults, reviewMustFix, cleanupFail } │
└─────────────────────────────────────────────────────────────┘
```

---

## Part 1：Schema 设计（plan.json + store）

### 1.0 Store 加 WAL + busy_timeout（ADR-029 决策 6，并发写前置）

**文件**：`extensions/coding-workflow/src/cw/store.ts`

**位置**：构造函数（`new CwStore` / DatabaseSync 初始化处）

```typescript
// 在打开 db 后、任何操作前执行：
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA busy_timeout=5000");
```

**原因**：决策 3 修订后，workflow 内多 agent 并行调 cw → 并发 BEGIN。WAL 支持并发读 + 单写串行，busy_timeout 让撞锁等待 5s 而非立即报错。

### 1.1 LitePlanSchema / MidDetailSchema 扩展

**文件**：`extensions/coding-workflow/src/cw/plan-parser.ts`

**LitePlanSchema.testCases 元素**加两字段（line 31-52 区域）：
```typescript
testCases: Type.Array(
  Type.Object({
    id: Type.String(),
    layer: Type.Union([Type.Literal("mock"), Type.Literal("real")]),
    scenario: Type.String(),
    steps: Type.String(),
    expected: Type.Object({
      url: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
    }),
    executor: Type.String(),
    requiresScreenshot: Type.Boolean(),
    // ── 新增（ADR-029 决策 4）──
    dependsOn: Type.Optional(Type.Array(Type.String()), {
      description: "执行顺序依赖：本用例依赖哪些前置用例建的数据状态。workflow 拓扑排序，被依赖的先跑。",
    }),
    parallelGroup: Type.Optional(Type.String(), {
      description: "资源冲突规避分组：同组用例已确认无资源冲突（不同 chrome profile/DB 表/端口）可并行。无此字段视为独占资源（串行）。",
    }),
  }),
),
```

**MidDetailSchema.testCases** 同样加这两字段（line 68-80 区域）。

### 1.2 TestCaseSeed / TestCase 类型扩展

**文件**：`extensions/coding-workflow/src/cw/types.ts`

```typescript
// TestCaseSeed（line 189）加：
export interface TestCaseSeed {
  // ...现有字段...
  /** 测试调度：执行顺序依赖（用例间数据状态依赖） */
  dependsOn?: string[];
  /** 测试调度：资源冲突规避分组（同组可并行） */
  parallelGroup?: string;
}

// TestCase（line 117）加：
export interface TestCase {
  // ...现有字段...
  dependsOn?: string[];
  parallelGroup?: string;
}
```

### 1.3 extractLitePlan / extractMidDetail 映射

**文件**：`plan-parser.ts` line 220-260

```typescript
// extractLitePlan 的 testCases.map 加：
testCases: obj.testCases.map((c) => ({
  id: c.id,
  layer: c.layer,
  // ...现有...
  requiresScreenshot: c.requiresScreenshot,
  dependsOn: c.dependsOn ?? [],        // 新增
  parallelGroup: c.parallelGroup,      // 新增
})),
```

### 1.4 Store migration v3→v4

**文件**：`extensions/coding-workflow/src/cw/store.ts`

```typescript
export const SCHEMA_VERSION = 4;  // 3 → 4

// MIGRATIONS 数组追加（line 67 后）：
// v3 → v4: test_case 表加 depends_on + parallel_group 列
(db: DatabaseSync) => {
  const cols = db.prepare("PRAGMA table_info(test_case)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "depends_on")) {
    db.exec("ALTER TABLE test_case ADD COLUMN depends_on TEXT");  // JSON array, nullable
  }
  if (!cols.some((c) => c.name === "parallel_group")) {
    db.exec("ALTER TABLE test_case ADD COLUMN parallel_group TEXT");  // nullable
  }
},
```

**DDL**（line 149 区域，`CREATE TABLE test_case`）加：
```sql
depends_on TEXT,           -- JSON array of testCase.id, nullable
parallel_group TEXT,       -- nullable
```

**mapTestCaseRow**（line 345）加：
```typescript
dependsOn: parseJsonField(r.depends_on, [] as string[]),
parallelGroup: typeof r.parallel_group === "string" ? r.parallel_group : undefined,
```

**insertTestCases**（line 434）的 INSERT SQL + 参数加两列。

---

## Part 2：接口契约（per-call cwd）

### 2.1 pi-subagents ExecuteOptions.cwd

**文件**：`extensions/subagents/src/types.ts` line 328

```typescript
export interface ExecuteOptions {
  task: string;
  agent?: string;
  wait?: boolean;
  model?: string;
  thinkingLevel?: string;
  skillPath?: string;
  appendSystemPrompt?: string[];
  schema?: Record<string, unknown>;
  maxTurns?: number;
  graceTurns?: number;
  signal?: AbortSignal;
  ctxModel?: ModelInfo;
  onUpdate?: (details: SubagentToolDetails) => void;
  onComplete?: (record: RecordSnapshot) => void;
  /** 新增：per-call 工作目录。缺省回退 service.cwd（主 session cwd）。 */
  cwd?: string;
}
```

### 2.2 pi-subagents buildSessionRunnerContext 用 per-call cwd

**文件**：`extensions/subagents/src/runtime/subagent-service.ts` line 545

```typescript
private async buildSessionRunnerContext(opts?: ExecuteOptions): Promise<SessionRunnerContext> {
  if (this.sdk === null) {
    this.sdk = await getSdk();
  }
  return {
    cwd: opts?.cwd ?? this.cwd,  // ← per-call 覆盖
    agentDir: this.modelService.getAgentDir(),
    modelRegistry: this.modelService.getModelRegistry(),
    resolveAgent: (name: string) => this.modelService.getAgentConfig(name),
    skillDirs: this.modelService.getDiscoverySkillDirs(),
    sdk: this.sdk,
  };
}
```

**调用方**（line 240 `execute()`）改为 `const ctx = await this.buildSessionRunnerContext(opts);`

### 2.3 pi-subagents tool schema 暴露 cwd

**文件**：`extensions/subagents/src/tools/subagent-actions.ts` line 43

```typescript
export interface StartHandlerInput {
  task?: string;
  agent?: string;
  wait?: boolean;
  model?: string;
  thinkingLevel?: string;
  skillPath?: string;
  appendSystemPrompt?: string[];
  schema?: Record<string, unknown>;
  maxTurns?: number;
  graceTurns?: number;
  cwd?: string;  // 新增
}
```

**文件**：`extensions/subagents/src/tools/subagent-tool.ts` line 88（startParam schema）

```typescript
startParam: Type.Optional(Type.Object({
  // ...现有字段...
  cwd: Type.Optional(Type.String({
    description: "Per-call working directory for the subagent. Overrides the session default. Use absolute path to a worktree for filesystem isolation.",
  })),
})),
```

**startHandler**（line 137）透传 cwd 到 service.execute：
```typescript
const handle = await service.execute({
  // ...现有...
  cwd: input.cwd,  // 新增
});
```

### 2.4 pi-workflow AgentCallOpts.cwd

**文件**：`extensions/workflow/src/engine/models/types.ts` line 56

```typescript
export interface AgentCallOpts {
  prompt: string;
  schema?: Record<string, unknown>;
  model?: string;
  scene?: string;
  timeoutMs?: number;
  skill?: string;
  skillPath?: string;
  description?: string;
  agent?: string;
  systemPromptFiles?: string[];
  schemaEnv?: string;
  /** 新增：per-call 工作目录。spawn pi 子进程时传给 child_process.spawn 的 cwd option。 */
  cwd?: string;
}
```

### 2.5 pi-workflow spawn 传 cwd

**文件**：`extensions/workflow/src/infra/pi-runner.ts` line 91

```typescript
const proc = spawn(command, cmdArgs, {
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
  env: env ?? process.env,
  cwd: opts.cwd,  // ← 新增（undefined 时 spawn 继承父进程 cwd）
});
```

> `buildArgs` 无需改——cwd 走 spawn options，不进 pi CLI 参数。

### 2.6 pi-workflow worker-script-builder 透传 cwd

**文件**：`extensions/workflow/src/infra/worker-script-builder.ts` line 162

```javascript
// agent() 内已知字段白名单（line 162）加 cwd：
const _knownFields = new Set(["prompt", "description", "schema", "model", "scene", "label", "task", "agent", "phase", "skill", "timeoutMs", "cwd"]);
```

**postMessage**（line 195 附近的 `parentPort.postMessage({ type: "agent-call", ... })`）需确认 opts 整体透传（含 cwd）。若当前是字段白名单透传，加 cwd。

---

## Part 3：workflow 脚本结构（execute-full-workflow）

### 3.1 入参契约（$ARGS）

```
workflow run execute-full-workflow --args '{
  topicDir: "/abs/.xyz-harness/{slug}/changes",
  planPath: "/abs/.xyz-harness/{slug}/plan.json",
  baseRef: "main",                  // 可选，默认 main，git diff 基线
  model: "provider/model",          // 可选，agent 模型
  tier: "lite",                     // lite | mid
  workspaceRoot: "/abs/project",    // worktree 父目录（git worktree add 的父）
  maxWorktrees: 6                   // 可选，并发 worktree 上限，默认 6
}'
```

### 3.2 Phase 0：worktree-setup

**算法**：
```
read plan.json → waves + testCases
算 worktree 需求：
  - dev: 按 parallelGroup 分组，每组一个 worktree（同组并行 implementer 共享？不——同组不同 wave 改不同文件，仍需各自 worktree 防 index 冲突）
  
  实际：每个 dev wave 一个 worktree（wave 内并行 implementer 改不同文件，可共享？不行——同 wave 并行的 implementer 各自 commit，共享 worktree 会 index 冲突）
  
  最终：每个 dev wave 的每个并行 case 一个 worktree（与 ADR-029 决策 2 一致）
  - test: 一个 test worktree
  - review: 一个 review worktree

建 worktree（spawn git worktree add）：
  for each needed wt:
    branch = "cw/{slug}-{role}-{n}"  // role: dev-w1 / test / review
    path = "{workspaceRoot}/.cw-wt/{branch}"
    spawn git -C {workspaceRoot} worktree add {path} -b {branch} {baseRef}
    记录 {role, branch, path}
  
失败处理：throw + 记录已建清单（Phase 3 cleanup）
```

> **worktree 命名规范**：`{workspaceRoot}/.cw-wt/cw-{slug}-{role}-{n}`。`.cw-wt/` 加 .gitignore。

### 3.3 Phase 1：dev waves（渐进式调 cw）

**二维数组构造**（复用 wave-model.md 的 dev wave 调度）：
```
devWaves = plan.waves 按并行组重构：
  按 parallelGroup 分组（无 group 各成一组）
  → 二维数组：[wave0_cases[], wave1_cases[], ...]
  wave 间串行（dependsOn 拓扑序），wave 内并行
```

**调度**（关键：每个 implementer 的 task 含"完成后调 cw"指令）：
```javascript
const buildImplementerPrompt = (waveCase, plan, workspaceRoot, topicId) => [
  "你是 implementer（TDD：先写失败测试→实现→跑通→commit）。",
  "工作目录: " + waveCase.worktree,
  "实现: " + waveCase.changes.join(", "),
  // ... TDD 步骤 ...
  "",
  "## 完成后强制（渐进式提交）",
  "commit 后必须立即调 cw tool 提交本 wave 的 commitHash：",
  'cw(action="dev", topicId="' + topicId + '", workspacePath="' + workspaceRoot + '", ',
  '  tasks=[{waveId: "' + waveCase.id + '", commitHash: "<你的 commit hash>"}])',
  "⚠️ workspacePath 必须传项目根（" + workspaceRoot + "），不能用 cwd（你在 worktree 里）",
  "",
  "## 返回",
  "调用 structured-output 返回 {commitHash, files, testsPassed, cwSubmitted}。",
].join("\n");

for (const wave of devWaves) {
  phase("dev-wave-" + wave.id);
  const results = await parallel(wave.cases.map(c => ({
    prompt: buildImplementerPrompt(c, plan, workspaceRoot, topicId),
    cwd: c.worktree,                          // ← per-call cwd
    schema: { commitHash: string, files: string[], testsPassed: boolean, cwSubmitted: boolean },
    description: "dev-" + c.id,
  })));
  // 任一 implementer 失败 → abort 后续 wave
  if (results.some(r => !r.commitHash || !r.cwSubmitted)) {
    log("dev wave " + wave.id + " 失败，abort 后续 dev wave");
    return earlyReturn;
  }
}
// 不需收集 allCommits——每步已调 cw，状态机已有
```

> **关键**：workflow 不收集 commitHash 了。每个 implementer 完成后自己调 cw(dev)，cw 状态机实时更新。workflow return 时 cw 已是 dev gatePassed 终态。

### 3.4 Phase 2：test + review（渐进式调 cw）

**test 二维数组构造**（ADR-029 决策 4 算法，dependsOn 是硬依赖）：
```
1. 拓扑排序 testCases（按 dependsOn）—— 被依赖的先跑
2. 同 parallelGroup 的用例 → 同 wave（并行）
3. 无 parallelGroup → 独占 wave（串行）
4. wave 间串行，上游任一 fail → abort 下游（硬依赖链断）
```

**调度**（wave 间串行，wave 内 parallel）：
```javascript
for (const wave of testWaves) {
  phase("test-wave-" + wave.map(c => c.id).join(","));
  const testCalls = wave.map(c => ({
    prompt: buildTestRunnerPrompt(c, plan, tier, workspaceRoot, topicId),
    cwd: testWorktree,
    schema: TEST_RESULT_SCHEMA,
    description: "test-" + c.id,
  }));
  const reviewCalls = (wave === testWaves[0]) ? [  // review 只在首个 test wave 并行启动
    { prompt: buildReviewPrompt("correctness", workspaceRoot), cwd: reviewWorktree, schema: REVIEW_SCHEMA, description: "review-correctness" },
    { prompt: buildReviewPrompt("quality", workspaceRoot), cwd: reviewWorktree, schema: REVIEW_SCHEMA, description: "review-quality" },
  ] : [];
  const results = await parallel([...testCalls, ...reviewCalls]);
  // 任一 test case fail → abort 后续 wave（硬依赖）
  if (results.some(r => r.status === "fail")) { log("test fail，abort 后续 wave"); break; }
}
```

> **review 时机**：review 审整个 diff，与 test case 无依赖。在首个 test wave 并行启动（test 跑时 review 同时审），后续 wave 不重复。若首个 wave 还没跑完 review 已完，review 结果留待最后汇总。

### 3.5 Phase 3：worktree-cleanup

```javascript
phase("cleanup");
const cleanupFailures = [];
for (const wt of worktrees) {
  try {
    require("child_process").execSync(
      `git -C ${workspaceRoot} worktree remove --force ${wt.path}`,
      { encoding: "utf-8", timeout: 30_000 }
    );
    // 可选：删分支 git branch -D {wt.branch}
  } catch (e) {
    cleanupFailures.push({ path: wt.path, branch: wt.branch, error: e.message });
  }
}
// cleanup 失败不 throw，记录到 return
```

### 3.6 Return 契约（修订：不含 commits/testResults，已在 cw）

```javascript
return {
  phase: "complete",
  // 不含 commits / testResults——每个 agent 完成后已渐进式调 cw，状态机已有
  cwStatus: {                          // workflow 末尾读 cw 确认终态
    devGatePassed: boolean,            // 主 agent 据此判断是否需回 dev
    testGatePassed: boolean,
    testProgress: [{id, status}, ...], // cw(test) 的渐进结果
  },
  reviewMustFix: {                     // 主 agent 决策是否回 dev 修
    mergedFile: ".../review-merged.md",
    totalMustFix: N,
    overlap: "high" | "medium" | "low",
  },
  worktrees: { built: N, cleaned: M, cleanupFailures: [...] },
  failures: { dev: [...], test: [...], review: [...] },  // 未调 cw 的失败 agent
  nextHint: "...",                     // 主 agent 据此决策（ask_user / 回 dev / complete）
};
```

---

## Part 4：wave 构造算法（伪码）

### 4.1 dev waves（复用 plan.json waves 的 parallelGroup）

```
输入: plan.waves = [{id, changes, dependsOn, parallelGroup}, ...]
输出: devWaves[][]（二维数组，外层串行，内层并行）

1. 拓扑排序 waves（按 dependsOn）
2. 按 parallelGroup 聚合：
   - 同 parallelGroup 的连续 waves → 合并成同一内层数组（并行）
   - 无 parallelGroup → 独占内层数组（单元素）
3. 每个内层元素分配 worktree（dev-w{i}）
```

### 4.2 test waves

```
输入: plan.testCases = [{id, layer, dependsOn, parallelGroup, ...}, ...]
输出: testCases（附 worktree + 调度信息）

1. 按 layer 分：mock 层先跑（全 pass 后跑 real）—— 但既然每 case 1 agent，
   且 plan 已标 parallelGroup，直接全并行（除非显式串行）
2. 按 parallelGroup 聚合：
   - 同 group → 可并行（已确认无资源冲突）
   - 不同 group 或无 group → 视为潜在冲突，分 wave 串行
3. dependsOn 拓扑序在同 group 内排序（软依赖，数据状态）
```

**简化决策**（Part 3.4 已述）：test case 默认全并行（一个 parallel 调用），dependsOn 作软依赖（prompt 告知），硬互斥用 parallelGroup 区分（分 wave 串行）。

---

## Part 5：coding-execute SKILL 改造

### 5.1 阶段 A+B 合并为"调 workflow"

**文件**：`extensions/coding-workflow/skills/coding-execute/SKILL.md`

原阶段 A（开发）+ 阶段 B（测试验收）的核心步骤改为：
```markdown
## 阶段 A+B：执行（调 workflow）

[MANDATORY] 主 agent 不直接派 implementer / test-runner / reviewer subagent。
改为调 workflow run execute-full-workflow，由 workflow 内部完成全部 dev + test + review。

workflow run execute-full-workflow --args '{
  topicDir, planPath, baseRef, tier, workspaceRoot
}'

workflow return 后：
- 读 return.commits → 调 cw(action=dev, tasks=commits)
- 读 return.testResults → 对 fail 的 case ask_user 决策（重跑 vs user-skipped+凭证）
- 读 return.reviewMustFix → 决策是否回 workflow 修（must_fix > 0 则重跑 dev wave）
- 全绿后 → 调 cw(action=test, cases=组装后的 cases)
```

### 5.2 保留的部分

- **阶段 C 收尾**：仍主 agent 执行（跑执行收尾机器门 + goal complete）
- **前置检查**：plan 产物完成 + goal 已创建
- **CW 数据契约**：test-results.json ↔ cw dev/test 映射不变

### 5.3 SKILL 铁律更新

```markdown
> [铁律] dev + test 阶段必须调 workflow run execute-full-workflow，不得主 agent 直接派 subagent。
> workflow 内 parallel() 必派 agent，机器层强制——堵住「小任务跳过 ensemble」的认知层逃逸。
> 主 agent 只做：调 workflow + 收 return + 调 cw(dev/test) + ask_user 决策 fail/user-skipped。
```

---

## Part 6：pending-env 砍除

### 6.1 影响文件清单

| 文件 | 改动 |
|------|------|
| `skills/lite-shared/references/execution-flow.md` | 删 pending-env 描述（line 203/226/227/251-255），real 无环境改记 `fail` + evidence |
| `skills/lite-shared/references/test-case-schema.md` | 核心原则四出路改两条：真跑 pass/fail + fail 后 ask_user 决策 |
| `skills/lite-shared/references/subagent-dispatch.md` | 删 pending-env 提及 |
| `skills/coding-execute/SKILL.md` | test-results.json status 字段去 pending-env |
| `skills/coding-execute/scripts/selftest_check_execute.py` | 改写 pending-env 自测 case |
| `src/cw/checks/check-execute.ts` | 无代码改动（pending-env 已落 realBadOther 判 FAIL），仅注释对齐 |

### 6.2 简化后状态机

```
status: pass | fail | user-skipped
  pass → 机器门 ✅
  user-skipped（必带 user_confirm_ref）→ 机器门 ✅（当 pass）
  fail → 机器门 ❌ → 主 agent ask_user：
    用户确认跳过 → 改 user-skipped + 凭证
    用户要求真跑 → 提供环境方案重跑
```

---

## 实现顺序（与 ADR-029 一致，含修订）

1. **Chain A**：pi-subagents per-call cwd（4 文件，内核已就绪）
2. **Chain B**：pi-workflow agent() cwd（4 文件）
3. **Store WAL + busy_timeout**（决策 6，并发写前置）
4. **Schema + pending-env**：plan.json 扩展 + store v3→v4 + 砍 pending-env（6 文件）
5. **workflow 脚本**：execute-full-workflow.js（4 phase，agent 渐进式调 cw）
6. **SKILL 改造**：coding-execute 阶段 A+B 改调 workflow

每步独立可测，Chain A/B 向后兼容（cwd optional），可先发布。

## Open questions（待 review 决策）

已全部确认（见 ADR-029 Open questions）：
1. worktree 并发上限 = 5，超限分批
2. worktree 独占
3. test dependsOn 是硬依赖（拓扑排序，上游 fail abort 下游）
4. mid 路径：dev Wave 绑定 test-matrix 编码进 testCases.dependsOn/parallelGroup，与 lite 对称
5. cw 渐进式调（每 agent 完成后立即调 cw，决策 3 修订）
6. agent 调 cw 必须显式传 workspacePath（项目根），workflow 通过 prompt 注入

实现时需注意：
- agent task 的 prompt 必须明确 cw 调用模板（含 workspacePath 参数）
- store WAL + busy_timeout 是并发前置（决策 6）
- workflow return 不含 commits/testResults（已在 cw），只 return review + failures + cwStatus
