// src/tui/progress-widget.ts
//
// belowEditor 常驻进度 widget。有 subagent 运行时显示计数 + /subagents list 指引。
// count=0 时 render 返回 [] 不占位。
//
// background 执行进度无法回流到对话流 tool block（SDK onUpdate 生命周期限制），
// 此 widget 作为可观测性补偿。

import type { SubagentRuntime } from "../runtime/runtime.ts";
import type { ThemeLike } from "./format.ts";

/**
 * 进度 widget。factory 只在 setWidget 时执行一次，
 * 返回的持久组件订阅 runtime.onChange 驱动重渲。
 *
//   ╔═══════════════════════════════════════════════════════════════╗
//   ║  constructor(rt, theme, tui):                                  ║
//   ║    rt.onChange(() => tui.requestRender())  ◄── 订阅 store 变化  ║
//   ║                                                                 ║
//   ║  render(width):                                                ║
//   ║    count = rt.listRunning().length                              ║
//   ║    count === 0 → return []（不占位）                            ║
//   ║    count > 0 → ["● N subagent running · /subagents list"]       ║
//   ╚═══════════════════════════════════════════════════════════════╝
 */
export class SubagentsProgressWidget {
  constructor(runtime: SubagentRuntime, theme: ThemeLike, tui: { requestRender(): void }) {
    //  runtime.onChange(() => tui.requestRender())
    void runtime; void theme; void tui;
    throw new Error("not implemented");
  }

  render(width: number): string[] {
    //  count === 0 → []；否则单行进度提示
    void width;
    throw new Error("not implemented");
  }
}
