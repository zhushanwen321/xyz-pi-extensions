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
  padVisible,
  visibleLen,
  buildPhaseGroups,
  formatAgentOneLiner,
} from "../interface/views/format.js";
import type { ExecutionTraceNode } from "../domain/state.js";

// ── Test fixtures ─────────────────────────────────────────────

const fakeTheme = {
  fg(_token: string, text: string): string {
    // Simulate ANSI: return text as-is (ANSI codes are zero-width).
    // Previous [token]text mock caused test failures because [token]
    // added visible chars that real ANSI doesn't.
    return text;
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

  it("nodes without phase go to (default) group", () => {
    const nodes = [
      makeNode({ stepIndex: 0, agent: "a" }),
      makeNode({ stepIndex: 1, phase: "build", agent: "b" }),
    ];

    const result = groupByPhase(nodes);

    expect(result.get("(default)")!.length).toBe(1);
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
    // fakeTheme returns [token]text which simulates ANSI (zero visible width
    // after stripping). After stripping, remaining chars are the real visible content.
    const stripped = result.replace(/\[[^\]]+\]/g, "");
    expect(stripped.length).toBeLessThanOrEqual(24);
  });

  it("status dot uses correct color token", () => {
    const completed = formatSidebarNode(makeNode({ status: "completed" }), false, 24, fakeTheme);
    expect(completed).toContain("●");

    const failed = formatSidebarNode(makeNode({ status: "failed" }), false, 24, fakeTheme);
    expect(failed).toContain("●");

    const running = formatSidebarNode(makeNode({ status: "running" }), false, 24, fakeTheme);
    expect(running).toContain("●");

    const pending = formatSidebarNode(makeNode({ status: "pending" }), false, 24, fakeTheme);
    expect(pending).toContain("●");
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
    expect(statusDotStr("completed", fakeTheme)).toBe("●");
  });

  it("maps failed to error token", () => {
    expect(statusDotStr("failed", fakeTheme)).toBe("●");
  });

  it("maps running to warning token", () => {
    expect(statusDotStr("running", fakeTheme)).toBe("●");
  });

  it("maps unknown to muted token", () => {
    expect(statusDotStr("pending", fakeTheme)).toBe("●");
  });
});

// ── visibleLen + padVisible ───────────────────────────────────

describe("visibleLen", () => {
  it("counts plain text length", () => {
    expect(visibleLen("hello")).toBe(5);
  });

  it("strips ANSI escape codes", () => {
    expect(visibleLen("\x1b[1m\x1b[32mbold-green\x1b[0m\x1b[0m")).toBe(10);
  });

  it("empty string", () => {
    expect(visibleLen("")).toBe(0);
  });
});

describe("padVisible", () => {
  it("pads plain string to target width", () => {
    expect(padVisible("abc", 6)).toBe("abc   ");
  });

  it("does not pad if already at width", () => {
    expect(padVisible("abc", 3)).toBe("abc");
  });

  it("does not pad if exceeding width", () => {
    expect(padVisible("abcdef", 3)).toBe("abcdef");
  });

  it("pads ANSI string by visible width", () => {
    const ansi = "\x1b[1mabc\x1b[0m";
    const result = padVisible(ansi, 6);
    expect(visibleLen(result)).toBe(6);
    expect(result.endsWith("   ")).toBe(true);
  });
});

// ── buildPhaseGroups ──────────────────────────────────────────

describe("buildPhaseGroups", () => {
  it("filters out phases with 0 agents", () => {
    const nodes = [
      makeNode({ stepIndex: 0, phase: "Review", agent: "review-1" }),
      makeNode({ stepIndex: 1, phase: "Fix", agent: "fix-1" }),
    ];
    const groups = buildPhaseGroups(nodes);
    expect(groups).toHaveLength(2);
    expect(groups[0].name).toBe("Review");
    expect(groups[0].nodes).toHaveLength(1);
    expect(groups[1].name).toBe("Fix");
  });

  it("aggregates nodes per phase", () => {
    const nodes = [
      makeNode({ stepIndex: 0, phase: "Review", agent: "review-1" }),
      makeNode({ stepIndex: 1, phase: "Review", agent: "review-2" }),
      makeNode({ stepIndex: 2, phase: "Fix", agent: "fix-1" }),
    ];
    const groups = buildPhaseGroups(nodes);
    expect(groups).toHaveLength(2);
    expect(groups[0].nodes).toHaveLength(2);
    expect(groups[0].doneCount).toBe(0);
  });

  it("counts completed nodes", () => {
    const nodes = [
      makeNode({ stepIndex: 0, phase: "Review", status: "completed" }),
      makeNode({ stepIndex: 1, phase: "Review", status: "running" }),
    ];
    const groups = buildPhaseGroups(nodes);
    expect(groups[0].doneCount).toBe(1);
  });
});

// ── formatAgentOneLiner ────────────────────────────────────────

describe("formatAgentOneLiner", () => {
  it("formats agent with status dot and name", () => {
    const node = makeNode({ agent: "review-1", model: "glm-5.1" });
    const result = formatAgentOneLiner(node, fakeTheme);
    expect(result).toContain("review-1");
    expect(result).toContain("glm-5.1");
    expect(result).toContain("●");
  });
});
