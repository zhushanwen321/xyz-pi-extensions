// src/__tests__/subagents-view.test.ts
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import {
  applyFilter,
  collectRecords,
  formatRecordRow,
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

function makeState(overrides: Partial<ViewState> = {}): ViewState {
  return { selectedIdx: 0, scrollOffset: 0, filterText: "", detailMode: false, disposed: false, syncCancelHint: false, ...overrides };
}

// ── collectRecords / sortRecords ──

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

// ── applyFilter ──

describe("applyFilter", () => {
  const records = [
    makeRecord({ id: "run-1", agent: "worker" }),
    makeRecord({ id: "bg-2", agent: "reviewer" }),
    makeRecord({ id: "run-3", agent: "scout" }),
  ];

  it("returns all when filterText is empty", () => {
    expect(applyFilter(records, "")).toHaveLength(3);
  });

  it("filters by agent name (case-insensitive)", () => {
    const filtered = applyFilter(records, "WORK");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].agent).toBe("worker");
  });

  it("filters by id", () => {
    const filtered = applyFilter(records, "bg-");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("bg-2");
  });

  it("returns empty when no match", () => {
    expect(applyFilter(records, "nonexistent")).toHaveLength(0);
  });
});

// ── formatRecordRow (对齐) ──

describe("formatRecordRow", () => {
  it("bolds selected row", () => {
    const line = formatRecordRow(makeRecord(), fakeTheme, true);
    expect(line.startsWith("**")).toBe(true);
  });

  it("does not bold unselected row", () => {
    const line = formatRecordRow(makeRecord(), fakeTheme, false);
    expect(line.startsWith("**")).toBe(false);
  });

  it("shows ❯ pointer for selected, spaces for unselected", () => {
    const selected = formatRecordRow(makeRecord(), fakeTheme, true);
    const unselected = formatRecordRow(makeRecord(), fakeTheme, false);
    expect(selected).toContain("❯");
    expect(unselected.startsWith("❯")).toBe(false);
    expect(unselected.startsWith(" ")).toBe(true);
  });

  it("shows bg mode tag for background records", () => {
    const line = formatRecordRow(makeRecord({ mode: "background" }), fakeTheme, false);
    expect(line).toContain("bg");
  });

  it("aligns columns consistently regardless of agent name length", () => {
    const line1 = formatRecordRow(makeRecord({ agent: "x" }), fakeTheme, false);
    const line2 = formatRecordRow(makeRecord({ agent: "very-long-agent-name" }), fakeTheme, false);
    const turnsPos1 = line1.indexOf("2t");
    const turnsPos2 = line2.indexOf("2t");
    expect(turnsPos1).toBe(turnsPos2);
    expect(turnsPos1).toBeGreaterThan(0);
  });
});

// ── processKey ──

describe("processKey", () => {
  const records = [makeRecord({ id: "1" }), makeRecord({ id: "2" })];

  // matchesKey 测试辅助：用 Key 对象生成匹配的 data
  // pi-tui matchesKey(data, Key.down) 匹配 legacy \x1bOB 和 \x1b[B 等
  const DOWN = "\x1b[B";
  const UP = "\x1b[A";
  const ENTER = "\r";

  it("↑ moves selectedIdx up", () => {
    const state = makeState({ selectedIdx: 1 });
    processKey(UP, records, state, fakeTheme, null, () => {}, null);
    expect(state.selectedIdx).toBe(0);
  });

  it("↓ moves selectedIdx down", () => {
    const state = makeState();
    const result = processKey(DOWN, records, state, fakeTheme, null, () => {}, null);
    expect(state.selectedIdx).toBe(1);
    expect(result).toBe(true);
  });

  it("↓ does not move past last record", () => {
    const state = makeState({ selectedIdx: 1 });
    const result = processKey(DOWN, records, state, fakeTheme, null, () => {}, null);
    expect(state.selectedIdx).toBe(1);
    expect(result).toBe(false);
  });

  it("Enter enters detail mode", () => {
    const state = makeState();
    const result = processKey(ENTER, records, state, fakeTheme, null, () => {}, null);
    expect(state.detailMode).toBe(true);
    expect(result).toBe(true);
  });

  it("Esc exits the view (calls done)", () => {
    const state = makeState();
    const done = vi.fn();
    processKey("\x1b", records, state, fakeTheme, null, done, null);
    expect(done).toHaveBeenCalled();
  });

  it("Esc in detail mode returns to split-pane (not exit)", () => {
    const state = makeState({ detailMode: true });
    const done = vi.fn();
    const result = processKey("\x1b", records, state, fakeTheme, null, done, null);
    expect(state.detailMode).toBe(false);
    expect(done).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it("typing appends to filterText (default, no filter mode needed)", () => {
    const state = makeState();
    processKey("w", records, state, fakeTheme, null, () => {}, null);
    processKey("o", records, state, fakeTheme, null, () => {}, null);
    expect(state.filterText).toBe("wo");
  });

  it("Backspace removes last filter char", () => {
    const state = makeState({ filterText: "abc" });
    processKey("\x7f", records, state, fakeTheme, null, () => {}, null);
    expect(state.filterText).toBe("ab");
  });

  // ── P3#5: x 键停止方案重设计 ──
  // 分屏模式：x 作为 filter 字符（不再停止）；detailMode：x 停止 running agent。

  it("P3#5: 分屏模式 x 作为 filter 字符（不停止 agent）", () => {
    const state = makeState();
    const records2 = [makeRecord({ id: "bg-1", status: "running" })];
    const cancel = vi.fn(() => true);
    const result = processKey("x", records2, state, fakeTheme, records2[0], () => {}, { cancelBackground: cancel, cancelRunningAgent: vi.fn() });
    expect(cancel).not.toHaveBeenCalled();
    expect(state.filterText).toBe("x");
    expect(result).toBe(true);
  });

  it("P3#5: detailMode x 停止 running background agent", () => {
    const state = makeState({ detailMode: true });
    const records2 = [makeRecord({ id: "bg-1", status: "running", mode: "background" })];
    const cancel = vi.fn(() => true);
    const result = processKey("x", records2, state, fakeTheme, records2[0], () => {}, { cancelBackground: cancel, cancelRunningAgent: vi.fn() });
    expect(cancel).toHaveBeenCalledWith("bg-1");
    expect(state.syncCancelHint).toBe(false); // background 真正取消，无提示
    expect(result).toBe(true);
  });

  it("P3#5: detailMode x 对 sync agent 设 syncCancelHint 提示", () => {
    const state = makeState({ detailMode: true });
    const records2 = [makeRecord({ id: "run-1", status: "running", mode: "sync" })];
    const cancelRunning = vi.fn(() => true);
    const cancelBg = vi.fn(() => true);
    const result = processKey("x", records2, state, fakeTheme, records2[0], () => {}, { cancelBackground: cancelBg, cancelRunningAgent: cancelRunning });
    expect(cancelRunning).toHaveBeenCalledWith("run-1");
    expect(cancelBg).not.toHaveBeenCalled(); // sync 不走 background cancel
    expect(state.syncCancelHint).toBe(true); // 设提示，渲染层据此显示「请在对话流按 Esc」
    expect(result).toBe(true);
  });

  it("P3#5: detailMode x 对非 running agent 无操作", () => {
    const state = makeState({ detailMode: true });
    const records2 = [makeRecord({ id: "run-1", status: "done" })];
    const cancel = vi.fn(() => true);
    const result = processKey("x", records2, state, fakeTheme, records2[0], () => {}, { cancelBackground: cancel, cancelRunningAgent: vi.fn() });
    expect(cancel).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it("P3#5: Esc 退出详情时清 syncCancelHint", () => {
    const state = makeState({ detailMode: true, syncCancelHint: true });
    processKey("\x1b", records, state, fakeTheme, null, () => {}, null);
    expect(state.detailMode).toBe(false);
    expect(state.syncCancelHint).toBe(false);
  });

  it("P3#5: Enter 进入详情时清 syncCancelHint", () => {
    const state = makeState({ syncCancelHint: true });
    processKey(ENTER, records, state, fakeTheme, null, () => {}, null);
    expect(state.detailMode).toBe(true);
    expect(state.syncCancelHint).toBe(false);
  });

  it("ignored when disposed", () => {
    const state = makeState({ disposed: true });
    const result = processKey(DOWN, records, state, fakeTheme, null, () => {}, null);
    expect(result).toBe(false);
    expect(state.selectedIdx).toBe(0);
  });

  it("↓ respects filter (only moves within filtered results)", () => {
    const records3 = [
      makeRecord({ id: "1", agent: "worker" }),
      makeRecord({ id: "2", agent: "reviewer" }),
      makeRecord({ id: "3", agent: "worker" }),
    ];
    const state = makeState({ filterText: "work" });
    processKey(DOWN, records3, state, fakeTheme, null, () => {}, null);
    expect(state.selectedIdx).toBe(1);
    // 第二次 ↓ 不应越界（filtered 只有 2 条）
    processKey(DOWN, records3, state, fakeTheme, null, () => {}, null);
    expect(state.selectedIdx).toBe(1);
  });

  it("detail mode ↑↓ scrolls eventLog", () => {
    const state = makeState({ detailMode: true, scrollOffset: 5 });
    processKey(UP, records, state, fakeTheme, null, () => {}, null);
    expect(state.scrollOffset).toBe(4);
    processKey(DOWN, records, state, fakeTheme, null, () => {}, null);
    expect(state.scrollOffset).toBe(5);
  });

  // ── 详情全屏翻屏：PgUp/PgDn/Home/End（legacy 序列）──
  const PGUP = "\x1b[5~";
  const PGDN = "\x1b[6~";
  const HOME = "\x1b[H";
  const END = "\x1b[F";
  // 详情上下文：视口 10 行，内容 30 行 → maxOffset = 20
  const detailCtx = { viewportHeight: 10, contentLines: 30 };

  it("detail mode Home 跳顶（scrollOffset=0）", () => {
    const state = makeState({ detailMode: true, scrollOffset: 15 });
    processKey(HOME, records, state, fakeTheme, null, () => {}, null, detailCtx);
    expect(state.scrollOffset).toBe(0);
  });

  it("detail mode End 跳底（clamp 到 maxOffset=20）", () => {
    const state = makeState({ detailMode: true, scrollOffset: 5 });
    processKey(END, records, state, fakeTheme, null, () => {}, null, detailCtx);
    // maxOffset = contentLines(30) - viewportHeight(10) = 20
    expect(state.scrollOffset).toBe(20);
  });

  it("detail mode PgDn 大跨度翻屏（+viewportHeight）", () => {
    const state = makeState({ detailMode: true, scrollOffset: 3 });
    processKey(PGDN, records, state, fakeTheme, null, () => {}, null, detailCtx);
    expect(state.scrollOffset).toBe(13); // 3 + 10
  });

  it("detail mode PgUp 大跨度翻屏（-viewportHeight），不低于 0", () => {
    const state = makeState({ detailMode: true, scrollOffset: 7 });
    processKey(PGUP, records, state, fakeTheme, null, () => {}, null, detailCtx);
    expect(state.scrollOffset).toBe(0); // 7 - 10 → clamp 0
  });

  it("detail mode PgDn 越界时 clamp 到 maxOffset", () => {
    const state = makeState({ detailMode: true, scrollOffset: 18 });
    processKey(PGDN, records, state, fakeTheme, null, () => {}, null, detailCtx);
    // 18 + 10 = 28，但 maxOffset = 20
    expect(state.scrollOffset).toBe(20);
  });

  it("matchesKey compatibility: \\x1bOA (alt arrow seq) also matches Key.up", () => {
    // 确认 matchesKey 兼容 \x1bOA（终端 cursor key 模式）
    expect(matchesKey("\x1bOA", Key.up)).toBe(true);
    expect(matchesKey("\x1bOB", Key.down)).toBe(true);
  });
});
