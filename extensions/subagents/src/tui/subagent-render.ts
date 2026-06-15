// src/tui/subagent-render.ts
//
// Subagent tool result 对话流渲染（FR-2.1 ~ FR-2.4）。
// 使用 pi-tui Box + Text/Spacer/Container 组件包装：
//   - renderCall 返回空 Container，隐藏 Pi 默认 "subagent" 标题行
//   - renderResult 的 Box 自己渲染包含 "subagent" 的统一背景 block
//   - 压缩视图动态高度：状态行 + 最近 ≤4 条 eventLog，随事件增长，不预填空行
//   - 滚动区每条 eventLog 截断到 ~50 可见字符，避免单行过长

import { Box, Container, Spacer, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";

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
}

// ============================================================
// Layout constants
// ============================================================

const COMPACT_SCROLL_LINES = 4;
const COMPACT_LABEL_MAX_WIDTH = 50; // 滚动区单条 label 最大可见字符数

// ============================================================
// Truncation (Bug #3: ANSI-style-preserving truncation)
// ============================================================

/**
 * 截断单行到 maxWidth，省略号前重应用 ANSI 样式，避免背景色断裂。
 *
 * pi-tui 的 truncateToWidth 在省略号前插 `\x1b[0m`（全局 reset），导致 Box 背景色
 * 在省略号处断裂——`⎿  bash find /Users/...…` 后半段失去背景色。本实现追踪
 * active SGR styles 并在写省略号前重应用，保证整行背景色一致。
 *
 * 移植自 pi-subagents render.ts:44-89（Intl.Segmenter 处理 Unicode/emoji）。
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function truncLine(text: string, maxWidth: number): string {
  if (visibleWidth(text) <= maxWidth) return text;

  const targetWidth = Math.max(0, maxWidth - 1);
  let result = "";
  let currentWidth = 0;
  let activeStyles: string[] = [];
  let i = 0;

  while (i < text.length) {
    const ansiMatch = text.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (ansiMatch) {
      const code = ansiMatch[0];
      result += code;
      if (code === "\x1b[0m" || code === "\x1b[m") {
        activeStyles = [];
      } else {
        activeStyles.push(code);
      }
      i += code.length;
      continue;
    }

    let end = i;
    while (end < text.length && !text.slice(end).match(/^\x1b\[[0-9;]*m/)) {
      end++;
    }

    const textPortion = text.slice(i, end);
    for (const seg of segmenter.segment(textPortion)) {
      const grapheme = seg.segment;
      const graphemeWidth = visibleWidth(grapheme);

      if (currentWidth + graphemeWidth > targetWidth) {
        return result + activeStyles.join("") + "…";
      }

      result += grapheme;
      currentWidth += graphemeWidth;
    }
    i = end;
  }

  return result + activeStyles.join("") + "…";
}

// ============================================================
// Spinner (Bug #1 + #4: seed-frame, 事件驱动，无 setInterval)
// ============================================================

const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** 无 seed 可用时的静态回退 glyph */
const STATIC_RUNNING_GLYPH = "●";

/** 累加多个事件数据为单一 seed（移植自 pi-subagents render.ts:96-103）。 */
function runningSeed(...values: Array<number | undefined>): number | undefined {
  let seed: number | undefined;
  for (const value of values) {
    if (value === undefined || !Number.isFinite(value)) continue;
    seed = (seed ?? 0) + Math.trunc(value);
  }
  return seed;
}

/** 从 details 计算 spinner seed（turns + tokens + elapsedSeconds + eventLog 长度）。
 *  这些值随事件推进单调增长，每次 onUpdate 触发重绘时 seed 变化 → spinner 自然换帧。
 *  静默期（无事件）seed 不变 → spinner 冻结，换取滚动体验（不再有 setInterval 抢占 viewport）。 */
function detailsSeed(d: SubagentToolDetails): number | undefined {
  return runningSeed(d.turns, d.totalTokens, d.elapsedSeconds, d.eventLog?.length);
}

function statusGlyph(d: SubagentToolDetails, theme: ThemeLike): string {
  switch (d.status) {
    case "running": {
      const seed = detailsSeed(d);
      const frame = seed === undefined ? STATIC_RUNNING_GLYPH : RUNNING_FRAMES[Math.abs(seed) % RUNNING_FRAMES.length]!;
      return theme.fg("accent", frame);
    }
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

/** 截断单行到最大可见宽度，超出部分显示 "…"（保留 ANSI 样式/背景色）。 */
function clampLine(line: string, maxWidth: number): string {
  return visibleWidth(line) > maxWidth ? truncLine(line, maxWidth) : line;
}

export function buildRenderLines(
  details: SubagentToolDetails,
  width: number,
  theme: ThemeLike,
  options: RenderOptions = {},
): string[] {
  if (options.expanded) return buildExpandedLines(details, theme);
  return buildCompactLines(details, width, theme);
}

function buildCompactLines(details: SubagentToolDetails, width: number, theme: ThemeLike): string[] {
  const lines: string[] = [];

  // 第 1 行：glyph + bold(agent) + dim(model·thinking 括号) + dim(· stats 内联)
  // 设计借鉴 pi-subagents render.ts:1024——身份+元数据+进度内聚在同一视觉锚点，
  // 避免「记忆桥」（用户不必跨行拼凑 agent 身份与进度）。
  lines.push(sanitizeLine(buildStatusLine(details, theme)));

  // 滚动区：最近 ≤4 条（过滤 turn_end——压缩视图不显示 turn 分隔），动态增长，不预填空行
  const prefixWidth = visibleWidth(theme.fg("dim", "⎿  ")); // 实际占 3 列
  const labelMaxWidth = Math.max(1, COMPACT_LABEL_MAX_WIDTH);
  const recent = (details.eventLog ?? [])
    .filter((e) => e.type !== "turn_end")
    .slice(-COMPACT_SCROLL_LINES);
  for (const entry of recent) {
    const raw = sanitizeLine(formatEventLogLine(entry, theme));
    // 先按 label 上限截断（保留 ANSI 背景色），再按行宽兜底，防止长 label 撑爆 block
    const clampedToLabel = visibleWidth(raw) > labelMaxWidth + prefixWidth
      ? truncLine(raw, labelMaxWidth + prefixWidth)
      : raw;
    lines.push(clampLine(clampedToLabel, width));
  }

  // 统一截断到可用宽度（避免任何单行超长触发 Pi 渲染异常）
  return lines.map((line) => clampLine(line, width));
}

/**
 * 构造第 1 行状态文本：glyph + bold(agent) + dim(model·thinking) + dim(· stats)。
 * stats 各字段仅在 > 0 时出现（全零隐藏，避免 `0 turns · 0 · 0s` 噪音）。
 * 借鉴 pi-subagents 的 statJoin（dim · 分隔）+ 括号分组元数据。
 */
function buildStatusLine(d: SubagentToolDetails, theme: ThemeLike): string {
  const glyph = statusGlyph(d, theme);
  const agent = theme.bold(d.agent);

  // model + thinking 括号分组（dim），借鉴 pi-subagents modelThinkingBadge
  const metaParts: string[] = [];
  if (d.model) metaParts.push(d.model);
  if (d.thinkingLevel) metaParts.push(`thinking ${d.thinkingLevel}`);
  const meta = metaParts.length > 0 ? ` ${theme.fg("dim", `(${metaParts.join(" · ")})`)}` : "";

  // stats 各字段 > 0 才出现（借鉴 pi-subagents formatProgressStats）
  const statParts: string[] = [];
  if (d.turns > 0) statParts.push(`${d.turns} turns`);
  if (d.totalTokens > 0) statParts.push(formatTokens(d.totalTokens));
  if (d.elapsedSeconds > 0) statParts.push(`${d.elapsedSeconds}s`);
  const stats = statParts.length > 0
    ? ` ${theme.fg("dim", "·")} ${theme.fg("dim", statParts.join(` ${theme.fg("dim", "·")} `))}`
    : "";

  return `${glyph} ${agent}${meta}${stats}`;
}

function buildExpandedLines(details: SubagentToolDetails, theme: ThemeLike): string[] {
  const lines: string[] = [];
  // 复用 buildStatusLine 保持压缩/展开视图第 1 行一致
  lines.push(sanitizeLine(buildStatusLine(details, theme)));

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
 * 用 pi-tui Box 统一处理背景色和内边距，内部每行用一个 Text(0,0) 或 Spacer。
 * Box paddingX=1 左右各 1 空格；paddingY=1 顶/底各 1 行背景填充，避免文字紧贴 block 边界
 * （pi-tui 的 paddingY 行会通过 applyBg("", width) 填充背景色，与内容行同色）。
 */
export class SubagentResultComponent implements Component {
  private _details: SubagentToolDetails;
  private _theme: ThemeLike;
  private _expanded = false;

  constructor(details: SubagentToolDetails, theme: ThemeLike) {
    this._details = details;
    this._theme = theme;
  }

  update(details: SubagentToolDetails): void {
    this._details = details;
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
    });
    const box = new Box(1, 1, this._getBgFn());
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
