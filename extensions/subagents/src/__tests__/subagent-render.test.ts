// src/__tests__/subagent-render.test.ts
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { buildRenderLines, SubagentResultComponent, type SubagentToolDetails, type ThemeLike } from "../tui/subagent-render.ts";

const passthroughTheme: ThemeLike = {
  bg(_color: string, text: string): string { return text; },
  fg(_color: string, text: string): string { return text; },
  bold(text: string): string { return text; },
};

function makeDetails(overrides: Partial<SubagentToolDetails> = {}): SubagentToolDetails {
  return {
    eventLog: [],
    status: "running",
    agent: "worker",
    turns: 0,
    totalTokens: 0,
    elapsedSeconds: 0,
    model: "anthropic/claude-sonnet-4.5",
    thinkingLevel: "medium",
    ...overrides,
  };
}

describe("buildRenderLines — 压缩视图（6 行）", () => {
  it("第1行：spinner + subagent + agent + model + thinking", () => {
    const lines = buildRenderLines(makeDetails({ agent: "reviewer", model: "zhipu/glm-4.6", thinkingLevel: "high" }), 80, passthroughTheme);
    expect(lines[0]).toContain("subagent");
    expect(lines[0]).toContain("reviewer");
    expect(lines[0]).toContain("zhipu/glm-4.6");
    expect(lines[0]).toContain("thinking: high");
  });

  it("第1行：无 thinkingLevel 时不显示 thinking 段", () => {
    const lines = buildRenderLines(makeDetails({ thinkingLevel: undefined }), 80, passthroughTheme);
    expect(lines[0]).not.toContain("thinking:");
  });

  it("第1行：done 显示 ✓", () => {
    const lines = buildRenderLines(makeDetails({ status: "done" }), 80, passthroughTheme);
    expect(lines[0]).toContain("✓");
  });

  it("第1行：failed 显示 ✗", () => {
    const lines = buildRenderLines(makeDetails({ status: "failed" }), 80, passthroughTheme);
    expect(lines[0]).toContain("✗");
  });

  it("滚动区长 label 截断到约 50 字符", () => {
    const longLabel = "a".repeat(80);
    const lines = buildRenderLines(makeDetails({
      eventLog: [{ type: "text_output", label: longLabel, ts: 0 }],
    }), 80, passthroughTheme);
    const scrollLine = lines.find((l) => l.includes("a".repeat(10)));
    expect(scrollLine).toBeDefined();
    // prefix "├─ " 占 4 列，截断后 label 部分应 <= 50
    const labelPart = scrollLine!.replace("├─ ", "").replace("...", "");
    expect(labelPart.length).toBeLessThanOrEqual(50);
  });

  it("滚动区行带 ├─ 连接线", () => {
    const lines = buildRenderLines(makeDetails({
      eventLog: [
        { type: "tool_end", label: "read auth.ts", ts: 0, status: "done" },
        { type: "text_output", label: "scanning files", ts: 0 },
      ],
    }), 80, passthroughTheme);
    const scrollLines = lines.slice(1, 5);
    expect(scrollLines.some((l) => l.includes("├─"))).toBe(true);
  });

  it("tool_end 带 ✓ 或 ✗", () => {
    const lines = buildRenderLines(makeDetails({
      eventLog: [
        { type: "tool_end", label: "read ok", ts: 0, status: "done" },
        { type: "tool_end", label: "bash fail", ts: 0, status: "failed" },
      ],
    }), 80, passthroughTheme);
    expect(lines.some((l) => l.includes("read ok") && l.includes("✓"))).toBe(true);
    expect(lines.some((l) => l.includes("bash fail") && l.includes("✗"))).toBe(true);
  });

  it("tool_start 无 ⏳ 标记", () => {
    const lines = buildRenderLines(makeDetails({
      eventLog: [{ type: "tool_start", label: "read foo.ts", ts: 0, status: "running" }],
    }), 80, passthroughTheme);
    const toolLine = lines.find((l) => l.includes("read foo.ts"));
    expect(toolLine).toBeDefined();
    expect(toolLine!).not.toContain("⏳");
  });

  it("只显示最近 4 条事件", () => {
    const eventLog = Array.from({ length: 8 }, (_, i) => ({
      type: "tool_end" as const, label: `tool-${i}`, ts: i, status: "done" as const,
    }));
    const lines = buildRenderLines(makeDetails({ eventLog }), 80, passthroughTheme);
    const scrollLines = lines.filter((l) => l.includes("├─"));
    expect(scrollLines).toHaveLength(4);
    expect(scrollLines[0]).toContain("tool-4");
    expect(scrollLines[3]).toContain("tool-7");
  });

  it("thinking 行显示", () => {
    const lines = buildRenderLines(makeDetails({
      eventLog: [{ type: "thinking", label: "analyzing the structure", ts: 0 }],
    }), 80, passthroughTheme);
    expect(lines.some((l) => l.includes("analyzing the structure"))).toBe(true);
  });

  it("最后一行 stats 右对齐", () => {
    const lines = buildRenderLines(makeDetails({ turns: 3, totalTokens: 12300, elapsedSeconds: 45 }), 80, passthroughTheme);
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toContain("3 turns");
    expect(lastLine).toContain("12.3k");
    expect(lastLine).toContain("45s");
    expect(lastLine.startsWith(" ")).toBe(true);
  });

  it("固定 6 行（事件不足时空行填充）", () => {
    const lines = buildRenderLines(makeDetails({
      eventLog: [{ type: "tool_end", label: "only one", ts: 0, status: "done" }],
    }), 80, passthroughTheme);
    expect(lines).toHaveLength(6);
  });
});

describe("buildRenderLines — 展开视图", () => {
  it("expanded=true 时显示全部 eventLog + result", () => {
    const eventLog = Array.from({ length: 8 }, (_, i) => ({
      type: "tool_end" as const, label: `tool-${i}`, ts: i, status: "done" as const,
    }));
    const lines = buildRenderLines(makeDetails({
      status: "done", eventLog, result: "All done.",
    }), 80, passthroughTheme, { expanded: true });
    expect(lines.filter((l) => l.includes("├─")).length).toBeGreaterThanOrEqual(8);
    expect(lines.some((l) => l.includes("All done."))).toBe(true);
  });
});

describe("SubagentResultComponent", () => {
  it("renders with background", () => {
    const comp = new SubagentResultComponent(makeDetails({ turns: 2, totalTokens: 5000, elapsedSeconds: 30 }), passthroughTheme);
    const lines = comp.render(80);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("update + re-render", () => {
    const comp = new SubagentResultComponent(makeDetails({ agent: "worker" }), passthroughTheme);
    comp.update(makeDetails({ agent: "reviewer", turns: 5 }));
    const lines = comp.render(80);
    expect(lines[0]).toContain("reviewer");
  });

  it("truncates long lines to width", () => {
    const longLabel = "A".repeat(10_000);
    const comp = new SubagentResultComponent(
      makeDetails({ eventLog: [{ type: "text_output", label: longLabel, ts: 0 }] }),
      passthroughTheme,
    );
    const width = 60;
    const lines = comp.render(width);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("always renders 6 lines in compact mode", () => {
    const comp = new SubagentResultComponent(
      makeDetails({ eventLog: [{ type: "tool_end", label: "only one", ts: 0, status: "done" }] }),
      passthroughTheme,
    );
    const lines = comp.render(80);
    expect(lines).toHaveLength(6);
  });
});
