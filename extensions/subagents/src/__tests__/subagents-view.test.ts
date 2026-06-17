// src/__tests__/subagents-view.test.ts
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import {
  applyFilter,
  collectRecords,
  formatRecordRow,
  processKey,
  renderView,
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

// ── renderView (split-pane) ──

describe("renderView", () => {
  it("shows 'Terminal too small' when termRows < 8", () => {
    const lines = renderView([], fakeTheme, 80, makeState(), 5);
    expect(lines.some((l) => l.includes("Terminal too small"))).toBe(true);
  });

  it("renders header with filter prompt (always visible, cursor _)", () => {
    const lines = renderView([], fakeTheme, 100, makeState(), 30);
    expect(lines.some((l) => l.includes("filter:"))).toBe(true);
    // 空过滤时光标 _ 仍在
    expect(lines.some((l) => l.includes("_"))).toBe(true);
  });

  it("renders footer with key hints (Esc 退出, no q/jk)", () => {
    const lines = renderView([], fakeTheme, 100, makeState(), 30);
    expect(lines.some((l) => l.includes("Esc 退出"))).toBe(true);
    expect(lines.some((l) => l.includes("Enter 详情"))).toBe(true);
  });

  it("renders left column header with count", () => {
    const records = [makeRecord({ id: "1" }), makeRecord({ id: "2" })];
    const lines = renderView(records, fakeTheme, 100, makeState(), 30);
    expect(lines.some((l) => l.includes("Agents (2/2)"))).toBe(true);
  });

  it("renders right column detail header", () => {
    const records = [makeRecord({ id: "run-1", agent: "worker", status: "done" })];
    const lines = renderView(records, fakeTheme, 100, makeState(), 30);
    expect(lines.some((l) => l.includes("Detail"))).toBe(true);
    expect(lines.some((l) => l.includes("worker"))).toBe(true);
    expect(lines.some((l) => l.includes("done"))).toBe(true);
  });

  it("renders model + thinking level in right column detail", () => {
    const records = [makeRecord({
      agent: "worker",
      model: "anthropic/claude-sonnet-4.5",
      thinkingLevel: "high",
    })];
    const lines = renderView(records, fakeTheme, 100, makeState(), 30);
    // model 和 thinking level 用括号分组显示
    expect(lines.some((l) => l.includes("anthropic/claude-sonnet-4.5"))).toBe(true);
    expect(lines.some((l) => l.includes("thinking high"))).toBe(true);
  });

  it("renders detail without model/thinking when absent", () => {
    const records = [makeRecord({ agent: "worker", model: undefined, thinkingLevel: undefined })];
    const lines = renderView(records, fakeTheme, 100, makeState(), 30);
    // 不应出现 thinking 关键词
    expect(lines.some((l) => l.includes("thinking"))).toBe(false);
  });

  it("shows filter text in header", () => {
    const state = makeState({ filterText: "work" });
    const lines = renderView([], fakeTheme, 100, state, 30);
    expect(lines.some((l) => l.includes("work_"))).toBe(true);
  });

  it("shows filtered count in left header", () => {
    const records = [
      makeRecord({ id: "1", agent: "worker" }),
      makeRecord({ id: "2", agent: "reviewer" }),
    ];
    const state = makeState({ filterText: "work" });
    const lines = renderView(records, fakeTheme, 100, state, 30);
    expect(lines.some((l) => l.includes("Agents (1/2)"))).toBe(true);
  });

  it("renders event log entries in right column", () => {
    const records = [makeRecord({
      eventLog: [{ type: "tool_start", label: "read foo.ts", ts: 0, status: "running" }],
    })];
    const lines = renderView(records, fakeTheme, 100, makeState(), 30);
    expect(lines.some((l) => l.includes("read foo.ts"))).toBe(true);
  });

  it("分屏右列折叠：长 label 单行截断（不换行成多行）", () => {
    const longLabel = "x".repeat(200);
    const records = [makeRecord({
      eventLog: [{ type: "text_output", label: longLabel, ts: 0 }],
    })];
    const lines = renderView(records, fakeTheme, 60, makeState(), 30);
    // 折叠视图：长 label 只占一行（截断 + …），不应出现 200 个 x
    const longLines = lines.filter((l) => l.includes("xxxx"));
    // 截断后单行可见宽度受限；含 x 的行数应 == 1（不换行）
    expect(longLines.length).toBe(1);
    expect(longLines[0]).toContain("…");
  });

  it("分屏右列用类型图标（›/·/>），不用 ⎿ 前缀", () => {
    const records = [makeRecord({
      eventLog: [
        { type: "tool_end", label: "read auth.ts", ts: 0, status: "done" },
        { type: "thinking", label: "analyzing", ts: 0 },
        { type: "text_output", label: "done", ts: 0 },
      ],
    })];
    const lines = renderView(records, fakeTheme, 100, makeState(), 30);
    // 不应出现废弃的 ⎿ 前缀
    expect(lines.some((l) => l.includes("⎿"))).toBe(false);
    // 应出现类型图标
    expect(lines.some((l) => l.includes("›") && l.includes("read auth.ts"))).toBe(true);
    expect(lines.some((l) => l.includes("·") && l.includes("analyzing"))).toBe(true);
    expect(lines.some((l) => l.includes(">") && l.includes("done"))).toBe(true);
  });
});

// ── renderView 详情全屏模式（detailMode）──

describe("renderView — 详情全屏（detailMode）", () => {
  it("detailMode 渲染全屏（标题为 agent 名，非 Subagents）", () => {
    const records = [makeRecord({ id: "1", agent: "worker", status: "done" })];
    const lines = renderView(records, fakeTheme, 100, makeState({ detailMode: true }), 30);
    // 标题行含 agent 名
    expect(lines.some((l) => l.includes("worker"))).toBe(true);
    // footer 含翻屏提示
    expect(lines.some((l) => l.includes("PgUp PgDn"))).toBe(true);
    expect(lines.some((l) => l.includes("Esc 返回"))).toBe(true);
  });

  it("detailMode 展开长 label（换行 + 续行缩进）", () => {
    const longLabel = "x".repeat(150);
    const records = [makeRecord({
      eventLog: [{ type: "text_output", label: longLabel, ts: 0 }],
    })];
    const lines = renderView(records, fakeTheme, 50, makeState({ detailMode: true }), 30);
    // 展开视图：150 个 x 会换行成多行（含续行缩进）
    const xLines = lines.filter((l) => l.includes("xxxx"));
    expect(xLines.length).toBeGreaterThan(1);
  });

  it("detailMode scrollOffset 控制可见内容窗口", () => {
    const eventLog = Array.from({ length: 50 }, (_, i) => ({
      type: "tool_end" as const, label: `event-${i}`, ts: i, status: "done" as const,
    }));
    const records = [makeRecord({ eventLog })];
    // 顶部（scrollOffset=0）：应看到 event-0
    const linesAtTop = renderView(records, fakeTheme, 100, makeState({ detailMode: true, scrollOffset: 0 }), 15);
    expect(linesAtTop.some((l) => l.includes("event-0"))).toBe(true);
    // 滚到中段（scrollOffset=60）：event-0 应滚出视口
    const linesAtMid = renderView(records, fakeTheme, 100, makeState({ detailMode: true, scrollOffset: 60 }), 15);
    expect(linesAtMid.some((l) => l.includes("event-0"))).toBe(false);
    // 中段应看到较高编号的 event（event-3x 附近）
    expect(linesAtMid.some((l) => /event-3\d/.test(l))).toBe(true);
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
