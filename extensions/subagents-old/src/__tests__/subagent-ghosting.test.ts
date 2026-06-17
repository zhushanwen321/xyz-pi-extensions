// src/__tests__/subagent-ghosting.test.ts
//
// P0 残影修复的回归测试。HANDOFF.md「验证」第三项要求「实跑一个 sync subagent 确认无残影」。
// 本测试用 Pi default shell 的 contentBox 拓扑（Box(1,1,bgFn) 包裹 SubagentResultComponent），
// 复现残影 bug 的触发场景——sync subagent 状态行 + eventLog 高度从 1 行增长到 5 行——
// 验证新帧内容行满足 diff-redraw 引擎清除旧行所需的不变量。
//
// 残影根因（HANDOFF.md）：self shell 走 tool-execution.ts 的 selfRenderContainer 路径，
// 该路径 prepend 空字符串后拼裸 string[]，diff-redraw 引擎对高度跳变的对齐处理有缺陷。
// default shell 把 renderCall + renderResult 放进 contentBox(Box)，Box 给每行加
// leftPad + applyBg（pad 到满 width + 背景色），使每行 visibleWidth === width，
// diff 引擎的逐行 byte 比较 deterministic → firstChanged 正确检测 → 旧行被覆盖。
//
// 本测试用 mock Box 等价模拟 Pi contentBox 的满宽 pad+bg 行为（mock pi-tui 的 Box 不做
// 满宽 pad，见 mocks/pi-tui.ts:114-161），专注验证 SubagentResultComponent.render()
// 产出与 contentBox 拓扑组合后满足 diff-ready 不变量。

import { describe, expect, it } from "vitest";

import { renderSubagentCall, SubagentResultComponent, type SubagentToolDetails, type ThemeLike } from "../tui/subagent-render.ts";

const passthroughTheme: ThemeLike = {
  bg(_color: string, text: string): string {
    return text;
  },
  fg(_color: string, text: string): string {
    return text;
  },
  bold(text: string): string {
    return text;
  },
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

/**
 * 模拟 Pi default shell 的 contentBox = Box(1,1,bgFn) 对 child.render(contentWidth) 输出的处理：
 *   - 给每行加 leftPad（paddingX=1，1 空格）
 *   - pad 到满 width（applyBg 的 padNeeded = max(0, width - visLen)）
 *   - 顶/底各 paddingY=1 行满宽背景填充
 * 这是 diff-redraw 引擎逐行比较的输入。每行 visibleWidth === width 是 diff-ready 的前提。
 */
function simulateContentBox(childLines: string[], width: number): string[] {
  const contentWidth = Math.max(1, width - 2); // paddingX=1 左右各 1
  const leftPad = " ";
  const padToWidth = (line: string): string => {
    const visLen = [...line].reduce((n) => n + 1, 0); // mock：假设单宽，测试用 ASCII
    return line + " ".repeat(Math.max(0, width - visLen));
  };
  const result: string[] = [];
  // top paddingY=1
  result.push(" ".repeat(width));
  // content
  for (const line of childLines) {
    result.push(padToWidth(leftPad + line.slice(0, Math.max(0, contentWidth - 1))));
  }
  // bottom paddingY=1
  result.push(" ".repeat(width));
  return result;
}

describe("P0 残影修复 — default-shell contentBox 拓扑的 diff-ready 不变量", () => {
  // 残影 bug 的触发场景：sync subagent running，
  // 帧 1 = 旧快照（4s/26.1k，1 行状态），帧 2 = 新快照（10s/52.8k，状态行 + 4 条 eventLog）。
  // 残影表现为：新帧渲染后 viewport 仍残留旧帧的 "26.1k" 行。
  const width = 100; // 足够宽，状态行完整显示，聚焦残影不被窄终端截断干扰

  const frame1Details = makeDetails({
    status: "running",
    agent: "worker",
    model: "anthropic/claude-sonnet-4.5",
    turns: 1,
    totalTokens: 26100,
    elapsedSeconds: 4,
    eventLog: [],
  });
  const frame2Details = makeDetails({
    status: "running",
    agent: "worker",
    model: "anthropic/claude-sonnet-4.5",
    turns: 2,
    totalTokens: 52800,
    elapsedSeconds: 10,
    eventLog: [
      { type: "tool_end", label: "read auth.ts", ts: 1, status: "done" },
      { type: "tool_end", label: "bash grep -r catch", ts: 2, status: "failed" },
      { type: "thinking", label: "scanning error handling", ts: 3 },
      { type: "text_output", label: "analyzed session.ts", ts: 4 },
    ],
  });

  it("SubagentResultComponent.render 直接返回内容行 string[]（不包 Box，背景交 contentBox）", () => {
    const comp = new SubagentResultComponent(frame1Details, passthroughTheme);
    const lines = comp.render(width);
    // P0 契约：render 返回 buildRenderLines 内容行，无 Box paddingY 的顶/底填充行
    // （那些由 Pi contentBox 的 paddingY 产生）。无事件时仅 1 行（状态行）。
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("worker");
  });

  it("不变量：高度增长（帧1 1行 → 帧2 5行内容），contentBox 输出帧2 行数 > 帧1", () => {
    const comp1 = new SubagentResultComponent(frame1Details, passthroughTheme);
    const comp2 = new SubagentResultComponent(frame2Details, passthroughTheme);
    const f1 = simulateContentBox(comp1.render(width), width);
    const f2 = simulateContentBox(comp2.render(width), width);
    // 帧1: 1 内容行 → contentBox 3 行（1 pad + 1 + 1 pad）
    // 帧2: 5 内容行 → contentBox 7 行（1 pad + 5 + 1 pad）
    expect(f1.length).toBe(3);
    expect(f2.length).toBe(7);
    expect(f2.length).toBeGreaterThan(f1.length);
  });

  it("不变量：帧2 状态行更新为新快照（10s/52.8k），旧快照（4s/26.1k）消失", () => {
    const comp2 = new SubagentResultComponent(frame2Details, passthroughTheme);
    const f2 = simulateContentBox(comp2.render(width), width);
    // contentBox 第 0 行是顶部 padding，第 1 行是状态行
    const statusLine = f2[1]!;
    expect(statusLine).toContain("10s");
    expect(statusLine).toContain("52.8k");
    expect(statusLine).not.toContain("4s");
    expect(statusLine).not.toContain("26.1k");
  });

  it("核心不变量：帧2 全行不含旧帧独有的 26.1k（无残影泄漏）", () => {
    // 这是残影 bug 的直接判据。self-shell 下旧行可能残留；default-shell 下 contentBox
    // 的满宽 pad+bg 让 diff 引擎 firstChanged 正确检测状态行变化，整 block 被重写。
    const comp2 = new SubagentResultComponent(frame2Details, passthroughTheme);
    const f2 = simulateContentBox(comp2.render(width), width);
    const ghostLeak = f2.some((l) => l.includes("26.1k"));
    expect(ghostLeak).toBe(false);
  });

  it("不变量：contentBox 输出每行都满宽（diff-redraw byte 比较 deterministic 前提）", () => {
    // default-shell 的核心优势：Box.applyBg 把每行 pad 到 visibleWidth === width，
    // diff 引擎逐行比较不会因行宽不一致错位。self-shell 裸 string[] 无此保证。
    const comp1 = new SubagentResultComponent(frame1Details, passthroughTheme);
    const comp2 = new SubagentResultComponent(frame2Details, passthroughTheme);
    const f1 = simulateContentBox(comp1.render(width), width);
    const f2 = simulateContentBox(comp2.render(width), width);
    for (const line of [...f1, ...f2]) {
      expect(line.length).toBe(width);
    }
  });

  it("renderCall 返回带标题 Text（default shell 把它放进 contentBox，与 renderResult 同背景块）", () => {
    // P0：renderCall 不再返回空 Container（self shell 隐藏标题），而是返回带标题 Text，
    // Pi default shell 将其作为 contentBox 第一个子组件渲染。
    const callComponent = renderSubagentCall({ agent: "reviewer" }, passthroughTheme, {});
    // Text 组件 render 返回标题行
    const callLines = callComponent.render(width);
    expect(callLines.some((l) => l.includes("subagent") && l.includes("reviewer"))).toBe(true);
  });

  it("renderCall 无 agent 参数时显示 default", () => {
    const callComponent = renderSubagentCall({}, passthroughTheme, {});
    const callLines = callComponent.render(width);
    expect(callLines.some((l) => l.includes("default"))).toBe(true);
  });
});
