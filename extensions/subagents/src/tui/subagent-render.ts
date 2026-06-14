// src/tui/subagent-render.ts
//
// Subagent tool result 对话流渲染（FR-2.1 ~ FR-2.4）。
// 6 行压缩布局：status + 滚动区(4) + stats。
// 使用 pi-tui Box + Text 组件包装，让 Box 统一处理背景色与左右内边距，
// 避免手写的背景/截断/padding 逻辑与 Pi 默认 Box 叠加产生渲染残留。

import { Box, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import { formatEventLogLine, formatTokens } from "./format.ts";
import type { AgentEventLogEntry } from "../types.ts";

// ============================================================
// Types
// ============================================================

export interface SubagentToolDetails {
  eventLog: AgentEventLogEntry[];
  status: "running" | "done" | "failed" | "cancelled";
  agent: string;
  turns: number;
  totalTokens: number;
  elapsedSeconds: number;
  result?: string;
  error?: string;
  backgroundId?: string;
  /** FR-1.2: "provider/modelId"（来自 ResolvedModel） */
  model?: string;
  /** FR-1.2: thinking level */
  thinkingLevel?: string;
}

export interface ThemeLike {
  bg(color: string, text: string): string;
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface RenderOptions {
  expanded?: boolean;
  spinnerFrame?: number;
}

// ============================================================
// Spinner
// ============================================================

const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function statusGlyph(status: SubagentToolDetails["status"], frame: number, theme: ThemeLike): string {
  switch (status) {
    case "running":
      return theme.fg("accent", RUNNING_FRAMES[frame % RUNNING_FRAMES.length]);
    case "done":
      return theme.fg("success", "✓");
    case "failed":
      return theme.fg("error", "✗");
    case "cancelled":
      return theme.fg("muted", "■");
  }
}

// ============================================================
// buildRenderLines
// ============================================================

/** 把含换行/制表符的原始 label 压成单行，避免 Pi TUI 把一条 eventLog 展开成多行。 */
function sanitizeLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/\t/g, "  ");
}

export function buildRenderLines(
  details: SubagentToolDetails,
  width: number,
  theme: ThemeLike,
  options: RenderOptions = {},
): string[] {
  if (options.expanded) return buildExpandedLines(details, theme, options.spinnerFrame ?? 0);
  return buildCompactLines(details, width, theme, options.spinnerFrame ?? 0);
}

function buildCompactLines(details: SubagentToolDetails, width: number, theme: ThemeLike, frame: number): string[] {
  const lines: string[] = [];

  // 第 1 行：spinner + agent + model + thinking
  const glyph = statusGlyph(details.status, frame, theme);
  const modelPart = details.model ? ` │ ${details.model}` : "";
  const thinkingPart = details.thinkingLevel ? ` │ thinking: ${details.thinkingLevel}` : "";
  lines.push(sanitizeLine(`${glyph} ${details.agent}${modelPart}${thinkingPart}`));

  // 第 2-5 行：滚动区（最近 4 条，过滤掉 turn_end——压缩视图不显示 turn 分隔）
  const recent = (details.eventLog ?? [])
    .filter((e) => e.type !== "turn_end")
    .slice(-4);
  for (const entry of recent) {
    lines.push(sanitizeLine(formatEventLogLine(entry, theme)));
  }
  while (lines.length < 5) lines.push(""); // 空行填充

  // 第 6 行：stats 右对齐
  const stats = `${details.turns} turns │ ${formatTokens(details.totalTokens)} │ ${details.elapsedSeconds}s`;
  const padNeeded = Math.max(0, width - visibleWidth(stats));
  lines.push(" ".repeat(padNeeded) + theme.fg("dim", stats));

  // 统一截断到可用宽度（避免任何单行超长触发 Pi 渲染异常）
  return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width) : line));
}

function buildExpandedLines(details: SubagentToolDetails, theme: ThemeLike, frame: number): string[] {
  const lines: string[] = [];
  const glyph = statusGlyph(details.status, frame, theme);
  const modelPart = details.model ? ` │ ${details.model}` : "";
  const thinkingPart = details.thinkingLevel ? ` │ thinking: ${details.thinkingLevel}` : "";
  lines.push(sanitizeLine(`${glyph} ${details.agent}${modelPart}${thinkingPart}`));

  let turnNumber = 0;
  for (const entry of details.eventLog ?? []) {
    if (entry.type === "turn_end") {
      turnNumber++;
      lines.push(theme.fg("dim", `── turn ${turnNumber} ──`));
      continue;
    }
    lines.push(sanitizeLine(formatEventLogLine(entry, theme, turnNumber)));
  }

  if (details.status === "done" && details.result) {
    lines.push("");
    for (const l of details.result.split("\n")) lines.push(sanitizeLine(l));
  }
  if (details.status === "failed" && details.error) {
    lines.push("");
    lines.push(theme.fg("error", `Error: ${details.error}`));
  }
  return lines;
}

// ============================================================
// Component (pi-tui Box + Text)
// ============================================================

/**
 * FR-2.1 ~ FR-2.4：subagent 对话流 block 组件。
 * 用 pi-tui Box 统一处理背景色和左右内边距，内部每行用一个 Text(0,0)。
 * Box paddingX=1 与之前手写的 applyBg 左右各 1 空格效果一致。
 */
export class SubagentResultComponent implements Component {
  private _details: SubagentToolDetails;
  private _theme: ThemeLike;
  private _spinnerFrame = 0;
  private _expanded = false;

  constructor(details: SubagentToolDetails, theme: ThemeLike) {
    this._details = details;
    this._theme = theme;
  }

  update(details: SubagentToolDetails): void {
    this._details = details;
  }

  setSpinnerFrame(frame: number): void {
    this._spinnerFrame = frame;
  }

  setExpanded(expanded: boolean): void {
    this._expanded = expanded;
  }

  invalidate(): void {
    // Box 在 render 时重建，无需额外清理缓存。
  }

  render(width: number): string[] {
    // Box 左右各 1 列内边距，内容可用宽度为 width - 2。
    const contentWidth = Math.max(1, width - 2);
    const lines = buildRenderLines(this._details, contentWidth, this._theme, {
      expanded: this._expanded,
      spinnerFrame: this._spinnerFrame,
    });
    const box = new Box(1, 0, this._getBgFn());
    for (const line of lines) {
      box.addChild(new Text(line, 0, 0));
    }
    return box.render(width);
  }

  private _getBgFn(): (text: string) => string {
    switch (this._details.status) {
      case "running":
        return (t: string) => this._theme.bg("toolPendingBg", t);
      case "done":
        return (t: string) => this._theme.bg("toolSuccessBg", t);
      case "failed":
      case "cancelled":
        return (t: string) => this._theme.bg("toolErrorBg", t);
    }
  }
}
