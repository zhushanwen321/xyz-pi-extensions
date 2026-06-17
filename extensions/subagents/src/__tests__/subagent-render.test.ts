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
    // 图标 `> ` 占 2 列，截断后 label 部分（去掉 `> ` 图标 + 省略号）应 <= 50
    const labelPart = scrollLine!.replace(/^> /, "").replace("…", "");
    expect(labelPart.length).toBeLessThanOrEqual(50);
  });

  it("滚动区行带类型图标（› 工具 / > 输出）", () => {
    const lines = buildRenderLines(makeDetails({
      eventLog: [
        { type: "tool_end", label: "read auth.ts", ts: 0, status: "done" },
        { type: "text_output", label: "scanning files", ts: 0 },
      ],
    }), 80, passthroughTheme);
    // 滚动区行通过类型图标识别：tool_end → `›`，text_output → `>`
    const scrollLines = lines.filter((l) => /^[›>·]/.test(l));
    expect(scrollLines.some((l) => l.startsWith("›") && l.includes("read auth.ts"))).toBe(true);
    expect(scrollLines.some((l) => l.startsWith(">") && l.includes("scanning files"))).toBe(true);
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
    // 滚动区行以类型图标开头（tool_end → `›`）
    const scrollLines = lines.filter((l) => l.startsWith("›"));
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

  it("动态高度：无 Ctrl+O 提示行（已移除 footer）", () => {
    const running = buildRenderLines(makeDetails({ status: "running" }), 80, passthroughTheme);
    const done = buildRenderLines(makeDetails({ status: "done" }), 80, passthroughTheme);
    expect(running.some((l) => l.includes("Ctrl+O"))).toBe(false);
    expect(done.some((l) => l.includes("Ctrl+O"))).toBe(false);
  });

  it("动态高度：无事件 = 1 行（仅状态行）；1 事件 = 2 行；4 事件 = 5 行；>4 截断到 5 行", () => {
    // 无事件：只有状态行
    expect(buildRenderLines(makeDetails({ eventLog: [] }), 80, passthroughTheme)).toHaveLength(1);
    // 1 事件：状态行 + 1
    expect(buildRenderLines(makeDetails({
      eventLog: [{ type: "tool_end", label: "only one", ts: 0, status: "done" }],
    }), 80, passthroughTheme)).toHaveLength(2);
    // 4 事件：状态行 + 4（恰好上限）
    const four = Array.from({ length: 4 }, (_, i) => ({ type: "tool_end" as const, label: `t${i}`, ts: i, status: "done" as const }));
    expect(buildRenderLines(makeDetails({ eventLog: four }), 80, passthroughTheme)).toHaveLength(5);
    // 8 事件：截断到最近 4 条 → 状态行 + 4 = 5
    const eight = Array.from({ length: 8 }, (_, i) => ({ type: "tool_end" as const, label: `t${i}`, ts: i, status: "done" as const }));
    const lines = buildRenderLines(makeDetails({ eventLog: eight }), 80, passthroughTheme);
    expect(lines).toHaveLength(5);
    // 滚动区 4 行以 `›` 工具图标开头
    expect(lines.filter((l) => l.startsWith("›"))).toHaveLength(4);
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
    expect(lines.filter((l) => l.startsWith("›")).length).toBeGreaterThanOrEqual(8);
    expect(lines.some((l) => l.includes("All done."))).toBe(true);
  });
});

describe("P1#3: 实时活动行（compact 视图第 2 行）", () => {
  it("running + currentActivity → 第 2 行是活动行（状态行后、滚动区前）", () => {
    const lines = buildRenderLines(makeDetails({
      status: "running",
      currentActivity: { type: "tool", label: "read auth.ts" },
      eventLog: [{ type: "tool_end", label: "prev tool", ts: 0, status: "done" }],
    }), 80, passthroughTheme);
    // 第 1 行状态行，第 2 行活动行（tool → `›`），第 3 行起 eventLog
    expect(lines[0]).toContain("worker");
    expect(lines[1]).toContain("read auth.ts");
    expect(lines[1]).toMatch(/^›/); // tool 图标
  });

  it("活动行图标按 type 选（tool→›、text→>、thinking→·）", () => {
    const tool = buildRenderLines(makeDetails({ currentActivity: { type: "tool", label: "x" } }), 80, passthroughTheme);
    expect(tool[1]).toMatch(/^›/);
    const text = buildRenderLines(makeDetails({ currentActivity: { type: "text", label: "x" } }), 80, passthroughTheme);
    expect(text[1]).toMatch(/^>/);
    const thinking = buildRenderLines(makeDetails({ currentActivity: { type: "thinking", label: "x" } }), 80, passthroughTheme);
    expect(thinking[1]).toMatch(/^·/);
  });

  it("terminal 态无 currentActivity → 无活动行，回归原布局", () => {
    // makeDetails 默认 currentActivity: undefined
    const done = buildRenderLines(makeDetails({ status: "done", eventLog: [{ type: "tool_end", label: "t", ts: 0, status: "done" }] }), 80, passthroughTheme);
    // 第 1 行状态行，第 2 行直接是 eventLog（无活动行）
    expect(done[0]).toContain("✓");
    expect(done[1]).toContain("t");
    // 显式传 undefined 也应无活动行
    const explicit = buildRenderLines(makeDetails({ status: "running", currentActivity: undefined }), 80, passthroughTheme);
    expect(explicit).toHaveLength(1); // 仅状态行
  });

  it("活动行不计入滚动区配额（独立锚点，4 条 eventLog + 1 活动行 = 6 行）", () => {
    const four = Array.from({ length: 4 }, (_, i) => ({ type: "tool_end" as const, label: `t${i}`, ts: i, status: "done" as const }));
    const lines = buildRenderLines(makeDetails({
      currentActivity: { type: "tool", label: "active" },
      eventLog: four,
    }), 80, passthroughTheme);
    // 状态行(1) + 活动行(1) + 滚动区(4) = 6 行
    expect(lines).toHaveLength(6);
    expect(lines[1]).toContain("active");
    // 滚动区 4 条 t0..t3 仍在（活动行没挤占配额）。精确匹配 tN 避免误中 "active"
    expect(four.every((e) => lines.some((l) => l.includes(`› ${e.label} ✓`)))).toBe(true);
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
    // P0: render 直接返回内容行（背景 + padding 由 Pi default shell 的 contentBox 施加），
    // 无 Box paddingY，状态行就在第 0 行。
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

  it("动态高度：无事件时仅 1 行状态行（背景 + padding 由 Pi default shell 施加，不在本组件）", () => {
    const comp = new SubagentResultComponent(
      makeDetails({ eventLog: [], status: "running" }),
      passthroughTheme,
    );
    const lines = comp.render(80);
    // P0: buildCompactLines 无事件 = 1 行（状态行）；render 直接返回内容行，
    // 顶/底背景填充行由 Pi default shell 的 contentBox(paddingY=1) 施加，不在本组件输出中。
    expect(lines).toHaveLength(1);
  });

  // ── P3#7: render 缓存（同 width 二次 render 返回同引用；变化时失效）──

  it("P3#7: 同 width 二次 render 返回同引用（命中缓存）", () => {
    const comp = new SubagentResultComponent(makeDetails({ turns: 2 }), passthroughTheme);
    const r1 = comp.render(80);
    const r2 = comp.render(80);
    expect(r2).toBe(r1); // 同引用（命中缓存，未重建）
  });

  it("P3#7: 不同 width 重建（缓存失效）", () => {
    const comp = new SubagentResultComponent(makeDetails(), passthroughTheme);
    const r1 = comp.render(80);
    const r2 = comp.render(60);
    expect(r2).not.toBe(r1); // width 变了 → 重建
  });

  it("P3#7: update 后缓存失效（重建）", () => {
    const comp = new SubagentResultComponent(makeDetails({ agent: "worker" }), passthroughTheme);
    comp.render(80);
    comp.update(makeDetails({ agent: "reviewer" }), passthroughTheme);
    const r2 = comp.render(80);
    expect(r2[0]).toContain("reviewer"); // 内容已更新
  });

  it("P3#7: setExpanded 值变化时缓存失效；值未变保留缓存", () => {
    const comp = new SubagentResultComponent(makeDetails(), passthroughTheme);
    const r1 = comp.render(80);
    // 值未变（false → false）→ 不失效
    comp.setExpanded(false);
    expect(comp.render(80)).toBe(r1);
    // 值变化（false → true）→ 失效重建
    comp.setExpanded(true);
    expect(comp.render(80)).not.toBe(r1);
  });

  it("P3#7: invalidate 后缓存失效", () => {
    const comp = new SubagentResultComponent(makeDetails(), passthroughTheme);
    const r1 = comp.render(80);
    comp.invalidate();
    expect(comp.render(80)).not.toBe(r1);
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

// ============================================================
// P1#4: 连续 streaming 分片折叠 + running 去重（方案 A）
// ============================================================
//
// 背景：execution-state.ts 把一段连续 text/thinking 输出按 100 字符切成多个 eventLog 分片。
// 压缩视图若逐条展示，会看到 N 个半句碎片（同一句话的前缀重复 N 次），可读性极差。
// 折叠策略：相邻同类分片 → 1 条首行代表行；running 时活动行已独占「正在输出」，
// 滚动区末条与活动行同类型则去重（方案 A）。

describe("buildRenderLines — 连续分片折叠（压缩视图）", () => {
  it("done 态：连续 text_output 分片折叠为 1 行（不展示重复碎片）", () => {
    // 模拟一段被切成 8 个分片的长输出
    const chunks = Array.from({ length: 8 }, (_, i) => ({
      type: "text_output" as const, label: `分片${i}内容`, ts: i,
    }));
    const lines = buildRenderLines(makeDetails({ status: "done", eventLog: chunks }), 80, passthroughTheme);
    // 只有 1 条 text_output 代表行（图标 `>`），而非 4 条碎片
    const textLines = lines.filter((l) => l.startsWith(">"));
    expect(textLines).toHaveLength(1);
    expect(textLines[0]).toContain("分片0内容");
  });

  it("连续 thinking 分片折叠为 1 行", () => {
    const chunks = Array.from({ length: 5 }, (_, i) => ({
      type: "thinking" as const, label: `推理${i}`, ts: i,
    }));
    const lines = buildRenderLines(makeDetails({ status: "done", eventLog: chunks }), 80, passthroughTheme);
    const thinkingLines = lines.filter((l) => l.startsWith("·"));
    expect(thinkingLines).toHaveLength(1);
    expect(thinkingLines[0]).toContain("推理0");
  });

  it("done 态：text, tool, text 折叠为 3 行（tool 隔开=不同组）", () => {
    const lines = buildRenderLines(makeDetails({
      status: "done",
      eventLog: [
        { type: "text_output", label: "turn1A", ts: 0 },
        { type: "text_output", label: "turn1B", ts: 1 },
        { type: "tool_end", label: "bash", ts: 2, status: "done" },
        { type: "text_output", label: "turn2A", ts: 3 },
        { type: "text_output", label: "turn2B", ts: 4 },
      ],
    }), 80, passthroughTheme);
    const scrollLines = lines.filter((l) => /^[›>·]/.test(l));
    expect(scrollLines.map((l) => l.trim())).toEqual([
      "> turn1A", "› bash ✓", "> turn2A",
    ]);
  });
});

describe("buildRenderLines — running 去重（方案 A）", () => {
  it("running + text 活动行：滚动区不再重复展示末条 text_output 代表行", () => {
    // 末段是连续 text_output（streaming 中），currentActivity 也是 text
    const lines = buildRenderLines(makeDetails({
      status: "running",
      currentActivity: { type: "text", label: "正在输出" },
      eventLog: [
        { type: "tool_end", label: "read", ts: 0, status: "done" },
        { type: "text_output", label: "流A", ts: 1 },
        { type: "text_output", label: "流B", ts: 2 },
      ],
    }), 80, passthroughTheme);
    // 活动行（dim 的 `>`）存在
    expect(lines.some((l) => l.includes("正在输出"))).toBe(true);
    // tool_end 行保留
    expect(lines.some((l) => l.startsWith("›") && l.includes("read"))).toBe(true);
    // 滚动区不应再有 text_output 代表行（末条被去重）——用流内容而非 `>` 前缀判断
    // （活动行也用 `>` 图标，故前缀计数会把活动行算进去）
    expect(lines.some((l) => l.includes("流A"))).toBe(false);
    expect(lines.some((l) => l.includes("流B"))).toBe(false);
  });

  it("running + thinking 活动行：滚动区末条 thinking 代表行去重", () => {
    const lines = buildRenderLines(makeDetails({
      status: "running",
      currentActivity: { type: "thinking", label: "推理中" },
      eventLog: [
        { type: "tool_end", label: "grep", ts: 0, status: "done" },
        { type: "thinking", label: "想A", ts: 1 },
        { type: "thinking", label: "想B", ts: 2 },
      ],
    }), 80, passthroughTheme);
    expect(lines.some((l) => l.includes("推理中"))).toBe(true);
    // 用流内容判断（活动行也用 `·` 图标，前缀计数会误算活动行）
    expect(lines.some((l) => l.includes("想A"))).toBe(false);
    expect(lines.some((l) => l.includes("想B"))).toBe(false);
    expect(lines.some((l) => l.startsWith("›") && l.includes("grep"))).toBe(true);
  });

  it("running + tool 活动行：text/thinking 历史代表行不去重（类型不同）", () => {
    // 活动行是 tool（tool_start），末段 text 历史代表行应保留
    const lines = buildRenderLines(makeDetails({
      status: "running",
      currentActivity: { type: "tool", label: "bash running" },
      eventLog: [
        { type: "text_output", label: "历史输出", ts: 0 },
        { type: "tool_start", label: "bash running", ts: 1, status: "running" },
      ],
    }), 80, passthroughTheme);
    // text 历史代表行保留
    expect(lines.some((l) => l.startsWith(">") && l.includes("历史输出"))).toBe(true);
  });

  it("done 态不做去重（无 currentActivity）", () => {
    const lines = buildRenderLines(makeDetails({
      status: "done",
      eventLog: [
        { type: "text_output", label: "输出A", ts: 0 },
        { type: "text_output", label: "输出B", ts: 1 },
      ],
    }), 80, passthroughTheme);
    // 折叠后 1 条 text_output 代表行保留
    expect(lines.filter((l) => l.startsWith(">"))).toHaveLength(1);
  });
});
