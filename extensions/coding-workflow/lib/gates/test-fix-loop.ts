/**
 * Test-Fix Loop Gate — P0 桩实现，内部复用 runReviewGateLoop（Phase 4 路由到 runTestFixLoop）。
 * P2 时替换为 pi.__workflowRun 驱动的 workflow 脚本。
 */

import { runReviewGateLoop, type ReviewGateResult } from "../review-gate-impl.js";
import type { Gate, GateContext, GateResult } from "./gate.js";

/** Type adapter: GateContext.onUpdate has UsageStats, runReviewGateLoop expects unknown. */
type RunReviewGateLoopOnUpdate = (partial: { content: Array<{ type: string; text: string }>; usage?: unknown }) => void;

export class TestFixLoopGate implements Gate {
  readonly name = "test-fix-loop";

  /**
   * P0: delegates to runReviewGateLoop which internally routes Phase 4
   * to runTestFixLoop (existing logic).
   * P2: will check for pi.__workflowRun and use it when available.
   */
  async run(ctx: GateContext): Promise<GateResult> {
    const result: ReviewGateResult = await runReviewGateLoop(
      ctx.phaseConfig,
      ctx.topicDir,
      ctx.skillResolver,
      ctx.signal,
      ctx.onUpdate as RunReviewGateLoopOnUpdate | undefined,
      ctx.processRegistry,
    );

    if (!result.passed) {
      return {
        passed: false,
        fixGuidance:
          `Test-Fix Loop FAILED after ${result.rounds} rounds.\n\n${result.summary}\n\nFix the failing test cases, then call coding-workflow-gate(phase=${ctx.phase}) again.`,
        details: {
          rounds: result.rounds,
          lastMustFix: result.lastMustFix,
          summary: result.summary,
        },
      };
    }

    return {
      passed: true,
      details: {
        rounds: result.rounds,
        summary: result.summary,
      },
    };
  }
}
