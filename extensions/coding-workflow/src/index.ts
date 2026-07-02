/**
 * coding-workflow 扩展入口 — 注册 tool + 导出 gates。
 *
 * 当前职责：
 * - 注册 test-orchestrator tool（机器强制的 E2E 测试状态机）
 * - 导出 gate 类（ReviewGate / TestFixLoopGate）供 phase runner 用
 *
 * 不在此处注册 gate——gate 是 phase runner（在 skills/ 里）调用的库，
 * 不是独立 tool。phase runner 通过 import { ReviewGate } 用。
 *
 * 文件职责：
 * - src/index.ts（本文件）: 工厂入口（注册 tool）
 * - src/test-orchestrator/: test-orchestrator tool（state + plan-parser + index）
 * - lib/gates/:             gate 基础设施（gate + review-gate + test-fix-loop + workflow-types）
 *
 * DESIGN NOTE — 为什么 gate 不注册为 tool？
 *   gate.run(ctx) 需要 GateContext（含 phase / topicDir / phaseConfig / skillResolver），
 *   这是 phase runner 内部组装的运行时上下文，不适合作为 tool 参数暴露给 AI。
 *   gate 是机器内部门控，AI 不直接调——由 phase runner 在 phase 结尾自动跑。
 *   test-orchestrator 反之是 AI 在 coding-execute 阶段主动调用的 tool。
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerTestOrchestratorTool } from "./test-orchestrator/index.js";

// ── gate 类再导出（供 phase runner import） ──────────────────

export { Gate, type GateContext, type GateResult } from "../lib/gates/gate.js";
export { ReviewGate } from "../lib/gates/review-gate.js";
export { TestFixLoopGate } from "../lib/gates/test-fix-loop.js";
export type {
  DoneReason,
  WorkflowRunFn,
  WorkflowRunResult,
} from "../lib/gates/workflow-types.js";

// ── test-orchestrator 再导出（judgeByExpected 供外部单测/复用） ──

export { judgeByExpected } from "./test-orchestrator/index.js";
export type {
  Actual,
  CaseStatus,
  Expected,
  TestCase,
  TestSession,
} from "./test-orchestrator/state.js";

// ── 扩展入口 ─────────────────────────────────────────────────

/**
 * coding-workflow 扩展工厂。
 *
 * 每个 Pi session 创建独立闭包（test-orchestrator 的 session Map 在闭包内，
 * 满足 Pi 多 session 隔离约束）。
 */
export default function codingWorkflowExtension(pi: ExtensionAPI): void {
  registerTestOrchestratorTool(pi);
}
