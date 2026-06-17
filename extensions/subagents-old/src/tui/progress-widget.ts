// src/tui/progress-widget.ts
//
// input 编辑器下方的轻量进度 widget（placement: "belowEditor"）。
//
// 目的：background subagent 的执行进度无法在对话流 tool block 内实时刷新
// （SDK 的 onUpdate 生命周期硬绑定在 execute() 调用期，background 的 execute
// 立即 return 后 tool block 即被 finalize，详见 subagent-tool.ts 注释）。
// 作为补偿，此处 widget 常驻 input 下方，当有 subagent 正在运行时显示计数 +
// 指引，让用户知道可 /subagents list 查看实时详情。
//
// 渲染契约：
//   - count = 0 时 render() 返回 []（widgetContainerBelow 的 spacerWhenEmpty=false，
//     不占任何行，视觉上 widget 消失）
//   - count > 0 时返回单行：⟳ N subagents running · /subagents list for details
//
// 更新驱动：订阅 runtime.onChange（background 事件 + 完成时均触发），
// 每次回调调 tui.requestRender()，框架重渲时调本组件 render() 实时读最新计数。

import type { Component } from "@earendil-works/pi-tui";

import type { SubagentRuntime } from "../runtime.ts";
import type { ThemeLike } from "./subagent-render.ts";

/** widget 所需的最小 tui 接口（结构类型，SDK 的 TUI 是其超集，可直接传入） */
interface WidgetTui {
  requestRender(): void;
}

/**
 * subagent 运行计数 widget。
 *
 * 生命周期：session_start 时由 index.ts 通过 setWidget 注册；session 切换时
 * clearExtensionWidgets 调 dispose()，新 session_start 重建。dispose 取消
 * runtime 订阅，防止 stale tui 引用。
 */
export class SubagentsProgressWidget implements Component {
  private readonly _runtime: SubagentRuntime;
  private readonly _theme: ThemeLike;
  private readonly _tui: WidgetTui;
  private readonly _unsub: () => void;

  constructor(runtime: SubagentRuntime, theme: ThemeLike, tui: WidgetTui) {
    this._runtime = runtime;
    this._theme = theme;
    this._tui = tui;
    // runtime 任何数据变更（bg 事件 / 完成 / cancel）都触发重渲。
    // render() 实时算 count，count 变化时视觉更新；count 不变则内容相同（幂等）。
    this._unsub = runtime.onChange(() => this._tui.requestRender());
  }

  /** 统计正在运行的 sync + background subagent 数量。 */
  private countRunning(): number {
    const syncRunning = this._runtime.listRunningAgents().filter((a) => a.status === "running").length;
    const bgRunning = this._runtime
      .listBackground()
      .filter((b) => b.status === "running").length;
    return syncRunning + bgRunning;
  }

  // fallow-ignore-next-line unused-class-member — pi-tui Component 接口契约
  invalidate(): void {
    // 无缓存状态，render 每次实时计算。
  }

  render(_width: number): string[] {
    const count = this.countRunning();
    if (count === 0) return []; // 无运行任务时不占位

    const noun = count === 1 ? "subagent" : "subagents";
    const spinner = this._theme.fg("warning", "⟳");
    const label = this._theme.bold(`${count} ${noun} running`);
    const hint = this._theme.fg("dim", " · /subagents list for details");
    return [`${spinner} ${label}${hint}`];
  }

  dispose(): void {
    this._unsub();
  }
}
