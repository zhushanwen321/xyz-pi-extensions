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
//   4. spinner 由 Date.now() 选帧 + 低频 setInterval 驱动 invalidate，不用 seed-frame（坑1 残影根因之一）。
//   5. streaming delta（text/thinking）不触发 onUpdate，仅离散边界事件触发重绘（避 viewport snap-back）。
//   6. 复用 lastComponent（P1a 优化，省 GC + 防 theme 闪烁）。

import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, Theme } from "@mariozechner/pi-coding-agent";

import type {
  AgentEventLogEntry,
  ExecutionStatus,
  ListResponse,
  SubagentToolResult,
  SyncResponse,
} from "../types.ts";
import {
  extractAgentName,
  firstLine,
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

/** footer 用的纯空格缩进（与 STREAM_PREFIX 等宽 4 列，但不带 ⎿）。 */
const FOOTER_PREFIX = "    ";

/** spinner 帧间隔（ms）。低频丝滑转动，只触发单行重绘不锁滚动。 */
const SPINNER_INTERVAL_MS = 200;

/** 压缩视图滚动区最多展示的 eventLog 条数（不含 currentActivity 行）。 */
const COMPACT_SCROLL_LINES = 3;

// ============================================================
// 类型（已存在的契约）
// ============================================================

/**
 * renderResult 的 context（SDK ToolRenderContext 的有意子集——只读 state/invalidate/lastComponent）。
 * SDK 实际传入更完整的 { args, toolCallId, cwd, executionStarted, argsComplete, isPartial,
 * expanded, showImages, isError, ... }，本组件结构兼容只取需要的字段。
 */
export interface RenderContext {
  state: Record<string, never>;
  invalidate(): void;
  lastComponent?: Component;
}

// ============================================================
// renderCall —— tool 标题行
// ============================================================

/**
 * renderCall：tool 标题行（agent + model + thinking，不变信息）。
 *
 *   "subagent worker · glm-5.2 · thinking high"
 *
 * model/thinkingLevel 由调用方（subagent-tool.ts 的闭包）预解析后传入，
 * 因为 renderCall 在 execute 前调用，但 model 解析是同步的（只读配置）。
 * resolved 缺失时（hub 未就绪）降级为只显示 agent 名。
 *
 * 返回 `new Text(line, 0, 0)`——paddingX=0 paddingY=0，背景交给 contentBox。
 */
export function renderSubagentCall(
  args: unknown,
  theme: Theme,
  _context: RenderContext,
  resolved?: { model: string; thinkingLevel?: string },
): Component {
  const t = theme as ThemeLike;
  const agent = extractAgentName(args);
  const parts = [`${t.fg("toolTitle", t.bold("subagent "))}${t.fg("accent", agent)}`];

  // model + thinking——完整 provider/model（accent 色），thinking 保持 dim。
  // 不去 provider 前缀——provider 是模型来源的关键信息，感知「用错模型」需要完整路径。
  if (resolved) {
    parts.push(t.fg("dim", " ("));
    parts.push(t.fg("accent", resolved.model));
    if (resolved.thinkingLevel) {
      parts.push(t.fg("dim", ` · thinking ${resolved.thinkingLevel})`));
    } else {
      parts.push(t.fg("dim", ")"));
    }
  }

  return new Text(parts.join(""), 0, 0);
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
  result: AgentToolResult<SubagentToolResult>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: RenderContext,
): Component {
  const themeLike = theme as ThemeLike;
  const details = result.details;

  // 防御性 fallback：按 action 判断 details 结构是否完整（G2-007）。
  // list/cancel 无顶层 status/agent，旧 guard（typeof details.status）会误判「execution failed」。
  // details 缺失通常是因为 execute 抛错（如 hub disposed）——此时 Pi 把 error.message 塞进
  // result.content[0].text。旧实现只显示 "no details available"，吞掉真实原因，导致 AI 盲猜。
  // 现在从 result.content 提取错误文本显示，拿不到才退回通用文案。
  if (!details || typeof details.action !== "string" || !isDetailsStructurallyComplete(details)) {
    const errorText = extractResultError(result.content);
    const fallback = errorText ?? "(subagent execution failed — no details available)";
    return new Text(themeLike.fg("warning", fallback), 0, 0);
  }

  // 复用 lastComponent（P1a 优化，省 GC + 防 theme 闪烁）
  if (context.lastComponent instanceof SubagentResultComponent) {
    const comp = context.lastComponent;
    comp.update(details, themeLike);
    comp.setExpanded(options.expanded);
    comp.setInvalidate(context.invalidate);
    return comp;
  }

  const comp = new SubagentResultComponent(details, themeLike);
  comp.setExpanded(options.expanded);
  comp.setInvalidate(context.invalidate);
  return comp;
}

// ============================================================
// SubagentResultComponent —— 持久 TUI 组件
// ============================================================

/**
 * SubagentResultComponent —— 持久 TUI 组件。
 *
 * update() 复用实例（省 GC），setExpanded 同步展开状态。
 *
 * spinner 驱动：running 态用低频 setInterval（SPINNER_INTERVAL_MS）调 context.invalidate()
 * 触发重绘，每次 render 用 Date.now() 选帧——丝滑转动。
 * terminal 态（done/failed/cancelled）clearInterval，spinner 停在终态图标。
 *
 * 安全性（对照 pi-tui 引擎源码确认）：
 *   - setInterval 只触发 invalidate（→ requestRender），不改行数/不加 eventLog
 *   - Pi diff 引擎只重绘变化的行（tui.ts:1346「spinner animation」场景）
 *   - 行数不变 → finalCursorRow 不变 → viewportTop 不变（tui.ts:1445）→ 不 snap-back
 *   - 旧 Bug #4 根因是 setInterval 同时推了 eventLog（行数变化），不是定时器本身
 *
 * render 返回的 string[] 是**裸内容行**（状态行 + message stream 行），
 * 不含背景色/padding——那些由 Pi 的 contentBox 施加。
 */
class SubagentResultComponent implements Component {
  private details: SubagentToolResult;
  private theme: ThemeLike;
  private expanded = false;
  /** invalidate 回调（来自 SDK context，内部已含 requestRender）。running 态定时器调它驱动重绘。 */
  private invalidateFn?: () => void;
  /** spinner 定时器（running 态启动，terminal 态清除）。 */
  private spinnerTimer?: ReturnType<typeof setInterval>;

  constructor(details: SubagentToolResult, theme: ThemeLike) {
    this.details = details;
    this.theme = theme;
  }

  /** 刷新 details + theme 引用（P1a 复用）。theme 必须随更新，否则 /theme 切换后显示错色。 */
  update(details: SubagentToolResult, theme: ThemeLike): void {
    this.details = details;
    this.theme = theme;
  }

  /** 注入 invalidate 回调（renderSubagentResult 从 context 传入）。 */
  setInvalidate(fn: () => void): void {
    this.invalidateFn = fn;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  invalidate(): void {
    // no-op：render 每次从 details 重建，无缓存。
  }

  render(width: number): string[] {
    this.maybeToggleSpinner();
    return this.expanded ? this.renderExpanded(width) : this.renderCompact(width);
  }

  /**
   * 按状态启停 spinner 定时器（FR-8 修复锁死 bug）。
   *   sync running → 启动（持续 onUpdate，需要 spinner 丝滑转动）
   *   其他（bg / list / cancel / terminal）→ 不启动（一次性 block，定时器泄漏会锁死页面）
   *
   *   判断信号：内层 syncResponse.mode === "sync"（非旧 backgroundId）。
   *   旧 bug：poll 返回的 QueryResult 无 backgroundId → spinner 误启动 → setInterval 永久泄漏 → 锁死。
   */
  private maybeToggleSpinner(): void {
    const sync = this.details.syncResponse;
    const isSyncRunning = sync !== undefined && sync.status === "running" && sync.mode === "sync";
    if (isSyncRunning) {
      if (this.spinnerTimer === undefined && this.invalidateFn) {
        this.spinnerTimer = setInterval(() => {
          this.invalidateFn!();
        }, SPINNER_INTERVAL_MS);
      }
    } else if (this.spinnerTimer !== undefined) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
  }

  // ── 压缩视图 ──────────────────────────────────────────────

  private renderCompact(width: number): string[] {
    const d = this.details;
    const theme = this.theme;

    // ── list 分支：表格（每行一个 item 摘要）──
    if (d.action === "list" && d.listResponse) {
      return renderListCompact(d.listResponse, theme, width);
    }
    // ── cancel 分支：确认行 ──
    if (d.action === "cancel" && d.cancelResponse) {
      return [truncLine(
        `${theme.fg("muted", "■")} ${theme.fg("dim", "cancelled ")}${theme.fg("accent", d.subagentId ?? "?")}`,
        width,
      )];
    }
    // ── start 分支：sync / bg ──
    if (d.bgResponse) {
      // bg 占位：一次性 block，不显示 spinner/eventLog。
      return [truncLine(
        `${theme.fg("accent", "●")} ${theme.fg("dim", "background: ")}${theme.fg("accent", d.subagentId ?? "?")}`
        + ` ${theme.fg("dim", "· running detached · will notify on completion")}`,
        width,
      )];
    }
    // sync：从 syncResponse 取字段
    const sync = d.syncResponse;
    if (!sync) return [truncLine(theme.fg("warning", "(subagent: no sync response)"), width)];

    const lines: string[] = [];
    lines.push(truncLine(buildStatusLineFromSync(sync, theme), width));

    // 滚动区：最近 N 条 eventLog（不含 turn_end），running 和 terminal 态统一展示。
    const scrollEntries = foldEntries(sync.eventLog.filter((e) => e.type !== "turn_end"));

    if (sync.status === "running" && sync.currentActivity) {
      const lastEntry = scrollEntries[scrollEntries.length - 1];
      const sameAsLast = lastEntry !== undefined && activityMatchesEntry(sync.currentActivity, lastEntry);
      if (!sameAsLast) {
        lines.push(truncLine(buildActivityLine(sync.currentActivity, theme), width));
      }
    }

    for (const entry of scrollEntries.slice(-COMPACT_SCROLL_LINES)) {
      lines.push(truncLine(`${theme.fg("dim", STREAM_PREFIX)}${formatEventLine(entry, theme)}`, width));
    }

    if (sync.status === "running") {
      lines.push(truncLine(`${theme.fg("dim", FOOTER_PREFIX)}${theme.fg("accent", "Press Ctrl+O for live detail")}`, width));
    } else {
      const delivery = buildDeliveryLineFromSync(sync, theme);
      if (delivery) {
        lines.push(truncLine(`${theme.fg("dim", STREAM_PREFIX)}${delivery}`, width));
      }
    }
    return lines;
  }

  // ── 展开视图 ──────────────────────────────────────────────

  private renderExpanded(width: number): string[] {
    const d = this.details;
    const theme = this.theme;

    if (d.action === "list" && d.listResponse) {
      return renderListExpanded(d.listResponse, theme, width);
    }
    if (d.action === "cancel" && d.cancelResponse) {
      return [truncLine(
        `${theme.fg("muted", "■")} ${theme.fg("dim", "cancelled ")}${theme.fg("accent", d.subagentId ?? "?")}`,
        width,
      )];
    }

    const lines: string[] = [];
    // bg 占位 expanded 与 compact 同（一次性 block 无细节可展开）
    if (d.bgResponse) {
      lines.push(truncLine(
        `${theme.fg("accent", "●")} ${theme.fg("dim", "background: ")}${theme.fg("accent", d.subagentId ?? "?")}`,
        width,
      ));
      return lines;
    }
    const sync = d.syncResponse;
    if (!sync) return [truncLine(theme.fg("warning", "(subagent: no sync response)"), width)];

    // sync expanded：完整 eventLog + 交付物
    lines.push(truncLine(buildStatusLineFromSync(sync, theme), width));
    lines.push("");
    for (const entry of sync.eventLog) {
      lines.push(truncLine(`${theme.fg("dim", STREAM_PREFIX)}${formatEventLine(entry, theme)}`, width));
    }
    const delivery = buildDeliveryLineFromSync(sync, theme);
    if (delivery) {
      lines.push("");
      lines.push(truncLine(`${theme.fg("dim", STREAM_PREFIX)}${delivery}`, width));
    }
    return lines;
  }
}

// ============================================================
// 私有 helper（模块内）
// ============================================================

// extractAgentName / firstLine 已上移到 ./format.ts 共享（tool-render / list-view /
// bg-notify-render / subagent-tool 复用）。

/** 按 action 检查 details 内层分组是否存在（G2-007 guard）。 */
function isDetailsStructurallyComplete(d: SubagentToolResult): boolean {
  switch (d.action) {
    case "start":
      return d.syncResponse !== undefined || d.bgResponse !== undefined;
    case "list":
      return d.listResponse !== undefined;
    case "cancel":
      return d.cancelResponse !== undefined;
    default:
      return false;
  }
}

/**
 * 从 tool result 的 content 里提取错误文本。
 *
 * execute 抛错（如 hub disposed / task 缺失）时，subagents handler 不 catch，
 * Pi 框架会把 error.message 塞进 result.content[0].text。renderResult 的 fallback
 * 分支用它把真实原因显示出来，避免只显「no details available」让 AI 盲猜。
 * content 可能多行，只取首行（用共享 firstLine 裁断 + sanitize）。
 */
function extractResultError(content: AgentToolResult<SubagentToolResult>["content"]): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    const text = getStringText(item);
    if (text) return firstLineSanitized(text);
  }
  return undefined;
}

/** 若 item 是带非空 .text 的对象则返回 text，否则 undefined。 */
function getStringText(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const val = (item as Record<string, unknown>).text;
  return typeof val === "string" && val.trim().length > 0 ? val : undefined;
}

/**
 * 构建 sync 状态行（从 SyncResponse 取字段，删 backgroundId 分支）。
 *
 *   glyph: running → spinner（accent）；done → ✓（success）；failed → ✗（error）；cancelled → ■（muted）
 *   stats: dim `· N turns · Nk · Ns`，各字段 > 0 才显示（全零省略）
 */
function buildStatusLineFromSync(
  s: { status: ExecutionStatus; turns: number; totalTokens: number; elapsedSeconds: number },
  theme: ThemeLike,
): string {
  const glyph = statusGlyph(s.status);
  const icon = glyph.icon ?? spinnerGlyph(Math.floor(Date.now() / SPINNER_INTERVAL_MS));
  const glyphStr = theme.fg(glyph.color, icon);

  const statsStr = buildStats(s, theme);
  const statsPrefix = statsStr ? ` ${theme.fg("dim", "·")} ${statsStr}` : "";

  return `${glyphStr}${statsPrefix}`;
}

/**
 * 构建 stats 字符串：`N turns · Nk · Ns`（零值隐藏，全零返回 ""）。
 * 各字段 dim 色，用 `·` 分隔（spec 分隔符语义：同级并列字段）。
 */
function buildStats(d: { turns: number; totalTokens: number; elapsedSeconds: number }, theme: ThemeLike): string {
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
  const tag = activity.type === "tool" ? "tool:" : activity.type === "thinking" ? "thinking:" : "text:";
  const label = sanitizeLabel(activity.label);
  // thinking 整行 dim（含标签）；其他标签 normal，前缀 dim
  const content = activity.type === "thinking"
    ? theme.fg("dim",`${tag} ${label}`)
    : `${tag} ${label}`;
  return `${theme.fg("dim",STREAM_PREFIX)}${content}`;
}

/**
 * 构建 terminal 态交付物行内容（不含 STREAM_PREFIX，由调用方加）。
 *   done      → result 首行（normal 色）
 *   failed    → `Error: {error 首行}`（error 色）
 *   cancelled → `Cancelled`（dim）
 */
function buildDeliveryLineFromSync(s: SyncResponse, theme: ThemeLike): string | undefined {
  switch (s.status) {
    case "done":
      return firstLineSanitized(s.result) || undefined;
    case "failed":
      return `${theme.fg("error", "Error:")}: ${firstLineSanitized(s.error)}`;
    case "cancelled":
      return theme.fg("dim", "Cancelled");
    default:
      return undefined;
  }
}

/**
 * 取文本首个非空行（多行压成首行展示），并 sanitize。
 * 用于 done/failed 的交付物预览。
 * 共享 firstLine（./format.ts）取首行，本 wrapper 叠加 sanitizeLabel。
 */
function firstLineSanitized(text?: string): string {
  return sanitizeLabel(firstLine(text));
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

/**
 * 折叠连续同类分片（text_output / thinking）为单条代表行。
 *
 * 问题：core 层把流式输出按 100 字符切成多个 chunk push 进 eventLog。
 * 压缩视图逐条显示这些 chunk，结果同一句话被拆成 N 个半句碎片（前 100 字符重复 N 次），可读性差。
 *
 * 解法：相邻且同类（text_output 或 thinking）的分片折叠为 1 条，
 * label 取组内**最后一条**（最新内容，反映流式进展）。被 tool 隔开的同类各自成组。
 *
 *   [text, text, text, tool, text] → [text(末), tool, text(末)]
 *
 * 纯渲染层折叠，不改 eventLog 本身（持久化仍是细粒度）。
 * expanded view 不折叠（那里用户想看完整内容）。
 */
function foldEntries(entries: AgentEventLogEntry[]): AgentEventLogEntry[] {
  const result: AgentEventLogEntry[] = [];
  for (const entry of entries) {
    const last = result[result.length - 1];
    // 相邻同类（text_output 或 thinking）→ 合并，取最新 label + ts
    if (
      last !== undefined &&
      last.type === entry.type &&
      (entry.type === "text_output" || entry.type === "thinking")
    ) {
      // readonly 字段不能 mutate，替换整个元素
      result[result.length - 1] = { ...last, label: entry.label, ts: entry.ts };
    } else {
      result.push({ ...entry });
    }
  }
  return result;
}

// ============================================================
// list 渲染 helper（action:"list" 分支）
// ============================================================

/** list compact：标题行 + 每行一个 item 摘要（glyph + agent + mode + status + duration）。 */
function renderListCompact(resp: ListResponse, theme: ThemeLike, width: number): string[] {
  if (resp.items.length === 0) {
    return [truncLine(theme.fg("dim", `No subagents (running: ${resp.running})`), width)];
  }
  const lines: string[] = [
    truncLine(theme.fg("dim", `Subagents (running: ${resp.running}/${resp.items.length})`), width),
  ];
  for (const it of resp.items) {
    const glyph = statusGlyph(it.status);
    const icon = glyph.icon ?? "●";
    const mode = it.mode === "background" ? "bg" : "sync";
    const line = `${theme.fg(glyph.color, icon)} ${theme.fg("accent", it.agent)}`
      + ` ${theme.fg("dim", `· ${mode} · ${it.status} · ${formatElapsedSeconds(it.duration)}`)}`;
    lines.push(truncLine(`${STREAM_PREFIX}${line}`, width));
  }
  return lines;
}

/** list expanded：compact 基础上每 item 追加 sessionFile 路径行。 */
function renderListExpanded(resp: ListResponse, theme: ThemeLike, width: number): string[] {
  const lines = renderListCompact(resp, theme, width);
  for (const it of resp.items) {
    if (it.sessionFile) {
      lines.push(truncLine(`${theme.fg("dim", `${FOOTER_PREFIX}session: `)}${it.sessionFile}`, width));
    }
  }
  return lines;
}
