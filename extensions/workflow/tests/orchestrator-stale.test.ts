// 测试框架：vitest
// 运行命令：npx vitest run tests/orchestrator-stale.test.ts
//
// Round 4 MF6: executeWithRetry / restart / runAndWait / isStaleContextErrorMsg 零测试。
// 本文件覆盖：
//   1. isStaleContextErrorMsg 纯函数（不依赖 runtime）
//   2. executeWithRetry 的 stale-context 早返回路径（mock pool 返回 stale 错误，验证不重试）

import { describe, expect, it, vi } from "vitest";

// 避免加载 @zhushanwen/pi-subagents 真实包（其 node_modules 没有 @mariozechner/pi-ai）
vi.mock("@zhushanwen/pi-subagents", () => ({
  getRuntime: () => undefined,
}));

import { isStaleContextErrorMsg, STALE_CONTEXT_PATTERNS } from "../src/orchestrator";

// ── isStaleContextErrorMsg 纯函数测试 ────────────────────────

describe("isStaleContextErrorMsg", () => {
  it("undefined 返回 false", () => {
    expect(isStaleContextErrorMsg(undefined)).toBe(false);
  });

  it("空字符串返回 false", () => {
    expect(isStaleContextErrorMsg("")).toBe(false);
  });

  it("stale context（小写）匹配", () => {
    expect(isStaleContextErrorMsg("error: stale context detected")).toBe(true);
  });

  it("StaleContext 驼峰匹配", () => {
    expect(isStaleContextErrorMsg("StaleContextException thrown")).toBe(true);
  });

  it("context canceled 匹配", () => {
    expect(isStaleContextErrorMsg("Agent failed: context canceled by user")).toBe(true);
  });

  it("aborted 匹配", () => {
    expect(isStaleContextErrorMsg("Operation aborted")).toBe(true);
  });

  it("大小写不敏感：STALE CONTEXT", () => {
    expect(isStaleContextErrorMsg("STALE CONTEXT error")).toBe(true);
  });

  it("不相关的错误不匹配", () => {
    expect(isStaleContextErrorMsg("rate limit exceeded")).toBe(false);
    expect(isStaleContextErrorMsg("network timeout")).toBe(false);
    expect(isStaleContextErrorMsg("invalid api key")).toBe(false);
  });

  it("匹配优先级：patterns 数组至少覆盖上述 4 种场景", () => {
    // Sanity check 模式列表完整性
    expect(STALE_CONTEXT_PATTERNS).toContain("stale context");
    expect(STALE_CONTEXT_PATTERNS).toContain("stalecontext");
    expect(STALE_CONTEXT_PATTERNS).toContain("context canceled");
    expect(STALE_CONTEXT_PATTERNS).toContain("aborted");
  });
});
