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

### 3.3 Phase 1：dev waves

**二维数组构造**（复用 wave-model.md 的 dev wave 调度）：
```
devWaves = plan.waves 按并行组重构：
  按 parallelGroup 分组（无 group 各成一组）
  → 二维数组：[wave0_cases[], wave1_cases[], ...]
  wave 间串行（dependsOn 拓扑序），wave 内并行
```

**调度**：
```javascript
const allCommits = [];
for (const wave of devWaves) {
  phase("dev-wave-" + wave.id);
  const results = await parallel(wave.cases.map(c => ({
    prompt: buildImplementerPrompt(c, plan),  // TDD: 先写测试→实现→跑通→commit
    cwd: c.worktree,                          // ← per-call cwd
    schema: { commitHash: string, files: string[], testsPassed: boolean },
    description: "dev-" + c.id,
  })));
  // 任一 implementer 失败 → 记录，继续还是 abort？
  // 决策：abort 后续 wave（依赖链断），但已 commit 的保留（cw dev 渐进式可提交部分）
  for (const r of results) {
    if (r.commitHash) allCommits.push({ waveId: wave.id, commitHash: r.commitHash });
    else { log("wave " + wave.id + " 失败，abort 后续 dev wave"); return earlyReturn; }
  }
}
```

### 3.4 Phase 2：test + review

**test 二维数组构造**（ADR-029 决策 4 算法）：
```
testCases 按 dependsOn 拓扑排序
→ 按 parallelGroup 打包同组连续用例
→ 无 group 各自独占 wave
→ testWaves[][]（wave 间串行，wave 内并行）

但 test 与 review 可并行（不同 worktree）→ 用一个 parallel 包含所有 test cases + 2 reviewer
```

**调度**：
```javascript
phase("test-review");
const testCalls = testCases.map(c => ({
  prompt: buildTestRunnerPrompt(c, plan, tier),  // 只跑这 1 条 case
  cwd: testWorktree,
  schema: TEST_RESULT_SCHEMA,  // {id, status, evidence, actual?, screenshotPath?, commitHash?}
  description: "test-" + c.id,
}));

const reviewCalls = [
  { prompt: buildReviewPrompt("correctness"), cwd: reviewWorktree, schema: REVIEW_SCHEMA, description: "review-correctness" },
  { prompt: buildReviewPrompt("quality"), cwd: reviewWorktree, schema: REVIEW_SCHEMA, description: "review-quality" },
];

const allResults = await parallel([...testCalls, ...reviewCalls]);
// 分离 test 结果 + review 结果
```

> **注意**：testCases 不分 wave 串行了——既然每 case 1 agent，且 test 与 review 并行，直接所有 test case + 2 reviewer 一起 parallel。dependsOn 的拓扑序在 prompt 里告知 agent（"前置用例 X 已跑，其数据状态 Y 可用"），但实际并行跑（plan 已确认依赖是数据状态依赖，不是执行互斥——除非 parallelGroup 不同）。
>
> **修正**：若 dependsOn 是严格执行顺序（E3 必须 E1 完成后才能跑），则仍需分 wave。看 dependsOn 语义：
> - 数据状态依赖（E1 建数据，E3 用）→ 若同 worktree，E1 的 commit 后 E3 可见 → 可并行（E3 agent 会看到 E1 的改动）
> - 真正的执行互斥（E1 起服务占端口，E3 也要起）→ 必须串行
> 
> **决策**：dependsOn 视为"软依赖"（数据状态），默认全并行；硬互斥用不同 parallelGroup 表达（强制串行）。这样 test 可全并行（除非显式标不同 group）。

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

### 3.6 Return 契约

```javascript
return {
  phase: "complete",
  commits: allCommits,          // [{waveId, commitHash}, ...] → 主 agent 组装 cw(dev) tasks
  testResults: testResults,     // [{id, status, evidence, actual?, screenshotPath?, commitHash?}, ...] → 主 agent 组装 cw(test) cases
  reviewMustFix: {              // 主 agent 决策是否回 dev 修
    mergedFile: ".../review-merged.md",
    totalMustFix: N,
    overlap: "high" | "medium" | "low",
  },
  worktrees: { built: N, cleaned: M, cleanupFailures: [...] },
  failures: { dev: [...], test: [...], review: [...] },
  nextHint: "...",              // 主 agent 据此决策
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

## 实现顺序（与 ADR-029 一致）

1. **Chain A**：pi-subagents per-call cwd（4 文件，内核已就绪）
2. **Chain B**：pi-workflow agent() cwd（4 文件）
3. **Schema + pending-env**：plan.json 扩展 + store v3→v4 + 砍 pending-env（6 文件）
4. **workflow 脚本**：execute-full-workflow.js（4 phase）
5. **SKILL 改造**：coding-execute 阶段 A+B 改调 workflow

每步独立可测，Chain A/B 向后兼容（cwd optional），可先发布。

## Open questions（待 review 决策）

1. **worktree 并发上限**：dev 多 wave 组 + test + review 可能同时 5+ worktree。设 maxWorktrees=6 够否？超限分批？
2. **worktree 共享 vs 独占**：同 parallelGroup 的 dev implementer 能否共享 worktree（改不同文件无 index 冲突）？倾向独占（安全 + 简单）。
3. **test dependsOn 软/硬依赖**：默认全并行 + prompt 告知软依赖，硬互斥用 parallelGroup。是否需更显式的 `executionHint: serial|parallel` 字段？倾向不加（parallelGroup 已够表达）。
4. **mid 路径**：mid 的 dev Wave 绑定 test-matrix 编码进 testCases.dependsOn/parallelGroup，与 lite 对称用独立 test-wave。需确认 mid-detail-plan SKILL 的指导改动。
5. **cw(dev) 一次性 vs 分批**：workflow return 所有 commits 后，主 agent 一次性调 cw(dev)（渐进式 tasks 长 N）。确认无问题。
