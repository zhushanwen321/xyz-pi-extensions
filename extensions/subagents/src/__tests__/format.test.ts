// src/__tests__/format.test.ts
import { describe, expect, it } from "vitest";

import { DEFAULT_CATEGORIES } from "../category.ts";
import {
  extractLabelFromArgs,
  firstLine,
  foldEventLog,
  formatConfigSummary,
  formatEventLogLine,
  formatThinkingLevelOption,
  padVisible,
  truncVisible,
} from "../tui/format.ts";
import type { AgentEventLogEntry, SubagentsGlobalConfig } from "../types.ts";

const cfg: SubagentsGlobalConfig = {
  version: 1, yoloByDefault: false, maxConcurrent: 4,
  categories: { ...DEFAULT_CATEGORIES },
  agentCategoryOverrides: {},
  fallback: { model: "mimo-router/mimo-v2.5", thinkingLevel: "low" },
};

describe("formatConfigSummary", () => {
  it("includes all categories with model + thinkingLevel", () => {
    const summary = formatConfigSummary(cfg, false);
    expect(summary).toContain("coding");
    expect(summary).toContain("deepseek-router/ds-flash");
    expect(summary).toContain("research");
    expect(summary).toContain("YOLO: OFF");
  });

  it("shows YOLO status", () => {
    expect(formatConfigSummary(cfg, true)).toContain("YOLO: ON");
    expect(formatConfigSummary(cfg, false)).toContain("YOLO: OFF");
  });

  it("shows maxConcurrent", () => {
    expect(formatConfigSummary(cfg, false)).toContain("4");
  });
});

describe("formatThinkingLevelOption", () => {
  it("formats level with description", () => {
    expect(formatThinkingLevelOption("high")).toBe("high — 深度推理，耗时较长");
    expect(formatThinkingLevelOption("xhigh")).toBe("xhigh — 最深度推理，耗时最长");
    expect(formatThinkingLevelOption("off")).toBe("off — 不使用推理");
  });
});

const fakeTheme = {
  fg(_token: string, text: string): string { return text; },
  bold(text: string): string { return `**${text}**`; },
};

describe("extractLabelFromArgs", () => {
  it("returns toolName when args is null/undefined", () => {
    expect(extractLabelFromArgs("read", null)).toBe("read");
    expect(extractLabelFromArgs("read", undefined)).toBe("read");
  });

  it("extracts path for read/write/edit", () => {
    expect(extractLabelFromArgs("read", { path: "extensions/foo/bar.ts" })).toBe("read bar.ts");
    expect(extractLabelFromArgs("write", { path: "/abs/path/file.md" })).toBe("write file.md");
  });

  it("extracts command for bash (truncated to 60 with …)", () => {
    // P1#2: 改用 truncVisible（grapheme-safe）替代 .slice——截断结果带 … 标记，
    // 让用户知道命令被截断（原 .slice 静默丢弃尾部，无视觉提示）。
    const long = "x".repeat(80);
    const result = extractLabelFromArgs("bash", { command: long });
    expect(result).toBe(`bash ${"x".repeat(59)}…`);
  });

  it("extracts query/url for web_*", () => {
    expect(extractLabelFromArgs("web_search", { query: "monorepo" })).toBe("web_search monorepo");
    expect(extractLabelFromArgs("web_fetch", { url: "https://example.com" })).toBe("web_fetch https://example.com");
  });

  it("returns toolName for unknown tool", () => {
    expect(extractLabelFromArgs("custom_tool", { foo: "bar" })).toBe("custom_tool");
  });
});

describe("formatEventLogLine", () => {
  it("formats tool_start with label only (no running marker)", () => {
    const entry: AgentEventLogEntry = { type: "tool_start", label: "read foo.ts", ts: 0, status: "running" };
    const line = formatEventLogLine(entry, fakeTheme);
    expect(line).toContain("read foo.ts");
    expect(line).not.toContain("running"); // FR-2.1: tool_start 无标记
  });

  it("formats tool_end done with ✓", () => {
    const entry: AgentEventLogEntry = { type: "tool_end", label: "edit bar.ts", ts: 0, status: "done" };
    const line = formatEventLogLine(entry, fakeTheme);
    expect(line).toContain("edit bar.ts");
    expect(line).toContain("✓");
  });

  it("formats tool_end failed with ✗", () => {
    const entry: AgentEventLogEntry = { type: "tool_end", label: "bash npm test", ts: 0, status: "failed" };
    const line = formatEventLogLine(entry, fakeTheme);
    expect(line).toContain("✗");
  });

  it("formats turn_end with turn number and summary", () => {
    const entry: AgentEventLogEntry = { type: "turn_end", label: "Fixed the handler", ts: 0 };
    const line = formatEventLogLine(entry, fakeTheme, 3);
    expect(line).toContain("turn 3");
    expect(line).toContain("Fixed the handler");
  });

  // ── 类型图标语义（2026-06-17：› 工具 / > 输出 / · thinking，替代 ⎿ 前缀）──

  it("tool_start / tool_end 用 › 图标（不再用 ⎿ 前缀）", () => {
    const start: AgentEventLogEntry = { type: "tool_start", label: "read foo.ts", ts: 0, status: "running" };
    const end: AgentEventLogEntry = { type: "tool_end", label: "read foo.ts", ts: 0, status: "done" };
    expect(formatEventLogLine(start, fakeTheme)).toContain("› read foo.ts");
    expect(formatEventLogLine(end, fakeTheme)).toContain("› read foo.ts");
    expect(formatEventLogLine(start, fakeTheme)).not.toContain("⎿");
  });

  it("text_output 用 > 图标", () => {
    const entry: AgentEventLogEntry = { type: "text_output", label: "All done", ts: 0 };
    expect(formatEventLogLine(entry, fakeTheme)).toContain("> All done");
  });

  it("thinking 用 · 图标（整行 dim）", () => {
    const entry: AgentEventLogEntry = { type: "thinking", label: "analyzing", ts: 0 };
    const line = formatEventLogLine(entry, fakeTheme);
    expect(line).toContain("· analyzing");
    expect(line).not.toContain("⎿");
  });
});

// ============================================================
// P1#2: truncVisible / padVisible（grapheme-safe 宽度工具）
// ============================================================

describe("truncVisible (P1#2)", () => {
  it("不截断短于 maxWidth 的字符串", () => {
    expect(truncVisible("abc", 5)).toBe("abc");
    expect(truncVisible("", 5)).toBe("");
  });

  it("ASCII 截断加 …", () => {
    expect(truncVisible("abcdef", 4)).toBe("abc…");
  });

  it("maxWidth <= 1 边界", () => {
    expect(truncVisible("ab", 1)).toBe("…");
    // maxWidth=0：visibleWidth("ab")=2 > 0 触发截断，但 target=max(0,-1) 分支
    // maxWidth <= 1 → 返回 …（与真实 pi-tui 的 grapheme 边界一致：无法容纳内容只留省略号）
    expect(truncVisible("ab", 0)).toBe("…");
  });

  it("grapheme-safe：emoji 不被劈半（核心契约）", () => {
    // 核心断言：截断结果不含半截代理对/半截 ZWJ 序列。
    // 无论 mock 的宽度模型如何，truncVisible 按 Intl.Segmenter grapheme 切分，
    // 不会在 grapheme cluster 内部断开。用「不含孤立代理项」验证而非精确字符串。
    const result = truncVisible("👨‍👩‍👧abcdefgh", 5);
    // 不应出现孤立高代理项（高代理项后必须跟低代理项）
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    // 不应出现孤立低代理项
    expect(result).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    // 不应出现孤立的 ZWJ（\u200d 前后应有 emoji code point）
    // 如果 grapheme 被劈半，会留下 …\u200d 或 \u200d… 这类残片
    expect(result.endsWith("…")).toBe(true);
  });

  it("grapheme-safe：CJK 字符在 grapheme 边界切", () => {
    // CJK 每字符 2 列（mock 与真实 pi-tui 一致），… = 1 列。
    // "中文测试" (8 列) 截断到 maxWidth=5：target=4 → 2 字符(4 列) + …(1) = 5
    expect(truncVisible("中文测试", 5)).toBe("中文…");
    // maxWidth=3：target=2 → 1 字符(2 列) + …(1) = 3
    expect(truncVisible("中文测试", 3)).toBe("中…");
  });

  it("无游离 ANSI（字面位置 == 可见位置）", () => {
    // truncVisible 的核心契约：输出不含 ANSI 转义码，
    // 这样后续 indexOf / padVisible 列对齐不会错位（见 TUI 指南 §第二部分.2）。
    const result = truncVisible("abcdefgh", 4);
    expect(result).not.toMatch(/\x1b\[/); // 无 CSI 转义
  });
});

describe("padVisible (P1#2)", () => {
  it("右侧补空格到目标宽度", () => {
    expect(padVisible("ab", 5)).toBe("ab   ");
  });

  it("已达/超目标宽度时不补", () => {
    expect(padVisible("abcde", 5)).toBe("abcde");
    expect(padVisible("abcdef", 5)).toBe("abcdef");
  });

  it("ANSI-safe：不把转义码算进宽度", () => {
    // 假设 visibleWidth 正确剥离 ANSI（mock + 真实 pi-tui 都这么做）
    // 这里只验证纯文本场景的行为稳定
    expect(padVisible("中", 4)).toBe("中  "); // 中=2 列，补 2 空格到 4
  });
});

describe("extractLabelFromArgs — bash emoji 安全截断 (P1#2)", () => {
  it("bash 命令含 emoji 在 grapheme 边界截断（无半截代理对）", () => {
    // 构造超长含 emoji 的 bash 命令，验证截断结果不含半截代理对（\uD83D 是 emoji 高代理项前缀）
    const emojiCmd = "echo 😂".repeat(30); // 远超 BASH_CMD_MAX=60
    const label = extractLabelFromArgs("bash", { command: emojiCmd });
    expect(label.startsWith("bash ")).toBe(true);
    expect(label.endsWith("…")).toBe(true);
    // 不应出现孤立的高代理项（\uD83D）或低代理项——说明没有劈半代理对
    expect(label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // 高代理项后非低代理项
    expect(label).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/); // 低代理项前非高代理项
  });
});

// ============================================================
// foldEventLog / firstLine（连续 streaming 分片折叠）
// ============================================================

/** 构造 eventLog 条目的简写。 */
function entry(type: AgentEventLogEntry["type"], label: string, ts = 0): AgentEventLogEntry {
  return { type, label, ts } as AgentEventLogEntry;
}

describe("firstLine", () => {
  it("取首个换行前的内容", () => {
    expect(firstLine("第一行\n第二行\n第三行", 100)).toBe("第一行");
  });

  it("无换行时原样返回（超 maxLen 截断）", () => {
    expect(firstLine("abcdef", 100)).toBe("abcdef");
    expect(firstLine("abcdef", 3)).toBe("abc");
  });

  it("处理 \\r\\n 换行", () => {
    expect(firstLine("head\r\ntail", 100)).toBe("head");
  });

  it("首行就超 maxLen 时截断到 maxLen", () => {
    expect(firstLine("x".repeat(150), 100)).toBe("x".repeat(100));
  });
});

describe("foldEventLog — 连续同类分片折叠", () => {
  it("连续 text_output 合并为 1 条（取首条 label）", () => {
    const out = foldEventLog([
      entry("text_output", "第一段"),
      entry("text_output", "第二段"),
      entry("text_output", "第三段"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("text_output");
    expect(out[0]!.label).toBe("第一段");
  });

  it("连续 thinking 合并为 1 条", () => {
    const out = foldEventLog([
      entry("thinking", "想A"),
      entry("thinking", "想B"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("thinking");
    expect(out[0]!.label).toBe("想A");
  });

  it("被 tool 隔开的同类各自成组（text, tool, text → 3 条）", () => {
    const out = foldEventLog([
      entry("text_output", "turn1 输出"),
      entry("text_output", "turn1 续"),
      entry("tool_start", "bash ls"),
      entry("text_output", "turn2 输出"),
    ]);
    expect(out.map((e) => e.label)).toEqual(["turn1 输出", "bash ls", "turn2 输出"]);
  });

  it("tool_start/tool_end/turn_end 原样透传", () => {
    const log = [
      entry("tool_start", "read a"),
      entry("tool_end", "read a"),
      entry("turn_end", ""),
      entry("tool_start", "bash x"),
    ];
    expect(foldEventLog(log)).toEqual(log);
  });

  it("折叠代表行的 label 取首条按换行切首段", () => {
    const out = foldEventLog([
      entry("text_output", "第一行\n第二行"),
      entry("text_output", "续"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe("第一行");
  });

  it("空数组返回空数组", () => {
    expect(foldEventLog([])).toEqual([]);
  });

  it("不修改输入数组（纯函数）", () => {
    const input = [entry("text_output", "a"), entry("text_output", "b")];
    const snapshot = input.map((e) => ({ ...e }));
    foldEventLog(input);
    expect(input).toEqual(snapshot);
    expect(input).toHaveLength(2);
  });

  it("交替类型不误合并（text, thinking, text, thinking → 4 条）", () => {
    const out = foldEventLog([
      entry("text_output", "t1"),
      entry("thinking", "k1"),
      entry("text_output", "t2"),
      entry("thinking", "k2"),
    ]);
    expect(out).toHaveLength(4);
    expect(out.map((e) => e.label)).toEqual(["t1", "k1", "t2", "k2"]);
  });
});
