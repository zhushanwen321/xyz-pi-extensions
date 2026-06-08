---
verdict: draft
priority: P0
blocks: [P1, P2, P3]
estimated-days: 3-4
---

# P0: Gate Pipeline 基础设施 + Workflow 交叉调用通道

## Goal

建立 Gate Pipeline 抽象层 + coding-workflow 与 workflow extension 的程序化调用通道（`pi.__workflowRun`），让后续 P1/P2/P3 只需关注业务逻辑（agent 文件 + workflow 脚本），不需要再关心 gate 调度机制。

## 前置条件

无。本阶段不依赖任何其他阶段。

## 核心架构决策

### 问题：coding-workflow 如何触发 workflow？

**Spec 原假设**：`import { WorkflowOrchestrator } from "@zhushanwen/pi-workflow"` 直接调用。
**实际**：`WorkflowOrchestrator` 是 workflow extension 工厂函数内部闭包变量，没有 export。

**解决方案**：与 `pi.__goalInit` 同模式——workflow extension 在 `session_start` 时将 orchestrator 的 run 方法包装后暴露到 pi 对象上：

```typescript
// workflow extension index.ts — session_start handler 中
const api = pi as unknown as Record<string, unknown>;
api.__workflowRun = async (name, args, signal?) => {
  const runId = await orch.run(name, args, undefined, undefined, signal);
  // 等待完成...
  return { status, scriptResult, error };
};
```

### 关键子问题：runAndWait()

当前 `orchestrator.run()` 返回 runId 后立即返回，workflow 在 Worker thread 中异步执行。coding-workflow 需要**同步等待结果**。

**方案**：在 `WorkflowOrchestrator` 上新增 `runAndWait(name, args, signal?, timeoutMs?)` 方法：
- 调用 `this.run()` 获取 runId
- 轮询 `this.instances.get(runId).status`，间隔 500ms
- 状态变为 terminal（completed/failed/aborted）时返回 `instance.scriptResult`
- 支持 AbortSignal 中断
- 默认超时 10 分钟

## File Structure

| 操作 | 文件 | 行数估计 | 说明 |
|------|------|---------|------|
| **modify** | `extension-dependencies.json` | ~5 | coding-workflow 添加 workflow 可选依赖 |
| **create** | `extensions/coding-workflow/lib/gates/gate.ts` | ~40 | Gate 接口定义 |
| **create** | `extensions/coding-workflow/lib/gates/review-gate.ts` | ~80 | Review-Gate（P0 阶段内部暂用 `runSingleAgent`） |
| **create** | `extensions/coding-workflow/lib/gates/phase-gate.ts` | ~60 | Phase-Gate（复用 `runGateScript`） |
| **create** | `extensions/coding-workflow/lib/gates/test-fix-loop.ts` | ~80 | Test-Fix Loop Gate（P0 阶段内部暂用 `runSingleAgent`） |
| **create** | `extensions/coding-workflow/lib/gates/index.ts` | ~10 | barrel export |
| **modify** | `extensions/coding-workflow/lib/helpers.ts` | ~20 | PhaseConfig 增加 `gates` 字段 + 状态路径辅助函数 |
| **modify** | `extensions/coding-workflow/index.ts` | ~10 | PHASES 增加 `gates` 配置 |
| **modify** | `extensions/coding-workflow/lib/tool-handlers.ts` | ~60 | `executeGateTool` 按 Gate Pipeline 重构 |
| **modify** | `extensions/workflow/src/index.ts` | ~30 | 暴露 `pi.__workflowRun` |
| **modify** | `extensions/workflow/src/orchestrator.ts` | ~50 | 新增 `runAndWait()` 方法 |

## Task List

### Task 0.1: WorkflowOrchestrator 新增 `runAndWait()`

**文件**: `extensions/workflow/src/orchestrator.ts`

在 `WorkflowOrchestrator` 类上新增方法：

```typescript
async runAndWait(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs: number = 600_000, // 10 分钟
): Promise<{ status: string; scriptResult?: unknown; error?: string; runId: string }> {
  const runId = await this.run(name, args, undefined, undefined, signal);
  
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      this.abort(runId);
      return { status: "aborted", runId, error: "Aborted by signal" };
    }
    const instance = this.instances.get(runId);
    if (!instance) return { status: "unknown", runId, error: "Instance not found" };
    if (isTerminal(instance.status)) {
      return {
        status: instance.status,
        scriptResult: instance.scriptResult,
        error: instance.error,
        runId,
      };
    }
    await new Promise(r => setTimeout(r, 500));
  }
  this.abort(runId);
  return { status: "timeout", runId, error: `Workflow timed out after ${timeoutMs}ms` };
}
```

**注意**：
- 需确认 `isTerminal()` 已从 `state.ts` import
- 需确认 `this.abort(runId)` 方法存在
- `instance.scriptResult` 需确认字段名（检查 `state.ts` 的 `WorkflowInstance` 类型）
- 轮询间隔 500ms，10 分钟超时 = 最多 1200 次轮询

### Task 0.2: workflow extension 暴露 `pi.__workflowRun`

**文件**: `extensions/workflow/src/index.ts`

在 `session_start` handler 中（已有 orchestrator 初始化逻辑），将 orchestrator 包装暴露：

```typescript
// 在 session_start handler 中，orchestrator 创建之后
const api = pi as unknown as Record<string, unknown>;
api.__workflowRun = async (
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<{ status: string; scriptResult?: unknown; error?: string; runId: string }> => {
  return orch.runAndWait(name, args, signal, timeoutMs);
};
```

**类型定义**：在 `shared/types/mariozechner/index.d.ts` 或 coding-workflow 的本地类型文件中声明：

```typescript
interface WorkflowRunResult {
  status: string;
  scriptResult?: unknown;
  error?: string;
  runId: string;
}

type WorkflowRunFn = (
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs?: number,
) => Promise<WorkflowRunResult>;
```

**注意**：
- `session_start` handler 中 orchestrator 已经创建（`new WorkflowOrchestrator(pi, ctx)`）
- 需要在 `session_tree` handler 中清理（清除旧 session 的引用）
- `__workflowRun` 是约定命名，与 `__goalInit` 同模式

### Task 0.3: extension-dependencies.json 添加依赖

**文件**: `extension-dependencies.json`

在 `@zhushanwen/pi-coding-workflow` 条目的 `dependsOn` 数组中添加：

```json
{
  "package": "@zhushanwen/pi-workflow",
  "type": "optional",
  "reason": "Review-Gate / Test-Fix Loop 通过 pi.__workflowRun 启动 workflow 脚本，缺失时降级为 runSingleAgent"
}
```

**类型选 `optional` 而非 `package`**：
- coding-workflow 不直接 import workflow 的代码（通过 `pi.__workflowRun` 调用）
- workflow 缺失时 ReviewGate/TestFixLoopGate 应降级到 `runSingleAgent`，不崩溃

### Task 0.4: Gate 接口定义

**文件**: `extensions/coding-workflow/lib/gates/gate.ts`（新建）

```typescript
/**
 * Gate Pipeline — 可配置的 gate 链，各 phase 声明自己的 gate 配置。
 * executeGateTool 按配置顺序执行 gate，任一失败则整体失败。
 */

export interface Gate {
  /** Gate 名称，对应 PhaseConfig.gates 数组中的字符串 */
  name: string;
  /** 执行 gate 检查 */
  run(ctx: GateContext): Promise<GateResult>;
}

export interface GateContext {
  /** 当前 phase 编号 */
  phase: number;
  /** topic 工作目录 */
  topicDir: string;
  /** 当前 workflow 状态 */
  state: WorkflowState;
  /** Pi ExtensionAPI（用于 pi.__workflowRun / pi.__goalInit） */
  pi: ExtensionAPI;
  /** Skill 解析器 */
  skillResolver: SkillResolver;
  /** 外部 abort signal */
  signal?: AbortSignal;
  /** 更新回调（流式输出） */
  onUpdate?: OnUpdateCallback;
  /** 子进程注册表（用于 runSingleAgent 降级） */
  processRegistry?: ChildProcess[];
}

export interface GateResult {
  /** gate 是否通过 */
  passed: boolean;
  /** 未通过时的修复指引 */
  fixGuidance?: string;
  /** 详细信息（用于日志/调试） */
  details?: Record<string, unknown>;
}
```

**import 来源**：
- `WorkflowState` from `../helpers.js`
- `ExtensionAPI` from `@mariozechner/pi-coding-agent`
- `SkillResolver` from `../skill-resolver.js`
- `ChildProcess` from `node:child_process`
- `OnUpdateCallback` from `../subagent.js`

### Task 0.5: Phase-Gate 实现

**文件**: `extensions/coding-workflow/lib/gates/phase-gate.ts`（新建）

从现有 `gate-runner.ts` 的 `runGateScript` 提取逻辑到 `PhaseGate` 类：

```typescript
export class PhaseGate implements Gate {
  name = "phase-gate" as const;

  constructor(private gateScriptPath: string) {}

  async run(ctx: GateContext): Promise<GateResult> {
    const result = await runGateScript(
      this.gateScriptPath, ctx.topicDir, ctx.phase, ctx.signal,
    );
    if (!result.passed) {
      return {
        passed: false,
        fixGuidance: `Phase-Gate FAILED. The following issues must be fixed:\n\n${result.output}`,
        details: { checks: result.checks },
      };
    }
    return { passed: true, details: { checks: result.checks } };
  }
}
```

**注意**：`runGateScript` 保持不变，直接复用。

### Task 0.6: Review-Gate 桩实现

**文件**: `extensions/coding-workflow/lib/gates/review-gate.ts`（新建）

**P0 阶段**：内部暂用当前 `runSingleAgent` 逻辑（确保不破坏现有功能）。接口已就位，P1 时替换为 `pi.__workflowRun`。

```typescript
export class ReviewGate implements Gate {
  name = "review-gate" as const;

  async run(ctx: GateContext): Promise<GateResult> {
    // P0: 直接复用现有 runReviewGateLoop
    // P1: 替换为 pi.__workflowRun
    const phaseConfig = this.getPhaseConfig(ctx);
    const result = await runReviewGateLoop(
      phaseConfig, ctx.topicDir, ctx.skillResolver,
      ctx.signal, ctx.onUpdate, ctx.processRegistry,
    );
    if (!result.passed) {
      return {
        passed: false,
        fixGuidance: `Review-Gate FAILED after ${result.rounds} rounds (last must_fix=${result.lastMustFix}).\n\n${result.summary}`,
        details: { rounds: result.rounds, lastMustFix: result.lastMustFix },
      };
    }
    return { passed: true, details: { rounds: result.rounds, reviewPath: result.reviewPath } };
  }

  private getPhaseConfig(ctx: GateContext): PhaseConfigForReview {
    // 从 ctx.state 和 phases 配置构建
  }
}
```

### Task 0.7: Test-Fix Loop Gate 桩实现

**文件**: `extensions/coding-workflow/lib/gates/test-fix-loop.ts`（新建）

同 ReviewGate，P0 暂用 `runTestFixLoop`，P2 替换为 `pi.__workflowRun`。

### Task 0.8: Barrel export

**文件**: `extensions/coding-workflow/lib/gates/index.ts`（新建）

```typescript
export { type Gate, type GateContext, type GateResult } from "./gate.js";
export { ReviewGate } from "./review-gate.js";
export { PhaseGate } from "./phase-gate.js";
export { TestFixLoopGate } from "./test-fix-loop.js";
```

### Task 0.9: PhaseConfig 增加 gates 字段 + 辅助函数

**文件**: `extensions/coding-workflow/lib/helpers.ts`

1. PhaseConfig 增加 `gates` 字段：

```typescript
export interface PhaseConfig {
  phase: number;
  name: string;
  skillName: string;
  reviewPrefix: string | string[];
  retrospectPrefix: string;
  deliverables: string[];
  reviewMode: string;
  gates: string[]; // 新增：gate 链配置，如 ["review-gate", "phase-gate"]
}
```

2. 新增状态路径辅助函数：

```typescript
export function getReviewGateStatePath(topicDir: string, phase: number): string {
  return path.join(topicDir, `.review-gate-p${phase}.json`);
}

export function getReviewReportsDir(topicDir: string, phase: number): string {
  return path.join(topicDir, "changes", "reviews", `phase-${phase}`);
}
```

### Task 0.10: PHASES 增加 gates 配置

**文件**: `extensions/coding-workflow/index.ts`

```typescript
const PHASES: PhaseConfig[] = [
  {
    phase: 1, name: "Spec", skillName: "xyz-harness-brainstorming",
    reviewPrefix: "spec_review", retrospectPrefix: "spec_retrospect",
    deliverables: ["spec.md"],
    reviewMode: "Mode 1: Plan review (verify spec completeness)",
    gates: ["review-gate", "phase-gate"], // 新增
  },
  {
    phase: 2, name: "Plan", skillName: "xyz-harness-writing-plans",
    reviewPrefix: "plan_review", retrospectPrefix: "plan_retrospect",
    deliverables: ["plan.md", "e2e-test-plan.md", "test_cases_template.json", "use-cases.md", "non-functional-design.md"],
    reviewMode: "Mode 1: Plan review (verify plan feasibility)",
    gates: ["review-gate", "phase-gate"], // 新增
  },
  {
    phase: 3, name: "Dev", skillName: "xyz-harness-phase-dev",
    reviewPrefix: [...], retrospectPrefix: "dev_retrospect",
    deliverables: ["changes/evidence/test_results.md"],
    reviewMode: "Mode 2: Code review (verify implementation against spec)",
    gates: ["review-gate", "phase-gate"], // 新增
  },
  {
    phase: 4, name: "Test", skillName: "xyz-harness-phase-test",
    reviewPrefix: "", retrospectPrefix: "test_retrospect",
    deliverables: ["changes/evidence/test_execution.json"],
    reviewMode: "Mode 3: Test review (verify test coverage and quality)",
    gates: ["test-fix-loop", "phase-gate"], // 新增
  },
  {
    phase: 5, name: "PR", skillName: "xyz-harness-phase-pr",
    reviewPrefix: "pr_review", retrospectPrefix: "overall_retrospect",
    deliverables: ["changes/evidence/pr_evidence.md", "changes/evidence/ci_results.md"],
    reviewMode: "Code review (verify PR completeness and CI results)",
    gates: ["phase-gate"], // 新增
  },
];
```

### Task 0.11: 重构 executeGateTool

**文件**: `extensions/coding-workflow/lib/tool-handlers.ts`

当前 `executeGateTool` 中硬编码的流程：

```
1. runReviewGateLoop → 失败返回
2. runGateScript → 失败返回
3. dispatchReviewSubagent → 失败返回
4. parseReviewVerdict → 失败返回
5. buildRetrospectFollowUp → steer
```

重构为：

```
1. 按 phaseConfig.gates 顺序执行 gate 链
   - "review-gate" → ReviewGate.run(ctx)
   - "phase-gate" → PhaseGate.run(ctx)
   - "test-fix-loop" → TestFixLoopGate.run(ctx)
2. 全部通过后执行 gate anti-fraud review（保持不变）
3. buildRetrospectFollowUp → steer（保持不变）
```

**关键改动点**：

```typescript
// 旧代码（删除）：
const reviewGateResult = await runReviewGateLoop(phaseConfig, ...);
if (!reviewGateResult.passed) { ... return; }
const gateResult = await runGateScript(gateScriptPath, ...);
if (!gateResult.passed) { ... return; }

// 新代码（替换为）：
const gateRegistry: Record<string, Gate> = {
  "review-gate": new ReviewGate(),
  "phase-gate": new PhaseGate(gateScriptPath),
  "test-fix-loop": new TestFixLoopGate(),
};

for (const gateName of phaseConfig.gates) {
  const gate = gateRegistry[gateName];
  if (!gate) continue; // 未知 gate 跳过
  const result = await gate.run({
    phase, topicDir: state.topicDir, state, pi,
    skillResolver, signal, onUpdate, processRegistry: activeSubprocesses,
  });
  if (!result.passed) {
    state.gateInProgress = false;
    persistState(pi, state);
    return {
      content: [{ type: "text", text: result.fixGuidance ?? "Gate failed" + "\n\nFix the issues, then call coding-workflow-gate(phase=" + phase + ") again." }],
      isError: true,
    };
  }
}
// 后续的 anti-fraud review + retrospect 逻辑保持不变
```

**注意事项**：
- ReviewGate/TestFixLoopGate 的 P0 桩实现内部仍调用 `runReviewGateLoop`/`runTestFixLoop`，行为与重构前一致
- anti-fraud review（`dispatchReviewSubagent`）不在 Gate Pipeline 中，保持在 gate 链之后执行
- retrospect steer 逻辑保持不变
- `runReviewGateLoop` 的 import 从 `review-gate-impl.ts` 移到 `gates/review-gate.ts` 内部

## Dependency Graph

```
Task 0.1 (runAndWait) ──→ Task 0.2 (暴露 pi.__workflowRun)
                                         ↓
Task 0.4 (Gate 接口) ──→ Task 0.5 (PhaseGate)
                       ──→ Task 0.6 (ReviewGate 桩) ──→ Task 0.8 (barrel)
                       ──→ Task 0.7 (TestFixLoop 桩)  ──→ Task 0.8
                                                          ↓
Task 0.9 (PhaseConfig)  ──→ Task 0.10 (PHASES 配置) ──→ Task 0.11 (重构 executeGateTool)
Task 0.3 (dependencies) ─────────────────────────────→ Task 0.11
```

可并行：
- Task 0.1 + 0.2（workflow 侧）和 Task 0.4-0.8（coding-workflow 侧）无依赖
- Task 0.3（dependencies）独立

## Acceptance Criteria

1. `pnpm --filter @zhushanwen/pi-coding-workflow typecheck` 通过
2. `pnpm --filter @zhushanwen/pi-workflow typecheck` 通过
3. 现有 5-phase 工作流功能不受影响（ReviewGate/TestFixLoopGate 桩内部仍用 `runSingleAgent`）
4. `pi.__workflowRun` 可用：workflow extension 加载后 pi 对象上有此函数
5. `runAndWait()` 能正确等待一个简单 workflow 完成并返回 `scriptResult`
6. PhaseConfig 有 `gates` 字段，5 个 phase 的 gates 配置正确
7. `executeGateTool` 按 gates 数组顺序执行，任一 gate 失败立即返回

## 验证命令

```bash
# 类型检查
pnpm --filter @zhushanwen/pi-coding-workflow typecheck
pnpm --filter @zhushanwen/pi-workflow typecheck

# Lint
pnpm --filter @zhushanwen/pi-coding-workflow lint
pnpm --filter @zhushanwen/pi-workflow lint

# 手动验证（启动 Pi 后）
/coding-workflow test feature
# 在 Phase 1 写完 spec.md 后调用 coding-workflow-gate
# 应看到 Review-Gate 正常执行（内部仍用 runSingleAgent）
```

## 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| `runAndWait()` 轮询可能占用事件循环 | 轻微延迟 | 500ms 间隔足够长，不影响 UI 响应 |
| Pi 进程内多 extension 共享 pi 对象导致类型冲突 | `__workflowRun` 被 other extension 覆盖 | 使用下划线前缀 + 独特命名 |
| `instance.scriptResult` 字段名可能不对 | 返回 undefined | 先读 `state.ts` 确认字段名 |
| Gate Pipeline 重构引入回归 | 现有 gate 流程断裂 | 桩实现内部复用原有逻辑，接口变化但行为不变 |
