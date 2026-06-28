// src/__tests__/format.test.ts
import { describe, expect, it } from "vitest";

import {
  formatElapsedSeconds,
  formatTokens,
  formatToolEventPairs,
  padToVisible,
  sanitizeLabel,
  segFillColored,
  shortId,
  spinnerGlyph,
  statusGlyph,
  tailFixedLines,
  truncLine,
} from "../tui/format.ts";
import type { AgentEventLogEntry } from "../types.ts";

// 最小 theme stub：formatToolEventPairs 经 ThemeLike 只调 fg（✓/✗ 着色）。
const theme = {
  fg: (_tag: string, text: string) => `<${_tag}>${text}</>`,
  bg: (_tag: string, text: string) => text,
  bold: (text: string) => text,
  underline: (text: string) => text,
} as const;

// ============================================================
// formatTokens
// ============================================================
describe("formatTokens", () => {
  it("shows plain value below 1000", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(820)).toBe("820");
    expect(formatTokens(999)).toBe("999");
  });

  it("shows N.Nk between 1000 and 9999", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(8200)).toBe("8.2k");
    expect(formatTokens(9999)).toBe("10.0k");
  });

  it("shows rounded Nk at 10000+", () => {
    expect(formatTokens(10000)).toBe("10k");
    expect(formatTokens(23000)).toBe("23k");
    expect(formatTokens(99999)).toBe("100k");
  });
});

// ============================================================
// formatElapsedSeconds
// ============================================================
describe("formatElapsedSeconds", () => {
  it("shows Xs below 60", () => {
    expect(formatElapsedSeconds(0)).toBe("0s");
    expect(formatElapsedSeconds(12)).toBe("12s");
    expect(formatElapsedSeconds(59)).toBe("59s");
  });

  it("shows Xm Ys between 60 and 3599", () => {
    expect(formatElapsedSeconds(60)).toBe("1m0s");
    expect(formatElapsedSeconds(72)).toBe("1m12s");
    expect(formatElapsedSeconds(3599)).toBe("59m59s");
  });

  it("shows Xh Ym at 3600+", () => {
    expect(formatElapsedSeconds(3600)).toBe("1h0m");
    expect(formatElapsedSeconds(3661)).toBe("1h1m");
    expect(formatElapsedSeconds(7325)).toBe("2h2m");
  });
});

// ============================================================
// statusGlyph
// ============================================================
describe("statusGlyph", () => {
  it("running → no icon, accent color", () => {
    expect(statusGlyph("running")).toEqual({ icon: undefined, color: "accent" });
  });

  it("done → checkmark, success", () => {
    expect(statusGlyph("done")).toEqual({ icon: "✓", color: "success" });
  });

  it("failed → cross, error", () => {
    expect(statusGlyph("failed")).toEqual({ icon: "✗", color: "error" });
  });

  it("cancelled → square, muted", () => {
    expect(statusGlyph("cancelled")).toEqual({ icon: "■", color: "muted" });
  });
});

// ============================================================
// spinnerGlyph
// ============================================================
describe("spinnerGlyph", () => {
  it("returns a frame for valid seed", () => {
    expect(spinnerGlyph(0)).toBe("⠋");
    expect(spinnerGlyph(1)).toBe("⠙");
    expect(spinnerGlyph(9)).toBe("⠏");
  });

  it("wraps around (mod 10)", () => {
    expect(spinnerGlyph(10)).toBe("⠋");
    expect(spinnerGlyph(15)).toBe("⠴"); // index 5
  });

  it("falls back to frame 0 on NaN", () => {
    expect(spinnerGlyph(NaN)).toBe("⠋");
  });

  it("handles negative seeds via abs", () => {
    expect(spinnerGlyph(-1)).toBe("⠙"); // abs(-1) % 10 = 1 → ⠙
    expect(spinnerGlyph(-10)).toBe("⠋");
  });

  it("falls back to frame 0 on Infinity", () => {
    expect(spinnerGlyph(Infinity)).toBe("⠋");
  });
});

// ============================================================
// sanitizeLabel
// ============================================================
describe("sanitizeLabel", () => {
  it("replaces CRLF/LF with single space", () => {
    expect(sanitizeLabel("line1\r\nline2\nline3")).toBe("line1 line2 line3");
  });

  it("replaces tabs with 2 spaces", () => {
    expect(sanitizeLabel("a\tb")).toBe("a  b");
  });

  it("collapses multiple consecutive newlines into one space", () => {
    // /[\r\n]+/g treats \r\n\r\n as one match → single space
    expect(sanitizeLabel("a\r\n\r\nb")).toBe("a b");
  });

  it("leaves clean text unchanged", () => {
    expect(sanitizeLabel("read foo.ts")).toBe("read foo.ts");
  });
});

// ============================================================
// padToVisible
// ============================================================
describe("padToVisible", () => {
  it("pads short text to width with trailing spaces", () => {
    expect(padToVisible("ab", 5)).toBe("ab   ");
  });

  it("returns unchanged when already at width", () => {
    expect(padToVisible("hello", 5)).toBe("hello");
  });

  it("returns unchanged when wider than width", () => {
    expect(padToVisible("hello world", 5)).toBe("hello world");
  });

  it("handles CJK width (2 columns per char)", () => {
    // 你好 = 4 visible columns
    expect(padToVisible("你好", 6)).toBe("你好  ");
  });
});

// ============================================================
// segFillColored
// ============================================================
describe("segFillColored", () => {
  it("returns empty string for width <= 0", () => {
    expect(segFillColored("title", "-", 0)).toBe("");
    expect(segFillColored("title", "-", -1)).toBe("");
  });

  it("pure fill when no title", () => {
    expect(segFillColored(undefined, "-", 5)).toBe("-----");
  });

  it("title + fill to width", () => {
    expect(segFillColored("Hi", "-", 5)).toBe("Hi---");
  });

  it("truncates title when wider than width", () => {
    const result = segFillColored("Hello World", "-", 5);
    // title visible width 11 > 5 → truncated to 5 (with ellipsis = 4 chars + …)
    expect(result.length).toBeLessThanOrEqual(10); // visible width 5 but may include ANSI
  });

  it("preserves ANSI in title and fill separately (no nesting color loss)", () => {
    const redTitle = "\x1b[31mHi\x1b[0m";
    const blueFill = "\x1b[34m-\x1b[0m";
    const result = segFillColored(redTitle, blueFill, 5);
    // title visible width = 2 ("Hi"), fill count = 3
    expect(result).toContain(redTitle);
    expect(result).toContain(blueFill);
    // fill repeated 3 times
    expect(result).toBe(redTitle + blueFill + blueFill + blueFill);
  });
});

// ============================================================
// truncLine
// ============================================================
describe("truncLine", () => {
  it("returns text unchanged when within width", () => {
    expect(truncLine("hello", 10)).toBe("hello");
    expect(truncLine("hello", 5)).toBe("hello");
  });

  it("returns empty string for width <= 0", () => {
    expect(truncLine("hello", 0)).toBe("");
  });

  it("truncates with ellipsis when exceeding width", () => {
    const result = truncLine("hello world", 8);
    expect(result.endsWith("…")).toBe(true);
    // visible width should be 8 (7 chars + ellipsis)
  });

  it("handles CJK characters (2 columns each)", () => {
    // 你好世界 = 8 visible columns; truncate to 5 → 2 chars (4 cols) + …
    const result = truncLine("你好世界", 5);
    expect(result.endsWith("…")).toBe(true);
  });

  it("handles emoji correctly", () => {
    const result = truncLine("😀😁😂🤣😃", 3);
    expect(result.endsWith("…")).toBe(true);
  });

  it("reapplies active ANSI styles before ellipsis (no background break)", () => {
    // red text that exceeds width → ellipsis should have red re-applied
    const input = "\x1b[31mhello world this is long\x1b[0m";
    const result = truncLine(input, 10);
    expect(result.endsWith("…")).toBe(true);
    // The ellipsis should be preceded by the active red style (re-applied)
    // Check that the last grapheme sequence includes the red SGR before …
    expect(result).toMatch(/\x1b\[31m…$/);
  });

  it("clears style stack on reset code", () => {
    // text with reset in the middle → after reset, no style re-applied
    const input = "\x1b[31mab\x1b[0mcdefghijk";
    const result = truncLine(input, 6);
    expect(result.endsWith("…")).toBe(true);
  });
});

// ============================================================
// formatToolEventPairs — tool_start/tool_end 配对折叠成单行
// ============================================================
describe("formatToolEventPairs", () => {
  /** 构造 tool_start 条目。 */
  const ts = (label: string, ts = 1000): AgentEventLogEntry =>
    ({ type: "tool_start", label, ts, status: "running" });
  /** 构造 tool_end 条目（done/failed）。 */
  const te = (label: string, status: "done" | "failed" = "done", ts = 1000): AgentEventLogEntry =>
    ({ type: "tool_end", label, ts, status });
  /** 构造 turn_end 条目。 */
  const turnEnd = (label = "turn", ts = 2000): AgentEventLogEntry =>
    ({ type: "turn_end", label, ts });
  /** 构造 error 条目。 */
  const err = (label: string, ts = 3000): AgentEventLogEntry =>
    ({ type: "error", label, ts });

  it("已完成 tool(start+end) → 折叠成 1 行，含 ✓，不输出单独 start 行", () => {
    const out = formatToolEventPairs([ts("read x.ts"), te("read x.ts")], theme);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("tool: read x.ts");
    expect(out[0]).toContain("success");
    expect(out[0]).toContain("✓");
  });

  it("failed tool → 折叠成 1 行含 ✗", () => {
    const out = formatToolEventPairs([ts("bash rm"), te("bash rm", "failed")], theme);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("✗");
    expect(out[0]).toContain("error");
  });

  it("running tool(只有 start 无 end) → 1 行无尾标", () => {
    const out = formatToolEventPairs([ts("edit a.ts")], theme);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe("tool: edit a.ts");
    // 无 ✓/✗
    expect(out[0]).not.toContain("✓");
    expect(out[0]).not.toContain("✗");
  });

  it("孤儿 tool_end(无对应 start) → 1 行含尾标", () => {
    // SDK 滞后/外部注入：只发 tool_end
    const out = formatToolEventPairs([te("external tool")], theme);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("✓");
  });

  it("turn_end 原样保留（不折叠）", () => {
    const out = formatToolEventPairs([turnEnd("result text")], theme);
    expect(out).toHaveLength(1);
    // turn_end 渲染成 ── turn ──（dim 色），不含 turn 文本 label
    expect(out[0]).toContain("turn");
  });

  it("error 条目原样保留（含 ✗）", () => {
    const out = formatToolEventPairs([err("crashed")], theme);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("crashed");
    expect(out[0]).toContain("✗");
  });

  it("多 tool + turn_end 混合：行数 = tool 数 + turn_end 数（不翻倍）", () => {
    // turn 1: read(完成) + bash(完成)；turn_end
    const entries = [
      ts("read a.ts"), te("read a.ts"),
      ts("bash ls"), te("bash ls"),
      turnEnd(),
    ];
    const out = formatToolEventPairs(entries, theme);
    // 2 个 tool 各 1 行 + 1 个 turn_end = 3 行（旧实现会是 5 行：2*2 tool + 1 turn）
    expect(out).toHaveLength(3);
    expect(out[0]).toContain("read a.ts");
    expect(out[1]).toContain("bash ls");
  });

  it("多 turn 跨界：相邻配对不跨 turn_end 误合并", () => {
    // turn1 的 tool_start 后跟 turn_end（而非 tool_end），再开 turn2 的 tool_end（孤儿）
    const entries = [
      ts("read a.ts"),          // turn1 running tool（无 end）
      turnEnd(),
      te("read a.ts"),          // turn2 孤儿 end（label 同 turn1 的 start，但中间有 turn_end 隔开）
    ];
    const out = formatToolEventPairs(entries, theme);
    // 相邻判定：start 后紧跟 turn_end 不是 tool_end → start 单独输出（无尾标）；
    // 孤儿 end 单独输出（含 ✓）。共 3 行，不误合并成 1 行。
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("tool: read a.ts");    // running start，无尾标
    expect(out[2]).toContain("✓");              // 孤儿 end
  });

  it("空数组 → 空数组", () => {
    expect(formatToolEventPairs([], theme)).toEqual([]);
  });

  it("窗口切片后 start/end 被切断：保守各输出 1 行（不跨窗口误合并）", () => {
    // 完整：[start A, end A, start B, end B]，slice(-1) 只剩 [end B]
    const full = [ts("A"), te("A"), ts("B"), te("B")];
    const window = full.slice(-1);
    const out = formatToolEventPairs(window, theme);
    // 窗口里只有孤儿 end B → 1 行含 ✓，不会因找不到 start 而丢
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("✓");
  });
});

// ============================================================
// tailFixedLines — 固定高度滚动窗口（对齐 bash 行数稳定）
// ============================================================
describe("tailFixedLines", () => {
  it("超过 height → 取尾部 height 行", () => {
    const out = tailFixedLines(["a", "b", "c", "d"], 3, "⎿ ", theme);
    expect(out).toEqual(["b", "c", "d"]);
  });

  it("正好 height → 原样返回", () => {
    const out = tailFixedLines(["a", "b", "c"], 3, "⎿ ", theme);
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("不足 height → pad 到 height 行（pad 行含 prefix，与活动行缩进对齐）", () => {
    const out = tailFixedLines(["a"], 3, "⎿ ", theme);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("a");
    // pad 行 = theme.fg("dim", prefix) = "<dim>⎿ </>"
    expect(out[1]).toBe("<dim>⎿ </>");
    expect(out[2]).toBe("<dim>⎿ </>");
  });

  it("空数组 → 全 pad", () => {
    const out = tailFixedLines([], 3, "⎿ ", theme);
    expect(out).toHaveLength(3);
    expect(out.every((l) => l === "<dim>⎿ </>")).toBe(true);
  });

  it("height <= 0 → 空数组", () => {
    expect(tailFixedLines(["a", "b"], 0, "⎿ ", theme)).toEqual([]);
    expect(tailFixedLines(["a", "b"], -1, "⎿ ", theme)).toEqual([]);
  });

  it("height 1 + 多行 → 仅末行（活动流末尾是最新活动）", () => {
    const out = tailFixedLines(["old", "newer", "newest"], 1, "⎿ ", theme);
    expect(out).toEqual(["newest"]);
  });
});

// ============================================================
// formatToolEventPairs — thinking/text 条目（单源后进 eventLog）
// ============================================================
describe("formatToolEventPairs: thinking/text", () => {
  it("thinking 条目 → `thinking: {label}` 整行 dim", () => {
    const out = formatToolEventPairs(
      [{ type: "thinking", label: "pondering", ts: 1000 }],
      theme,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("<dim>thinking: pondering</>");
  });

  it("text 条目 → `text: {label}`（非 dim）", () => {
    const out = formatToolEventPairs(
      [{ type: "text", label: "writing output", ts: 1000 }],
      theme,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("text: writing output");
    expect(out[0]).not.toContain("<dim>");
  });

  it("tool + thinking 混合：各自 1 行，thinking 不被折叠", () => {
    const out = formatToolEventPairs(
      [
        { type: "tool_start", label: "read x.ts", ts: 1000, status: "running" },
        { type: "tool_end", label: "read x.ts", ts: 1000, status: "done" },
        { type: "thinking", label: "analyzing", ts: 2000 },
      ],
      theme,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("read x.ts");
    expect(out[1]).toContain("thinking: analyzing");
  });
});

// ============================================================
// shortId
// ============================================================
describe("shortId", () => {
  it("returns sync id unchanged (run-N already short)", () => {
    expect(shortId("run-1")).toBe("run-1");
    expect(shortId("run-42")).toBe("run-42");
  });

  it("strips timestamp from background id (bg-N-<ts> → bg-N)", () => {
    expect(shortId("bg-1-1719500000000")).toBe("bg-1");
    expect(shortId("bg-99-1719500123456")).toBe("bg-99");
  });
});
