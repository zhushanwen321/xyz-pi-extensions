// src/tui/tool-render.ts
//
// 对话流 tool block 渲染。renderCall（标题行）+ renderResult（背景色 block）。
//
// 关键设计（Bug #2/#4 修复 + pi-tui-development-guide.md 三条红线）：
//   1. 不设 renderShell（默认 default）。背景色/padding 归 Pi 的 contentBox = Box(1,1,bgFn)，
//      它按 isPartial/isError 自动切 toolPendingBg/toolSuccessBg/toolErrorBg 三态。
//      组件 render 返回的 string[] **绝不调 theme.bg**——否则双重背景混色（坑2）。
//   2. 所有输出行经 truncLine（ANSI 安全，省略号前重应用 SGR，背景不断裂——坑2）。
//   3. 上下留白（Spacer(1) + Box paddingY=1）由 ToolExecutionComponent 负责，
//      组件不自己加 Spacer 做间隔（坑3）。
//   4. spinner 由 seed-frame 驱动（detailsSeed(details)），不用 setInterval（坑1 残影根因之一）。
//   5. streaming delta（text/thinking）不触发 onUpdate，仅离散边界事件触发重绘（避 viewport snap-back）。
//   6. 复用 lastComponent（P1a 优化，省 GC + 防 theme 闪烁）。

import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, Theme } from "@mariozechner/pi-coding-agent";

import type { SubagentToolDetails } from "../types.ts";
import {
  formatElapsedSeconds,
  formatEventLine,
  formatTokens,
  sanitizeLabel,
  spinnerGlyph,
  statusGlyph,
  type ThemeLike,
  truncLine,
} from "./format.ts";

// ============================================================
// 常量
// ============================================================

/** message stream 每行的缩进前缀（2 空格 + ⎿ + 空格），dim 色。 */
const STREAM_PREFIX = "  ⎿ ";

/** 压缩视图滚动区最多展示的 eventLog 条数（不含 currentActivity 行）。 */
const COMPACT_SCROLL_LINES = 3;

// ============================================================
// 类型（已存在的契约）
// ============================================================

/** renderResult 的 context（SDK 注入，含 lastComponent 供复用）。 */
export interface RenderContext {
  state: Record<string, never>;
  invalidate(): void;
  lastComponent?: Component;
}

/** SubagentResultComponent 的 props 形状（TUI 组件内部状态）。 */
export interface SubagentResultProps {
  details: SubagentToolDetails;
  expanded: boolean;
  theme: ThemeLike;
}

// ============================================================
// renderCall —— tool 标题行
// ============================================================

/**
 * renderCall：tool 标题行（agent 名）。无状态。
 *
 *   "subagent worker"（toolTitle 色 + accent 色 agent）
 *
 * 返回 `new Text(line, 0, 0)`——paddingX=0 paddingY=0，背景交给 contentBox。
 * 参考 pi-subagents extension/index.ts:450-454 single 分支。
 */
export function renderSubagentCall(args: unknown, theme: Theme, _context: RenderContext): Component {
  const t = theme as ThemeLike;
  const agent = extractAgentName(args);
  return new Text(
    `${t.fg("toolTitle", t.bold("subagent "))}${t.fg("accent", agent)}`,
    0, 0,
  );
}

// ============================================================
// renderResult —— 对话流背景色 block（路由 + 复用）
// ============================================================

/**
 * renderResult：对话流背景色 block。
 *
 *   1. details 缺失 → fallback new Text（防御性）
 *   2. lastComponent instanceof SubagentResultComponent
 *        → comp.update(details, theme) + setExpanded（复用，省 GC）
 *   3. 否则 new SubagentResultComponent(details, theme)
 *   4. setExpanded(options.expanded)
 *
 * 背景色由 Pi default shell 的 contentBox 按 isPartial/isError 自动施加，
 * 组件本身不施加背景色。
 */
export function renderSubagentResult(
  result: AgentToolResult<SubagentToolDetails>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: RenderContext,
): Component {
  const themeLike = theme as ThemeLike;
  const details = result.details;

  // 防御性 fallback：details 缺失或结构不完整时显示占位。
  // execute throw 后 SDK 会重建空 details（{} 或 undefined），此时 status/agent 缺失——
  // 不能当 SubagentToolDetails 渲染，否则显示 "⠋ undefined" 误导用户。
  if (!details || typeof details.status !== "string" || typeof details.agent !== "string") {
    return new Text(themeLike.fg("dim", "(subagent did not produce details)"), 0, 0);
  }

  // 复用 lastComponent（P1a 优化，省 GC + 防 theme 闪烁）
  if (context.lastComponent instanceof SubagentResultComponent) {
    const comp = context.lastComponent;
    comp.update(details, themeLike);
    comp.setExpanded(options.expanded);
    return comp;
  }

  const comp = new SubagentResultComponent(details, themeLike);
  comp.setExpanded(options.expanded);
  return comp;
}

// ============================================================
// SubagentResultComponent —— 持久 TUI 组件
// ============================================================

/**
 * SubagentResultComponent —— 持久 TUI 组件。
 *
 * update() 复用实例（省 GC），setExpanded 同步展开状态。
 * seed 由 detailsSeed(details) 在 render 时算（spinner 自然换帧，无定时器）。
 *
 * render 返回的 string[] 是**裸内容行**（状态行 + message stream 行），
 * 不含背景色/padding——那些由 Pi 的 contentBox 施加。
 */
export class SubagentResultComponent implements Component {
  private details: SubagentToolDetails;
  private theme: ThemeLike;
  private expanded = false;

  constructor(details: SubagentToolDetails, theme: ThemeLike) {
    this.details = details;
    this.theme = theme;
  }

  /** 刷新 details + theme 引用（P1a 复用）。theme 必须随更新，否则 /theme 切换后显示错色。 */
  update(details: SubagentToolDetails, theme: ThemeLike): void {
    this.details = details;
    this.theme = theme;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  invalidate(): void {
    // no-op：render 每次从 details 重建，无缓存。
  }

  render(width: number): string[] {
    return this.expanded ? this.renderExpanded(width) : this.renderCompact(width);
  }

  // ── 压缩视图 ──────────────────────────────────────────────

  private renderCompact(width: number): string[] {
    const lines: string[] = [];
    const d = this.details;
    const theme = this.theme;

    // 第 1 行：状态行（glyph + agent + meta + stats）
    lines.push(truncLine(buildStatusLine(d, theme), width));

    if (d.status === "running") {
      // message stream：currentActivity（若有）+ 最近 ≤3 条 eventLog + footer
      const scrollEntries = d.eventLog.filter((e) => e.type !== "turn_end");

      // currentActivity 与 eventLog 末条去重（避免两行近乎相同）
      let activityShown = false;
      if (d.currentActivity) {
        const lastEntry = scrollEntries[scrollEntries.length - 1];
        const sameAsLast =
          lastEntry !== undefined &&
          activityMatchesEntry(d.currentActivity, lastEntry);
        if (!sameAsLast) {
          lines.push(truncLine(buildActivityLine(d.currentActivity, theme), width));
          activityShown = true;
        }
      }

      // 最近 COMPACT_SCROLL_LINES 条（若 activity 已占首行，取最后 N 条；末条若与 activity 重复则跳过）
      const tail = scrollEntries.slice(-COMPACT_SCROLL_LINES);
      for (const entry of tail) {
        // activity 是末条的重复时，跳过末条
        if (activityShown && entry === scrollEntries[scrollEntries.length - 1] && d.currentActivity) {
          if (activityMatchesEntry(d.currentActivity, entry)) continue;
        }
        lines.push(truncLine(`${theme.fg("dim",STREAM_PREFIX)}${formatEventLine(entry, theme)}`, width));
      }

      // footer：Ctrl+O 提示（accent 色）
      lines.push(truncLine(`${theme.fg("dim",STREAM_PREFIX)}${theme.fg("accent", "Press Ctrl+O for live detail")}`, width));
    } else {
      // terminal 态（done/failed/cancelled）：1 行交付物
      const delivery = buildDeliveryLine(d, theme);
      if (delivery) {
        lines.push(truncLine(`${theme.fg("dim",STREAM_PREFIX)}${delivery}`, width));
      }
    }

    return lines;
  }

  // ── 展开视图 ──────────────────────────────────────────────

  private renderExpanded(width: number): string[] {
    const lines: string[] = [];
    const d = this.details;
    const theme = this.theme;

    // 状态行
    lines.push(truncLine(buildStatusLine(d, theme), width));

    // 空行间隔
    lines.push("");

    // 完整 eventLog（含 turn_end 分隔）
    for (const entry of d.eventLog) {
      lines.push(truncLine(`${theme.fg("dim",STREAM_PREFIX)}${formatEventLine(entry, theme)}`, width));
    }

    // 交付物（完整首行）
    const delivery = buildDeliveryLine(d, theme);
    if (delivery) {
      lines.push("");
      lines.push(truncLine(`${theme.fg("dim",STREAM_PREFIX)}${delivery}`, width));
    }

    return lines;
  }
}

// ============================================================
// detailsSeed —— spinner seed
// ============================================================

/**
 * 从 details 计算 spinner seed（每次 render 变化，驱动换帧）。
 *
 *   seed = turns + totalTokens + elapsedSeconds + eventLog.length（单调增长）
 *
 * 每次 onUpdate（真实事件）→ seed 变化 → spinner 换帧；
 * 静默期 seed 不变 → spinner 冻结 → 换取滚动体验。
 */
export function detailsSeed(details: SubagentToolDetails): number {
  // 防御：details 可能是 RecordSnapshot（缺 elapsedSeconds），undefined 参与加法得 NaN
  const turns = details.turns ?? 0;
  const tokens = details.totalTokens ?? 0;
  const elapsed = details.elapsedSeconds ?? 0;
  const logLen = details.eventLog?.length ?? 0;
  return turns + tokens + elapsed + logLen;
}

// ============================================================
// 私有 helper（模块内）
// ============================================================

/**
 * 从 renderCall 的 unknown args 安全提取 agent 名。
 * 类型守卫窄化（替代 `as { agent?: string }` 全可选断言，避免 taste warning）。
 */
function extractAgentName(args: unknown): string {
  if (typeof args === "object" && args !== null && "agent" in args) {
    const v = (args as { agent: unknown }).agent;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "worker";
}

/**
 * 构建状态行：`{glyph} {bold(agent)}{meta}{stats}`（tui-conversation.md §1）。
 *
 *   glyph: running → seed-frame spinner（accent）；done → ✓（success）；failed → ✗（error）；cancelled → ■（muted）
 *   meta:  dim `(model · thinking level)`，无 thinking 则 `(model)`，无 model 省略
 *   stats: dim `· N turns · Nk · Ns`，各字段 > 0 才显示（全零省略）
 */
function buildStatusLine(d: SubagentToolDetails, theme: ThemeLike): string {
  const glyph = statusGlyph(d.status);
  const icon = glyph.icon ?? spinnerGlyph(detailsSeed(d));
  const glyphStr = theme.fg(glyph.color, icon);

  const agentStr = theme.bold(d.agent);

  // meta：(model · thinking level)，dim
  const metaStr = buildMetaBadge(d, theme);

  // stats：· N turns · Nk · Ns，零值隐藏
  const statsStr = buildStats(d, theme);
  const statsPrefix = statsStr ? ` ${theme.fg("dim", "·")} ${statsStr}` : "";

  return `${glyphStr} ${agentStr}${metaStr}${statsPrefix}`;
}

/**
 * 构建 meta 徽章：dim `(model · thinking level)`。
 * model 取 basename（lastIndexOf("/") 后），更简洁。
 * 无 thinking → `(model)`；无 model → 省略括号。
 */
function buildMetaBadge(d: SubagentToolDetails, theme: ThemeLike): string {
  if (!d.model) return "";
  const modelBase = d.model.lastIndexOf("/") !== -1
    ? d.model.slice(d.model.lastIndexOf("/") + 1)
    : d.model;
  const inner = d.thinkingLevel
    ? `${modelBase} · thinking ${d.thinkingLevel}`
    : modelBase;
  return theme.fg("dim", ` (${inner})`);
}

/**
 * 构建 stats 字符串：`N turns · Nk · Ns`（零值隐藏，全零返回 ""）。
 * 各字段 dim 色，用 `·` 分隔（spec 分隔符语义：同级并列字段）。
 */
function buildStats(d: SubagentToolDetails, theme: ThemeLike): string {
  const parts: string[] = [];
  if (d.turns > 0) parts.push(`${d.turns} turns`);
  if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
  if (d.elapsedSeconds > 0) parts.push(formatElapsedSeconds(d.elapsedSeconds));
  if (parts.length === 0) return "";
  return parts.map((p) => theme.fg("dim", p)).join(` ${theme.fg("dim", "·")} `);
}

/**
 * 构建 currentActivity 行：`  ⎿ {图标} {label}`。
 * 图标按 activity.type：tool→`›`、thinking→`·`、text→`>`。
 * label 经 sanitize 压成单行。
 */
function buildActivityLine(
  activity: { type: "tool" | "text" | "thinking"; label: string },
  theme: ThemeLike,
): string {
  const icon = activity.type === "tool" ? "›" : activity.type === "thinking" ? "·" : ">";
  const label = sanitizeLabel(activity.label);
  // thinking 整行 dim（含图标）；其他图标 normal，前缀 dim
  const content = activity.type === "thinking"
    ? theme.fg("dim",`${icon} ${label}`)
    : `${icon} ${label}`;
  return `${theme.fg("dim",STREAM_PREFIX)}${content}`;
}

/**
 * 构建 terminal 态交付物行内容（不含 STREAM_PREFIX，由调用方加）。
 *   done      → result 首行（normal 色）
 *   failed    → `Error: {error 首行}`（error 色）
 *   cancelled → `Cancelled`（dim）
 */
function buildDeliveryLine(d: SubagentToolDetails, theme: ThemeLike): string | undefined {
  switch (d.status) {
    case "done":
      return firstLine(d.result) || undefined;
    case "failed":
      return `${theme.fg("error", "Error:")}: ${firstLine(d.error)}`;
    case "cancelled":
      return theme.fg("dim","Cancelled");
    default:
      return undefined;
  }
}

/**
 * 取文本首个非空行（多行压成首行展示），并 sanitize。
 * 用于 done/failed 的交付物预览。
 */
function firstLine(text?: string): string {
  if (!text) return "";
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  return sanitizeLabel(line);
}

/**
 * 判断 currentActivity 是否与某条 eventLog 末条语义重复。
 *
 * running 时 currentActivity（实时 streaming 锚点）可能正好是 eventLog 末条
 * 正在跑的 tool_start（同 label）。此时滚动区不再重复铺该条，避免两行近乎相同。
 *
 *   activity.type === "tool" 且 entry 是 tool_start + status:"running" + 同 label → 重复
 *   其他情况 → 不重复（thinking/text 的 streaming 与 eventLog 分片语义不同）
 */
function activityMatchesEntry(
  activity: { type: "tool" | "text" | "thinking"; label: string },
  entry: { type: string; label: string; status?: string },
): boolean {
  if (activity.type !== "tool") return false;
  if (entry.type !== "tool_start") return false;
  if (entry.status !== "running") return false;
  return sanitizeLabel(activity.label) === sanitizeLabel(entry.label);
}
