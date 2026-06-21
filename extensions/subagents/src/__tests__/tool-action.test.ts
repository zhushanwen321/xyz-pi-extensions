// src/__tests__/tool-action.test.ts
//
// tool action 路由 + adapter 出参结构测试（AC-2/AC-3/AC-9）。
// 用 stub SubagentService（不依赖真实 SDK），测 handler + adapter 纯逻辑。

import { describe, expect, it, vi } from "vitest";

import type { SubagentService } from "../runtime/subagent-service.ts";
import { adapter, cancelHandler, listHandler, startHandler } from "../tools/subagent-actions.ts";
import type {
  ExecutionHandle,
  RecordSnapshot,
  SubagentRecord,
  SubagentToolDetails,
} from "../types.ts";

// ── stub 工厂 ──

function makeDetails(over: Partial<SubagentToolDetails> = {}): SubagentToolDetails {
  return {
    status: "done",
    mode: "sync",
    agent: "worker",
    model: "test/model",
    thinkingLevel: undefined,
    turns: 1,
    totalTokens: 10,
    elapsedSeconds: 1,
    eventLog: [],
    result: "ok",
    ...over,
  };
}

function makeSnapshot(over: Partial<RecordSnapshot> = {}): RecordSnapshot {
  return {
    id: "run-1",
    agent: "worker",
    model: "test/model",
    thinkingLevel: undefined,
    mode: "sync",
    task: "t",
    status: "done",
    eventLog: [],
    turns: 1,
    totalTokens: 10,
    startedAt: 1000,
    endedAt: 2000,
    result: "ok",
    error: undefined,
    sessionFile: undefined,
    ...over,
  };
}

function makeService(over: Partial<SubagentService> = {}): SubagentService {
  return {
    execute: vi.fn(),
    findRecord: vi.fn(() => undefined),
    cancel: vi.fn(() => false),
    collectRecords: vi.fn(() => [] as SubagentRecord[]),
    ...over,
  } as unknown as SubagentService;
}

// ============================================================
// startHandler
// ============================================================
describe("startHandler", () => {
  it("缺 startParam → throw", async () => {
    const svc = makeService();
    await expect(startHandler(svc, undefined, undefined)).rejects.toThrow(/startParam is required/);
  });

  it("task 空白 → throw", async () => {
    const svc = makeService();
    await expect(startHandler(svc, { task: "   " }, undefined)).rejects.toThrow(/task is required/);
  });

  it("sync 完成 → kind=sync + syncResponse + subagentId", async () => {
    const svc = makeService({
      execute: vi.fn(async (): Promise<ExecutionHandle> => ({
        mode: "sync",
        record: makeSnapshot({ id: "run-1", sessionFile: "s.jsonl" }),
        details: makeDetails({ status: "done", sessionFile: "s.jsonl" }),
      })),
    });
    const r = await startHandler(svc, { task: "do it" }, undefined);
    expect(r.kind).toBe("sync");
    if (r.kind !== "sync") return;
    expect(r.subagentId).toBe("run-1");
    expect(r.sessionFile).toBe("s.jsonl");
    expect(r.response.mode).toBe("sync");
    expect(r.response.status).toBe("done");
  });

  it("background 启动 → kind=bg + bgResponse.message 含 detached", async () => {
    const svc = makeService({
      execute: vi.fn(async (): Promise<ExecutionHandle> => ({
        mode: "background",
        subagentId: "bg-1-123",
        sessionFile: undefined,
        details: makeDetails({ status: "running", mode: "background" }),
      })),
    });
    const r = await startHandler(svc, { task: "long", wait: false }, undefined);
    expect(r.kind).toBe("bg");
    if (r.kind !== "bg") return;
    expect(r.subagentId).toBe("bg-1-123");
    expect(r.response.message).toMatch(/detached/);
  });

  it("sync streaming onUpdate → liftSync 包成 SubagentToolResult.syncResponse（C4 回归）", async () => {
    // execute 内部模拟 streaming：调用传入的 onUpdate(project 产出的 details)。
    // 验证 liftSync：subagentId=null（streaming 期未知）+ mode:"sync" + 字段透传。
    let capturedOnUpdate: ((d: SubagentToolDetails) => void) | undefined;
    const svc = makeService({
      execute: vi.fn(async (opts): Promise<ExecutionHandle> => {
        capturedOnUpdate = opts.onUpdate;
        return {
          mode: "sync",
          record: makeSnapshot({ id: "run-1", sessionFile: "s.jsonl" }),
          details: makeDetails({ status: "done", sessionFile: "s.jsonl" }),
        };
      }) as unknown as SubagentService["execute"],
    });
    const toolOnUpdate = vi.fn();
    await startHandler(svc, { task: "do" }, undefined, toolOnUpdate);

    // execute 内部应已收到 onUpdate 包装（streaming 期才回流——此处 stub 未主动调，
    // 但验证 wrapper 已透传给 service.execute）。
    expect(capturedOnUpdate).toBeDefined();
    // 模拟 service 在 streaming 期调 onUpdate(project(details))：
    const streamDetails = makeDetails({ status: "running", sessionFile: "s.jsonl", currentActivity: { type: "tool", label: "ls" } });
    capturedOnUpdate!(streamDetails);
    // tool 层的 onUpdate 应被调用一次，收到 liftSync 后的 SubagentToolResult。
    expect(toolOnUpdate).toHaveBeenCalledTimes(1);
    const arg = toolOnUpdate.mock.calls[0]![0];
    expect(arg.details.action).toBe("start");
    expect(arg.details.subagentId).toBeNull(); // streaming 期未知
    expect(arg.details.syncResponse).toBeDefined();
    expect(arg.details.syncResponse.mode).toBe("sync");
    expect(arg.details.syncResponse.status).toBe("running");
    expect(arg.details.syncResponse.currentActivity).toEqual({ type: "tool", label: "ls" });
    expect(arg.details.sessionFile).toBe("s.jsonl");
    // content text 为 details.result（streaming 期通常空）
    expect(arg.content[0]).toMatchObject({ type: "text" });
  });
});

// ============================================================
// listHandler
// ============================================================
describe("listHandler", () => {
  it("空 → running:0, items:[]", () => {
    const svc = makeService({ collectRecords: vi.fn(() => [] as SubagentRecord[]) });
    const r = listHandler(svc, undefined);
    expect(r.response).toEqual({ running: 0, items: [] });
  });

  it("limit 夹紧 [1,100]——collectRecords 收到夹紧后的值（C1 回归）", () => {
    const collect = vi.fn(() => [] as SubagentRecord[]);
    const svc = makeService({ collectRecords: collect });
    // includeFinished=true 时 collect 即 limit，验证夹紧：
    // 0 → 1
    listHandler(svc, { includeFinished: true, limit: 0 });
    expect(collect).toHaveBeenLastCalledWith(1);
    // 100000 → 100
    listHandler(svc, { includeFinished: true, limit: 100000 });
    expect(collect).toHaveBeenLastCalledWith(100);
    // undefined → 20（默认）
    listHandler(svc, { includeFinished: true });
    expect(collect).toHaveBeenLastCalledWith(20);
    // 负数 → 1
    listHandler(svc, { includeFinished: true, limit: -5 });
    expect(collect).toHaveBeenLastCalledWith(1);
  });

  it("includeFinished=false → collectRecords 收到 MIN_COLLECT_FOR_FILTER(100) 而非 limit（C2 回归）", () => {
    const collect = vi.fn(() => [] as SubagentRecord[]);
    const svc = makeService({ collectRecords: collect });
    // limit=5 但 includeFinished=false → 应取 100（避免 running 被截断滤掉）
    listHandler(svc, { includeFinished: false, limit: 5 });
    expect(collect).toHaveBeenLastCalledWith(100);
    // includeFinished=true → collect 即 limit
    listHandler(svc, { includeFinished: true, limit: 5 });
    expect(collect).toHaveBeenLastCalledWith(5);
  });

  it("includeFinished=false 过滤非 running", () => {
    const records: SubagentRecord[] = [
      { id: "r1", agent: "w", status: "running", mode: "background", startedAt: 1, endedAt: undefined, turns: 0, totalTokens: 0, model: "m", thinkingLevel: undefined, eventLog: [] },
      { id: "r2", agent: "w", status: "done", mode: "sync", startedAt: 2, endedAt: 3, turns: 0, totalTokens: 0, model: "m", thinkingLevel: undefined, eventLog: [] },
    ];
    const svc = makeService({ collectRecords: vi.fn(() => records) });
    const r = listHandler(svc, { includeFinished: false });
    expect(r.response.items).toHaveLength(1);
    expect(r.response.items[0].subagentId).toBe("r1");
    expect(r.response.running).toBe(1);
  });

  it("item 8 字段齐全（含 duration 实时计算）", () => {
    const records: SubagentRecord[] = [
      { id: "r1", agent: "w", status: "done", mode: "sync", startedAt: 1000, endedAt: 2500, turns: 2, totalTokens: 50, model: "m", thinkingLevel: "high", eventLog: [], sessionFile: "x.jsonl" },
    ];
    const svc = makeService({ collectRecords: vi.fn(() => records) });
    const r = listHandler(svc, { includeFinished: true });
    const item = r.response.items[0];
    expect(item).toMatchObject({
      subagentId: "r1", agent: "w", status: "done", mode: "sync",
      duration: 1, model: "m", totalTokens: 50, sessionFile: "x.jsonl",
    });
  });

  it("items 超过 limit → 截断到 limit 条", () => {
    const records: SubagentRecord[] = [
      { id: "r1", agent: "w", status: "running", mode: "background", startedAt: 1, endedAt: undefined, turns: 0, totalTokens: 0, model: "m", thinkingLevel: undefined, eventLog: [] },
      { id: "r2", agent: "w", status: "running", mode: "background", startedAt: 2, endedAt: undefined, turns: 0, totalTokens: 0, model: "m", thinkingLevel: undefined, eventLog: [] },
      { id: "r3", agent: "w", status: "running", mode: "background", startedAt: 3, endedAt: undefined, turns: 0, totalTokens: 0, model: "m", thinkingLevel: undefined, eventLog: [] },
    ];
    const svc = makeService({ collectRecords: vi.fn(() => records) });
    const r = listHandler(svc, { includeFinished: true, limit: 2 });
    expect(r.response.items).toHaveLength(2);
  });
});

// ============================================================
// cancelHandler
// ============================================================
describe("cancelHandler", () => {
  it("缺 subagentId → throw", async () => {
    const svc = makeService();
    await expect(cancelHandler(svc, undefined)).rejects.toThrow(/subagentId is required/);
    await expect(cancelHandler(svc, { subagentId: "  " })).rejects.toThrow(/subagentId is required/);
  });

  it("id 不存在 → throw No subagent record", async () => {
    const svc = makeService({ findRecord: vi.fn(() => undefined) });
    await expect(cancelHandler(svc, { subagentId: "nope" })).rejects.toThrow(/No subagent record with id "nope"/);
  });

  it("mode=sync → throw Cannot cancel sync", async () => {
    const svc = makeService({
      findRecord: vi.fn(() => makeSnapshot({ id: "run-1", mode: "sync" })),
    });
    await expect(cancelHandler(svc, { subagentId: "run-1" })).rejects.toThrow(/Cannot cancel sync subagent/);
  });

  it("已终态（cancel 返回 false）→ throw could not be cancelled", async () => {
    const svc = makeService({
      findRecord: vi.fn(() => makeSnapshot({ id: "bg-1", mode: "background", status: "done" })),
      cancel: vi.fn(() => false),
    });
    await expect(cancelHandler(svc, { subagentId: "bg-1" })).rejects.toThrow(/could not be cancelled.*status: done/);
  });

  it("成功 → cancelled:true", async () => {
    const svc = makeService({
      findRecord: vi.fn(() => makeSnapshot({ id: "bg-1", mode: "background", status: "running" })),
      cancel: vi.fn(() => true),
    });
    const r = await cancelHandler(svc, { subagentId: "bg-1" });
    expect(r.subagentId).toBe("bg-1");
    expect(r.response.cancelled).toBe(true);
  });
});

// ============================================================
// adapter
// ============================================================
describe("adapter", () => {
  it("start sync → SubagentToolResult.syncResponse + content 是合法 JSON", () => {
    const r = adapter({
      action: "start",
      domain: {
        kind: "sync", subagentId: "run-1", sessionFile: "s.jsonl",
        response: { status: "done", mode: "sync", agent: "w", model: "m", thinkingLevel: undefined, turns: 1, totalTokens: 0, elapsedSeconds: 1, eventLog: [] },
      },
    });
    expect(r.details.action).toBe("start");
    expect(r.details.subagentId).toBe("run-1");
    expect(r.details.syncResponse).toBeDefined();
    expect(r.details.bgResponse).toBeUndefined();
    // content 是合法 JSON 字符串
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.action).toBe("start");
  });

  it("start bg → SubagentToolResult.bgResponse + content 合法 JSON（C3 回归）", () => {
    const r = adapter({
      action: "start",
      domain: {
        kind: "bg", subagentId: "bg-1", sessionFile: undefined,
        response: { status: "running", mode: "background", message: "detached, will notify on completion" },
      },
    });
    expect(r.details.action).toBe("start");
    expect(r.details.subagentId).toBe("bg-1");
    expect(r.details.bgResponse).toBeDefined();
    expect(r.details.syncResponse).toBeUndefined();
    expect(r.details.sessionFile).toBeNull();
    // content JSON round-trip（bg 序列化回归）
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.bgResponse.message).toMatch(/detached/);
    expect(parsed.syncResponse).toBeUndefined();
  });

  it("list → 最外层 subagentId/sessionFile 为 null", () => {
    const r = adapter({ action: "list", domain: { response: { running: 0, items: [] } } });
    expect(r.details.action).toBe("list");
    expect(r.details.subagentId).toBeNull();
    expect(r.details.sessionFile).toBeNull();
    expect(r.details.listResponse).toEqual({ running: 0, items: [] });
  });

  it("cancel → cancelResponse.cancelled:true 字面量", () => {
    const r = adapter({ action: "cancel", domain: { subagentId: "bg-1", response: { cancelled: true } } });
    expect(r.details.cancelResponse).toEqual({ cancelled: true });
    expect(r.details.subagentId).toBe("bg-1");
  });
});
