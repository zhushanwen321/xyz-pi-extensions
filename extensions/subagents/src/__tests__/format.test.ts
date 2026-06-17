// src/__tests__/format.test.ts
import { describe, expect, it } from "vitest";

import { DEFAULT_CATEGORIES } from "../category.ts";
import {
  extractLabelFromArgs,
  formatConfigSummary,
  formatEventLogLine,
  formatThinkingLevelOption,
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

  it("extracts command for bash (truncated to 60)", () => {
    const long = "x".repeat(80);
    const result = extractLabelFromArgs("bash", { command: long });
    expect(result).toBe(`bash ${"x".repeat(60)}`);
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
