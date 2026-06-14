// src/tui/subagent-render.ts
//
// Subagent tool result 对话流渲染（FR-2.1 ~ FR-2.4）。
// 6 行压缩布局：status + 滚动区(4) + stats。
// spinner 定时器由 subagent-tool.ts 的 renderSubagentResult 管理（存 ToolRenderContext.state）。

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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
    case "running": return theme.fg("accent", RUNNING_FRAMES[frame % RUNNING_FRAMES.length]);
    case "done": return theme.fg("success", "✓");
    case "failed": return theme.fg("error", "✗");
    case "cancelled": return theme.fg("muted", "■");
  }
}

// ============================================================
// buildRenderLines
// ============================================================

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
  lines.push(`${glyph} ${details.agent}${modelPart}${thinkingPart}`);

  // 第 2-5 行：滚动区（最近 4 条，过滤掉 turn_end——压缩视图不显示 turn 分隔）
  const recent = (details.eventLog ?? [])
    .filter((e) => e.type !== "turn_end")
    .slice(-4);
  for (const entry of recent) {
    lines.push(formatEventLogLine(entry, theme));
  }
  while (lines.length < 5) lines.push(""); // 空行填充

  // 第 6 行：stats 右对齐
  const stats = `${details.turns} turns │ ${formatTokens(details.totalTokens)} │ ${details.elapsedSeconds}s`;
  const padNeeded = Math.max(0, width - visibleWidth(stats) - 2);
  lines.push(" ".repeat(padNeeded) + theme.fg("dim", stats));

  return lines;
}

function buildExpandedLines(details: SubagentToolDetails, theme: ThemeLike, frame: number): string[] {
  const lines: string[] = [];
  const glyph = statusGlyph(details.status, frame, theme);
  const modelPart = details.model ? ` │ ${details.model}` : "";
  const thinkingPart = details.thinkingLevel ? ` │ thinking: ${details.thinkingLevel}` : "";
  lines.push(`${glyph} ${details.agent}${modelPart}${thinkingPart}`);

  let turnNumber = 0;
  for (const entry of details.eventLog ?? []) {
    if (entry.type === "turn_end") {
      turnNumber++;
      lines.push(theme.fg("dim", `── turn ${turnNumber} ──`));
      continue;
    }
    lines.push(formatEventLogLine(entry, theme, turnNumber));
  }

  if (details.status === "done" && details.result) {
    lines.push("");
    for (const l of details.result.split("\n")) lines.push(l);
  }
  if (details.status === "failed" && details.error) {
    lines.push("");
    lines.push(theme.fg("error", `Error: ${details.error}`));
  }
  return lines;
}

// ============================================================
// Component
// ============================================================

export class SubagentResultComponent {
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

  invalidate(): void {}

  render(width: number): string[] {
    const lines = buildRenderLines(this._details, width, this._theme, {
      expanded: this._expanded,
      spinnerFrame: this._spinnerFrame,
    });
    return lines.map((line) => this.applyBg(line, width));
  }

  private applyBg(text: string, width: number): string {
    const bgFn = this.getBgFn();
    const contentWidth = Math.max(1, width - 2);
    const truncated = visibleWidth(text) > contentWidth ? truncateToWidth(text, contentWidth) : text;
    const padNeeded = Math.max(0, contentWidth - visibleWidth(truncated));
    const padded = ` ${truncated}${" ".repeat(padNeeded)} `;
    return bgFn ? bgFn(padded) : padded;
  }

  private getBgFn(): ((text: string) => string) | undefined {
    switch (this._details.status) {
      case "running": return (t: string) => this._theme.bg("toolPendingBg", t);
      case "done": return (t: string) => this._theme.bg("toolSuccessBg", t);
      case "failed":
      case "cancelled": return (t: string) => this._theme.bg("toolErrorBg", t);
    }
  }
}
