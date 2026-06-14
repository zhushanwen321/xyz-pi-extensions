// src/tui/subagent-render.ts
//
// Subagent tool result 对话流渲染（FR-2.1 ~ FR-2.4）。
// 使用 pi-tui Box + Text/Spacer/Container 组件包装：
//   - renderCall 返回空 Container，隐藏 Pi 默认 "subagent" 标题行
//   - renderResult 的 Box 自己渲染包含 "subagent" 的统一背景 block
//   - 压缩视图固定 6 行，空行用 Spacer 填充以保证真实 Box 高度稳定
//   - 滚动区每条 eventLog 截断到 ~50 可见字符，避免单行过长

import { Box, Container, Spacer, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

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
// Layout constants
// ============================================================

const COMPACT_SCROLL_LINES = 4;
const COMPACT_LINES_TOTAL = 6;
const COMPACT_LABEL_MAX_WIDTH = 50; // 滚动区单条 label 最大可见字符数

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

/** 截断单行到最大可见宽度，超出部分显示 "..."（与 pi-tui truncateToWidth 一致）。 */
function clampLine(line: string, maxWidth: number): string {
  return visibleWidth(line) > maxWidth ? truncateToWidth(line, maxWidth) : line;
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

  // 第 1 行：spinner + "subagent" 标题 + agent + model + thinking
  const glyph = statusGlyph(details.status, frame, theme);
  const modelPart = details.model ? ` │ ${details.model}` : "";
  const thinkingPart = details.thinkingLevel ? ` │ thinking: ${details.thinkingLevel}` : "";
  lines.push(sanitizeLine(`${glyph} subagent │ ${details.agent}${modelPart}${thinkingPart}`));

  // 第 2-5 行：滚动区（最近 4 条，过滤掉 turn_end——压缩视图不显示 turn 分隔）
  const prefixWidth = visibleWidth(theme.fg("dim", "├─ ")); // 实际占 4 列
  const labelMaxWidth = Math.max(1, COMPACT_LABEL_MAX_WIDTH);
  const recent = (details.eventLog ?? [])
    .filter((e) => e.type !== "turn_end")
    .slice(-COMPACT_SCROLL_LINES);
  for (const entry of recent) {
    const raw = sanitizeLine(formatEventLogLine(entry, theme));
    // 先按 label 上限截断，再按行宽兜底，防止长 label 撑爆 block
    const clampedToLabel = visibleWidth(raw) > labelMaxWidth + prefixWidth
      ? truncateToWidth(raw, labelMaxWidth + prefixWidth)
      : raw;
    lines.push(clampLine(clampedToLabel, width));
  }
  while (lines.length < COMPACT_LINES_TOTAL - 1) lines.push(""); // 空行填充到 stats 前

  // 第 6 行：stats 右对齐
  const stats = `${details.turns} turns │ ${formatTokens(details.totalTokens)} │ ${details.elapsedSeconds}s`;
  const padNeeded = Math.max(0, width - visibleWidth(stats));
  lines.push(" ".repeat(padNeeded) + theme.fg("dim", stats));

  // 统一截断到可用宽度（避免任何单行超长触发 Pi 渲染异常）
  return lines.map((line) => clampLine(line, width));
}

function buildExpandedLines(details: SubagentToolDetails, theme: ThemeLike, frame: number): string[] {
  const lines: string[] = [];
  const glyph = statusGlyph(details.status, frame, theme);
  const modelPart = details.model ? ` │ ${details.model}` : "";
  const thinkingPart = details.thinkingLevel ? ` │ thinking: ${details.thinkingLevel}` : "";
  lines.push(sanitizeLine(`${glyph} subagent │ ${details.agent}${modelPart}${thinkingPart}`));

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
// Component (pi-tui Box + Text/Spacer)
// ============================================================

/**
 * FR-2.4：renderCall 返回空 Container，让 Pi 不要渲染默认的 "subagent" 标题行。
 * 标题被纳入 renderResult 的 Box 内部，从而整个 tool 输出都在同一背景 block 中。
 */
export function renderSubagentCall(_args: unknown, _theme: ThemeLike, _context: unknown): Component {
  return new Container();
}

/**
 * FR-2.1 ~ FR-2.4：subagent 对话流 block 组件。
 * 用 pi-tui Box 统一处理背景色和左右内边距，内部每行用一个 Text(0,0) 或 Spacer。
 * Box paddingX=1 与之前手写的 applyBg 左右各 1 空格效果一致；paddingY=0 避免首尾额外空行。
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
      // 空字符串传给 Text 会返回空数组，导致 block 高度不稳定；用 Spacer 产生一行背景空格。
      if (line === "") {
        box.addChild(new Spacer(1));
      } else {
        box.addChild(new Text(line, 0, 0));
      }
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
