/**
 * Test-Fix Loop Gate — P2 实现。
 * 优先使用 pi.__workflowRun 驱动 phase4-test-fix-loop workflow 脚本
 * （core → noncore 串行，各含 10 轮 test-fix 循环 + 增量测试策略），
 * 不可用时降级到 runSingleAgent（P0 逻辑）。
 */

import * as fs from "node:fs";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { getReviewGateStatePath } from "../helpers.js";
// fallow-ignore-file — implements Gate interface members consumed via polymorphism

import { runReviewGateLoop, type ReviewGateResult } from "../review-gate-impl.js";
import type { Gate, GateContext, GateResult } from "./gate.js";

// ─── Types ────────────────────────────────────────────────

/** Return type from pi.__workflowRun when calling phase4-test-fix-loop. */
interface WorkflowTestFixResult {
  core: {
    passed: boolean;
    round?: number;
    total?: number;
    stagnation?: boolean;
    lastFailed?: number;
    maxRounds?: boolean;
  };
  noncore: WorkflowTestFixResult["core"] | null;
  overall: boolean;
}

/** Signature of pi.__workflowRun exposed by workflow extension. */
type WorkflowRunFn = (
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs?: number,
) => Promise<{ status: string; scriptResult?: unknown; error?: string; runId: string }>;

/** Type adapter: GateContext.onUpdate has UsageStats, runReviewGateLoop expects unknown. */
type RunReviewGateLoopOnUpdate = (partial: { content: Array<{ type: string; text: string }>; usage?: unknown }) => void;

// ─── TestFixLoopGate ──────────────────────────────────────

export class TestFixLoopGate implements Gate {
  readonly name = "test-fix-loop";

  /** Test-Fix Loop workflow timeout: 15 minutes (test-fix cycles may be long). */
  private static readonly WORKFLOW_TIMEOUT_MS = 15 * 60_000;

  async run(ctx: GateContext): Promise<GateResult> {
    const workflowRun = this.getWorkflowRun(ctx.pi);
    if (workflowRun) {
      return this.runViaWorkflow(workflowRun, ctx);
    }
    return this.runFallback(ctx);
  }

  // ── Workflow path (pi.__workflowRun) ────────────────────

  private async runViaWorkflow(workflowRun: WorkflowRunFn, ctx: GateContext): Promise<GateResult> {
    const workflowName = "phase4-test-fix-loop";
    const args = this.buildWorkflowArgs(ctx);

    const wfResult = await workflowRun(workflowName, args, ctx.signal, TestFixLoopGate.WORKFLOW_TIMEOUT_MS);

    if (wfResult.status !== "completed" || wfResult.error) {
      return {
        passed: false,
        fixGuidance: `Test-Fix Loop workflow '${workflowName}' failed (status=${wfResult.status}): ${wfResult.error ?? "unknown error"}. Fix the failing test cases, then call coding-workflow-gate(phase=${ctx.phase}) again.`,
        details: { status: wfResult.status, runId: wfResult.runId, source: "workflow" },
      };
    }

    const data = wfResult.scriptResult as WorkflowTestFixResult | undefined;
    if (!data) {
      return {
        passed: false,
        fixGuidance: `Test-Fix Loop workflow '${workflowName}' returned no result. Fix the failing test cases, then call coding-workflow-gate(phase=${ctx.phase}) again.`,
        details: { status: wfResult.status, source: "workflow" },
      };
    }

    // Persist state
    await this.persistState(ctx.topicDir, data);

    if (!data.overall) {
      const scope = data.core.passed ? "noncore" : "core";
      const failed = data.core.passed ? data.noncore : data.core;
      const reason = failed?.stagnation
        ? `Stagnation: failed count did not decrease for 3 consecutive rounds (${scope}).`
        : failed?.maxRounds
          ? `Max rounds (10) reached with ${failed?.lastFailed ?? "unknown"} failures remaining (${scope}).`
          : `Test-Fix Loop failed for ${scope} scope.`;

      return {
        passed: false,
        fixGuidance: `Test-Fix Loop FAILED. ${reason}\n\nFix the failing test cases, then call coding-workflow-gate(phase=${ctx.phase}) again.`,
        details: {
          core: data.core,
          noncore: data.noncore,
          source: "workflow",
        },
      };
    }

    return {
      passed: true,
      details: {
        core: data.core,
        noncore: data.noncore,
        source: "workflow",
      },
    };
  }

  // ── Fallback path (runSingleAgent) ──────────────────────

  private async runFallback(ctx: GateContext): Promise<GateResult> {
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
          source: "fallback",
        },
      };
    }

    return {
      passed: true,
      details: {
        rounds: result.rounds,
        summary: result.summary,
        source: "fallback",
      },
    };
  }

  // ── Helpers ─────────────────────────────────────────────

  private getWorkflowRun(pi: ExtensionAPI): WorkflowRunFn | undefined {
    const api = pi as unknown as Record<string, unknown>;
    if (typeof api.__workflowRun === "function") {
      return api.__workflowRun as WorkflowRunFn;
    }
    return undefined;
  }

  private buildWorkflowArgs(ctx: GateContext): Record<string, unknown> {
    return {
      topicDir: ctx.topicDir,
      phase: ctx.phase,
      maxRounds: 10,
      maxStagnation: 3,
    };
  }

  /** Write .review-gate-p4.json state file for post-hoc inspection. */
  private async persistState(topicDir: string, data: WorkflowTestFixResult): Promise<void> {
    const statePath = getReviewGateStatePath(topicDir, 4);
    try {
      await fs.promises.writeFile(statePath, JSON.stringify(data, null, 2));
    } catch {
      // State persistence failure is non-critical
    }
  }
}
