// src/__tests__/runtime-history.test.ts
//
// ADR-024 L1: 验证 runtime 的 history 持久化接入。
// 核心场景：进程 A 写入历史 → 新 runtime（模拟进程 B）读回。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPersistedRecord, HistoryStore } from "../persistence/history-store.ts";
import { SubagentRuntime } from "../runtime.ts";

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-rt-test-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("SubagentRuntime — history persistence (ADR-024 L1)", () => {
  it("listHistory reads records persisted by a prior runtime instance (cross-process)", async () => {
    // 进程 A：直接通过 HistoryStore 写入（模拟 runAgent 完成后的 append）
    const storeA = new HistoryStore(tmpHome, "/proj");
    await storeA.append(
      buildPersistedRecord({
        id: "run-1", agent: "worker", status: "done", mode: "sync",
        task: "fix typo", startedAt: 1000, endedAt: 2000,
        resultText: "done", cwd: "/proj",
      }),
    );
    await storeA.append(
      buildPersistedRecord({
        id: "bg-1-xyz", agent: "reviewer", status: "failed", mode: "background",
        task: "review code", startedAt: 3000, endedAt: 4000,
        error: "model timeout", cwd: "/proj",
      }),
    );

    // 进程 B：新 runtime 用同一 homeDir/cwd，构造时重建 HistoryStore
    const rtB = new SubagentRuntime({ cwd: "/proj", homeDir: tmpHome, agentDir: "/tmp/.pi/agent" });
    const recent = rtB.listHistory();

    expect(recent).toHaveLength(2);
    // 新→旧
    expect(recent[0].id).toBe("bg-1-xyz");
    expect(recent[0].mode).toBe("background");
    expect(recent[0].status).toBe("failed");
    expect(recent[1].id).toBe("run-1");
    expect(recent[1].mode).toBe("sync");
  });

  it("listHistory(limit) returns only N newest", async () => {
    const store = new HistoryStore(tmpHome, "/proj");
    for (let i = 0; i < 5; i++) {
      await store.append(
        buildPersistedRecord({
          id: `run-${i}`, agent: "a", status: "done", mode: "sync",
          task: "t", startedAt: i, cwd: "/proj",
        }),
      );
    }
    const rt = new SubagentRuntime({ cwd: "/proj", homeDir: tmpHome, agentDir: "/tmp/.pi/agent" });
    rt["_history"] = store;
    const limited = rt.listHistory(3);
    expect(limited).toHaveLength(3);
    expect(limited[0].id).toBe("run-4");
    expect(limited[2].id).toBe("run-2");
  });

  it("listHistory returns empty when no prior records", () => {
    const rt = new SubagentRuntime({ cwd: "/fresh/proj", homeDir: tmpHome, agentDir: "/tmp/.pi/agent" });
    expect(rt.listHistory()).toEqual([]);
  });

  it("history is isolated per cwd", async () => {
    const storeA = new HistoryStore(tmpHome, "/proj-a");
    await storeA.append(
      buildPersistedRecord({
        id: "run-a", agent: "x", status: "done", mode: "sync",
        task: "t", startedAt: 1, cwd: "/proj-a",
      }),
    );

    // proj-b 的 runtime 不应看到 proj-a 的记录
    const rtB = new SubagentRuntime({ cwd: "/proj-b", homeDir: tmpHome, agentDir: "/tmp/.pi/agent" });
    expect(rtB.listHistory()).toEqual([]);

    // proj-a 的 runtime 能看到
    const rtA = new SubagentRuntime({ cwd: "/proj-a", homeDir: tmpHome, agentDir: "/tmp/.pi/agent" });
    expect(rtA.listHistory()).toHaveLength(1);
    expect(rtA.listHistory()[0].id).toBe("run-a");
  });
});
