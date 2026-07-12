/**
 * notifyDone 的 GUI 协议测试（S#13）。
 *
 * notifyDone 在 run 到达 done 终态时发送完成通知，RPC 模式下附加 __gui__ list-tree。
 * 本测试覆盖：
 *   - RPC 模式下 details.__gui__ 正确构造（list-tree + status/icon 映射）
 *   - reason 非空时 statusStr 拼接后映射正确（如 done (failed) → failed/cross）
 *   - reason 为空时的映射
 *   - 非 RPC 模式不附加 __gui__
 *   - label 格式含 slug（I#3 对齐）
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { notifyDone, type WorkflowNotifyDetails } from "../interface/helpers.ts";

/** 最小 WorkflowRun mock（duck typing，notifyDone 只访问这些字段）。 */
type RunMock = {
  spec: { scriptName: string; slug?: string };
  state: {
    status: string;
    reason?: string;
    scriptResult?: unknown;
    trace: { toArray: () => Array<{ stepIndex: number; agent: string; status: string }> };
  };
};

function makeRun(overrides: {
  scriptName?: string;
  slug?: string;
  status?: string;
  reason?: string;
  scriptResult?: unknown;
  traceNodes?: Array<{ stepIndex: number; agent: string; status: string }>;
}): RunMock {
  return {
    spec: {
      scriptName: overrides.scriptName ?? "build",
      slug: overrides.slug,
    },
    state: {
      status: overrides.status ?? "done",
      reason: overrides.reason,
      scriptResult: overrides.scriptResult,
      trace: {
        toArray: () => overrides.traceNodes ?? [],
      },
    },
  };
}

/** 最小 pi mock（只 mock sendMessage 捕获 details）。 */
function makePi(): { pi: ExtensionAPI; captured: { details: unknown }[] } {
  const captured: { details: unknown }[] = [];
  const pi = {
    sendMessage: vi.fn((_msg: unknown, _opts: unknown) => {
      captured.push((_msg as { details: unknown }).details as { details: unknown });
    }),
  } as unknown as ExtensionAPI;
  return { pi, captured };
}

describe("notifyDone — GUI 协议", () => {
  // notifyDone 接收 WorkflowRun（class），RunMock 结构兼容（duck typing），
  // 用单次断言收窄避免每个用例重复 as never。
  const runAsParam = (r: RunMock): Parameters<typeof notifyDone>[2] => r as never;

  it("RPC 模式 + reason=failed → __gui__ list-tree status=failed icon=cross", () => {
    const { pi, captured } = makePi();
    const run = makeRun({ status: "done", reason: "failed", slug: "ci" });

    notifyDone(pi, "run-abc12345", runAsParam(run), new Set(), { mode: "rpc", hasUI: true });

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const details = captured[0] as WorkflowNotifyDetails;
    expect(details.__gui__).toBeDefined();
    const comp = details.__gui__!.component;
    expect(comp.type).toBe("list-tree");
    const items = comp.props.items as Array<{ status: string; icon: string }>;
    // statusStr = "done (failed)" → mapRunStatus 含 "failed" → failed
    expect(items[0].status).toBe("failed");
    expect(items[0].icon).toBe("cross");
  });

  it("RPC 模式 + 无 reason → __gui__ status=done icon=check", () => {
    const { pi, captured } = makePi();
    const run = makeRun({ status: "done", reason: undefined, slug: "deploy" });

    notifyDone(pi, "run-defg1234", runAsParam(run), new Set(), { mode: "rpc", hasUI: true });

    const details = captured[0] as WorkflowNotifyDetails;
    const items = details.__gui__!.component.props.items as Array<{ status: string; icon: string }>;
    expect(items[0].status).toBe("done");
    expect(items[0].icon).toBe("check");
  });

  it("RPC 模式 + 无 reason → __gui__ status=done icon=check", () => {
    const { pi, captured } = makePi();
    const run = makeRun({ status: "done", reason: undefined, slug: "deploy" });

    notifyDone(pi, "run-defg1234", runAsParam(run), new Set(), { mode: "rpc", hasUI: true });

    const details = captured[0] as WorkflowNotifyDetails;
    const items = details.__gui__!.component.props.items as Array<{ status: string; icon: string }>;
    expect(items[0].status).toBe("done");
    expect(items[0].icon).toBe("check");
  });

  it("RPC 模式 + label 含 slug（I#3 对齐 buildWorkflowGui 格式）", () => {
    const { pi, captured } = makePi();
    const run = makeRun({ status: "done", reason: "completed", slug: "ci" });

    notifyDone(pi, "abcdefgh1234", runAsParam(run), new Set(), { mode: "rpc", hasUI: true });

    const details = captured[0] as WorkflowNotifyDetails;
    const items = details.__gui__!.component.props.items as Array<{ label: string }>;
    // label = `${name} ${slug} ${runId.slice(0,8)}`.trim()
    expect(items[0].label).toBe("build ci abcdefgh");
  });

  it("RPC 模式 + 无 slug → label 不含 slug（trim 去中间空格）", () => {
    const { pi, captured } = makePi();
    const run = makeRun({ status: "done", reason: "completed", slug: undefined });

    notifyDone(pi, "abcdefgh1234", runAsParam(run), new Set(), { mode: "rpc", hasUI: true });

    const details = captured[0] as WorkflowNotifyDetails;
    const items = details.__gui__!.component.props.items as Array<{ label: string }>;
    // slug 为 undefined → "build  abcdefgh"（中间双空格），trim 不去中间空格
    expect(items[0].label).toBe("build  abcdefgh");
  });

  it("非 RPC 模式 → 不附加 __gui__", () => {
    const { pi, captured } = makePi();
    const run = makeRun({ status: "done", reason: "completed" });

    notifyDone(pi, "run-xxx", runAsParam(run), new Set(), { mode: "tui", hasUI: true });

    const details = captured[0] as WorkflowNotifyDetails;
    expect(details.__gui__).toBeUndefined();
  });

  it("无 ctx → 不附加 __gui__", () => {
    const { pi, captured } = makePi();
    const run = makeRun({ status: "done", reason: "completed" });

    notifyDone(pi, "run-yyy", runAsParam(run), new Set(), undefined);

    const details = captured[0] as WorkflowNotifyDetails;
    expect(details.__gui__).toBeUndefined();
  });

  it("去重：同一 runId 第二次调用不发送消息", () => {
    const { pi, captured } = makePi();
    const run = makeRun({ status: "done", reason: "completed" });
    const notified = new Set<string>();

    notifyDone(pi, "run-dedup", runAsParam(run), notified, { mode: "rpc", hasUI: true });
    notifyDone(pi, "run-dedup", runAsParam(run), notified, { mode: "rpc", hasUI: true });

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(1);
  });

  it("details 基础字段正确（runId/name/status/reason/traceLength）", () => {
    const { pi, captured } = makePi();
    const run = makeRun({
      status: "done",
      reason: "completed",
      scriptName: "my-workflow",
      traceNodes: [
        { stepIndex: 0, agent: "worker", status: "done" },
        { stepIndex: 1, agent: "reviewer", status: "done" },
      ],
    });

    notifyDone(pi, "run-base123", runAsParam(run), new Set(), { mode: "rpc", hasUI: true });

    const details = captured[0] as WorkflowNotifyDetails;
    expect(details.runId).toBe("run-base123");
    expect(details.name).toBe("my-workflow");
    expect(details.status).toBe("done");
    expect(details.reason).toBe("completed");
    expect(details.traceLength).toBe(2);
  });
});
