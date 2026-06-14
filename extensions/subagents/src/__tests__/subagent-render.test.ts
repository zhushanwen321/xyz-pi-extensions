// src/__tests__/subagent-render.test.ts
import { describe, expect, it } from "vitest";

import { buildRenderLines, SubagentResultComponent, type SubagentToolDetails } from "../tui/subagent-render.ts";

const fakeTheme = {
  bg(_color: string, text: string): string { return `[bg:${text}]`; },
};

function makeDetails(overrides: Partial<SubagentToolDetails> = {}): SubagentToolDetails {
  return {
    eventLog: [],
    status: "running",
    agent: "worker",
    turns: 0,
    totalTokens: 0,
    elapsedSeconds: 0,
    ...overrides,
  };
}

describe("buildRenderLines", () => {
  it("shows status line with agent name and turns", () => {
    const lines = buildRenderLines(makeDetails({ turns: 3, totalTokens: 12000, elapsedSeconds: 45 }));
    expect(lines[0]).toContain("worker");
    expect(lines[0]).toContain("3 turns");
    expect(lines[0]).toContain("12.0k");
    expect(lines[0]).toContain("45s");
  });

  it("shows running icon for running status", () => {
    const lines = buildRenderLines(makeDetails({ status: "running" }));
    // ⠹ character
    expect(lines[0]).toContain("\u2839");
  });

  it("shows done icon for done status", () => {
    const lines = buildRenderLines(makeDetails({ status: "done" }));
    expect(lines[0]).toContain("\u2713");
  });

  it("shows failed icon for failed status", () => {
    const lines = buildRenderLines(makeDetails({ status: "failed" }));
    expect(lines[0]).toContain("\u2717");
  });

  it("renders eventLog entries without ├─", () => {
    const lines = buildRenderLines(makeDetails({
      eventLog: [
        { type: "tool_start", label: "read foo.ts", ts: 0, status: "running" },
        { type: "tool_end", label: "edit bar.ts", ts: 0, status: "done" },
        { type: "turn_end", label: "Fixed the handler", ts: 0 },
      ],
    }));
    expect(lines.some((l) => l.includes("read foo.ts") && !l.includes("\u251C"))).toBe(true);
    expect(lines.some((l) => l.includes("edit bar.ts") && l.includes("\u2713"))).toBe(true);
    expect(lines.some((l) => l.includes("turn 1") && l.includes("Fixed the handler"))).toBe(true);
  });

  it("shows result for done status", () => {
    const lines = buildRenderLines(makeDetails({
      status: "done",
      result: "The file has been fixed.",
    }));
    expect(lines.some((l) => l.includes("The file has been fixed."))).toBe(true);
  });

  it("shows error for failed status", () => {
    const lines = buildRenderLines(makeDetails({
      status: "failed",
      error: "rate limited",
    }));
    expect(lines.some((l) => l.includes("Error: rate limited"))).toBe(true);
  });
});

describe("SubagentResultComponent", () => {
  it("renders lines with background color", () => {
    const details = makeDetails({ turns: 2, totalTokens: 5000, elapsedSeconds: 30 });
    const comp = new SubagentResultComponent(details, fakeTheme);
    const lines = comp.render(80);
    expect(lines.length).toBeGreaterThan(0);
    // Each line should have background applied
    expect(lines[0]).toContain("[bg:");
  });

  it("updates details and re-renders", () => {
    const comp = new SubagentResultComponent(makeDetails({ agent: "worker" }), fakeTheme);
    comp.update(makeDetails({ agent: "reviewer", turns: 5 }));
    const lines = comp.render(80);
    expect(lines[0]).toContain("reviewer");
    expect(lines[0]).toContain("5 turns");
  });
});
