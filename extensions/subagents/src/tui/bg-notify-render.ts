// src/tui/bg-notify-render.ts
//
// background 完成通知的对话流渲染器。
// pi.registerMessageRenderer("subagent-bg-notify", ...) 注册。
// display:true 后由 CustomMessageComponent 调用，渲染成与 tool block 同风格的完成块。

import type { ThemeLike } from "./format.ts";

/**
 * 渲染 background 完成通知。
 *
//   ╔══════════════════════════════════════════════════════════╗
//   ║  从 message.details 提取 BgNotifyRecord                     ║
//   ║  按 status（done/failed/cancelled）选背景色 + 图标          ║
//   ║  拼 agent + result/error → 返回 Text                       ║
//   ║  与 tool block 同风格（toolSuccessBg/toolErrorBg）          ║
//   ╚══════════════════════════════════════════════════════════╝
 */
export function renderBgNotifyMessage(message: { details?: unknown }, theme: ThemeLike): { text: string } {
  //  1. message.details as BgNotifyRecord
  //  2. statusGlyph(status) → 图标 + 颜色
  //  3. 拼完成块文本
  void message; void theme;
  throw new Error("not implemented");
}
