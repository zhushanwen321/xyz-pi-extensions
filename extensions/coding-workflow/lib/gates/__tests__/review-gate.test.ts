// lib/gates/__tests__/review-gate.test.ts
//
// W-2 修复：coding-workflow 之前零测试。D-8 gate caller 迁移（T32+T33：status → reason）
// 完全裸奔——本测试覆盖 ReviewGate 对每个 DoneReason 的消费 + fallback 路径。
//
// 不测 runFallback（它会调 runReviewGateLoop → 触发文件系统 + 子进程依赖，属于 e2e 范畴）。
// 仅测 runViaWorkflow 路径——通过 pi.__workflowRun 注入 fake，验证 D-8 reason 消费正确。

/* eslint-disable taste/no-unsafe-cast */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import type { GateContext } from "../gate.js";
import { ReviewGate } from "../review-gate.js";

// ── Helpers ─────────────────────────────────────────────────

type DoneReason = "completed" | "failed" | "aborted" | "budget_limited" | "time_limited";

interface WfResult {
  status: "done";
  reason: DoneReason;
  scriptResult?: unknown;
  error?: string;
  runId: string;
}

/** Build a GateContext with a fake pi exposing __workflowRun. */
function makeCtx(workflowRunImpl: (name: string) => Promise<WfResult>): GateContext {
  const pi = {
    __workflowRun: vi.fn(async (name: string) => workflowRunImpl(name)),
  } as unknown as ExtensionAPI;
   
  return {
    phase: 1,
    topicDir: "/tmp/topic",
    state: {} as never,
    phaseConfig: {} as never,
    pi,
    skillResolver: {} as never,
  } as GateContext;
}

// ============================================================
// D-8 reason consumption — each DoneReason branch
// ============================================================

describe("ReviewGate D-8 reason consumption (runViaWorkflow)", () => {
  it("reason=completed + scriptResult.passed=true → gate passes", async () => {
    const gate = new ReviewGate();
    const ctx = makeCtx(async () => ({
      status: "done",
      reason: "completed",
      runId: "r1",
      scriptResult: { passed: true, rounds: 2, lastMustFix: 0, reviewPath: "/r.md" },
    }));

    const result = await gate.run(ctx);

    expect(result.passed).toBe(true);
    expect(result.details).toMatchObject({ rounds: 2, reviewPath: "/r.md", source: "workflow" });
  });

  it("reason=completed + scriptResult.passed=false → gate fails with rounds detail", async () => {
    const gate = new ReviewGate();
    const ctx = makeCtx(async () => ({
      status: "done",
      reason: "completed",
      runId: "r2",
      scriptResult: { passed: false, rounds: 3, lastMustFix: 5 },
    }));

    const result = await gate.run(ctx);

    expect(result.passed).toBe(false);
    expect(result.fixGuidance).toMatch(/Review-Gate FAILED/i);
    expect(result.details).toMatchObject({
      rounds: 3,
      lastMustFix: 5,
      source: "workflow",
    });
  });

  it("reason=failed → gate fails, fixGuidance includes reason=failed + error", async () => {
    const gate = new ReviewGate();
    const ctx = makeCtx(async () => ({
      status: "done",
      reason: "failed",
      error: "boom",
      runId: "r3",
    }));

    const result = await gate.run(ctx);

    expect(result.passed).toBe(false);
    // 关键断言（W-2/D-8）：reason 透传到 fixGuidance + details
    expect(result.fixGuidance).toContain("reason=failed");
    expect(result.fixGuidance).toContain("boom");
    expect(result.details).toMatchObject({ reason: "failed", runId: "r3", source: "workflow" });
  });

  it("reason=aborted → gate fails with reason=aborted in fixGuidance", async () => {
    const gate = new ReviewGate();
    const ctx = makeCtx(async () => ({
      status: "done",
      reason: "aborted",
      runId: "r4",
    }));

    const result = await gate.run(ctx);

    expect(result.passed).toBe(false);
    expect(result.fixGuidance).toContain("reason=aborted");
    expect(result.details).toMatchObject({ reason: "aborted" });
  });

  it("reason=time_limited → gate fails with reason=time_limited", async () => {
    const gate = new ReviewGate();
    const ctx = makeCtx(async () => ({
      status: "done",
      reason: "time_limited",
      runId: "r5",
    }));

    const result = await gate.run(ctx);

    expect(result.passed).toBe(false);
    expect(result.fixGuidance).toContain("reason=time_limited");
    expect(result.details).toMatchObject({ reason: "time_limited" });
  });

  it("reason=budget_limited → gate fails with reason=budget_limited", async () => {
    const gate = new ReviewGate();
    const ctx = makeCtx(async () => ({
      status: "done",
      reason: "budget_limited",
      runId: "r6",
    }));

    const result = await gate.run(ctx);

    expect(result.passed).toBe(false);
    expect(result.fixGuidance).toContain("reason=budget_limited");
    expect(result.details).toMatchObject({ reason: "budget_limited" });
  });

  it("reason=completed + error set → gate fails (error short-circuits even on completed)", async () => {
    // 边界：reason=completed 但 error 有值——runViaWorkflow 第一个分支
    // `if (wfResult.reason !== "completed" || wfResult.error)` 会进入 fail 分支
    const gate = new ReviewGate();
    const ctx = makeCtx(async () => ({
      status: "done",
      reason: "completed",
      error: "partial failure",
      runId: "r7",
    }));

    const result = await gate.run(ctx);

    expect(result.passed).toBe(false);
    expect(result.fixGuidance).toContain("partial failure");
  });

  it("reason=completed + scriptResult undefined → gate fails (no result)", async () => {
    const gate = new ReviewGate();
    const ctx = makeCtx(async () => ({
      status: "done",
      reason: "completed",
      runId: "r8",
      // no scriptResult
    }));

    const result = await gate.run(ctx);

    expect(result.passed).toBe(false);
    expect(result.fixGuidance).toMatch(/returned no result/i);
  });

  it("passes correct workflowName (phase${N}-review-gate) + signal + timeout to __workflowRun", async () => {
    const gate = new ReviewGate();
    const ac = new AbortController();
    const ctx = makeCtx(async () => ({
      status: "done",
      reason: "completed",
      runId: "r9",
      scriptResult: { passed: true, rounds: 1, lastMustFix: 0 },
    }));
    ctx.signal = ac.signal;
    ctx.phase = 2;

    await gate.run(ctx);

    const wfRun = (ctx.pi as unknown as { __workflowRun: (...a: unknown[]) => Promise<unknown> }).__workflowRun;
    expect(wfRun).toHaveBeenCalledWith(
      "phase2-review-gate", // workflowName derived from phase
      expect.any(Object), // args
      ac.signal, // signal forwarded
      expect.any(Number), // timeout forwarded (15min)
    );
  });
});
