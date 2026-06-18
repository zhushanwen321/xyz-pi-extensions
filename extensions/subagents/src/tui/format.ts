// src/tui/format.ts
//
// 纯格式化函数。零 Pi 依赖、零 runtime 依赖，可单测。

import type { AgentEventLogEntry, ExecutionStatus } from "../types.ts";

/** ThemeLike：TUI 语义 token 着色接口（duck-typed，兼容 Pi Theme）。 */
export interface ThemeLike {
  bg(color: string, text: string): string;
  fg(color: string, text: string): string;
  bold(text: string): string;
  dim(text: string): string;
}

/** 格式化 token 数（K/M）。 */
export function formatTokens(n: number): string {
  //  <1000 → 原值；<1e6 → "N.Nk"；否则 "N.NM"
  void n;
  throw new Error("not implemented");
}

/** 格式化时长（秒 → "Xs"/"Xm Ys"）。 */
export function formatDuration(seconds: number): string {
  //  <60 → "Xs"；<3600 → "Xm Ys"；否则 "Xh Ym"
  void seconds;
  throw new Error("not implemented");
}

/** status → 图标 + 颜色 token。 */
export function statusGlyph(status: ExecutionStatus): { icon: string; color: string } {
  //  running → { "⠋"(spinner seed 驱动), "pending" }
  //  done → { "✓", "success" }
  //  failed → { "✗", "error" }
  //  cancelled → { "■", "warning" }
  void status;
  throw new Error("not implemented");
}

/** 格式化单条 eventLog 条目（带图标 + 着色）。 */
export function formatEventLine(entry: AgentEventLogEntry, theme: ThemeLike): string {
  //  tool_start/tool_end → 图标 + label
  //  text_output/thinking → dim 前缀 + 截断 label
  //  turn_end → 分隔
  void entry; void theme;
  throw new Error("not implemented");
}

/** 截断文本到 maxLen（带省略号）。 */
export function truncate(text: string, maxLen: number): string {
  //  超长 → slice(0, maxLen-3) + "..."
  void text; void maxLen;
  throw new Error("not implemented");
}

/** 生成 spinner 字形（seed 驱动，非定时器——修复 viewport 锚定 bug）。 */
export function spinnerGlyph(seed: number): string {
  //  ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"][seed % 10]
  void seed;
  throw new Error("not implemented");
}
