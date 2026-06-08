---
verdict: pass
complexity: L1
---

# Coding-Workflow 按最新 Spec 改造实施计划

> **For agentic workers:** 使用 executing-plans skill 按 Execution Group 逐个实施。Wave 2 的 BG2/BG3/BG4 可并行开发。

**Goal:** 将 coding-workflow 扩展按最新 spec 改造，Review-Gate / Test-Fix Loop 全部接入 Workflow Extension，实现 Gate Pipeline 抽象、状态隔离、Goal 自动注入、SKILL.md 清理。

**Architecture:** 在 coding-workflow 内新增 `lib/gates/` 目录实现 Gate Pipeline 抽象；各 phase 的 Review-Gate 逻辑下沉为 `.pi/workflows/*.js` 脚本，由 `WorkflowOrchestrator` 执行；11 个新的 `agents/*.md` 文件作为 reviewer / fix worker 的 system prompt；coding-workflow 通过 `pi.__goalInit` 调用 goal extension 的 `initializeGoalFromExternal()`。

**Tech Stack:** TypeScript, Pi Extension API, Workflow Extension (`agent()`/`parallel()`/`pipeline()`), `pi --mode json` subagent

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `extension-dependencies.json` | modify | BG1 | 添加 coding-workflow → workflow 依赖 |
| `lib/gates/gate.ts` | create | BG1 | Gate 接口定义（Gate/GateContext/GateResult） |
| `lib/gates/review-gate.ts` | create | BG1 | Review-Gate 实现：启动 workflow、解析结果、写状态文件 |
| `lib/gates/phase-gate.ts` | create | BG1 | Phase-Gate 实现：脚本检查 + AI 防伪造 |
| `lib/gates/test-fix-loop.ts` | create | BG1 | Test-Fix Loop 实现：启动 workflow、解析 test-execute JSON |
| `lib/gates/index.ts` | create | BG1 | gates 目录 barrel export |
| `index.ts` | modify | BG1 | PHASES 数组增加 `gates` 字段 |
| `lib/tool-handlers.ts` | modify | BG1 | `executeGateTool` 按 Gate Pipeline 重构 |
| `lib/helpers.ts` | modify | BG1 | 新增 `checkPhaseGateReviews` 等辅助函数 |
| `agents/spec-requirements-reviewer.md` | create | BG2 | Phase 1 Review-Gate：审查 + 直接修复 spec.md |
| `.pi/workflows/phase1-review-gate.js` | create | BG2 | Phase 1 workflow：agent 循环，must_fix=0 退出，最多 3 轮 |
| `agents/plan-requirements-reviewer.md` | create | BG2 | Phase 2 L1/L2 共用：审查 plan 交付物 |
| `agents/plan-bl-requirements-reviewer.md` | create | BG2 | Phase 2 L2 专用：业务逻辑审查 |
| `.pi/workflows/phase2-review-gate.js` | create | BG2 | Phase 2 workflow：L1 单 agent / L2 串行双 agent，最多 3 轮 |
| `agents/spec-plan-conformance-reviewer.md` | create | BG3 | Phase 3 阶段一：规格符合性 + 业务逻辑 |
| `agents/simulated-data-generator.md` | create | BG3 | Phase 3 阶段一.五：生成 JSON fixture |
| `agents/fallow-reviewer.md` | create | BG3 | Phase 3 阶段二：包装 fallow CLI |
| `agents/review-sync-fix-worker.md` | create | BG3 | Phase 3 阶段二：汇总 5 reviewer + 判断退出 + 分组 |
| `agents/file-fix-subagent.md` | create | BG3 | Phase 3 阶段二：串行修复同一文件的 must_fix |
| `.pi/workflows/phase3-review-gate.js` | create | BG3 | Phase 3 workflow：三阶段（阶段一 → 阶段一.五 → 阶段二循环） |
| `agents/test-execute-coordinator.md` | create | BG4 | Phase 4：构造/读取 JSON、分派 Wave、汇总判断 |
| `agents/test-fix-worker.md` | create | BG4 | Phase 4：分析失败 + 修复 + 更新状态 |
| `agents/test-case-subagent.md` | create | BG4 | Phase 4：执行测试 case，更新 passed/skipped/failed |
| `.pi/workflows/phase4-test-fix-loop.js` | create | BG4 | Phase 4 workflow：core → noncore 串行，含增量测试 |
| `lib/tool-handlers.ts` | modify | BG5 | Phase 2/3 Goal 自动注入 + Retrospect 上下文注入 |
| `skills/xyz-harness-brainstorming/SKILL.md` | modify | BG5 | 删除 Spec Review / Gate Handoff，新增 gate 调用指导 |
| `skills/xyz-harness-writing-plans/SKILL.md` | modify | BG5 | 删除 Self-Review / Plan Review / Gate Handoff，新增 gate 调用指导 |
| `skills/xyz-harness-phase-dev/SKILL.md` | modify | BG5 | 删除 Five-Step Review / Gate Handoff，新增 Goal 自动追踪指导 |
| `skills/xyz-harness-phase-test/SKILL.md` | modify | BG5 | 删除 Review-Gate / Gate Handoff，新增 Test-Fix Loop 机制 |
| `CHANGELOG.md` | modify | BG6 | 记录所有变更 |
| `README.md` | modify | BG6 | 反映新的 gate 机制和 agent 文件 |

---

## Task List

### Task 1: 添加 extension-dependencies.json 依赖

**Type:** backend
**Group:** BG1
**Files:**
- Modify: `extension-dependencies.json`

- [ ] **Step 1: 在 `extension-dependencies.json` 的 `@zhushanwen/pi-coding-workflow` 条目下添加依赖**

```json
{
  "package": "@zhushanwen/pi-workflow",
  "type": "package",
  "reason": "Review-Gate / Test-Fix Loop 使用 WorkflowOrchestrator 启动 workflow 脚本"
}
```

- [ ] **Step 2: 验证 JSON Schema 合规**

Run: `npx ajv-cli validate -s extension-dependencies.schema.json -d extension-dependencies.json`
Expected: PASS

---

### Task 2: 创建 Gate Pipeline 抽象

**Type:** backend
**Group:** BG1
**Files:**
- Create: `lib/gates/gate.ts`
- Create: `lib/gates/review-gate.ts`
- Create: `lib/gates/phase-gate.ts`
- Create: `lib/gates/test-fix-loop.ts`
- Create: `lib/gates/index.ts`

- [ ] **Step 1: 定义 Gate 接口**

`lib/gates/gate.ts`:
```typescript
export interface Gate {
  name: string;
  run(ctx: GateContext): Promise<GateResult>;
}

export interface GateContext {
  phase: number;
  topicDir: string;
  state: WorkflowState;
  skillResolver: SkillResolver;
  signal?: AbortSignal;
}

export interface GateResult {
  passed: boolean;
  fixGuidance?: string;
  details?: Record<string, unknown>;
}
```

- [ ] **Step 2: 实现 Review-Gate**

`lib/gates/review-gate.ts`:
- import `WorkflowOrchestrator` from `@zhushanwen/pi-workflow`
- `run()` 方法：构造 workflow 参数 → 调用 `orch.run()` → 等待 completion → 读取 `instance.scriptResult` → 写 `.review-gate-p{N}.json`
- 支持 phase 1/2/3 的不同 workflow 名称路由

- [ ] **Step 3: 实现 Phase-Gate**

`lib/gates/phase-gate.ts`:
- 复用现有的 `runGateScript` 逻辑
- Phase 3/4 增加 AI 防伪造 subagent dispatch
- 返回 `GateResult`

- [ ] **Step 4: 实现 Test-Fix Loop Gate**

`lib/gates/test-fix-loop.ts`:
- 类似 Review-Gate，但启动 `phase4-test-fix-loop` workflow
- 解析返回的 test-execute JSON 结果

- [ ] **Step 5: barrel export**

`lib/gates/index.ts`:
```typescript
export { type Gate, type GateContext, type GateResult } from "./gate.js";
export { ReviewGate } from "./review-gate.js";
export { PhaseGate } from "./phase-gate.js";
export { TestFixLoopGate } from "./test-fix-loop.js";
```

---

### Task 3: 更新 PHASES 配置并重构 executeGateTool

**Type:** backend
**Group:** BG1
**Files:**
- Modify: `index.ts`
- Modify: `lib/tool-handlers.ts`
- Modify: `lib/helpers.ts`

- [ ] **Step 1: PHASES 增加 gates 字段**

`index.ts`:
```typescript
const PHASES: PhaseConfig[] = [
  { phase: 1, name: "Spec", skillName: "xyz-harness-brainstorming",
    gates: ["review-gate", "phase-gate"], ... },
  { phase: 2, name: "Plan", skillName: "xyz-harness-writing-plans",
    gates: ["review-gate", "phase-gate"], ... },
  { phase: 3, name: "Dev", skillName: "xyz-harness-phase-dev",
    gates: ["review-gate", "phase-gate"], ... },
  { phase: 4, name: "Test", skillName: "xyz-harness-phase-test",
    gates: ["test-fix-loop", "phase-gate"], ... },
  { phase: 5, name: "PR", skillName: "xyz-harness-phase-pr",
    gates: ["phase-gate"], ... },
];
```

- [ ] **Step 2: 重构 executeGateTool**

`lib/tool-handlers.ts`:
- 删除硬编码的 review-gate → phase-gate 顺序
- 改为按 `phaseConfig.gates` 数组顺序执行 gate 链
- 每个 gate 通过 `new ReviewGate()` / `new PhaseGate()` / `new TestFixLoopGate()` 实例化
- 保持现有的错误返回格式（`{ content, isError }`）

- [ ] **Step 3: 新增 review-gate 状态检查辅助函数**

`lib/helpers.ts`:
```typescript
export function getReviewGateStatePath(topicDir: string, phase: number): string {
  return path.join(topicDir, `.review-gate-p${phase}.json`);
}
export function getReviewReportsDir(topicDir: string, phase: number): string {
  return path.join(topicDir, "changes", "reviews", `phase-${phase}`);
}
```

---

### Task 4: 创建 Phase 1 Review-Gate Workflow 和 Agent

**Type:** backend
**Group:** BG2
**Files:**
- Create: `agents/spec-requirements-reviewer.md`
- Create: `.pi/workflows/phase1-review-gate.js`

- [ ] **Step 1: 创建 agent 文件**

`agents/spec-requirements-reviewer.md`:
```markdown
---
name: spec-requirements-reviewer
description: "Reviews spec.md for completeness, consistency, and clarity."
---

# Spec Requirements Reviewer

你是 spec 文档审查专家...
（按 phase-1-spec.md 中 Review-Gate 章节要求编写）
```

- [ ] **Step 2: 创建 workflow 脚本**

`.pi/workflows/phase1-review-gate.js`:
```javascript
const meta = { name: "phase1-review-gate", description: "Phase 1 Spec Review-Gate" };

(async () => {
  const { topicDir, phase } = $ARGS;
  const reviewsDir = `${topicDir}/changes/reviews/phase-1`;
  
  for (let round = 1; round <= 3; round++) {
    const result = await agent({
      prompt: `Review ${topicDir}/spec.md (round ${round})...`,
      agent: "spec-requirements-reviewer",
      description: `spec-review-r${round}`,
    });
    
    // 解析 must_fix（workflow 脚本内读取 review 文件或解析 agent 返回）
    const { mustFix } = parseReview(`${reviewsDir}/spec_review_v${round}.md`);
    if (mustFix <= 0) {
      return { passed: true, rounds: round, lastMustFix: 0, reviewPath: `${reviewsDir}/spec_review_v${round}.md` };
    }
    
    // stagnation check (simplified)
    if (round >= 2 && mustFix >= lastMustFix) {
      return { passed: false, rounds: round, lastMustFix: mustFix, stagnation: true };
    }
    lastMustFix = mustFix;
  }
  
  return { passed: false, rounds: 3, lastMustFix, maxRounds: true };
})();
```

- [ ] **Step 3: lint workflow 脚本**

Run: `pi workflow-lint phase1-review-gate`
Expected: ✅ No issues

---

### Task 5: 创建 Phase 2 Review-Gate Workflow 和 Agent

**Type:** backend
**Group:** BG2
**Files:**
- Create: `agents/plan-requirements-reviewer.md`
- Create: `agents/plan-bl-requirements-reviewer.md`
- Create: `.pi/workflows/phase2-review-gate.js`

- [ ] **Step 1: 创建两个 agent 文件**

按 phase-2-spec.md 中 Review-Gate 章节要求编写。

- [ ] **Step 2: 创建 workflow 脚本（含 L1/L2 分支）**

`.pi/workflows/phase2-review-gate.js`:
```javascript
const meta = { name: "phase2-review-gate", description: "Phase 2 Plan Review-Gate" };

(async () => {
  const { topicDir, complexity } = $ARGS;
  // L1: 单 agent / L2: 串行双 agent
  // 循环最多 3 轮，must_fix=0 退出
})();
```

---

### Task 6: 实现 Review-Gate 状态隔离

**Type:** backend
**Group:** BG2
**Files:**
- Modify: `lib/gates/review-gate.ts`
- Modify: `lib/helpers.ts`

- [ ] **Step 1: review-gate 完成后写状态文件**

`lib/gates/review-gate.ts`:
```typescript
async persistReviewGateState(topicDir: string, phase: number, result: ReviewGateState) {
  const statePath = getReviewGateStatePath(topicDir, phase);
  await fs.promises.writeFile(statePath, JSON.stringify(result, null, 2));
}
```

- [ ] **Step 2: 确保交付物目录存在**

在 workflow 启动前创建 `changes/reviews/phase-{N}/` 目录。

---

### Task 7: 创建 Phase 3 阶段一和阶段一.五 Agent

**Type:** backend
**Group:** BG3
**Files:**
- Create: `agents/spec-plan-conformance-reviewer.md`
- Create: `agents/simulated-data-generator.md`

- [ ] **Step 1: spec-plan-conformance-reviewer**

按 phase-3-spec.md 阶段一要求编写：
- 输入：spec.md + plan.md + use-cases.md + git diff + 源代码
- 输出 YAML frontmatter：verdict, must_fix, review_metrics.spec_coverage/plan_coverage/ac_coverage/simulated_data_paths

- [ ] **Step 2: simulated-data-generator**

按 phase-3-spec.md 阶段一.五要求编写：
- 输入：spec-plan-conformance-reviewer 报告中的 `simulated_data_paths`
- 输出：JSON fixture 文件到 `changes/reviews/phase-3/simulated_data/`

---

### Task 8: 创建 Phase 3 阶段二 Reviewer Agent

**Type:** backend
**Group:** BG3
**Files:**
- Create: `agents/fallow-reviewer.md`

- [ ] **Step 1: fallow-reviewer**

按 phase-3-spec.md 要求编写：
- 包装 `fallow audit --format json --base main`
- 将 JSON 结果转为结构化 review 报告（YAML frontmatter + must_fix）
- 输出到 `changes/reviews/phase-3/fallow_review_v{N}.md`

**注意**：standards/robustness/integration/taste reviewer **复用现有 SKILL.md**，不新建 agent。workflow 脚本中通过 `agent({ prompt: "...", agent: "xyz-harness-standards-reviewer" })` 调用。由于 SKILL.md 不在 `agents/` 目录，`AgentRegistry` 无法自动发现，需要将 SKILL.md 内容内联到 task prompt 中，或在 coding-workflow 的 `SkillResolver` 中支持解析 SKILL.md 并生成临时 `.md` 文件供 `AgentRegistry` 使用。

**推荐方案**：coding-workflow 的 `SkillResolver.resolve()` 读取 SKILL.md 内容后，写入临时文件到 `cwd/.pi/agents/` 目录，供 `AgentRegistry` 扫描。临时文件命名 `<skill-name>.md`（如 `xyz-harness-standards-reviewer.md`），frontmatter 中的 `name` 字段设为 skill 名。

---

### Task 9: 创建 Phase 3 Fix Worker Agent

**Type:** backend
**Group:** BG3
**Files:**
- Create: `agents/review-sync-fix-worker.md`
- Create: `agents/file-fix-subagent.md`

- [ ] **Step 1: review-sync-fix-worker**

按 phase-3-spec.md 要求编写：
- 读取 5 份 reviewer 报告（standards/taste/robustness/fallow/integration）
- 汇总 must_fix，去重 + 排序 + 按文件分组
- 判断：must_fix = 0 → 返回通过 / must_fix > 0 → 生成分组修复计划

- [ ] **Step 2: file-fix-subagent**

按 phase-3-spec.md 要求编写：
- 输入：文件路径 + 该文件上的 must_fix 列表（按优先级排序）
- 串行修复所有 must_fix
- 修复后 git commit

---

### Task 10: 创建 Phase 3 Review-Gate Workflow 脚本

**Type:** backend
**Group:** BG3
**Files:**
- Create: `.pi/workflows/phase3-review-gate.js`

- [ ] **Step 1: 创建三阶段 workflow 脚本**

`.pi/workflows/phase3-review-gate.js`:
```javascript
const meta = { name: "phase3-review-gate", description: "Phase 3 Dev Review-Gate (3 stages)" };

(async () => {
  const { topicDir } = $ARGS;
  const reviewsDir = `${topicDir}/changes/reviews/phase-3`;
  
  // 外层循环：最多 3 次重新提交
  for (let outer = 1; outer <= 3; outer++) {
    // 阶段一：spec-plan-conformance
    const s1 = await agent({ prompt: "...", agent: "spec-plan-conformance-reviewer" });
    if (s1.mustFix > 0) return { passed: false, stage: 1, outer, mustFix: s1.mustFix };
    
    // 阶段一.五：模拟数据生成
    await agent({ prompt: "...", agent: "simulated-data-generator" });
    
    // 阶段二：并行 5 reviewer
    let lastMustFix = -1;
    let stagCount = 0;
    for (let inner = 1; inner <= 3; inner++) {
      const [std, taste, robust, fallow, integ] = await parallel([
        agent({ prompt: "...", agent: "standards-reviewer" }),
        agent({ prompt: "...", agent: "taste-reviewer" }),
        agent({ prompt: "...", agent: "robustness-reviewer" }),
        agent({ prompt: "...", agent: "fallow-reviewer" }),
        agent({ prompt: "...", agent: "integration-reviewer" }),
      ]);
      
      // Fix Worker 汇总
      const fixPlan = await agent({ prompt: "汇总修复...", agent: "review-sync-fix-worker" });
      if (fixPlan.mustFix <= 0) return { passed: true, outer, inner };
      
      // 按文件串行修复
      for (const file of fixPlan.files) {
        await agent({ prompt: `修复 ${file.path}...`, agent: "file-fix-subagent" });
      }
      
      // stagnation check
      if (lastMustFix >= 0 && fixPlan.mustFix >= lastMustFix) {
        stagCount++;
        if (stagCount >= 2) return { passed: false, stagnation: true, outer, inner };
      }
      lastMustFix = fixPlan.mustFix;
    }
  }
  return { passed: false, maxOuter: true };
})();
```

---

### Task 11: 创建 Phase 4 Test-Fix Loop Agent

**Type:** backend
**Group:** BG4
**Files:**
- Create: `agents/test-execute-coordinator.md`
- Create: `agents/test-fix-worker.md`
- Create: `agents/test-case-subagent.md`

- [ ] **Step 1: 三个 agent 文件**

按 phase-4-spec.md 要求编写：
- `test-execute-coordinator`：构造 test-execute JSON、分派 Wave、汇总
- `test-fix-worker`：分析失败、修复代码/测试、更新状态
- `test-case-subagent`：执行一组 case、更新 passed/skipped/failed

---

### Task 12: 创建 Phase 4 Test-Fix Loop Workflow 脚本

**Type:** backend
**Group:** BG4
**Files:**
- Create: `.pi/workflows/phase4-test-fix-loop.js`

- [ ] **Step 1: 创建 workflow 脚本**

`.pi/workflows/phase4-test-fix-loop.js`:
```javascript
const meta = { name: "phase4-test-fix-loop", description: "Phase 4 Test-Fix Loop" };

(async () => {
  const { topicDir } = $ARGS;
  const templatePath = `${topicDir}/test_cases_template.json`;
  const reviewsDir = `${topicDir}/changes/reviews/phase-4`;
  
  async function runTestFixLoop(scope) {
    let lastFailed = -1;
    let stagCount = 0;
    for (let round = 1; round <= 10; round++) {
      const stateFile = `${reviewsDir}/test-execute-v${round}-${scope}.json`;
      
      // coordinator 构造 JSON + 分派 Wave
      const result = await agent({ prompt: `构造 ${scope} test-execute v${round}...`, agent: "test-execute-coordinator" });
      
      // Wave 并行测试（每 Wave 最多 3 个 subagent）
      // 增量测试：只重跑 failed + 依赖下游
      
      // Fix Worker 修复
      if (result.failed > 0) {
        await agent({ prompt: `修复 ${scope} 失败 case...`, agent: "test-fix-worker" });
      }
      
      if (result.failed === 0) return { passed: true, round };
      
      // stagnation check (3 轮)
      if (lastFailed >= 0 && result.failed >= lastFailed) {
        stagCount++;
        if (stagCount >= 3) return { passed: false, stagnation: true, round };
      }
      lastFailed = result.failed;
    }
    return { passed: false, maxRounds: true };
  }
  
  const core = await runTestFixLoop("core");
  if (!core.passed) return { core, noncore: null };
  
  const noncore = await runTestFixLoop("noncore");
  return { core, noncore };
})();
```

---

### Task 13: 实现 Phase 2/3 Goal 自动注入

**Type:** backend
**Group:** BG5
**Files:**
- Modify: `lib/tool-handlers.ts`

- [ ] **Step 1: Phase 2 Goal 注入（含 L2 追加）**

`executePhaseStartTool` 中 Phase 2 入口：
```typescript
// 注入 L1 默认任务
const goalInit = (pi as unknown as Record<string, unknown>).__goalInit as GoalInitFn;
if (goalInit) {
  goalInit("Phase 2: 完成 plan 阶段交付物", L1_TASKS);
}
// steering prompt 中指导主 agent：评估 L2 后调用 goal_manager.add_tasks() 追加
```

- [ ] **Step 2: Phase 3 Goal 动态任务列表**

`executePhaseStartTool` 中 Phase 3 入口：
```typescript
const plan = readPlan(state.topicDir);
const executionGroups = extractExecutionGroups(plan);
const taskList = buildDevGoalTasks(executionGroups);
if (goalInit) {
  goalInit("Phase 3: Dev 编码实现", taskList);
}
```

---

### Task 14: 实现 Retrospect 上下文注入

**Type:** backend
**Group:** BG5
**Files:**
- Modify: `lib/review-dispatcher.ts`

- [ ] **Step 1: 修改 Retrospect 触发方式**

`buildRetrospectFollowUp` 改为直接 dispatch subagent（而非 steer 指令让主 agent 执行）：
```typescript
export async function dispatchRetrospectSubagent(...) {
  // 读取 Phase 1~N 的关键交付物摘要
  const contextSummary = buildContextSummary(topicDir, phases);
  const taskPrompt = `你是复盘分析师。以下是本阶段的关键交付物摘要：\n${contextSummary}\n\n按方法论执行复盘...`;
  
  return runSingleAgent({
    task: taskPrompt,
    systemPrompt: "Expert retrospect analyst...",
    cwd: topicDir,
    signal,
    onUpdate,
    processRegistry,
  });
}
```

- [ ] **Step 2: `buildContextSummary` 读取关键文件**

读取 spec.md、plan.md、review 报告等关键内容，生成摘要（避免完整文件过大）。

---

### Task 15: 更新所有 SKILL.md

**Type:** documentation
**Group:** BG5
**Files:**
- Modify: `skills/xyz-harness-brainstorming/SKILL.md`
- Modify: `skills/xyz-harness-writing-plans/SKILL.md`
- Modify: `skills/xyz-harness-phase-dev/SKILL.md`
- Modify: `skills/xyz-harness-phase-test/SKILL.md`

- [ ] **Step 1: 删除旧章节**

| SKILL.md | 删除章节 |
|----------|---------|
| brainstorming | Spec Review 章节、Gate Handoff 章节、Phase Transition 中"单独 session 跑 gate" |
| writing-plans | Self-Review 章节、Plan Review 章节、Gate Handoff 章节 |
| phase-dev | Step 4（Five-Step Specialized Review）、Step 4a、Step 6 review 检查项、Step 7（Gate Handoff）、Step 8"单独 session" |
| phase-test | Review-Gate 章节、Gate Handoff 章节 |

- [ ] **Step 2: 新增章节**

| SKILL.md | 新增内容 |
|----------|---------|
| brainstorming | "完成后调用 coding-workflow-gate(phase=1)"、Goal 追踪建议（brainstorming 完成后提示用户 /goal） |
| writing-plans | "完成后调用 coding-workflow-gate(phase=2)"、复杂度评估后调用 `goal_manager.add_tasks()` 追加 L2 任务 |
| phase-dev | Goal 自动追踪指导（`initializeGoalFromExternal` 自动注入）、"完成后调用 coding-workflow-gate(phase=3)" |
| phase-test | Test-Fix Loop Workflow 机制、test-execute JSON 版本化、手动验证清单输出、Phase-Gate 严格防伪造 |

---

### Task 16: 验证与清理

**Type:** validation
**Group:** BG6
**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`

- [ ] **Step 1: 全量类型检查**

Run: `pnpm -r typecheck`
Expected: 0 errors

- [ ] **Step 2: 全量 lint**

Run: `pnpm -r lint`
Expected: 0 errors

- [ ] **Step 3: 更新 CHANGELOG**

记录：Workflow Extension 接入、Gate Pipeline 抽象、11 个新 agent、4 个 workflow 脚本、Goal 自动注入、Retrospect 改造、SKILL.md 清理。

- [ ] **Step 4: 更新 README**

反映新的 gate 机制（Review-Gate → Phase-Gate → Retrospect）、agent 文件列表、workflow 脚本说明。

---

## Execution Groups

### BG1: Gate Pipeline 基础设施

**Description:** Gate Pipeline 抽象层，阻塞后续所有工作

**Tasks:** Task 1, Task 2, Task 3

**Files (预估):** 6 个文件创建 + 3 个文件修改

**Subagent 配置:**

| 配置项 | 值 |
|--------|------|
| Agent | general-purpose |
| Model | medium |
| 注入上下文 | Gate Pipeline 接口设计、Workflow Extension Orchestrator API、现有 coding-workflow gate 逻辑 |
| 读取文件 | `extensions/workflow/src/orchestrator.ts`、现有 `lib/tool-handlers.ts` |
| 修改/创建文件 | `lib/gates/*.ts`、`index.ts`、`lib/tool-handlers.ts`、`extension-dependencies.json` |

**Dependencies:** 无

---

### BG2: Phase 1/2 Review-Gate Workflow

**Description:** Phase 1/2 的 Review-Gate workflow 脚本和 agent

**Tasks:** Task 4, Task 5, Task 6

**Files (预估):** 5 个文件创建 + 1 个文件修改

**Dependencies:** BG1

---

### BG3: Phase 3 Review-Gate Workflow

**Description:** Phase 3 三阶段 Review-Gate（阶段一 → 阶段一.五 → 阶段二循环）

**Tasks:** Task 7, Task 8, Task 9, Task 10

**Files (预估):** 6 个文件创建

**Dependencies:** BG1

---

### BG4: Phase 4 Test-Fix Loop Workflow

**Description:** Phase 4 Test-Fix Loop（core → noncore 串行）

**Tasks:** Task 11, Task 12

**Files (预估):** 4 个文件创建

**Dependencies:** BG1

---

### BG5: Goal + Retrospect + SKILL.md 清理

**Description:** Goal 自动注入、Retrospect 改造、4 个 SKILL.md 更新

**Tasks:** Task 13, Task 14, Task 15

**Files (预估):** 1 个文件修改 + 4 个文件修改

**Dependencies:** BG1（部分）、BG2/BG3/BG4（了解 workflow 结构后更新 SKILL.md）

---

### BG6: 验证与清理

**Description:** 类型检查、lint、文档更新

**Tasks:** Task 16

**Files (预估):** 2 个文件修改

**Dependencies:** BG1~BG5 全部完成

---

## Dependency Graph & Wave Schedule

```
BG1 (基础设施)
    ├──→ BG2 (Phase 1/2 Review-Gate)
    ├──→ BG3 (Phase 3 Review-Gate)
    └──→ BG4 (Phase 4 Test-Fix Loop)
                ↓
            BG5 (Goal + Retrospect + SKILL.md)
                ↓
            BG6 (验证与清理)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | Gate Pipeline 基础设施，无依赖 |
| Wave 2 | BG2, BG3, BG4 | 各自 workflow 脚本和 agent，可并行开发 |
| Wave 3 | BG5 | 依赖 BG1 的 Goal 注入逻辑，以及 BG2/3/4 的 workflow 结构 |
| Wave 4 | BG6 | 最终验证 |

**并行约束:**
- Wave 1 必须完成才能进入 Wave 2
- Wave 2 中 BG2/BG3/BG4 可并行（无互相依赖）
- Wave 3 的 SKILL.md 更新建议在 BG2/BG3/BG4 至少有一个完成后再进行（确认 workflow 结构）

---

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| FR-1 Workflow 接入 Phase 1/2/3 Review-Gate | adopted | Task 4-10 |
| FR-2 Test-Fix Loop Workflow | adopted | Task 11-12 |
| FR-3 Gate Pipeline 抽象 | adopted | Task 2-3 |
| FR-4 状态隔离 | adopted | Task 6 |
| FR-5 Goal 自动注入 | adopted | Task 13 |
| FR-6 Retrospect fork | **postponed** | Task 14（降级为上下文注入，原因：coding-workflow 的 `runSingleAgent` 无法调用 pi-subagents 的 fork API，需等 pi-subagents 开放 CLI fork 参数） |
| FR-7 11 个 agent 文件 | adopted | Task 4-12 |
| FR-8 SKILL.md 清理 | adopted | Task 15 |
| FR-9 Workflow 集成点 | adopted | Task 1-3 |
| FR-10 阶段一.五 | adopted | Task 7 |
| FR-11 Fix Worker 按文件修复 | adopted | Task 9 |
| FR-12 增量测试 | adopted | Task 12 |
| FR-13 连续不降处理 | adopted | Task 10（workflow 脚本内实现） |

---

## ADR Evaluation

**评估结果：创建 1 个 ADR**

### ADR-019: Coding-Workflow 依赖 Workflow Extension

**上下文**: coding-workflow 的 Review-Gate / Test-Fix Loop 需要多 agent 编排能力（循环、并行、暂停/恢复、预算控制）。

**决策**: coding-workflow 通过 package 依赖引入 `@zhushanwen/pi-workflow`，使用 `WorkflowOrchestrator` 执行 workflow 脚本。

**替代方案**: 在 coding-workflow 内部实现简化版 workflow 引擎（基于 `runSingleAgent` + 手动管理循环和并行）。放弃原因：维护成本高、feature parity 困难（callCache、pause/resume、budget 等）。

**后果**:
- 正面：利用 Workflow Extension 成熟的编排能力，开发成本降低
- 负面：coding-workflow 与 workflow 形成硬依赖，卸载 workflow 会导致 coding-workflow 崩溃

---

## Self-Check

- [ ] spec 中每个 FR 都有对应 Task（FR-1~FR-13 全部覆盖）
- [ ] 没有 "TBD"/"TODO" placeholder
- [ ] 所有文件路径使用绝对或相对路径（不含 `${主题}` 变量）
- [ ] Task 粒度与 subagent 调度粒度对齐（每个 Task 是一次可独立完成的代码修改单元）
- [ ] Execution Groups 按依赖关系分组，Wave 编排合理
- [ ] plan.md YAML frontmatter 含 verdict + complexity
