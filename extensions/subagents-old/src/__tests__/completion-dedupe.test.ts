// src/__tests__/completion-dedupe.test.ts
//
// TTL 去重 Map 测试。移植自 tintinweb/pi-subagents 的 completion-dedupe。
// 用于 background 完成通知去重（防止 cancel + abort catch 双发 sendMessage）。

import { describe, expect, it } from "vitest";

import {
  buildCompletionKey,
  getGlobalSeenMap,
  markSeenWithTtl,
} from "../persistence/completion-dedupe.ts";

describe("buildCompletionKey", () => {
  it("uses id when present", () => {
    expect(buildCompletionKey({ id: "bg-1-abc" }, "fallback")).toBe("id:bg-1-abc");
  });

  it("falls back to meta composite when no id", () => {
    const key = buildCompletionKey(
      { agent: "reviewer", sessionId: "s1", timestamp: 1000, success: true },
      "scope-x",
    );
    expect(key).toContain("s1");
    expect(key).toContain("reviewer");
    expect(key).toContain("1000");
    expect(key).toContain("1"); // success true → "1"
    expect(key).toContain("scope-x");
  });

  it("produces same key for same meta", () => {
    const data = { agent: "a", sessionId: "s", timestamp: 5, success: false };
    expect(buildCompletionKey(data, "f")).toBe(buildCompletionKey(data, "f"));
  });

  // ── Round 5 SUG#13: 边界 case 覆盖 ──────────────────
  it("id 为空串时 fallback 到 meta key", () => {
    expect(buildCompletionKey({ id: "" }, "f")).not.toMatch(/^id:/);
    expect(buildCompletionKey({ id: "" }, "f")).toContain("f");
  });

  it("id 为纯空白时 fallback 到 meta key", () => {
    const key = buildCompletionKey({ id: "   " }, "f");
    expect(key).not.toMatch(/^id:/);
    expect(key).toContain("f");
  });

  it("id 为非字符串时 fallback 到 meta key", () => {
    const key = buildCompletionKey({ id: 123 }, "f");
    expect(key).not.toMatch(/^id:/);
    expect(key).toContain("f");
  });

  it("meta 字段全缺失时使用默认值（no-session:unknown:no-ts）", () => {
    const key = buildCompletionKey({}, "f");
    expect(key).toContain("no-session");
    expect(key).toContain("unknown");
    expect(key).toContain("no-ts");
    expect(key).toContain("f");
    // success 未知 → "?" 标记
    expect(key).toContain("?");
  });

  it("id 为非空字符串时优先用 id（忽略 meta 缺失）", () => {
    expect(buildCompletionKey({ id: "bg-1" }, "f")).toBe("id:bg-1");
  });
});

describe("markSeenWithTtl", () => {
  it("returns false on first sight, true on duplicate within TTL", () => {
    const seen = new Map<string, number>();
    const now = 10000;
    const ttl = 60000;
    expect(markSeenWithTtl(seen, "k", now, ttl)).toBe(false);
    expect(markSeenWithTtl(seen, "k", now + 1000, ttl)).toBe(true);
  });

  it("returns false again after TTL expires", () => {
    const seen = new Map<string, number>();
    const ttl = 60000;
    markSeenWithTtl(seen, "k", 10000, ttl);
    expect(markSeenWithTtl(seen, "k", 10000 + ttl + 1, ttl)).toBe(false);
  });

  it("prunes expired entries", () => {
    const seen = new Map<string, number>();
    const ttl = 1000;
    markSeenWithTtl(seen, "old", 0, ttl);
    markSeenWithTtl(seen, "new", 2000, ttl); // triggers prune of "old"
    expect(seen.has("old")).toBe(false);
    expect(seen.has("new")).toBe(true);
  });
});

describe("getGlobalSeenMap", () => {
  it("returns same Map instance for same key", () => {
    const m1 = getGlobalSeenMap("__test_dedupe_map__");
    m1.set("x", 1);
    const m2 = getGlobalSeenMap("__test_dedupe_map__");
    expect(m2).toBe(m1);
    expect(m2.get("x")).toBe(1);
    m2.delete("x");
  });
});
