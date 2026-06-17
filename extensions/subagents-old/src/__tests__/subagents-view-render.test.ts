// src/__tests__/subagents-view-render.test.ts
//
// /subagents list 视图纯渲染层（renderView）的测试。
// 从 subagents-view.test.ts 拆出——renderView / renderDetailView 是纯函数（无 runtime 依赖），
// 归 subagents-view-render.ts；数据合并 / 按键 / 工厂测试留在 subagents-view.test.ts。
// 这样两文件都 < 500 行（githook 建议值）。

import { describe, expect, it } from "vitest";

import type { ThemeLike } from "../tui/format.ts";
import type { SubagentRecord, ViewState } from "../tui/subagents-view-render.ts";
import { renderView } from "../tui/subagents-view-render.ts";

const fakeTheme: ThemeLike = {
  bg(_t: string, text: string): string { return text; },
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

  it("分屏右列折叠连续 text_output 分片为 1 行（与对话流一致）", () => {
    // 模拟一段被切成多个分片的长输出（如 streaming delta 按 100 字符切分）
    const records = [makeRecord({
      eventLog: [
        { type: "text_output", label: "第一段开头", ts: 0 },
        { type: "text_output", label: "第一段续", ts: 1 },
        { type: "text_output", label: "第一段尾", ts: 2 },
        { type: "text_output", label: "更多", ts: 3 },
      ],
    })];
    const lines = renderView(records, fakeTheme, 100, makeState(), 30);
    // 只有 1 条 text_output 代表行（图标 `>`），而非 4 条碎片
    const textLines = lines.filter((l) => l.includes(">") && l.includes("第一段开头"));
    expect(textLines).toHaveLength(1);
    // 后续分片 label 不应出现
    expect(lines.some((l) => l.includes("第一段尾"))).toBe(false);
    expect(lines.some((l) => l.includes("更多"))).toBe(false);
  });

  it("分屏右列折叠连续 thinking 分片为 1 行", () => {
    const records = [makeRecord({
      eventLog: [
        { type: "thinking", label: "推理A", ts: 0 },
        { type: "thinking", label: "推理B", ts: 1 },
      ],
    })];
    const lines = renderView(records, fakeTheme, 100, makeState(), 30);
    const thinkingLines = lines.filter((l) => l.includes("·") && l.includes("推理A"));
    expect(thinkingLines).toHaveLength(1);
    expect(lines.some((l) => l.includes("推理B"))).toBe(false);
  });

  it("分屏右列：tool 隔开的同类各自成组", () => {
    const records = [makeRecord({
      eventLog: [
        { type: "text_output", label: "turn1A", ts: 0 },
        { type: "text_output", label: "turn1B", ts: 1 },
        { type: "tool_end", label: "bash", ts: 2, status: "done" },
        { type: "text_output", label: "turn2A", ts: 3 },
      ],
    })];
    const lines = renderView(records, fakeTheme, 100, makeState(), 30);
    expect(lines.some((l) => l.includes("turn1A"))).toBe(true);
    expect(lines.some((l) => l.includes("bash"))).toBe(true);
    expect(lines.some((l) => l.includes("turn2A"))).toBe(true);
    // 被折叠掉的分片不出现
    expect(lines.some((l) => l.includes("turn1B"))).toBe(false);
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

  it("detailMode 不折叠——连续分片各自展示（与压缩视图区分）", () => {
    // 全屏视图按需求 1：允许展开多行、自动换行，不做首行折叠
    const records = [makeRecord({
      eventLog: [
        { type: "text_output", label: "片段一", ts: 0 },
        { type: "text_output", label: "片段二", ts: 1 },
        { type: "text_output", label: "片段三", ts: 2 },
      ],
    })];
    const lines = renderView(records, fakeTheme, 100, makeState({ detailMode: true }), 30);
    // 三个分片都应出现（未折叠）
    expect(lines.some((l) => l.includes("片段一"))).toBe(true);
    expect(lines.some((l) => l.includes("片段二"))).toBe(true);
    expect(lines.some((l) => l.includes("片段三"))).toBe(true);
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
