/**
 * ReviewGate — phase 结尾的代码审查门。
 *
 * 跑 `phase${N}-review-gate` workflow（多轮 must-fix 审查循环），消费其 scriptResult：
 *   { passed: boolean, rounds: number, lastMustFix: number, reviewPath?: string }
 * passed=true 放行；passed=false 阻塞并给出剩余 must-fix 指引。
 *
 * workflowName 随 phase 变（phase1-review-gate / phase2-review-gate / ...），
 * 这是与 TestFixLoopGate（固定名）的关键差异。
 *
 * 契约来源：lib/gates/__tests__/review-gate.test.ts（每个 DoneReason 分支 + workflowName 推导）。
 */

import { Gate,type GateContext, type GateResult } from "./gate.js";
import type { WorkflowRunResult } from "./workflow-types.js";

// ── ReviewGate 的 scriptResult 形态 ──────────────────────────

/**
 * ReviewGate workflow 的 script 返回值。
 * 由 workflow extension 的 review-gate 脚本产出，gate 只读不写。
 */
interface ReviewScriptResult {
  /** 审查循环是否全部通过（无剩余 must-fix）。 */
  passed: boolean;
  /** 已执行的审查轮数。 */
  rounds: number;
  /** 最后一轮剩余的 must-fix 数（passed=true 时为 0）。 */
  lastMustFix: number;
  /** 审查报告路径（passed=true 时存在，供上层展示）。 */
  reviewPath?: string;
}

// ── ReviewGate ───────────────────────────────────────────────

export class ReviewGate extends Gate {
  protected workflowName(ctx: GateContext): string {
    return `phase${ctx.phase}-review-gate`;
  }

  protected failPrefix(): string {
    return "Review-Gate FAILED";
  }

  protected interpretResult(
    result: WorkflowRunResult,
    _ctx: GateContext,
  ): GateResult {
    const script = result.scriptResult as ReviewScriptResult | undefined;

    // completed 但无 scriptResult —— workflow 异常终止但未报错
    if (!script) {
      return {
        passed: false,
        details: { runId: result.runId, source: "workflow" },
        fixGuidance: `${this.failPrefix()} — workflow returned no result`,
      };
    }

    if (script.passed) {
      return {
        passed: true,
        details: {
          rounds: script.rounds,
          reviewPath: script.reviewPath,
          source: "workflow",
        },
      };
    }

    // passed=false：还有 must-fix 未解决
    return {
      passed: false,
      details: {
        rounds: script.rounds,
        lastMustFix: script.lastMustFix,
        source: "workflow",
      },
      fixGuidance: `${this.failPrefix()} — ${script.lastMustFix} must-fix remaining after ${script.rounds} rounds`,
    };
  }

}
