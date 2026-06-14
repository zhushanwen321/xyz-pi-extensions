// src/__tests__/agent-widget.test.ts
import { describe, expect, it, vi } from "vitest";

import { AgentWidgetManager, renderStatusLine, renderWidget, type WidgetAgentState } from "../tui/agent-widget.ts";

describe("renderWidget", () => {
  it("returns empty array when no agents", () => {
    expect(renderWidget([], 0)).toEqual([]);
  });

  it("shows spinner + agent name for running agents", () => {
    const agents: WidgetAgentState[] = [
      { id: "1", agent: "reviewer", status: "running", turns: 3, totalTokens: 12000, elapsedSeconds: 15,
        eventLog: [{ type: "tool_start", label: "read foo.ts", ts: 0, status: "running" }] },
    ];
    const lines = renderWidget(agents, 0);
    expect(lines[0]).toContain("reviewer");
    expect(lines[0]).toContain("3 turns");
    expect(lines[0]).toContain("12.0k token");
    expect(lines[1]).toContain("read foo.ts");
  });

  it("shows ✓ for done agents", () => {
    const agents: WidgetAgentState[] = [
      { id: "1", agent: "worker", status: "done", summary: "fixed the bug", finishedAt: Date.now() },
    ];
    const lines = renderWidget(agents, 0);
    expect(lines.some((l) => l.includes("✓") && l.includes("fixed the bug"))).toBe(true);
  });

  it("shows ✗ for failed agents", () => {
    const agents: WidgetAgentState[] = [
      { id: "1", agent: "worker", status: "failed", summary: "rate limited", finishedAt: Date.now() },
    ];
    const lines = renderWidget(agents, 0);
    expect(lines.some((l) => l.includes("✗"))).toBe(true);
  });
});

describe("renderStatusLine", () => {
  it("returns undefined when no running agents", () => {
    expect(renderStatusLine([{ id: "1", agent: "x", status: "done" }])).toBeUndefined();
  });

  it("returns count for running agents", () => {
    const agents: WidgetAgentState[] = [
      { id: "1", agent: "a", status: "running" },
      { id: "2", agent: "b", status: "running" },
    ];
    expect(renderStatusLine(agents)).toBe("2 agents running");
  });

  it("singular for 1 running", () => {
    expect(renderStatusLine([{ id: "1", agent: "a", status: "running" }])).toBe("1 agent running");
  });
});

describe("AgentWidgetManager", () => {
  it("updateAgent + render calls setWidget", () => {
    const ui = { setWidget: vi.fn(), setStatus: vi.fn() };
    const mgr = new AgentWidgetManager();
    mgr.attachUI(ui);
    mgr.updateAgent({ id: "1", agent: "worker", status: "running" });
    expect(ui.setWidget).toHaveBeenCalledWith("subagents", expect.any(Array));
    expect(ui.setStatus).toHaveBeenCalledWith("subagents", "1 agent running");
    mgr.detach();
  });

  it("removeAgent clears widget when empty", () => {
    const ui = { setWidget: vi.fn(), setStatus: vi.fn() };
    const mgr = new AgentWidgetManager();
    mgr.attachUI(ui);
    mgr.updateAgent({ id: "1", agent: "x", status: "running" });
    mgr.removeAgent("1");
    expect(ui.setWidget).toHaveBeenCalledWith("subagents", undefined);
    mgr.detach();
  });

  it("listAgents returns all states", () => {
    const mgr = new AgentWidgetManager();
    mgr.updateAgent({ id: "1", agent: "a", status: "running" });
    mgr.updateAgent({ id: "2", agent: "b", status: "done", finishedAt: Date.now() });
    expect(mgr.listAgents()).toHaveLength(2);
  });
});

// ============================================================
// FR-2: 增强 inline widget 渲染（eventLog 滚动）
// ============================================================

import { STALLED_TIMEOUT_MS } from "../types.ts";

describe("renderWidget — eventLog scrolling", () => {
  it("shows status summary + recent eventLog entries", () => {
    const state: WidgetAgentState = {
      id: "1", agent: "worker", status: "running", turns: 2, totalTokens: 5000, elapsedSeconds: 30,
      eventLog: [
        { type: "tool_start", label: "read foo.ts", ts: 0, status: "running" },
        { type: "tool_end", label: "edit bar.ts", ts: 0, status: "done" },
        { type: "turn_end", label: "Fixed X", ts: 0 },
      ],
    };
    const lines = renderWidget([state], 0);
    expect(lines[0]).toContain("worker");
    expect(lines[0]).toContain("2 turns");
    expect(lines[1]).toContain("read foo.ts");
    // FR-2.1: tool_start 无 running 标记（formatEventLogLine 不再追加 ⟳ running）
    expect(lines[1]).not.toContain("running");
    expect(lines.some((l) => l.includes("edit bar.ts") && l.includes("✓"))).toBe(true);
    expect(lines.some((l) => l.includes("turn") && l.includes("Fixed X"))).toBe(true);
  });

  it("limits total lines to MAX_WIDGET_LINES (12)", () => {
    const state: WidgetAgentState = {
      id: "1", agent: "worker", status: "running", turns: 0, totalTokens: 0, elapsedSeconds: 0,
      eventLog: Array.from({ length: 50 }, (_, i) => ({
        type: "tool_start" as const, label: `tool-${i}`, ts: 0, status: "running" as const,
      })),
    };
    const lines = renderWidget([state], 0);
    expect(lines.length).toBeLessThanOrEqual(12);
  });

  it("shows possibly stalled when last event older than STALLED_TIMEOUT_MS", () => {
    const state: WidgetAgentState = {
      id: "1", agent: "worker", status: "running", turns: 1, totalTokens: 100, elapsedSeconds: 600,
      eventLog: [{ type: "tool_start", label: "old tool", ts: Date.now() - STALLED_TIMEOUT_MS - 1000, status: "running" }],
    };
    const lines = renderWidget([state], 0);
    expect(lines.some((l) => l.includes("stalled"))).toBe(true);
  });

  it("distributes lines across multiple running agents", () => {
    const states: WidgetAgentState[] = [
      { id: "1", agent: "a", status: "running", turns: 0, eventLog: Array.from({ length: 5 }, (_, i) => ({ type: "tool_start" as const, label: `t${i}`, ts: 0, status: "running" as const })) },
      { id: "2", agent: "b", status: "running", turns: 0, eventLog: Array.from({ length: 5 }, (_, i) => ({ type: "tool_start" as const, label: `u${i}`, ts: 0, status: "running" as const })) },
    ];
    const lines = renderWidget(states, 0);
    expect(lines.length).toBeLessThanOrEqual(12);
  });
});
