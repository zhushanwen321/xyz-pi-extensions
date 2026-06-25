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
  ExecutionStatus,
  ListResponse,
  SubagentToolResult,
  SyncResponse,
} from "../types.ts";
import {
  extractAgentName,
  firstLine,
  formatElapsedSeconds,
  formatTokens,
  formatToolEventPairs,
  sanitizeLabel,
  spinnerGlyph,
  statusGlyph,
  tailFixedLines,
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

/**
 * spinner 帧间隔（ms）。对齐 Pi 原生 Loader 的 DEFAULT_INTERVAL_MS=80（loader.ts:12）——
 * 10 帧 × 80ms = 800ms 转一圈（约 1.25 转/秒），与 Pi working 指示器视觉一致。
 *
 * 同时用于两处：maybeToggleSpinner 的 setInterval（驱动 invalidate 重绘换帧）+
 * buildStatusLineFromSync 的 Date.now()/SPINNER_INTERVAL_MS 选帧。两者用同一常量保证
 * 每次 invalidate 都恰好转一帧（setInterval 节奏 = 选帧粒度）。
 */
const SPINNER_INTERVAL_MS = 80;

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
   *
   *   Defense-in-depth（第二层守卫，BL-6/TS-2/TS-4）：第一层在 subagent-service.ts execute()
   *   的 B1 守卫——background 路径 onUpdate 被置 undefined，bg 事件不会回流 tool 层。
   *   此处 mode === "sync" 是冗余守卫——若未来 B1 被误删，这里仍能阻断 bg 事件启动 spinner。
   *   不要删此 gate 除非 B1 守卫有强测试覆盖且不可变。
   */
  private maybeToggleSpinner(): void {
    const sync = "syncResponse" in this.details ? this.details.syncResponse : undefined;
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
    if ("bgResponse" in d) {
      // bg 占位：一次性 block，不显示 spinner/eventLog。
      return [truncLine(
        `${theme.fg("accent", "●")} ${theme.fg("dim", "background: ")}${theme.fg("accent", d.subagentId ?? "?")}`
        + ` ${theme.fg("dim", "· running detached · will notify on completion")}`,
        width,
      )];
    }
    // sync：从 syncResponse 取字段
    if (!("syncResponse" in d)) return [truncLine(theme.fg("warning", "(subagent: no sync response)"), width)];
    const sync = d.syncResponse;

    const lines: string[] = [];
    lines.push(truncLine(buildStatusLineFromSync(sync, theme), width));

    // 滚动区：固定高度窗口（对齐 Pi bash 的行数稳定语义）。
    // 单源设计：eventLog 已含 thinking/text 条目（与 tool 同构），不再有 currentActivity 独立出口。
    // 用 formatToolEventPairs 折叠 tool 对（每个 tool 1 行 + ✓/✗），thinking/text 条目原样保留。
    // 取尾部 COMPACT_SCROLL_LINES 行，不足 pad dim 空行 → 行数恒定，达到最大后只滚动更新。
    const scrollEntries = sync.eventLog.filter((e) => e.type !== "turn_end");
    const stream = formatToolEventPairs(scrollEntries, theme);
    // 加 ⎿ 前缀后交 tailFixedLines 取尾部 N 行 + pad（pad 空行用同样前缀对齐缩进列）
    const prefixed = stream.map((l) => `${theme.fg("dim", STREAM_PREFIX)}${l}`);
    for (const line of tailFixedLines(prefixed, COMPACT_SCROLL_LINES, STREAM_PREFIX, theme)) {
      lines.push(truncLine(line, width));
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
    if ("bgResponse" in d) {
      lines.push(truncLine(
        `${theme.fg("accent", "●")} ${theme.fg("dim", "background: ")}${theme.fg("accent", d.subagentId ?? "?")}`,
        width,
      ));
      return lines;
    }
    if (!("syncResponse" in d)) return [truncLine(theme.fg("warning", "(subagent: no sync response)"), width)];
    const sync = d.syncResponse;

    // sync expanded：完整 eventLog（从 turns[] 派生，离散语义事件）+ 交付物。
    // tool_start/tool_end 对折叠成 1 行（每个 tool 一行，尾部 ✓/✗）；turn_end 原样保留。
    lines.push(truncLine(buildStatusLineFromSync(sync, theme), width));
    lines.push("");
    for (const line of formatToolEventPairs(sync.eventLog, theme)) {
      lines.push(truncLine(`${theme.fg("dim", STREAM_PREFIX)}${line}`, width));
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
      return "syncResponse" in d || "bgResponse" in d;
    case "list":
      return "listResponse" in d;
    case "cancel":
      return "cancelResponse" in d;
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
  s: {
    status: ExecutionStatus;
    turns: number;
    totalTokens: number;
    elapsedSeconds: number;
    model?: string;
    thinkingLevel?: string;
  },
  theme: ThemeLike,
): string {
  const glyph = statusGlyph(s.status);
  const icon = glyph.icon ?? spinnerGlyph(Math.floor(Date.now() / SPINNER_INTERVAL_MS));
  const glyphStr = theme.fg(glyph.color, icon);

  // model 信息：紧跟 glyph 后，accent 色（与 renderCall 标题行一致），让用户
  // 在运行中/结束时都能看到「用什么模型」。[HISTORICAL] 此前 SyncResponse
  // 已带 model 但 buildStatusLineFromSync 参数写窄未取，导致 result 区从不显示 model。
  const modelStr = s.model ? theme.fg("accent", s.model) : "";
  const thinkingStr = s.thinkingLevel ? theme.fg("dim", `· thinking ${s.thinkingLevel}`) : "";
  const modelPart = modelStr ? ` ${modelStr}${thinkingStr ? ` ${thinkingStr}` : ""}` : "";

  const statsStr = buildStats(s, theme);
  const statsPrefix = statsStr ? ` ${theme.fg("dim", "·")} ${statsStr}` : "";

  return `${glyphStr}${modelPart}${statsPrefix}`;
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
