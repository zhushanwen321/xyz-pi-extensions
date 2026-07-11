// src/__tests__/session-reconstructor.test.ts
//
// session-reconstructor 专属测试。
// 覆盖：从 session.jsonl 重建 turns[]/usage/result/error/eventLog；
//      identity custom entry 解析；toolCall↔toolResult 配对；
//      防御性降级（文件缺失/损坏/缺 identity/无 assistant message）。
//
// 用 tmpdir + 真实 .jsonl 文件（隔离文件系统）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IDENTITY_CUSTOM_TYPE, reconstructFromFile } from "../session-reconstructor.ts";

/** 写一行到文件（JSON.stringify + 换行）。 */
function writeLine(file: number | fs.PathOrFileDescriptor, obj: unknown): void {
  fs.writeSync(file, `${JSON.stringify(obj)}\n`);
}

/** session header 行。 */
function headerLine(cwd = "/tmp"): unknown {
  return { type: "session", version: 3, id: "sess-uuid", timestamp: "2026-01-01T00:00:00.000Z", cwd };
}

/** identity custom entry。 */
function identityEntry(identity: object): unknown {
  return {
    type: "custom", id: "id-1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z",
    customType: IDENTITY_CUSTOM_TYPE, data: identity,
  };
}

/** assistant message entry（content blocks + usage + stopReason）。 */
function assistantEntry(
  blocks: object[],
  opts: { usage?: object; stopReason?: string; errorMessage?: string; ts?: number; parentId?: string } = {},
): unknown {
  return {
    type: "message", id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    parentId: opts.parentId ?? "id-1",
    timestamp: new Date(opts.ts ?? 1000).toISOString(),
    message: {
      role: "assistant",
      content: blocks,
      usage: opts.usage ?? { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { total: 0 } },
      stopReason: opts.stopReason ?? "stop",
      errorMessage: opts.errorMessage,
      timestamp: opts.ts ?? 1000,
    },
  };
}

/** toolResult message entry。 */
function toolResultEntry(toolCallId: string, toolName: string, opts: { isError?: boolean; parentId?: string; text?: string } = {}): unknown {
  return {
    type: "message", id: `tr-${Math.random().toString(36).slice(2, 8)}`,
    parentId: opts.parentId ?? "id-1",
    timestamp: new Date(2000).toISOString(),
    message: {
      role: "toolResult", toolCallId, toolName,
      content: [{ type: "text", text: opts.text ?? "result" }],
      isError: opts.isError ?? false,
      timestamp: 2000,
    },
  };
}

describe("reconstructFromFile", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-test-"));
    filePath = path.join(tmpDir, "test.jsonl");
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJsonl(lines: unknown[]): void {
    const fd = fs.openSync(filePath, "w");
    for (const line of lines) writeLine(fd, line);
    fs.closeSync(fd);
  }

  // ============================================================
  // 基本重建
  // ============================================================
  describe("基本重建", () => {
    it("单 assistant message → 1 turn，text/usage 正确", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "bg-1", agent: "worker", mode: "background", task: "do it", startedAt: 500 }),
        assistantEntry([{ type: "text", text: "hello world" }]),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec).toBeDefined();
      expect(rec!.id).toBe("bg-1");
      expect(rec!.agent).toBe("worker");
      expect(rec!.mode).toBe("background");
      expect(rec!.task).toBe("do it");
      expect(rec!.status).toBe("done");
      expect(rec!.turns).toHaveLength(1);
      expect(rec!.turns[0].text).toBe("hello world");
      expect(rec!.turnCount).toBe(1);
      expect(rec!.totalTokens).toBe(30); // 10+20+0+0
      expect(rec!.result).toBe("hello world");
    });

    it("thinking block 累积进 turn.thinking", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "sync", task: "t", startedAt: 100 }),
        assistantEntry([
          { type: "thinking", thinking: "let me think" },
          { type: "text", text: "answer" },
        ]),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.turns[0].thinking).toBe("let me think");
      expect(rec!.turns[0].text).toBe("answer");
    });

    it("多 assistant message → 多 turn，result 用空行拼接", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "sync", task: "t", startedAt: 100 }),
        assistantEntry([{ type: "text", text: "first" }], { ts: 1000 }),
        assistantEntry([{ type: "text", text: "second" }], { ts: 2000, parentId: undefined }),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.turns).toHaveLength(2);
      expect(rec!.turnCount).toBe(2);
      expect(rec!.result).toBe("first\n\nsecond");
    });

    it("读出 identity 里的 rootSessionId", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "bg-1", agent: "w", mode: "background", task: "t", startedAt: 100, rootSessionId: "sess-A" }),
        assistantEntry([{ type: "text", text: "ok" }]),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.rootSessionId).toBe("sess-A");
    });

    it("旧文件 identity 写 parentSessionId → fallback 读到 rootSessionId（向后兼容）", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "bg-1", agent: "w", mode: "background", task: "t", startedAt: 100, parentSessionId: "sess-legacy" }),
        assistantEntry([{ type: "text", text: "ok" }]),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.rootSessionId).toBe("sess-legacy");
    });

    it("identity 无 rootSessionId（旧文件）→ rootSessionId 为 undefined", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "bg-1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        assistantEntry([{ type: "text", text: "ok" }]),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.rootSessionId).toBeUndefined();
    });

    it("读出 identity 里的 parentRecordId/depth（递归层级）", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "run-2", agent: "w", mode: "sync", task: "t", startedAt: 100, rootSessionId: "sess-A", parentRecordId: "run-1", depth: 2 }),
        assistantEntry([{ type: "text", text: "ok" }]),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.parentRecordId).toBe("run-1");
      expect(rec!.depth).toBe(2);
    });

    it("旧文件无 parentRecordId/depth → 兑底 undefined/0（顶层）", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "bg-1", agent: "w", mode: "background", task: "t", startedAt: 100, rootSessionId: "sess-A" }),
        assistantEntry([{ type: "text", text: "ok" }]),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.parentRecordId).toBeUndefined();
      expect(rec!.depth).toBe(0);
    });

    it("endedAt 为最后一条 entry 的时间戳（非 now）", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "bg-1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        assistantEntry([{ type: "text", text: "first" }], { ts: 1000 }),
        assistantEntry([{ type: "text", text: "second" }], { ts: 5000, parentId: undefined }),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.endedAt).toBe(5000);
    });
  });

  // ============================================================
  // toolCall ↔ toolResult 配对
  // ============================================================
  describe("toolCall 配对", () => {
    it("toolCall + toolResult → InternalToolCall done", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "sync", task: "t", startedAt: 100 }),
        assistantEntry([
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/x.ts" } },
        ]),
        toolResultEntry("call-1", "read"),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.turns[0].toolCalls).toHaveLength(1);
      const tc = rec!.turns[0].toolCalls[0];
      expect(tc.toolName).toBe("read");
      expect(tc._status).toBe("done");
      expect(tc.isError).toBe(false);
    });

    it("toolResult isError → InternalToolCall failed", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "sync", task: "t", startedAt: 100 }),
        assistantEntry([
          { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "false" } },
        ]),
        toolResultEntry("call-1", "bash", { isError: true }),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.turns[0].toolCalls[0]._status).toBe("failed");
      expect(rec!.turns[0].toolCalls[0].isError).toBe(true);
    });

    it("孤儿 toolResult（无匹配 toolCall）→ 丢弃，不崩", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "sync", task: "t", startedAt: 100 }),
        assistantEntry([{ type: "text", text: "ok" }]),
        toolResultEntry("nonexistent", "read"),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec).toBeDefined();
      expect(rec!.turns[0].toolCalls).toHaveLength(0);
    });
  });

  // ============================================================
  // error / stopReason
  // ============================================================
  describe("error 处理", () => {
    it("stopReason=error → lastError + error 字段", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "sync", task: "t", startedAt: 100 }),
        assistantEntry([{ type: "text", text: "partial" }], {
          stopReason: "error", errorMessage: "API timeout",
        }),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.lastError).toBe("API timeout");
      expect(rec!.error).toBe("API timeout");
      expect(rec!.status).toBe("failed"); // error stopReason → failed
    });

    it("stopReason=aborted 无 errorMessage → lastError = 'aborted'", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "sync", task: "t", startedAt: 100 }),
        assistantEntry([{ type: "text", text: "" }], { stopReason: "aborted" }),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.lastError).toBe("aborted");
      expect(rec!.status).toBe("failed");
    });

    it("前序 error 但最后 stop → lastError 清除（镜像 turn_end 语义），status=done", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "sync", task: "t", startedAt: 100 }),
        assistantEntry([{ type: "text", text: "oops" }], {
          stopReason: "error", errorMessage: "transient", ts: 1000,
        }),
        assistantEntry([{ type: "text", text: "recovered" }], { stopReason: "stop", ts: 2000 }),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.lastError).toBeUndefined(); // 后续 stop 清除了 error
      expect(rec!.status).toBe("done");
      expect(rec!.result).toBe("oops\n\nrecovered");
    });
  });

  // ============================================================
  // eventLog 派生
  // ============================================================
  describe("eventLog 派生", () => {
    it("tool_start + tool_end + turn_end 条目", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "sync", task: "t", startedAt: 100 }),
        assistantEntry([
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "/x.ts" } },
        ]),
        toolResultEntry("c1", "read"),
      ]);
      const rec = reconstructFromFile(filePath);
      const types = rec!.eventLog.map((e) => e.type);
      expect(types).toContain("tool_start");
      expect(types).toContain("tool_end");
      expect(types).toContain("turn_end");
    });
  });

  // ============================================================
  // 防御性降级
  // ============================================================
  describe("防御性降级", () => {
    it("文件缺失 → undefined", () => {
      expect(reconstructFromFile(path.join(tmpDir, "nonexistent.jsonl"))).toBeUndefined();
    });

    it("空文件 → undefined", () => {
      fs.writeFileSync(filePath, "", "utf-8");
      expect(reconstructFromFile(filePath)).toBeUndefined();
    });

    it("缺 identity custom entry → undefined", () => {
      writeJsonl([
        headerLine(),
        assistantEntry([{ type: "text", text: "no identity" }]),
      ]);
      expect(reconstructFromFile(filePath)).toBeUndefined();
    });

    it("有 identity 但无 assistant message → undefined", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "sync", task: "t", startedAt: 100 }),
      ]);
      expect(reconstructFromFile(filePath)).toBeUndefined();
    });

    it("损坏 JSON 行跳过，合法行仍解析", () => {
      const fd = fs.openSync(filePath, "w");
      fs.writeSync(fd, `${JSON.stringify(headerLine())}\n`);
      fs.writeSync(fd, "THIS IS NOT JSON\n");
      fs.writeSync(fd, `${JSON.stringify(identityEntry({ id: "r1", agent: "w", mode: "sync", task: "t", startedAt: 100 }))}\n`);
      fs.writeSync(fd, `${JSON.stringify(assistantEntry([{ type: "text", text: "survived" }]))}\n`);
      fs.closeSync(fd);
      const rec = reconstructFromFile(filePath);
      expect(rec).toBeDefined();
      expect(rec!.result).toBe("survived");
    });
  });
});
