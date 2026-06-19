// src/tui/list-view.ts
//
// /subagents list 全屏带框左右分屏 overlay。
//   左列：record 列表（状态图标 + agent + mode + 绝对时长）
//   右列：选中 record 详情（eventLog + result/error，可翻屏）
//
// 布局（margin:1 → 四边距终端 1 行；框贴满 render width）：
//   ╭─ Subagents ───────╮
//   │ filter: _          │
//   ├─ Records ──┬─ Detail ┤
//   │ body ...    │ body ...│  ← pad 到满屏高
//   ├─────────────┴─────────┤
//   │ ↑↓ 导航 ...           │
//   ╰──────────────────────╯
//
// 契约（ctx.ui.custom overlay，对照 pi-tui-development-guide.md §3.2）：
//   custom<void>((tui, theme, kb, done) => Component, {overlay:true, overlayOptions})
//   Component: render(width):string[] + invalidate() + handleInput?(data)
//
// 关键避坑（全部来自 dev guide）：
//   1. G-017 防叠加：模块级 activeView 单例，进入前 close()，factory 内 setActiveView
//   2. 导航只用方向键 matchesKey("up"|"down")，禁 j/k（避 filter 冲突）
//   3. overlay 退出 wrappedDone：幂等→标记→unsubscribe→clearActiveView→done()
//   4. sync record 不调 hub.cancel（会污染状态），UI 层 syncCancelHint 提示
//   5. 不调 theme.bg（背景由 Pi overlay 容器施加），只 fg/bold
//   6. 所有行经 truncLine（ANSI 安全）
//   7. 边框不调 renderShell:"self"（守 default-shell / 无残影契约）

import type { Component } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { SubagentHub } from "../runtime/subagent-hub.ts";
import type { SubagentRecord } from "../types.ts";
import {
  formatElapsedSeconds,
  formatEventLine,
  formatTokens,
  padToVisible,
  sanitizeLabel,
  segFill,
  statusGlyph,
  type ThemeLike,
  truncLine,
} from "./format.ts";

// ============================================================
// 常量
// ============================================================

/** list 收集的 record 上限（足够覆盖一个活跃 session）。 */
const LIST_LIMIT = 100;

/** 左列占比。 */
const LEFT_COL_RATIO = 0.32;
/** 列最小宽度。 */
const COL_MIN_WIDTH = 20;
/** 列内最小内容宽度（兜底防负）。 */
const COL_INNER_MIN = 4;
/** 列内缩进（"→ " 或 "  " 前缀宽度）。 */
const COL_INDENT = 2;
/** 详情区 eventLog 翻屏步长（方向键单步）。 */
const DETAIL_SCROLL_STEP = 1;
/** 详情区 PgUp/PgDn 默认步长（无 viewport 信息时）。 */
const PAGE_SCROLL_DEFAULT = 10;
/** 右列预览的最近 eventLog 条数。 */
const PREVIEW_RECENT_LINES = 3;
/** 秒→毫秒换算。 */
const MS_PER_SECOND = 1000;

// ── 边框常量（与 subagents-old/subagents-view-render.ts 对齐）──
/** 左右边框字符宽度（│ x 2）。 */
const BORDER_WIDTH = 2;
/** 分屏模式下，框内**不滚动**的固定行数（顶框 1 + filter 1 + 分区线 1 + 底分区线 1 + footer 1 + 底框 1）。 */
const SPLIT_FIXED_LINES = 6;
/** 详情模式下，框内**不滚动**的固定行数（顶框 1 + 底分区线 1 + footer 1 + 底框 1）。
 *  元数据/段头/eventLog 都在 content[] 里一起翻屏，故不计固定行。 */
const DETAIL_FIXED_LINES = 4;
/** 详情区可用最小高度。 */
const DETAIL_MIN_VIEWPORT = 3;
/** 终端最小行数（低于此回退紧凑空列表框）。 */
const MIN_TERM_ROWS = 8;
/** overlayOptions.margin:1 上下各占 1 行 → 可用高度需扣 2 行。 */
const OVERLAY_MARGIN_LINES = 2;
/** terminal.rows 读不到时的兜底行数（防 duck-type 失败）。 */
const TERM_ROWS_FALLBACK = 24;
/** 顶框嵌入标题（分屏模式）。 */
const TITLE_SPLIT = "Subagents";
/** 分屏分区线左/右嵌入标题。 */
const TITLE_LEFT = "Records";
const TITLE_RIGHT = "Detail";

/** list 视图内部状态。 */
export interface ViewState {
  selectedIdx: number;
  scrollOffset: number;
  filterText: string;
  detailMode: boolean;
  disposed: boolean;
  /** sync 取消提示（runtime 无法主动 abort sync，提示用户按对话流 Esc）。 */
  syncCancelHint: boolean;
}

/** 详情翻屏上下文（processKey 算步长用）。 */
export interface DetailKeyContext {
  viewportHeight: number;
  contentLines?: number;
}

/** TUI 接口（duck-type：requestRender + terminal.rows）。
 *  terminal.rows 用于全屏框填满 + 详情翻屏步长（同 WorkflowsView.ts:104 cast）。 */
interface TuiLike {
  requestRender(): void;
  terminal: { rows: number };
}

/** 触发外部 notify 的回调（避免 list-view 直接依赖 ctx.ui）。 */
export type NotifyFn = (message: string, type?: "info" | "warning" | "error") => void;

// ============================================================
// G-017：模块级 overlay 单例（防叠加）
// ============================================================

/** 当前活动的 list overlay 句柄（null 表示无）。连按两次快捷键时先 close 前一个。 */
let activeView: { close: () => void } | null = null;

// ============================================================
// overlay 工厂
// ============================================================

/**
 * 创建全屏左右分屏 overlay。
 *
 *   ╔══════════════════════════════════════════════════════════════════╗
 *   ║  1. G-017 防叠加：activeView?.close()                              ║
 *   ║  2. ctx.ui.custom((tui, theme, kb, done) => {                      ║
 *   ║       unsubscribe = hub.onChange(() => tui.requestRender())        ║
 *   ║       activeView = { close: wrappedDone }                          ║
 *   ║       return new SubagentsListComponent(...)                       ║
 *   ║     }, { overlay:true, overlayOptions:{margin:0, width:"100%"}})   ║
 *   ║                                                                    ║
 *   ║  directId 不在 records 中 → notify 警告，仍打开列表                ║
 *   ╚══════════════════════════════════════════════════════════════════╝
 */
export async function createSubagentsView(
  hub: SubagentHub,
  theme: ThemeLike,
  ctx: ExtensionContext,
  directId?: string,
): Promise<void> {
  // G-017：先关前一个 overlay
  if (activeView) {
    activeView.close();
    activeView = null;
  }

  const notify: NotifyFn = (msg, type) => ctx.ui.notify(msg, type);

  // directId 提示
  if (directId) {
    const all = hub.collectRecords(LIST_LIMIT);
    if (!all.some((r) => r.id === directId)) {
      notify(`未找到 id "${directId}"，显示全部列表`, "warning");
    }
  }

  await ctx.ui.custom<void>(
    (tui, _theme, _kb, done) => {
      // duck-type cast：读 terminal.rows 做满屏填高 + 详情翻屏步长
      const tuiLike = tui as TuiLike;
      const state: ViewState = {
        selectedIdx: 0,
        scrollOffset: 0,
        filterText: "",
        detailMode: false,
        disposed: false,
        syncCancelHint: false,
      };

      // 订阅 store 变化 → requestRender（store 驱动重渲）
      const unsubscribe = hub.onChange(() => {
        if (!state.disposed) tuiLike.requestRender();
      });

      // directId 命中 → 进详情模式
      if (directId) {
        const records = hub.collectRecords(LIST_LIMIT);
        const idx = records.findIndex((r) => r.id === directId);
        if (idx >= 0) {
          state.selectedIdx = idx;
          state.detailMode = true;
        }
      }

      const component = new SubagentsListComponent(hub, theme, tuiLike, state, unsubscribe, notify);

      // wrappedDone（dev guide §4 顺序：幂等→标记→unsubscribe→clearActiveView→done）
      const wrappedDone = () => {
        if (state.disposed) return; // 幂等
        state.disposed = true; // ① 标记
        unsubscribe(); // ② 解订 store 事件
        activeView = null; // ③ 清 G-017 句柄
        done(undefined); // ④ 框架 done（触发 overlay 销毁）
      };
      component.setCloseFn(wrappedDone);
      activeView = { close: wrappedDone };

      return component;
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center" as const,
        width: "100%",
        maxHeight: "100%",
        // margin:1 → 四边各留 1 行，框贴满 render width（与终端边缘有 1 行间距）
        margin: 1,
      },
    },
  );
}

// ============================================================
// 按键处理（纯函数，可单测）
// ============================================================

/**
 * 按键处理。两条模式：
 *
 *   ╔══════════════════════════════════════════════════════════════════╗
 *   ║  分屏模式：                                                        ║
 *   ║    Esc 退出（有 filter 先清）/ ↑↓ 导航 / Enter 进详情              ║
 *   ║    Backspace 删 filter / 可打印字符直接 filter                     ║
 *   ║                                                                    ║
 *   ║  详情模式：                                                        ║
 *   ║    Esc 返回 / ↑↓ PgUp/PgDn Home End 翻屏 / x 停止                  ║
 *   ║    x 键：background → hub.cancel(id)（真正 abort）                 ║
 *   ║           sync → 仅 syncCancelHint（runtime 无法主动 abort sync）  ║
 *   ╚══════════════════════════════════════════════════════════════════╝
 *
 * 返回 KeyResult：changed 表示状态变更需重绘；exit 表示调用方应关闭 overlay。
 * 二者正交——Esc 在分屏模式无 filter 时 changed=false + exit=true。
 */
export interface KeyResult {
  /** 状态变更，需 invalidate + requestRender。 */
  changed: boolean;
  /** 调用方应调用 closeFn 关闭 overlay。 */
  exit: boolean;
}

export function processKey(
  data: string,
  records: SubagentRecord[],
  state: ViewState,
  selected: SubagentRecord | null,
  hub: SubagentHub | null,
  detailCtx: DetailKeyContext | undefined,
  notify: NotifyFn | undefined,
): KeyResult {
  // ── 详情模式 ──
  if (state.detailMode) {
    if (matchesKey(data, "escape")) {
      state.detailMode = false;
      state.scrollOffset = 0;
      state.syncCancelHint = false;
      return { changed: true, exit: false };
    }
    if (matchesKey(data, "up")) {
      state.scrollOffset = Math.max(0, state.scrollOffset - DETAIL_SCROLL_STEP);
      return { changed: true, exit: false };
    }
    if (matchesKey(data, "down")) {
      const max = detailScrollMax(detailCtx);
      state.scrollOffset = Math.min(max, state.scrollOffset + DETAIL_SCROLL_STEP);
      return { changed: true, exit: false };
    }
    if (matchesKey(data, "pageUp")) {
      const step = detailCtx?.viewportHeight ?? PAGE_SCROLL_DEFAULT;
      state.scrollOffset = Math.max(0, state.scrollOffset - step);
      return { changed: true, exit: false };
    }
    if (matchesKey(data, "pageDown")) {
      const step = detailCtx?.viewportHeight ?? PAGE_SCROLL_DEFAULT;
      const max = detailScrollMax(detailCtx);
      state.scrollOffset = Math.min(max, state.scrollOffset + step);
      return { changed: true, exit: false };
    }
    if (matchesKey(data, "home")) {
      state.scrollOffset = 0;
      return { changed: true, exit: false };
    }
    if (matchesKey(data, "end")) {
      state.scrollOffset = detailScrollMax(detailCtx);
      return { changed: true, exit: false };
    }
    // x：停止当前 record
    if (data === "x" && selected) {
      const changed = handleCancel(selected, hub, state, notify);
      return { changed, exit: false };
    }
    return { changed: false, exit: false };
  }

  // ── 分屏模式 ──
  if (matchesKey(data, "escape")) {
    // 有 filter 先清（changed）；无 filter → 退出 overlay（exit）
    if (state.filterText.length > 0) {
      state.filterText = "";
      state.selectedIdx = 0;
      return { changed: true, exit: false };
    }
    return { changed: false, exit: true };
  }
  if (matchesKey(data, "up")) {
    state.selectedIdx = Math.max(0, state.selectedIdx - 1);
    return { changed: true, exit: false };
  }
  if (matchesKey(data, "down")) {
    state.selectedIdx = Math.min(Math.max(0, records.length - 1), state.selectedIdx + 1);
    return { changed: true, exit: false };
  }
  if (matchesKey(data, "enter") || matchesKey(data, "return")) {
    if (selected) {
      state.detailMode = true;
      state.scrollOffset = 0;
      state.syncCancelHint = false;
      return { changed: true, exit: false };
    }
    return { changed: false, exit: false };
  }
  if (matchesKey(data, "backspace")) {
    if (state.filterText.length > 0) {
      state.filterText = state.filterText.slice(0, -1);
      state.selectedIdx = 0;
      return { changed: true, exit: false };
    }
    return { changed: false, exit: false };
  }
  // 可打印字符 → filter（单字符 ASCII 可见区）
  if (data.length === 1 && data >= " " && data <= "~") {
    state.filterText += data;
    state.selectedIdx = 0;
    return { changed: true, exit: false };
  }
  return { changed: false, exit: false };
}

/** filter 过滤 + 排序（纯函数，可单测）。 */
export function applyFilter(records: SubagentRecord[], filterText: string): SubagentRecord[] {
  const q = filterText.trim().toLowerCase();
  if (!q) return records;
  return records.filter((r) => {
    return (
      r.agent.toLowerCase().includes(q) ||
      r.status.toLowerCase().includes(q) ||
      r.mode.toLowerCase().includes(q) ||
      r.id.toLowerCase().includes(q)
    );
  });
}

// ============================================================
// Component 实现
// ============================================================

/**
 * 全屏带框左右分屏 list 组件。
 *
 * 不缓存行（records 每次 render 都从 hub.collectRecords 拉最新——保证 store 变化后刷新）。
 * 缓存的是「上次 render 的 width×rows」（用于 invalidate 后强制重建）。
 */
class SubagentsListComponent implements Component {
  private cachedKey: string | undefined;
  private cachedLines: string[] | undefined;
  private closeFn: () => void = () => {};

  constructor(
    private readonly hub: SubagentHub,
    private readonly theme: ThemeLike,
    private readonly tui: TuiLike,
    private readonly state: ViewState,
    private readonly unsubscribe: () => void,
    private readonly notify: NotifyFn,
  ) {}

  setCloseFn(fn: () => void): void {
    this.closeFn = fn;
  }

  invalidate(): void {
    this.cachedKey = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    const rows = this.termRows();
    const key = `${width}x${rows}`;
    if (key === this.cachedKey && this.cachedLines) return this.cachedLines;
    const lines = this.buildLines(width, rows);
    this.cachedKey = key;
    this.cachedLines = lines;
    return lines;
  }

  handleInput(data: string): void {
    if (this.state.disposed) return;

    const records = applyFilter(this.hub.collectRecords(LIST_LIMIT), this.state.filterText);
    const selected = records[this.state.selectedIdx] ?? null;
    // 详情翻屏步长：可用视口高（terminal 高 - margin 行 - 框内固定行）。
    // 与 renderDetailBox 的 viewH 计算保持一致（元数据/段头在 content 里一起翻屏，不算固定）。
    const detailCtx: DetailKeyContext = {
      viewportHeight: Math.max(DETAIL_MIN_VIEWPORT, this.termRows() - OVERLAY_MARGIN_LINES - DETAIL_FIXED_LINES),
      contentLines: selected?.eventLog.length,
    };

    const result = processKey(data, records, this.state, selected, this.hub, detailCtx, this.notify);

    if (result.exit) {
      this.closeFn();
      return;
    }
    if (result.changed) {
      this.invalidate();
      this.tui.requestRender();
    }
  }

  /** 安全读 terminal.rows（兜底防 duck-type 失败）。 */
  private termRows(): number {
    const rows = this.tui.terminal?.rows;
    return typeof rows === "number" && rows > 0 ? rows : TERM_ROWS_FALLBACK;
  }

  // ── 内部：渲染 ──────────────────────────────────────────

  /**
   * 构建行数组（全屏带框）。
   *
   *   width  = render 收到的可用宽（margin:1 → termCols - 2，框正好填满）
   *   rows   = terminal.rows（用于把 body pad 到满屏，让框像真正的全屏面板）
   *
   * 分四个分支：
   *   1. 终端太矮（< MIN_TERM_ROWS）→ 紧凑提示，不画框
   *   2. detailMode → 详情全屏框
   *   3. 空列表 → 紧凑小框（不填满全屏）
   *   4. 有 records → 分屏满屏框
   */
  private buildLines(width: number, rows: number): string[] {
    const records = applyFilter(this.hub.collectRecords(LIST_LIMIT), this.state.filterText);

    // 终端太矮：回退紧凑（不强求满屏，避免框被压缩成一团）
    if (rows < MIN_TERM_ROWS) {
      return this.renderTooSmall(width);
    }

    if (this.state.detailMode) {
      const selected = records[this.state.selectedIdx] ?? null;
      return this.renderDetailBox(selected, width, rows);
    }

    if (records.length === 0) {
      return this.renderEmptyBox(width);
    }

    // clamp selectedIdx（filter 后可能越界）
    this.state.selectedIdx = Math.min(this.state.selectedIdx, records.length - 1);
    return this.renderSplitBox(records, width, rows);
  }

  // ── 分支 1：终端太小 ──────────────────────────────────

  private renderTooSmall(width: number): string[] {
    const t = this.theme;
    const contentWidth = Math.max(1, width - BORDER_WIDTH);
    const inner = `${t.fg("warning", `终端太矮（需 ≥${MIN_TERM_ROWS} 行）`)}`;
    return [
      t.fg("borderMuted", `╭${segFill(undefined, "─", contentWidth)}╮`),
      `│${padToVisible(inner, contentWidth)}│`,
      t.fg("borderMuted", `╰${segFill(undefined, "─", contentWidth)}╯`),
    ];
  }

  // ── 分支 3：空列表紧凑框 ──────────────────────────────

  private renderEmptyBox(width: number): string[] {
    const t = this.theme;
    const contentWidth = Math.max(1, width - BORDER_WIDTH);
    const inner = (s: string) => `│${padToVisible(s, contentWidth)}│`;
    return [
      t.fg("borderMuted", `╭${segFill(t.fg("accent", t.bold(` ${TITLE_SPLIT} `)), "─", contentWidth)}╮`),
      inner(""),
      inner(truncLine(t.fg("dim", "(暂无 subagent 记录)"), contentWidth)),
      inner(""),
      inner(truncLine(t.fg("dim", "Esc 退出"), contentWidth)),
      t.fg("borderMuted", `╰${segFill(undefined, "─", contentWidth)}╯`),
    ];
  }

  // ── 分支 4：分屏满屏框 ────────────────────────────────

  private renderSplitBox(records: SubagentRecord[], width: number, rows: number): string[] {
    const t = this.theme;
    const contentWidth = Math.max(1, width - BORDER_WIDTH);
    // 左右列宽：左按比例，右占余下（减去分隔符 1 列）
    const leftWidth = Math.max(COL_MIN_WIDTH, Math.floor(contentWidth * LEFT_COL_RATIO));
    const rightWidth = Math.max(COL_MIN_WIDTH, contentWidth - leftWidth - 1);

    // 框线着色（borderMuted）+ 左右列分隔符
    const line = (s: string) => t.fg("borderMuted", s);
    const sep = line("│");

    // 满屏可用 body 高 = 终端高 - margin 行 - 固定行（顶框/filter/分区线/底分区线/footer/底框 = 6）
    const bodyH = Math.max(1, rows - OVERLAY_MARGIN_LINES - SPLIT_FIXED_LINES);

    const lines: string[] = [];

    // 顶框（嵌入标题）
    lines.push(line(`╭${segFill(t.fg("accent", t.bold(` ${TITLE_SPLIT} `)), "─", contentWidth)}╮`));

    // filter 行（默认可直接输入：filter: _）
    const filterDisplay = this.state.filterText
      ? `${t.fg("dim", "filter: ")}${t.bold(this.state.filterText)}${t.fg("accent", "_")}`
      : `${t.fg("dim", "filter: ")}${t.fg("accent", "_")}`;
    lines.push(`│${padToVisible(truncLine(filterDisplay, contentWidth), contentWidth)}│`);

    // 分区线（嵌入左/右标题）
    const leftTitle = t.fg("accent", t.bold(` ${TITLE_LEFT} `));
    const rightTitle = t.fg("accent", t.bold(` ${TITLE_RIGHT} `));
    const divLeft = segFill(leftTitle, "─", leftWidth);
    const divRight = segFill(rightTitle, "─", rightWidth);
    lines.push(line(`├${divLeft}┬${divRight}┤`));

    // body：左列 record 列表 + 右列选中预览
    const leftLines = this.renderLeftColumn(records, leftWidth);
    const rightLines = this.renderRightPreview(records[this.state.selectedIdx] ?? null, rightWidth);
    const bodyRows = Math.max(leftLines.length, rightLines.length, bodyH);
    for (let i = 0; i < bodyRows; i++) {
      const l = leftLines[i] ?? "";
      const r = rightLines[i] ?? "";
      const row = `${padToVisible(truncLine(l, leftWidth), leftWidth)}${sep}${padToVisible(truncLine(r, rightWidth), rightWidth)}`;
      lines.push(`│${padToVisible(row, contentWidth)}│`);
    }

    // 底分区线
    lines.push(line(`├${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┤`));

    // footer
    const footer = t.fg("dim", "↑↓ 导航 · Enter 详情 · 字符过滤 · Esc 退出");
    lines.push(`│${padToVisible(truncLine(footer, contentWidth), contentWidth)}│`);

    // 底框
    lines.push(line(`╰${segFill(undefined, "─", contentWidth)}╯`));

    return lines;
  }

  /** 左列：record 列表。 */
  private renderLeftColumn(records: SubagentRecord[], width: number): string[] {
    const t = this.theme;
    const innerWidth = Math.max(COL_INNER_MIN, width - COL_INDENT);
    return records.map((r, i) => {
      const selected = i === this.state.selectedIdx;
      const glyph = statusGlyph(r.status);
      // running 用首帧（overlay 无 setInterval，靠 onChange 触发换帧）
      const icon = glyph.icon ?? "·";
      const iconStr = t.fg(glyph.color, icon);
      const modeTag = r.mode === "background" ? "bg" : "sync";
      // 绝对时长（非相对时间）——避免 overlay 无定时器刷新导致相对时间 stale
      const dur = formatElapsedSeconds(elapsedSec(r));
      const label = `${iconStr} ${r.agent} ${t.fg("dim", modeTag)} ${t.fg("dim", dur)}`;
      const content = selected ? t.fg("accent", label) : label;
      const prefix = selected ? "→ " : "  ";
      return `${prefix}${truncLine(content, innerWidth)}`;
    });
  }

  /** 右列：选中 record 的预览（分屏模式下）。 */
  private renderRightPreview(record: SubagentRecord | null, width: number): string[] {
    const t = this.theme;
    if (!record) return [t.fg("dim", "(无选中)")];

    const lines: string[] = [];
    lines.push(truncLine(`${t.bold(record.agent)} ${t.fg("dim", `· ${record.model}`)}`, width));
    lines.push(truncLine(
      t.fg("dim", `${record.status} · ${record.turns} turns · ${formatTokens(record.totalTokens)} · ${formatElapsedSeconds(elapsedSec(record))}`),
      width,
    ));
    lines.push("");

    // 最近 PREVIEW_RECENT_LINES 条 eventLog 预览
    const recent = record.eventLog.slice(-PREVIEW_RECENT_LINES);
    if (recent.length === 0) {
      lines.push(truncLine(t.fg("dim", "(无执行轨迹——来自历史记录)"), width));
    } else {
      for (const entry of recent) {
        lines.push(truncLine(formatEventLine(entry, t), width));
      }
    }

    lines.push("");
    lines.push(truncLine(t.fg("dim", "Enter 查看完整详情"), width));
    return lines;
  }

  // ── 分支 2：详情全屏框 ────────────────────────────────

  /**
   * 详情视图：完整 eventLog（不折叠）+ result/error + sessionFile。
   *
   *   ╭─ {agent} ──╮
   *   │ 元数据 2 行 │
   *   │ [hint 2 行] │  ← syncCancelHint 时
   *   │             │
   *   │ ── 执行轨迹 ──│
   *   │ logLines ... │  ← scrollOffset 翻屏，pad 到满屏
   *   ├──────────────┤
   *   │ footer       │
   *   ╰──────────────╯
   */
  private renderDetailBox(record: SubagentRecord | null, width: number, rows: number): string[] {
    const t = this.theme;
    const contentWidth = Math.max(1, width - BORDER_WIDTH);
    const line = (s: string) => t.fg("borderMuted", s);

    if (!record) {
      const inner = (s: string) => `│${padToVisible(s, contentWidth)}│`;
      return [
        line(`╭${segFill(t.fg("accent", t.bold(" 详情 ")), "─", contentWidth)}╮`),
        inner(""),
        inner(truncLine(t.fg("dim", "(无选中 record)"), contentWidth)),
        inner(""),
        inner(truncLine(t.fg("dim", "Esc 返回"), contentWidth)),
        line(`╰${segFill(undefined, "─", contentWidth)}╯`),
      ];
    }

    // ── 内容行（先生成全部，再翻屏）──
    const content: string[] = [];

    // 元数据：第 1 行 id + 状态 + turns + tokens
    content.push(truncLine(
      t.fg("dim", `${record.id} · ${record.mode} · ${record.status} · ${record.turns} turns · ${formatTokens(record.totalTokens)}`),
      contentWidth,
    ));
    // 元数据：第 2 行 model + thinking（括号分组）
    const metaParts: string[] = [];
    if (record.model) metaParts.push(record.model);
    if (record.thinkingLevel) metaParts.push(`thinking ${record.thinkingLevel}`);
    if (metaParts.length > 0) {
      content.push(truncLine(t.fg("dim", `(${metaParts.join(" · ")})`), contentWidth));
    } else {
      content.push("");
    }

    // syncCancelHint（占 2 行：空行 + 提示）
    if (this.state.syncCancelHint) {
      content.push("");
      content.push(truncLine(t.fg("warning", "sync subagent 无法在此终止——请按对话流 Esc 终止"), contentWidth));
    }

    content.push("");
    content.push(truncLine(t.fg("accent", t.bold("── 执行轨迹 ──")), contentWidth));

    // eventLog（不折叠）
    if (record.eventLog.length === 0) {
      content.push(truncLine(t.fg("dim", "(无执行轨迹——来自历史记录)"), contentWidth));
    } else {
      for (const entry of record.eventLog) {
        content.push(truncLine(formatEventLine(entry, t), contentWidth));
      }
    }

    // 结果/错误
    if (record.result) {
      content.push("");
      content.push(truncLine(t.fg("accent", "结果:"), contentWidth));
      for (const l of record.result.split("\n")) {
        content.push(truncLine(sanitizeLabel(l), contentWidth));
      }
    }
    if (record.error) {
      content.push("");
      content.push(truncLine(t.fg("error", `Error: ${firstLine(record.error)}`), contentWidth));
    }
    if (record.sessionFile) {
      content.push("");
      content.push(truncLine(t.fg("dim", `session: ${record.sessionFile}`), contentWidth));
    }

    // ── 翻屏 ──
    // 可用视口高 = 终端高 - margin 行 - 框内固定行（顶框/底分区线/footer/底框 = 4）。
    // 元数据/段头/eventLog 都在 content 里一起翻屏，不计固定行。
    const viewH = Math.max(DETAIL_MIN_VIEWPORT, rows - OVERLAY_MARGIN_LINES - DETAIL_FIXED_LINES);
    const max = Math.max(0, content.length - viewH);
    if (this.state.scrollOffset > max) this.state.scrollOffset = max;
    const startIdx = Math.max(0, Math.min(this.state.scrollOffset, max));
    this.state.scrollOffset = startIdx; // 回写收敛（End 越界后下次渲染归位）
    const visible = content.slice(startIdx, startIdx + viewH);

    // ── 组装 ──
    const lines: string[] = [];

    // 顶框（嵌入 agent 名）
    lines.push(line(`╭${segFill(t.fg("accent", t.bold(` ${record.agent} `)), "─", contentWidth)}╮`));

    for (const l of visible) {
      lines.push(`│${padToVisible(l, contentWidth)}│`);
    }
    // pad 到 viewH（框内视口填满）
    while (lines.length < 1 + viewH) {
      lines.push(`│${" ".repeat(contentWidth)}│`);
    }

    // 底分区线 + footer + 底框
    lines.push(line(`├${segFill(undefined, "─", contentWidth)}┤`));
    const canCancel = record.status === "running";
    const cancelHint = canCancel
      ? (record.mode === "background" ? " · x 停止" : " · x 提示停止")
      : "";
    const scrollInfo = content.length > viewH
      ? ` · ${startIdx + 1}-${Math.min(startIdx + viewH, content.length)}/${content.length}`
      : "";
    const footer = t.fg("dim", `Esc 返回 · ↑↓/PgUp/PgDn/Home/End 翻屏${cancelHint}${scrollInfo}`);
    lines.push(`│${padToVisible(truncLine(footer, contentWidth), contentWidth)}│`);
    lines.push(line(`╰${segFill(undefined, "─", contentWidth)}╯`));

    return lines;
  }

  /** dispose 时清理（Pi overlay 销毁时调用）。 */
  dispose(): void {
    this.unsubscribe();
  }
}

// ============================================================
// 内部辅助
// ============================================================

/** 计算 record 已耗时秒（endedAt 优先，否则 now - startedAt）。 */
function elapsedSec(r: SubagentRecord): number {
  const end = r.endedAt ?? Date.now();
  return Math.max(0, Math.floor((end - r.startedAt) / MS_PER_SECOND));
}

/** 详情翻屏最大 offset（contentLines - viewportHeight，兜底 0）。
 *  与 renderDetailBox 的 max 计算保持一致（content.length - viewH）。 */
function detailScrollMax(detailCtx: DetailKeyContext | undefined): number {
  const content = detailCtx?.contentLines ?? 0;
  const viewH = detailCtx?.viewportHeight ?? DETAIL_MIN_VIEWPORT;
  return Math.max(0, content - viewH);
}

/** 处理取消按键（x）。background 真正 abort；sync 仅提示。返回是否变化。 */
function handleCancel(
  record: SubagentRecord,
  hub: SubagentHub | null,
  state: ViewState,
  notify: NotifyFn | undefined,
): boolean {
  if (record.status !== "running") {
    notify?.(`无法停止：record 已 ${record.status}`, "warning");
    return false;
  }
  if (record.mode === "background") {
    if (!hub) {
      notify?.("runtime 未就绪，无法停止", "error");
      return false;
    }
    const ok = hub.cancel(record.id);
    notify?.(ok ? `已请求停止 ${record.id}` : `停止失败（record 可能已结束）`, ok ? "info" : "warning");
    return true;
  }
  // sync：runtime 无法主动 abort（signal 来自 Pi tool 框架），仅提示
  state.syncCancelHint = true;
  notify?.("sync subagent 请按对话流 Esc 终止", "info");
  return true;
}

/** 取文本首个非空行。 */
function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim())?.trim() ?? "";
}
