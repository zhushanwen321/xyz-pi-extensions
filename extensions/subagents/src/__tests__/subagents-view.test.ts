// src/__tests__/subagents-view.test.ts
import { describe, expect, it, vi } from "vitest";

import {
  collectRecords,
  formatDetailView,
  formatListView,
  processKey,
  sortRecords,
  type SubagentRecord,
  type ViewState,
} from "../tui/subagents-view.ts";

const fakeTheme = {
  fg(_t: string, text: string): string { return text; },
  bold(text: string): string { return `**${text}**`; },
};

function makeRecord(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "run-1", agent: "worker", status: "running", startedAt: Date.now() - 30000,
    eventLog: [], turns: 2, totalTokens: 5000, ...overrides,
  };
}

describe("collectRecords", () => {
  it("merges widget + bg + completed by id with cancelled priority", () => {
    const widget: SubagentRecord[] = [
      { id: "run-1", agent: "worker", status: "running", eventLog: [], startedAt: 1 },
    ];
    const bg: SubagentRecord[] = [
      { id: "bg-1", agent: "scout", status: "cancelled", eventLog: [], startedAt: 2 },
    ];
    const merged = collectRecords(widget, bg, []);
    expect(merged).toHaveLength(2);
    expect(merged.find((r) => r.id === "bg-1")?.status).toBe("cancelled");
  });

  it("cancelled overrides running when same id", () => {
    const widget = [makeRecord({ id: "x", status: "running" })];
    const completed = [makeRecord({ id: "x", status: "cancelled" })];
    const merged = collectRecords(widget, [], completed);
    expect(merged.find((r) => r.id === "x")?.status).toBe("cancelled");
  });

  it("widget overrides bg when bg is not cancelled", () => {
    const widget = [makeRecord({ id: "x", status: "running" })];
    const bg = [makeRecord({ id: "x", status: "done" })];
    const merged = collectRecords(widget, bg, []);
    expect(merged.find((r) => r.id === "x")?.status).toBe("running");
  });
});

describe("sortRecords", () => {
  it("sorts running first, then failed, cancelled, done; within group by startedAt desc", () => {
    const records: SubagentRecord[] = [
      makeRecord({ id: "1", status: "done", startedAt: 100 }),
      makeRecord({ id: "2", status: "running", startedAt: 50 }),
      makeRecord({ id: "3", status: "failed", startedAt: 200 }),
      makeRecord({ id: "4", status: "cancelled", startedAt: 150 }),
    ];
    const sorted = sortRecords(records);
    expect(sorted.map((r) => r.id)).toEqual(["2", "3", "4", "1"]);
  });
});

describe("formatListView", () => {
  it("shows empty state when no records", () => {
    const lines = formatListView([], fakeTheme, 80, 0);
    expect(lines.some((l) => l.includes("No subagent"))).toBe(true);
  });

  it("shows header + rows", () => {
    const records = [
      makeRecord({ id: "run-3", agent: "worker", status: "done", turns: 5, totalTokens: 23000 }),
      makeRecord({ id: "bg-1", agent: "researcher", status: "running", turns: 2, totalTokens: 8000 }),
    ];
    const lines = formatListView(records, fakeTheme, 80, 0);
    expect(lines.some((l) => l.includes("Subagents"))).toBe(true);
    expect(lines.some((l) => l.includes("run-3"))).toBe(true);
    expect(lines.some((l) => l.includes("bg-1"))).toBe(true);
  });

  it("highlights selected row", () => {
    const records = [makeRecord({ id: "1" }), makeRecord({ id: "2" })];
    const lines = formatListView(records, fakeTheme, 80, 1);
    // fakeTheme.bold wraps with **...**
    expect(lines.some((l) => l.includes("**"))).toBe(true);
  });
});

describe("formatDetailView", () => {
  it("shows header with id + agent + status", () => {
    const record = makeRecord({ id: "bg-1", agent: "scout", status: "running" });
    const lines = formatDetailView(record, fakeTheme, 80, 0);
    expect(lines.some((l) => l.includes("bg-1"))).toBe(true);
    expect(lines.some((l) => l.includes("scout"))).toBe(true);
  });

  it("shows event log", () => {
    const record = makeRecord({
      eventLog: [
        { type: "tool_start", label: "read foo", ts: 0, status: "running" },
        { type: "turn_end", label: "summary", ts: 0 },
      ],
    });
    const lines = formatDetailView(record, fakeTheme, 80, 0);
    expect(lines.some((l) => l.includes("read foo"))).toBe(true);
    expect(lines.some((l) => l.includes("summary"))).toBe(true);
  });

  it("shows 'Terminal too small' when terminalRows < 8", () => {
    const record = makeRecord();
    const lines = formatDetailView(record, fakeTheme, 80, 0, 5);
    expect(lines.some((l) => l.includes("Terminal too small"))).toBe(true);
  });
});

describe("processKey", () => {
  function makeState(): ViewState {
    return { level: 0, selectedIdx: 0, scrollOffset: 0, disposed: false };
  }
  const records = [makeRecord({ id: "1" }), makeRecord({ id: "2" })];

  it("j moves selectedIdx down", () => {
    const state = makeState();
    const result = processKey("j", records, state, fakeTheme, null, () => {}, null);
    expect(state.selectedIdx).toBe(1);
    expect(result).toBe(true);
  });

  it("k moves selectedIdx up", () => {
    const state = { ...makeState(), selectedIdx: 1 };
    processKey("k", records, state, fakeTheme, null, () => {}, null);
    expect(state.selectedIdx).toBe(0);
  });

  it("Enter at level 0 goes to level 1", () => {
    const state = makeState();
    const result = processKey("\r", records, state, fakeTheme, null, () => {}, null);
    expect(state.level).toBe(1);
    expect(result).toBe(true);
  });

  it("q at level 0 calls done", () => {
    const state = makeState();
    const done = vi.fn();
    processKey("q", records, state, fakeTheme, null, done, null);
    expect(done).toHaveBeenCalled();
  });

  it("q at level 1 returns to level 0", () => {
    const state = { ...makeState(), level: 1 };
    const result = processKey("q", records, state, fakeTheme, null, () => {}, null);
    expect(state.level).toBe(0);
    expect(result).toBe(true);
  });

  it("Esc at level 1 returns to level 0", () => {
    const state = { ...makeState(), level: 1 };
    processKey("\x1b", records, state, fakeTheme, null, () => {}, null);
    expect(state.level).toBe(0);
  });

  it("x on running background agent calls cancelBackground", () => {
    const state = makeState();
    const records2 = [makeRecord({ id: "bg-1", status: "running" })];
    const cancel = vi.fn(() => true);
    processKey("x", records2, state, fakeTheme, records2[0], () => {}, { cancelBackground: cancel });
    expect(cancel).toHaveBeenCalledWith("bg-1");
  });

  it("ignored when disposed", () => {
    const state = { ...makeState(), disposed: true };
    const result = processKey("j", records, state, fakeTheme, null, () => {}, null);
    expect(result).toBe(false);
    expect(state.selectedIdx).toBe(0);
  });
});
