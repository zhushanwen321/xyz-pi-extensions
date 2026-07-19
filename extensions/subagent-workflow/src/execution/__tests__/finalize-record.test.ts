// doFinalizeRecord — manifest status 透传测试（M3: 4 态方案）。
//
// 验证 finalize-record.ts 的 status 映射：done→completed, failed→failed, cancelled→cancelled
// （cancelled 不再归并 failed）。crashed 不进 finalize 入参（TS 签名锁定 done/failed/cancelled）。
//
// 测试策略：record 不带 sessionFile/worktreeHandle,跳过 Step 0 (collectPatch) 和 Step 3
// (finalized/tombstone/aliveMarker/worktree cleanup) 的文件操作,聚焦 Step 4 writeManifest
// 的 status 产出。FinalizeDeps 用 stub 注入（manifestStore 为真实实例,指向 tmpDir）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { doFinalizeRecord } from "../finalize-record.ts";
import { ManifestStore } from "../manifest-store.ts";
import type { AgentResult, ExecutionRecord } from "../types.ts";

function makeMinimalRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: "finalize-test",
    agent: "worker",
    model: "test/model",
    thinkingLevel: undefined,
    mode: "background",
    task: "test",
    slug: "test",
    startedAt: 1000,
    rootSessionId: "session-main",
    parentRecordId: undefined,
    depth: 0,
    status: "running",
    turns: [],
    turnCount: 0,
    totalTokens: 0,
    lastError: undefined,
    endedAt: undefined,
    result: undefined,
    error: undefined,
    agentResult: undefined,
    sessionFile: undefined,
    controller: undefined,
    ...overrides,
  } as ExecutionRecord;
}

function makeMinimalResult(): AgentResult {
  return {
    text: "done",
    turns: 1,
    durationMs: 100,
    success: true,
    sessionId: "sess-1",
    toolCalls: [],
  };
}

describe("doFinalizeRecord — manifest status 透传 (M3 4 态)", () => {
  let tmpDir: string;
  let manifestStore: ManifestStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "finalize-test-"));
    manifestStore = new ManifestStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 构造最小 FinalizeDeps：record 无 sessionFile/worktreeHandle,跳过 Step 0/3 文件操作。 */
  function makeDeps() {
    return {
      manifestStore,
      worktreeManager: {} as never,
      store: { archive: vi.fn() } as never,
      modelService: {} as never,
      pi: { appendEntry: vi.fn() },
      clearThrottle: vi.fn(),
      emitUnregister: vi.fn(),
    };
  }

  it("status=cancelled → manifest 写 cancelled（不再归并 failed）", async () => {
    const record = makeMinimalRecord({ id: "rec-cancelled" });
    await doFinalizeRecord(makeDeps(), record, makeMinimalResult(), "cancelled");

    const manifest = await manifestStore.readManifest("rec-cancelled");
    expect(manifest).not.toBeNull();
    // 关键断言：cancelled 直接透传,不是 "failed"
    expect(manifest?.status).toBe("cancelled");
  });

  it("status=done → manifest 写 completed", async () => {
    const record = makeMinimalRecord({ id: "rec-done" });
    await doFinalizeRecord(makeDeps(), record, makeMinimalResult(), "done");

    const manifest = await manifestStore.readManifest("rec-done");
    expect(manifest?.status).toBe("completed");
  });

  it("status=failed → manifest 写 failed", async () => {
    const record = makeMinimalRecord({ id: "rec-failed" });
    await doFinalizeRecord(makeDeps(), record, makeMinimalResult(), "failed");

    const manifest = await manifestStore.readManifest("rec-failed");
    expect(manifest?.status).toBe("failed");
  });
});
