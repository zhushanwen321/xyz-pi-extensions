// src/__tests__/agent-widget.test.ts
import { describe, expect, it, vi } from "vitest";

import { AgentWidgetManager, renderStatusLine, renderWidget, type WidgetAgentState } from "../tui/agent-widget.ts";

describe("renderWidget", () => {
  it("returns empty array when no agents", () => {
    expect(renderWidget([], 0)).toEqual([]);
  });

  it("shows spinner + agent name for running agents", () => {
    const agents: WidgetAgentState[] = [
      { id: "1", agent: "reviewer", status: "running", turns: 3, totalTokens: 12000, elapsedSeconds: 15, activity: "reading" },
    ];
    const lines = renderWidget(agents, 0);
    expect(lines[0]).toContain("reviewer");
    expect(lines[0]).toContain("↻3");
    expect(lines[0]).toContain("12.0k token");
    expect(lines[1]).toContain("⎿ reading");
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
