// lib/gates/__tests__/test-fix-loop.test.ts
//
// W-2 修复：TestFixLoopGate 对 D-8 reason 的消费（与 review-gate.test.ts 对称）。
// 覆盖 runViaWorkflow 路径——pi.__workflowRun 注入 fake，验证每个 DoneReason 分支。

/* eslint-disable taste/no-unsafe-cast */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import type { GateContext } from "../gate.js";
import { TestFixLoopGate } from "../test-fix-loop.js";
import type { WorkflowRunResult } from "../workflow-types.js";

// ── Helpers ─────────────────────────────────────────────────

function makeCtx(workflowRunImpl: (name: string) => Promise<WorkflowRunResult>): GateContext {
  const pi = {
    __workflowRun: vi.fn(async (name: string) => workflowRunImpl(name)),
  } as unknown as ExtensionAPI;
   
  return {
    phase: 4,
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

describe("TestFixLoopGate D-8 reason consumption (runViaWorkflow)", () => {
  it("reason=completed + overall=true → gate passes", async () => {
    const gate = new TestFixLoopGate();
    const ctx = makeCtx(async () => ({
      status: "done",
      reason: "completed",
      runId: "r1",
      scriptResult: {
        core: { passed: true, round: 3, total: 3 },
        noncore: { passed: true, round: 2, total: 2 },
        overall: true,
      },
    }));

    const result = await gate.run(ctx);

    expect(result.passed).toBe(true);
    expect(result.details).toMatchObject({ source: "workflow" });
  });

  it("reason=completed + overall=false (core failed) → gate fails with core scope", async () => {
    const gate = new TestFixLoopGate();
    const ctx = makeCtx(async () => ({
      status: "done",
      reason: "completed",
      runId: "r2",
      scriptResult: {
        core: { passed: false, round: 10, total: 10, lastFailed: 4, maxRounds: true },
        noncore: null,
        overall: false,
      },
    }));

    const result = await gate.run(ctx);

    expect(result.passed).toBe(false);
    expect(result.fixGuidance).toMatch(/Test-Fix Loop FAILED/i);
    expect(result.fixGuidance).toContain("core");
    expect(result.details).toMatchObject({ source: "workflow" });
  });

  it("reason=failed → gate fails, fixGuidance includes reason=failed + error", async () => {
    const gate = new TestFixLoopGate();
    const ctx = makeCtx(async () => ({
      status: "done",
      reason: "failed",
      error: "worker crashed",
      runId: "r3",
    }));

    const result = await gate.run(ctx);

    expect(result.passed).toBe(false);
    // 关键断言（W-2/D-8）：reason 透传到 fixGuidance + details
    expect(result.fixGuidance).toContain("reason=failed");
    expect(result.fixGuidance).toContain("worker crashed");
    expect(result.details).toMatchObject({ reason: "failed", runId: "r3", source: "workflow" });
  });

  it("reason=aborted → gate fails with reason=aborted", async () => {
    const gate = new TestFixLoopGate();
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
    const gate = new TestFixLoopGate();
    const ctx = makeCtx(async () => ({
      status: "done",
      reason: "time_limited",
      runId: "r5",
    }));

    const result = await gate.run(ctx);
    expect(result.passed).toBe(false);
    expect(result.fixGuidance).toContain("reason=time_limited");
  });

  it("reason=budget_limited → gate fails with reason=budget_limited", async () => {
    const gate = new TestFixLoopGate();
    const ctx = makeCtx(async () => ({
      status: "done",
      reason: "budget_limited",
      runId: "r6",
    }));

    const result = await gate.run(ctx);
    expect(result.passed).toBe(false);
    expect(result.fixGuidance).toContain("reason=budget_limited");
  });

  it("reason=completed + error set → gate fails (error short-circuits)", async () => {
    const gate = new TestFixLoopGate();
    const ctx = makeCtx(async () => ({
      status: "done",
      reason: "completed",
      error: "partial",
      runId: "r7",
    }));

    const result = await gate.run(ctx);
    expect(result.passed).toBe(false);
    expect(result.fixGuidance).toContain("partial");
  });

  it("reason=completed + scriptResult undefined → gate fails (no result)", async () => {
    const gate = new TestFixLoopGate();
    const ctx = makeCtx(async () => ({
      status: "done",
      reason: "completed",
      runId: "r8",
    }));

    const result = await gate.run(ctx);
    expect(result.passed).toBe(false);
    expect(result.fixGuidance).toMatch(/returned no result/i);
  });

  it("passes 'phase4-test-fix-loop' as workflowName (fixed, not phase-derived)", async () => {
    const gate = new TestFixLoopGate();
    const ac = new AbortController();
    const ctx = makeCtx(async () => ({
      status: "done",
      reason: "completed",
      runId: "r9",
      scriptResult: {
        core: { passed: true },
        noncore: null,
        overall: true,
      },
    }));
    ctx.signal = ac.signal;

    await gate.run(ctx);

    const wfRun = (ctx.pi as unknown as { __workflowRun: (...a: unknown[]) => Promise<unknown> }).__workflowRun;
    // TestFixLoopGate 总是用 fixed name "phase4-test-fix-loop"（不随 ctx.phase 变）
    expect(wfRun).toHaveBeenCalledWith(
      "phase4-test-fix-loop",
      expect.any(Object),
      ac.signal,
      expect.any(Number),
    );
  });
});
