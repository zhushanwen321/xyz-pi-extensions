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
  it("第1行：glyph + agent + model + thinking（括号分组，· 分隔）", () => {
    const lines = buildRenderLines(makeDetails({ agent: "reviewer", model: "zhipu/glm-4.6", thinkingLevel: "high" }), 80, passthroughTheme);
    // P0: agent name 是视觉焦点（不再有硬编码 "subagent" 标题词）
    expect(lines[0]).toContain("reviewer");
    expect(lines[0]).not.toContain("subagent │");
    // model + thinking 括号分组
    expect(lines[0]).toContain("zhipu/glm-4.6");
    expect(lines[0]).toContain("thinking high");
    expect(lines[0]).toContain("(");
    expect(lines[0]).toContain(")");
  });

  it("第1行：无 thinkingLevel 时不显示 thinking 段", () => {
    const lines = buildRenderLines(makeDetails({ thinkingLevel: undefined }), 80, passthroughTheme);
    expect(lines[0]).not.toContain("thinking");
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
    const labelPart = scrollLine!.replace("├─ ", "").replace("…", "");
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

  it("stats 内联在第 1 行（· 分隔，全零隐藏）", () => {
    const lines = buildRenderLines(makeDetails({ turns: 3, totalTokens: 12300, elapsedSeconds: 45 }), 80, passthroughTheme);
    // P0: stats 现在内联在第 1 行，不再独立第 6 行右对齐
    const header = lines[0]!;
    expect(header).toContain("3 turns");
    expect(header).toContain("12.3k");
    expect(header).toContain("45s");
    expect(header).toContain("·");
  });

  it("stats 全零时不显示（避免 0 turns · 0 · 0s 噪音）", () => {
    const lines = buildRenderLines(makeDetails({ turns: 0, totalTokens: 0, elapsedSeconds: 0 }), 80, passthroughTheme);
    expect(lines[0]).not.toContain("0 turns");
    expect(lines[0]).not.toContain("0s");
  });

  it("running 时最后一行显示 Ctrl+O 提示", () => {
    const lines = buildRenderLines(makeDetails({ status: "running" }), 80, passthroughTheme);
    const lastLine = lines[lines.length - 1]!;
    expect(lastLine).toContain("Ctrl+O");
  });

  it("done 时最后一行无 Ctrl+O 提示（空行保持高度）", () => {
    const lines = buildRenderLines(makeDetails({ status: "done" }), 80, passthroughTheme);
    const lastLine = lines[lines.length - 1]!;
    expect(lastLine).not.toContain("Ctrl+O");
  });

  it("固定 6 行（事件不足时空行填充）", () => {
    const lines = buildRenderLines(makeDetails({
      eventLog: [{ type: "tool_end", label: "only one", ts: 0, status: "done" }],
    }), 80, passthroughTheme);
    expect(lines).toHaveLength(6);
  });

  it("Bug #4: running spinner 由 seed 驱动，不同 turns → 不同帧", () => {
    // seed = turns + totalTokens + elapsedSeconds + eventLog.length
    const frames = new Set<string>();
    for (const turns of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const lines = buildRenderLines(makeDetails({ turns, totalTokens: 0, elapsedSeconds: 0, eventLog: [] }), 80, passthroughTheme);
      frames.add(lines[0]!.trim().charAt(0)!);
    }
    // 至少出现 2 个不同帧（seed 随 turns 变化 → 帧变化）
    expect(frames.size).toBeGreaterThanOrEqual(2);
  });

  it("Bug #4: 全零 details 的 spinner 不为空（seed=0 选帧 0 或静态回退）", () => {
    const lines = buildRenderLines(makeDetails({ turns: 0, totalTokens: 0, elapsedSeconds: 0, eventLog: [] }), 80, passthroughTheme);
    // seed = runningSeed(0,0,0,0) = 0 → 帧 0 = ⠋；passthroughTheme 不着色
    expect(lines[0]).toContain("⠋");
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

describe("Bug #3: truncLine 保留 ANSI 背景色", () => {
  // 用真实 ANSI 序列的 theme：fg 加前景色，bg 加背景色
  const ansiTheme: ThemeLike = {
    bg(color: string, text: string): string {
      // 模拟 48;5;{color}m 背景色
      return `\x1b[48;5;${color}m${text}\x1b[49m`;
    },
    fg(color: string, text: string): string {
      return `\x1b[38;5;${color}m${text}\x1b[39m`;
    },
    bold(text: string): string { return `\x1b[1m${text}\x1b[22m`; },
  };

  it("截断后省略号前重应用 ANSI 样式（不含裸 \\x1b[0m… 断裂）", () => {
    // Bug #3 核心：pi-tui 的 truncateToWidth 在省略号前插 \x1b[0m（全局 reset），
    // 导致 Box 背景色在省略号处断裂。truncLine 应追踪 active styles 并在 … 前重应用。
    // eventLog 行由 formatEventLogLine 套 fg 色，截断时这些 fg 样式必须在 … 前重应用。
    const longLabel = "x".repeat(100);
    const details = makeDetails({
      status: "running",
      eventLog: [{ type: "tool_end", label: longLabel, ts: 0, status: "done" }],
    });
    const lines = buildRenderLines(details, 30, ansiTheme);
    const scrollLine = lines.find((l) => l.includes("…"));
    expect(scrollLine).toBeDefined();
    // 关键断言 1：省略号 … 前不应有裸 \x1b[0m（全局 reset 会清所有样式 + 背景）
    const ellipsisIdx = scrollLine!.indexOf("…");
    const beforeEllipsis = scrollLine!.slice(0, ellipsisIdx);
    expect(beforeEllipsis).not.toMatch(/\x1b\[0m$/);
    expect(beforeEllipsis).not.toMatch(/\x1b\[m$/);
    // 关键断言 2：truncLine 不应产生 "\x1b[0m…" 这类 reset+省略号 模式（全行扫描）
    expect(scrollLine).not.toMatch(/\x1b\[0m…/);
  });

  it("截断后整行可见宽度不超过限制", () => {
    const longLabel = "A".repeat(200);
    const details = makeDetails({
      eventLog: [{ type: "text_output", label: longLabel, ts: 0 }],
    });
    const lines = buildRenderLines(details, 50, ansiTheme);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(50);
    }
  });
});
