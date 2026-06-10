/**
 * Tests for WorkflowsView pure formatting functions
 *
 * Covers: groupByPhase, formatSidebarNode, formatActivityLine,
 * formatElapsed, formatTokenStat.
 *
 * Pure functions imported from views/format.ts — no Pi runtime dependency.
 */

import { describe, it, expect } from "vitest";
import {
  groupByPhase,
  formatSidebarNode,
  formatActivityLine,
  formatElapsed,
  formatTokenStat,
  statusDotStr,
} from "../views/format.js";
import type { ExecutionTraceNode } from "../state.js";

// ── Test fixtures ─────────────────────────────────────────────

const fakeTheme = {
  fg(token: string, text: string): string {
    return `[${token}]${text}`;
  },
  bold(text: string): string {
    return `**${text}**`;
  },
};

function makeNode(overrides: Partial<ExecutionTraceNode> = {}): ExecutionTraceNode {
  return {
    stepIndex: 0,
    agent: "test-agent",
    task: "do something",
    model: "default",
    status: "pending",
    ...overrides,
  };
}

// ── groupByPhase ──────────────────────────────────────────────

describe("groupByPhase", () => {
  it("groups nodes by phase", () => {
    const nodes = [
      makeNode({ stepIndex: 0, phase: "setup", agent: "a" }),
      makeNode({ stepIndex: 1, phase: "build", agent: "b" }),
      makeNode({ stepIndex: 2, phase: "setup", agent: "c" }),
    ];

    const result = groupByPhase(nodes);

    expect(result.size).toBe(2);
    expect(result.get("setup")!.length).toBe(2);
    expect(result.get("build")!.length).toBe(1);
  });

  it("nodes without phase go to (no phase) group", () => {
    const nodes = [
      makeNode({ stepIndex: 0, agent: "a" }),
      makeNode({ stepIndex: 1, phase: "build", agent: "b" }),
    ];

    const result = groupByPhase(nodes);

    expect(result.get("(no phase)")!.length).toBe(1);
    expect(result.get("build")!.length).toBe(1);
  });

  it("empty array returns empty Map", () => {
    const result = groupByPhase([]);
    expect(result.size).toBe(0);
  });

  it("sorts nodes within phase by stepIndex ascending (FR-3.2)", () => {
    const nodes = [
      makeNode({ stepIndex: 5, phase: "test", agent: "c" }),
      makeNode({ stepIndex: 2, phase: "test", agent: "a" }),
      makeNode({ stepIndex: 4, phase: "test", agent: "b" }),
    ];

    const result = groupByPhase(nodes);
    const phaseNodes = result.get("test")!;

    expect(phaseNodes.map((n) => n.stepIndex)).toEqual([2, 4, 5]);
  });
});

// ── formatSidebarNode ─────────────────────────────────────────

describe("formatSidebarNode", () => {
  it("selected node has ❯ prefix", () => {
    const node = makeNode({ agent: "my-agent", status: "running" });
    const result = formatSidebarNode(node, true, 24, fakeTheme);

    expect(result.startsWith("❯ ")).toBe(true);
  });

  it("unselected node has space prefix", () => {
    const node = makeNode({ agent: "my-agent", status: "running" });
    const result = formatSidebarNode(node, false, 24, fakeTheme);

    expect(result.startsWith("  ")).toBe(true);
  });

  it("truncates long agent names to fit width", () => {
    const node = makeNode({ agent: "very-long-agent-name-that-exceeds", status: "completed" });
    const result = formatSidebarNode(node, false, 24, fakeTheme);

    // Visible length (stripping mock [token] markers) should be <= width.
    // Note: mock theme.fg returns `[success]●` (11 chars), but real ANSI
    // codes are invisible. Stripping mock markers simulates visible length.
    const stripped = result.replace(/\[[^\]]+\]/g, "");
    expect(stripped.length).toBeLessThanOrEqual(24);
  });

  it("status dot uses correct color token", () => {
    const completed = formatSidebarNode(makeNode({ status: "completed" }), false, 24, fakeTheme);
    expect(completed).toContain("[success]●");

    const failed = formatSidebarNode(makeNode({ status: "failed" }), false, 24, fakeTheme);
    expect(failed).toContain("[error]●");

    const running = formatSidebarNode(makeNode({ status: "running" }), false, 24, fakeTheme);
    expect(running).toContain("[warning]●");

    const pending = formatSidebarNode(makeNode({ status: "pending" }), false, 24, fakeTheme);
    expect(pending).toContain("[muted]●");
  });
});

// ── formatActivityLine ────────────────────────────────────────

describe("formatActivityLine", () => {
  it("formats as ToolName(args)", () => {
    const result = formatActivityLine({ name: "Bash", input: "git status" }, 60);
    expect(result).toBe("Bash(git status)");
  });

  it("truncates long args with ellipsis", () => {
    const longArgs = "a".repeat(100);
    const result = formatActivityLine({ name: "Bash", input: longArgs }, 30);

    expect(result.length).toBeLessThanOrEqual(30);
    expect(result).toContain("\u2026"); // U+2026 ellipsis
  });

  it("returns just name when maxWidth < 10", () => {
    const result = formatActivityLine({ name: "Bash", input: "cmd" }, 5);
    expect(result).toBe("Bash");
  });

  it("handles Skill tool call", () => {
    const result = formatActivityLine({ name: "Skill", input: "code-review" }, 60);
    expect(result).toBe("Skill(code-review)");
  });
});

// ── formatElapsed ─────────────────────────────────────────────

describe("formatElapsed", () => {
  it("returns '-' when no startedAt", () => {
    expect(formatElapsed(undefined)).toBe("-");
  });

  it("computes seconds from startedAt", () => {
    const now = Date.now();
    const startedAt = new Date(now - 5000).toISOString();
    expect(formatElapsed(startedAt, now)).toBe("5s");
  });

  it("formats minutes and seconds for longer durations", () => {
    const now = Date.now();
    const startedAt = new Date(now - 125000).toISOString(); // 2m 5s
    expect(formatElapsed(startedAt, now)).toBe("2m5s");
  });

  it("returns 0s for sub-second durations", () => {
    const now = Date.now();
    const startedAt = new Date(now - 500).toISOString();
    expect(formatElapsed(startedAt, now)).toBe("0s");
  });
});

// ── formatTokenStat ───────────────────────────────────────────

describe("formatTokenStat", () => {
  it("shows 0 tok when no usage", () => {
    expect(formatTokenStat(undefined, undefined)).toBe("0 tok · 0 tool calls");
  });

  it("shows correct token count with usage", () => {
    const usage = { input: 1000, output: 500 };
    expect(formatTokenStat(usage, undefined)).toBe("1500 tok · 0 tool calls");
  });

  it("shows correct tool call count", () => {
    const toolCalls = [{ name: "Bash", input: "cmd" }, { name: "Read", input: "file" }];
    expect(formatTokenStat(undefined, toolCalls)).toBe("0 tok · 2 tool calls");
  });

  it("shows both usage and tool calls", () => {
    const usage = { input: 200, output: 100 };
    const toolCalls = [{ name: "Bash", input: "cmd" }];
    expect(formatTokenStat(usage, toolCalls)).toBe("300 tok · 1 tool calls");
  });
});

// ── statusDotStr ──────────────────────────────────────────────

describe("statusDotStr", () => {
  it("maps completed to success token", () => {
    expect(statusDotStr("completed", fakeTheme)).toBe("[success]●");
  });

  it("maps failed to error token", () => {
    expect(statusDotStr("failed", fakeTheme)).toBe("[error]●");
  });

  it("maps running to warning token", () => {
    expect(statusDotStr("running", fakeTheme)).toBe("[warning]●");
  });

  it("maps unknown to muted token", () => {
    expect(statusDotStr("pending", fakeTheme)).toBe("[muted]●");
  });
});
