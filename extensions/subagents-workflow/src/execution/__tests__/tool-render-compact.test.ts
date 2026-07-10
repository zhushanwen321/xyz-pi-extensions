// src/__tests__/tool-render-compact.test.ts
//
// renderCompact（displayItems 布局）行内容正确性测试。
//
// [SPAWN 改造] compact 布局对齐 nicobailon collapsed：
//   首行 = icon + agent；
//   中间 = displayItems 滚动区（formatDisplayItem：→ formatToolCall 格式）；
//   底部 = usage 独立行（N turns · Nk · Ns）。
// 替代旧 tool-render-compact-layout/full-lifecycle/spinner 三个测试（Step3
// displayItems 改动后旧断言失效）。

import type { Component } from "@earendil-works/pi-tui";
import type { AgentToolResult, Theme } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { type RenderContext, renderSubagentResult } from "../../interface/tool-render.ts";
import type { DisplayItem, SubagentToolResult, SyncResponse } from "../types.ts";

const theme = {
  fg: (_tag: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

function makeCtx(): RenderContext {
  return { state: {} as Record<string, never>, invalidate: vi.fn() };
}

function syncResult(sync: Partial<SyncResponse>): AgentToolResult<SubagentToolResult> {
  return {
    content: [{ type: "text", text: "" }],
    details: {
      action: "start",
      subagentId: "run-1",
      sessionFile: "s.jsonl",
      syncResponse: {
        status: "running",
        mode: "sync",
        agent: "worker",
        model: "test/model",
        thinkingLevel: undefined,
        turns: 0,
        totalTokens: 0,
        elapsedSeconds: 0,
        eventLog: [],
        displayItems: [],
        ...sync,
      },
    },
  };
}

function renderCompactLines(
  result: AgentToolResult<SubagentToolResult>,
  isPartial = false,
): string[] {
  const comp = renderSubagentResult(result, { expanded: false, isPartial }, theme, makeCtx());
  return (comp as unknown as Component).render(80);
}

const bashItem = (status: "running" | "done" | "failed" = "done"): DisplayItem => ({
  type: "toolCall",
  name: "bash",
  args: { command: "git status" },
  status,
});
const readItem: DisplayItem = {
  type: "toolCall",
  name: "read",
  args: { path: "/home/user/proj/a.ts" },
  status: "done",
};

describe("renderCompact displayItems 布局", () => {
  describe("首行 = icon + agent", () => {
    it("running 态首行含 spinner + agent 名", () => {
      const lines = renderCompactLines(syncResult({ agent: "worker" }), true);
      // spinner 是非字母符号，agent 名紧跟
      expect(lines[0]).toContain("worker");
    });

    it("done 态首行含 ✓ glyph + agent 名", () => {
      const lines = renderCompactLines(syncResult({ status: "done", agent: "worker" }));
      expect(lines[0]).toContain("✓");
      expect(lines[0]).toContain("worker");
    });

    it("首行不含 model（避免与 renderCall 标题行重复）", () => {
      const lines = renderCompactLines(syncResult({ model: "test/model" }));
      expect(lines[0]).not.toContain("test/model");
    });
  });

  describe("displayItems 滚动区", () => {
    it("toolCall item 格式化为 → formatToolCall", () => {
      const lines = renderCompactLines(syncResult({
        displayItems: [bashItem()],
      }));
      // 找到含 → 的行
      const itemLine = lines.find((l) => l.includes("→"));
      expect(itemLine).toBeDefined();
      expect(itemLine).toContain("git status");
    });

    it("read item 显示 read + 路径", () => {
      const lines = renderCompactLines(syncResult({
        displayItems: [readItem],
      }));
      const itemLine = lines.find((l) => l.includes("→"));
      expect(itemLine).toContain("read");
      expect(itemLine).toContain("a.ts");
    });

    it("done 态 toolCall 尾部含 ✓", () => {
      const lines = renderCompactLines(syncResult({
        displayItems: [bashItem("done")],
      }));
      const itemLine = lines.find((l) => l.includes("→"));
      expect(itemLine).toContain("✓");
    });

    it("failed 态 toolCall 尾部含 ✗", () => {
      const lines = renderCompactLines(syncResult({
        displayItems: [bashItem("failed")],
      }));
      const itemLine = lines.find((l) => l.includes("→"));
      expect(itemLine).toContain("✗");
    });

    it("running 态 toolCall 无 ✓/✗ 标记", () => {
      const lines = renderCompactLines(syncResult({
        displayItems: [bashItem("running")],
      }));
      const itemLine = lines.find((l) => l.includes("→"));
      expect(itemLine).not.toContain("✓");
      expect(itemLine).not.toContain("✗");
    });

    it("displayItems 超过 COMPACT_SCROLL_LINES(3) 只展示最近 3 条", () => {
      const lines = renderCompactLines(syncResult({
        displayItems: [
          { type: "toolCall", name: "bash", args: { command: "cmd1" }, status: "done" },
          { type: "toolCall", name: "bash", args: { command: "cmd2" }, status: "done" },
          { type: "toolCall", name: "bash", args: { command: "cmd3" }, status: "done" },
          { type: "toolCall", name: "bash", args: { command: "cmd4" }, status: "done" },
          { type: "toolCall", name: "bash", args: { command: "cmd5" }, status: "done" },
        ],
      }));
      // 只有 cmd3/cmd4/cmd5（最近 3 条），cmd1/cmd2 不展示
      const itemLines = lines.filter((l) => l.includes("→"));
      expect(itemLines).toHaveLength(3);
      expect(itemLines.some((l) => l.includes("cmd1"))).toBe(false);
      expect(itemLines.some((l) => l.includes("cmd5"))).toBe(true);
    });

    it("空 displayItems 时无滚动区行（只有首行 + 可能的 stats）", () => {
      const lines = renderCompactLines(syncResult({
        displayItems: [],
        turns: 0,
        totalTokens: 0,
        elapsedSeconds: 0,
      }));
      // 无 stats（全零），只有首行
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("worker");
    });
  });

  describe("底部 stats 行", () => {
    it("各字段 >0 时显示 N turns · Nk · Ns", () => {
      const lines = renderCompactLines(syncResult({
        status: "done",
        turns: 3,
        totalTokens: 12000,
        elapsedSeconds: 30,
      }));
      const statsLine = lines[lines.length - 1];
      expect(statsLine).toContain("3 turns");
      // 12000 tokens 格式化后含 k
      expect(statsLine).toMatch(/\d/);
    });

    it("全零时无 stats 行", () => {
      const lines = renderCompactLines(syncResult({
        turns: 0,
        totalTokens: 0,
        elapsedSeconds: 0,
        displayItems: [bashItem()],
      }));
      // 首行 + 1 个 item，无 stats
      expect(lines).toHaveLength(2);
    });

    it("stats 是最后一行", () => {
      const lines = renderCompactLines(syncResult({
        turns: 2,
        displayItems: [bashItem()],
      }));
      expect(lines[lines.length - 1]).toContain("2 turns");
    });
  });
});
