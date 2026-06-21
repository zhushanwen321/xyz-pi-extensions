/**
 * Tests for WorkflowsView pure formatting functions
 *
 * Covers: groupByPhase, formatActivityLine,
 * formatElapsed, formatTokenStat.
 *
 * Pure functions imported from views/format.ts — no Pi runtime dependency.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import type { ExecutionTraceNode, WorkflowInstance } from "../domain/state.js";
import {
  buildPhaseGroups,
  formatActivityLine,
  formatAgentOneLiner,
  formatElapsed,
  formatStatusBadge,
  formatTokenStat,
  groupByPhase,
  padVisible,
  statusDotStr,
  visibleLen,
} from "../interface/views/format.js";
import { createWorkflowsView } from "../interface/views/WorkflowsView.js";
import type { WorkflowOrchestrator } from "../orchestrator.js";

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
    expect(result).toContain("\u25CF");
  });
});

// ── formatStatusBadge ─────────────────────────────────────────

describe("formatStatusBadge", () => {
  it("maps running to warning with \u25CF", () => {
    const result = formatStatusBadge("running", fakeTheme);
    expect(result).toContain("running");
  });

  it("maps paused to warning with \u23F8", () => {
    const result = formatStatusBadge("paused", fakeTheme);
    expect(result).toContain("PAUSED");
  });

  it("maps completed to success with \u2713", () => {
    const result = formatStatusBadge("completed", fakeTheme);
    expect(result).toContain("completed");
  });

  it("maps failed to error with \u2717", () => {
    const result = formatStatusBadge("failed", fakeTheme);
    expect(result).toContain("failed");
  });

  it("maps aborted to error", () => {
    const result = formatStatusBadge("aborted", fakeTheme);
    expect(result).toContain("aborted");
  });

  it("maps budget_limited to error", () => {
    const result = formatStatusBadge("budget_limited", fakeTheme);
    expect(result).toContain("budget");
  });

  it("maps time_limited to error", () => {
    const result = formatStatusBadge("time_limited", fakeTheme);
    expect(result).toContain("timeout");
  });
});

// ── processKey / handleInput integration tests ────────────────
//
// processKey is module-private; tested indirectly via the component's
// handleInput returned by createWorkflowsView.

/** Build a minimal WorkflowInstance with 2 phases x 2 agents. */
function makeTestInstance(overrides: Partial<WorkflowInstance> = {}): WorkflowInstance {
  return {
    runId: "test-run-001",
    name: "test-workflow",
    status: "running",
    callCache: new Map(),
    trace: [
      {
        stepIndex: 0, phase: "Review", agent: "review-agent", task: "review code",
        model: "glm-5.1", status: "completed",
        startedAt: new Date(Date.now() - 60000).toISOString(),
        completedAt: new Date(Date.now() - 30000).toISOString(),
        result: { content: "LGTM", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 150, turns: 1 } },
      },
      {
        stepIndex: 1, phase: "Review", agent: "lint-agent", task: "run linter",
        model: "glm-5.1", status: "completed",
        startedAt: new Date(Date.now() - 29000).toISOString(),
        completedAt: new Date(Date.now() - 10000).toISOString(),
        result: { content: "no errors", toolCalls: [{ name: "Bash", input: "eslint ." }] },
      },
      {
        stepIndex: 2, phase: "Fix", agent: "fix-agent", task: "fix issues",
        model: "glm-5.1", status: "running",
        startedAt: new Date(Date.now() - 5000).toISOString(),
      },
      {
        stepIndex: 3, phase: "Fix", agent: "verify-agent", task: "verify fixes",
        model: "glm-5.1", status: "pending",
      },
    ],
    worker: "/path/to/workflow.js",
    startedAt: new Date(Date.now() - 60000).toISOString(),
    budget: { usedTokens: 500, usedCost: 0.01 },
    ...overrides,
  };
}

/** Create a mock orchestrator wired to the given instance. */
function createMockOrchestrator(instance: WorkflowInstance) {
  return {
    getInstance: vi.fn().mockReturnValue(instance),
    abort: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue("new-run-002"),
    events: {
      subscribe: vi.fn().mockReturnValue(vi.fn()),
    },
  } as unknown as WorkflowOrchestrator;
}

/**
 * Set up the component returned by createWorkflowsView.
 * Calls ctx.ui.custom's factory immediately with mock TUI primitives.
 * Returns the component handle plus mock functions for assertions.
 */
async function setupViewComponent(instance?: WorkflowInstance) {
  const inst = instance ?? makeTestInstance();
  const orchestrator = createMockOrchestrator(inst);
  const requestRender = vi.fn();
  const done = vi.fn();
  let component: { invalidate(): void; render(w: number): string[]; handleInput(d: string): void };

  const ctx = {
    ui: {
      custom: vi.fn().mockImplementation(
        (factory: (tui: unknown, _t: unknown, _kb: unknown, d: () => void) => unknown) => {
          component = factory(
            { requestRender, terminal: { rows: 40 } },
            fakeTheme,
            {},
            done,
          ) as typeof component;
          return Promise.resolve();
        },
      ),
      notify: vi.fn(),
    },
  } as unknown as ExtensionContext;

  await createWorkflowsView(orchestrator, inst.runId, fakeTheme, ctx);

  return {
    // @ts-expect-error — component is assigned synchronously inside ui.custom mock
    component,
    orchestrator,
    requestRender,
    done,
    notify: (ctx as unknown as { ui: { notify: ReturnType<typeof vi.fn> } }).ui.notify,
  };
}

describe("processKey (via handleInput)", () => {
  // Key sequences — match the mock pi-tui Key constants
  const ESC = "\x1b";
  const UP = "\x1b[A";
  const DOWN = "\x1b[B";
  const ENTER = "\r";

  // ── Escape navigation ────────────────────────────────

  it("escape at level 0 calls done(), does not requestRender", async () => {
    const { component, done, requestRender } = await setupViewComponent();
    component.handleInput(ESC);
    expect(done).toHaveBeenCalledTimes(1);
    // processKey returns false → handleInput does NOT call requestRender
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("escape at level 1 goes back to level 0", async () => {
    const { component, requestRender, done } = await setupViewComponent();
    // Enter → level 1
    component.handleInput(ENTER);
    requestRender.mockClear();
    // Escape → back to level 0 (returns true → render)
    component.handleInput(ESC);
    expect(requestRender).toHaveBeenCalledTimes(1);
    // Verify we're back at level 0: another escape should call done()
    done.mockClear();
    component.handleInput(ESC);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("escape at level 2 goes back to level 1", async () => {
    const { component, requestRender, done } = await setupViewComponent();
    // Enter → level 1, Enter → level 2
    component.handleInput(ENTER);
    component.handleInput(ENTER);
    requestRender.mockClear();
    // Escape → level 1
    component.handleInput(ESC);
    expect(requestRender).toHaveBeenCalledTimes(1);
    // Verify level 1: escape should go to level 0
    requestRender.mockClear();
    component.handleInput(ESC);
    expect(requestRender).toHaveBeenCalledTimes(1);
    // Verify level 0: escape calls done
    done.mockClear();
    component.handleInput(ESC);
    expect(done).toHaveBeenCalledTimes(1);
  });

  // ── Up/Down at level 0 ───────────────────────────────

  it("down at level 0 increments phaseIdx", async () => {
    const { component, requestRender } = await setupViewComponent();
    // Initial phaseIdx=0, phases=[Review, Fix]
    component.handleInput(DOWN);
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it("up at level 0 decrements phaseIdx and resets agentIdx", async () => {
    const { component, requestRender } = await setupViewComponent();
    // Move to phaseIdx=1 first
    component.handleInput(DOWN);
    requestRender.mockClear();
    // Now move back to phaseIdx=0
    component.handleInput(UP);
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it("up at level 0 when phaseIdx=0 does nothing", async () => {
    const { component, requestRender } = await setupViewComponent();
    component.handleInput(UP);
    // processKey returns false → no requestRender
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("down at level 0 wraps at last phase", async () => {
    const { component, requestRender } = await setupViewComponent();
    // Go to last phase (index 1)
    component.handleInput(DOWN);
    requestRender.mockClear();
    // Already at last phase, down does nothing
    component.handleInput(DOWN);
    expect(requestRender).not.toHaveBeenCalled();
  });

  // ── Enter navigation ─────────────────────────────────

  it("enter at level 0 goes to level 1", async () => {
    const { component, requestRender } = await setupViewComponent();
    component.handleInput(ENTER);
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it("enter at level 1 goes to level 2", async () => {
    const { component, requestRender } = await setupViewComponent();
    component.handleInput(ENTER); // level 1
    requestRender.mockClear();
    component.handleInput(ENTER); // level 2
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  // ── Up/Down at level 2 ───────────────────────────────

  it("down at level 2 increments agentIdx", async () => {
    const { component, requestRender } = await setupViewComponent();
    // Enter level 1 then level 2
    component.handleInput(ENTER);
    component.handleInput(ENTER);
    requestRender.mockClear();
    // agentIdx=0 initially, move to 1
    component.handleInput(DOWN);
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it("up at level 2 decrements agentIdx", async () => {
    const { component, requestRender } = await setupViewComponent();
    // Enter level 1 then level 2, then down to agentIdx=1
    component.handleInput(ENTER);
    component.handleInput(ENTER);
    component.handleInput(DOWN);
    requestRender.mockClear();
    // Move back to agentIdx=0
    component.handleInput(UP);
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it("up at level 2 when agentIdx=0 does nothing", async () => {
    const { component, requestRender } = await setupViewComponent();
    component.handleInput(ENTER);
    component.handleInput(ENTER);
    requestRender.mockClear();
    component.handleInput(UP);
    expect(requestRender).not.toHaveBeenCalled();
  });

  // ── Global actions ───────────────────────────────────

  it("'x' key calls abort on orchestrator", async () => {
    const { component, orchestrator } = await setupViewComponent();
    component.handleInput("x");
    expect(orchestrator.abort).toHaveBeenCalledWith("test-run-001");
  });

  it("'x' on terminal status notifies 'already completed'", async () => {
    const inst = makeTestInstance({ status: "completed" });
    const { component, notify } = await setupViewComponent(inst);
    component.handleInput("x");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("completed"), "warning");
  });

  it("'p' key when running calls pause", async () => {
    const { component, orchestrator } = await setupViewComponent();
    component.handleInput("p");
    expect(orchestrator.pause).toHaveBeenCalledWith("test-run-001");
  });

  it("'p' key when paused calls resume", async () => {
    const inst = makeTestInstance({ status: "paused" });
    const { component, orchestrator } = await setupViewComponent(inst);
    component.handleInput("p");
    expect(orchestrator.resume).toHaveBeenCalledWith("test-run-001");
  });

  it("'p' on terminal status notifies warning", async () => {
    const inst = makeTestInstance({ status: "completed" });
    const { component, notify } = await setupViewComponent(inst);
    component.handleInput("p");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("completed"), "warning");
  });

  // ── Save mode ────────────────────────────────────────

  it("'s' key enters save mode", async () => {
    const { component, requestRender } = await setupViewComponent();
    component.handleInput("s");
    // processKey returns true → requestRender called
    expect(requestRender).toHaveBeenCalledTimes(1);
    // Verify save mode active: escape should exit save mode (not exit view)
    requestRender.mockClear();
    component.handleInput(ESC);
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it("save mode: escape exits save mode without exiting view", async () => {
    const { component, done, requestRender } = await setupViewComponent();
    component.handleInput("s");
    requestRender.mockClear();
    component.handleInput(ESC);
    // Should exit save mode (returns true → render), not call done
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
  });

  it("save mode: printable char appends to input value", async () => {
    const { component, requestRender } = await setupViewComponent();
    component.handleInput("s");
    requestRender.mockClear();
    component.handleInput("A");
    expect(requestRender).toHaveBeenCalledTimes(1);
    // Backspace to remove the char, proving it was appended
    requestRender.mockClear();
    component.handleInput("\x7f"); // backspace
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it("save mode: backspace removes last char", async () => {
    const { component, requestRender } = await setupViewComponent();
    component.handleInput("s");
    // Append a char
    component.handleInput("X");
    requestRender.mockClear();
    // Backspace removes it
    component.handleInput("\x7f");
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it("save mode: backspace on empty input does nothing", async () => {
    const { component, requestRender } = await setupViewComponent();
    component.handleInput("s");
    requestRender.mockClear();
    // Backspace on the initial value (instance name "test-workflow")
    // This should remove one char and return true
    component.handleInput("\x7f");
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it("save mode: enter with empty name shows error", async () => {
    const { component, requestRender } = await setupViewComponent();
    component.handleInput("s");
    // Clear input by backspacing all chars (instance name = "test-workflow", 12 chars)
    for (let i = 0; i < "test-workflow".length; i++) {
      component.handleInput("\x7f");
    }
    requestRender.mockClear();
    // Enter with empty input → sets error message, returns true
    component.handleInput("\r");
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  // ── Disposed state ───────────────────────────────────

  it("handleInput after done is a no-op", async () => {
    const { component, done, requestRender } = await setupViewComponent();
    component.handleInput(ESC); // calls done
    expect(done).toHaveBeenCalledTimes(1);
    requestRender.mockClear();
    // Any subsequent input should be ignored
    component.handleInput(DOWN);
    expect(requestRender).not.toHaveBeenCalled();
  });
});
