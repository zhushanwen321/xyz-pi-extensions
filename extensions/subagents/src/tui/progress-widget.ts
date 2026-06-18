// src/tui/progress-widget.ts
//
// belowEditor 常驻进度 widget。有 subagent 运行时显示计数 + /subagents list 指引。
// count=0 时 render 返回 [] 不占位。
//
// background 执行进度无法回流到对话流 tool block（SDK onUpdate 生命周期限制），
// 此 widget 作为可观测性补偿。
//
// 设计（pi-tui-development-guide.md）：
//   - 不设 renderShell，背景色归 Pi shell（widget 路径下不施加背景色）
//   - 所有输出行经 truncLine（ANSI 安全）
//   - count=0 必须返回 []（空数组），否则会在 belowEditor 留空行

import type { Component } from "@earendil-works/pi-tui";

import type { SubagentHub } from "../runtime/subagent-hub.ts";
import { type ThemeLike,truncLine } from "./format.ts";

/**
 * 进度 widget。factory 只在 setWidget 时执行一次，
 * 返回的持久组件订阅 hub.onChange 驱动重渲。
 *
 *   constructor(hub, theme, tui):
 *     hub.onChange(() => tui.requestRender())  ◄── 订阅 store 变化
 *
 *   render(width):
 *     count = hub.listRunning().length
 *     count === 0 → return []（不占位）
 *     count > 0 → ["● N subagent running · /subagents list"]
 */
export class SubagentsProgressWidget implements Component {
  private hub: SubagentHub;
  private theme: ThemeLike;
  private unsubscribe?: () => void;

  constructor(hub: SubagentHub, theme: ThemeLike, tui: { requestRender(): void }) {
    this.hub = hub;
    this.theme = theme;
    // 订阅 store 变化 → 触发 Pi 重渲（widget render 会重新读 listRunning 计数）
    this.unsubscribe = hub.onChange(() => tui.requestRender());
  }

  invalidate(): void {
    // no-op：render 每次从 hub 实时读，无缓存。
  }

  render(width: number): string[] {
    const count = this.hub.listRunning().length;
    // count=0 不占位（返回空数组，belowEditor 不留空行）
    if (count === 0) return [];

    const theme = this.theme;
    const noun = count === 1 ? "subagent running" : "subagents running";
    const line =
      `${theme.fg("accent", "●")} ${count} ${noun} ` +
      `${theme.fg("dim", "·")} ${theme.fg("dim", "/subagents list")}`;
    return [truncLine(line, width)];
  }
}
