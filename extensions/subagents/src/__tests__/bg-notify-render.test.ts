// src/__tests__/bg-notify-render.test.ts
//
// background 完成通知的渲染测试。
//
// 核心契约：renderBgNotifyMessage 必须返回 Box(customMessageBg)——
// Pi 的 CustomMessageComponent 对 customRenderer 返回值是「裸 addChild」，
// 返回裸 Text 会丢失紫色背景。本测试钉死「施加 customMessageBg」这一行为。
//
// 测试用 mock theme（bg 记录调用色 token），不依赖真实 Pi Theme。

import { Box } from "@earendil-works/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { renderBgNotifyMessage } from "../tui/bg-notify-render.ts";

/** 构造 mock theme：bg 记录被调用的色 token，fg/bold 透传文本。 */
function makeTheme(): { theme: Theme; bgColors: string[] } {
  const bgColors: string[] = [];
  const theme = {
    fg: (_tag: string, text: string) => text,
    bold: (text: string) => text,
    bg: (color: string, text: string) => {
      bgColors.push(color);
      return text;
    },
  };
  return { theme: theme as unknown as Theme, bgColors };
}

describe("renderBgNotifyMessage", () => {
  it("单条 done → Box 实例 + 施加 customMessageBg + 内容可见", () => {
    const { theme, bgColors } = makeTheme();
    const comp = renderBgNotifyMessage(
      { details: { status: "done", agent: "worker", id: "bg-1", result: "All green" } },
      { expanded: false },
      theme,
    );

    expect(comp).toBeInstanceOf(Box);
    const lines = comp!.render(80);
    const joined = lines.join("\n");
    // 紫色背景施加（paddingY=1 上下各 1 + content 行 ≥ 3 次）
    expect(bgColors.filter((c) => c === "customMessageBg").length).toBeGreaterThanOrEqual(3);
    // 前景内容仍在
    expect(joined).toContain("worker");
    expect(joined).toContain("All green");
    expect(joined).toContain("bg-1");
  });

  it("单条 failed → 内容含 Error + agent", () => {
    const { theme } = makeTheme();
    const comp = renderBgNotifyMessage(
      { details: { status: "failed", agent: "scout", id: "bg-2", error: "boom" } },
      { expanded: false },
      theme,
    );
    expect(comp).toBeInstanceOf(Box);
    const joined = comp!.render(80).join("\n");
    expect(joined).toContain("scout");
    expect(joined).toContain("Error");
    expect(joined).toContain("boom");
  });

  it("批量 → Box 施加 customMessageBg，每条 agent 可见", () => {
    const { theme, bgColors } = makeTheme();
    const comp = renderBgNotifyMessage(
      {
        details: {
          batch: true,
          items: [
            { status: "done", agent: "alpha", id: "1", result: "r1" },
            { status: "failed", agent: "beta", id: "2", error: "e2" },
          ],
        },
      },
      { expanded: false },
      theme,
    );
    expect(comp).toBeInstanceOf(Box);
    const joined = comp!.render(80).join("\n");
    expect(bgColors).toContain("customMessageBg");
    expect(joined).toContain("alpha");
    expect(joined).toContain("beta");
  });

  it("cancelled → 内容含 cancelled", () => {
    const { theme } = makeTheme();
    const comp = renderBgNotifyMessage(
      { details: { status: "cancelled", agent: "w", id: "bg-3" } },
      { expanded: false },
      theme,
    );
    expect(comp).toBeInstanceOf(Box);
    expect(comp!.render(80).join("\n")).toContain("cancelled");
  });

  it("details 缺失/结构不全 → undefined（走 Pi 默认渲染兜底）", () => {
    const { theme } = makeTheme();
    expect(renderBgNotifyMessage({ details: undefined }, { expanded: false }, theme)).toBeUndefined();
    expect(renderBgNotifyMessage({ details: { foo: 1 } }, { expanded: false }, theme)).toBeUndefined();
    // 缺 status / agent
    expect(
      renderBgNotifyMessage({ details: { id: "x", agent: "w" } }, { expanded: false }, theme),
    ).toBeUndefined();
    expect(
      renderBgNotifyMessage({ details: { status: "done", id: "x" } }, { expanded: false }, theme),
    ).toBeUndefined();
  });

  it("details 无效时不施加任何背景（兜底路径不应泄漏背景色）", () => {
    const { theme, bgColors } = makeTheme();
    renderBgNotifyMessage({ details: undefined }, { expanded: false }, theme);
    expect(bgColors).not.toContain("customMessageBg");
  });

  // ── model 显示（task 5）──

  it("record 带 model → 内容含 model 字符串（agent 后、状态描述前）", () => {
    const { theme } = makeTheme();
    const comp = renderBgNotifyMessage(
      { details: { status: "done", agent: "general-purpose", model: "anthropic/sonnet-4-5", id: "bg-1", result: "ok" } },
      { expanded: false },
      theme,
    );
    const joined = comp!.render(80).join("\n");
    expect(joined).toContain("anthropic/sonnet-4-5");
    // agent 和状态仍在
    expect(joined).toContain("general-purpose");
    expect(joined).toContain("finished");
  });

  it("record 无 model → 向后兼容，不渲染 model 段不崩", () => {
    const { theme } = makeTheme();
    const comp = renderBgNotifyMessage(
      { details: { status: "done", agent: "worker", id: "bg-2", result: "r" } },
      { expanded: false },
      theme,
    );
    const joined = comp!.render(80).join("\n");
    expect(joined).toContain("worker");
    expect(joined).toContain("finished");
  });
});
