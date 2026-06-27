// src/tui/list-view.ts
//
// /subagents list 全屏带框左右分屏 overlay。
//   左列：record 列表（状态图标 + agent + mode + 绝对时长）
//   右列：选中 record 详情（eventLog + result/error，可翻屏）
//
// 布局（margin:0 全屏覆盖，自画视觉边距盖住底下对话流）：
//   overlay 覆盖整个终端；框外留 1 行/1 列空白（applyPadding 画），框在内侧。
//     ┌────────────────────────────┐  ← overlay 顶空白行（盖底下）
//     │  ╭─ Subagents ───────────╮  │  ← 左 1 空格 + 框 + 右 1 空格
//     │  │ filter: _              │  │
//     │  ├─ Records ─┬─ Detail ───┤  │
//     │  │ body ...   │ body ...   │  │
//     │  ├────────────┴────────────┤  │
//     │  │ ↑↓ 导航 ...             │  │
//     │  ╰─────────────────────────╯  │
//     └────────────────────────────┘  ← overlay 底空白行
//   （外层框线仅为示意，实际是空白行/空格列）
//
// 契约（ctx.ui.custom overlay，对照 pi-tui-development-guide.md §3.2）：
//   custom<void>((tui, theme, kb, done) => Component, {overlay:true, overlayOptions})
//   Component: render(width):string[] + invalidate() + handleInput?(data)
//
// 关键避坑：
//   1. G-017 防叠加：模块级 activeView 单例，进入前 close()，factory 内 setActiveView
//   2. 导航只用方向键 matchesKey("up"|"down")，禁 j/k（避 filter 冲突）
//   3. overlay 退出 wrappedDone：幂等→标记→unsubscribe→clearAnimTimer→clearActiveView→done
//   4. sync record 不调 service.cancel（会污染状态），UI 层 syncCancelHint 提示
//   5. 不调 theme.bg（背景由 Pi overlay 容器施加），只 fg/bold
//   6. 所有行经 truncLine（ANSI 安全）
//   7. 边框不调 renderShell:"self"（守 default-shell / 无残影契约）
//   8. 不用 Pi 的 overlay margin（那是物理留白会透出底内容）——改 margin:0 全屏覆盖
//      + applyPadding 自画视觉边距（顶底空白行 + 左右空格列），盖住底下对话流
//   9. 动画 setInterval(250ms) 安全：行数恒定（pad 到满屏），diff 只重画 spinner/elapsed

import type { Component } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { computeElapsedSeconds } from "../core/execution-record.ts";
import type { SubagentService } from "../runtime/subagent-service.ts";
import type { SubagentRecord } from "../types.ts";
import {
  firstLine,
  formatElapsedSeconds,
  formatTokens,
  formatToolEventPairs,
  padToVisible,
  sanitizeLabel,
  segFillColored,
  spinnerGlyph,
  statusGlyph,
  tailFixedLines,
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

// ── 边框常量 ──
/** 左右边框字符宽度（│ x 2）。 */
const BORDER_WIDTH = 2;
/** 分屏模式下，框内**不滚动**的固定行数（顶框 1 + filter 1 + 分区线 1 + 底分区线 1 + footer 1 + 底框 1）。 */
const SPLIT_FIXED_LINES = 6;
/** 终端最小行数（低于此回退紧凑空列表框）。 */
const MIN_TERM_ROWS = 8;
/** terminal.rows 读不到时的兜底行数（防 duck-type 失败）。 */
const TERM_ROWS_FALLBACK = 24;
/** 自画视觉边距：框外左右各 1 列空白（盖住底下对话流）。 */
const PAD_COLS = 2;
/** 自画视觉边距：框外顶底各 1 行空白。 */
const PAD_ROWS = 2;
/** 内框最小宽（兜底防极窄终端）。 */
const MIN_INNER_WIDTH = 4;
/** 内框最小高（兜底防极矮终端）。 */
const MIN_INNER_ROWS = 4;
/** 详情内容总行数探测宽度（够大避免截断折行影响行数统计）。 */
const DETAIL_LEN_PROBE_WIDTH = 9999;
/** 垂直居中除数（floor(剩余/2)）。 */
const VERT_CENTER_DIVISOR = 2;
/**
 * overlay 动画刷新间隔（spinner 换帧 + elapsed 跳动）。
 * 对齐 tool-render.ts SPINNER_INTERVAL_MS=80（同 Pi Loader DEFAULT_INTERVAL_MS）。
 * 80ms 刷新 elapsed（秒级）无视觉影响——diff 引擎秒数不变就不重绘。
 */
const OVERLAY_REFRESH_MS = 80;
/** spinner 帧切换粒度（与 Date.now() 配合选帧）。对齐 SPINNER_INTERVAL_MS。 */
const SPINNER_FRAME_MS = 80;
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
// G-017：防叠加 overlay 句柄（session 隔离）
// ============================================================
// ponytail: 用 const Map 而非 let 单例，按 sessionId 索引实现 session 隔离
// （同进程多 session 不会互相清掉对方的 overlay）。session_shutdown 钩子清理防泄漏。
const activeViews = new Map<string, { close: () => void }>();

/** 获取指定 session 的活动 overlay 句柄（null 表示无）。 */
function getActiveView(sessionId: string): { close: () => void } | null {
  return activeViews.get(sessionId) ?? null;
}

/** 设置指定 session 的活动 overlay 句柄。 */
function setActiveView(sessionId: string, view: { close: () => void } | null): void {
  if (view) activeViews.set(sessionId, view);
  else activeViews.delete(sessionId);
}

/** session 结束时清理句柄（防 Map 泄漏）。 */
export function clearActiveViewOnShutdown(sessionId: string): void {
  activeViews.delete(sessionId);
}

// ============================================================
// overlay 工厂
// ============================================================

/**
 * 创建全屏左右分屏 overlay。
 *
 *   ╔══════════════════════════════════════════════════════════════════╗
 *   ║  1. G-017 防叠加：activeView?.close()                              ║
 *   ║  2. ctx.ui.custom((tui, theme, kb, done) => {                      ║
 *   ║       unsubscribe = service.onChange(() => tui.requestRender())  ║
 *   ║       activeView = { close: wrappedDone }                          ║
 *   ║       return new SubagentsListComponent(...)                       ║
 *   ║     }, { overlay:true, overlayOptions:{margin:0, width:"100%"}})   ║
 *   ║                                                                    ║
 *   ║  directId 不在 records 中 → notify 警告，仍打开列表                ║
 *   ╚══════════════════════════════════════════════════════════════════╝
 */
export async function createSubagentsView(
  service: SubagentService,
  theme: ThemeLike,
  ctx: ExtensionContext,
  directId?: string,
): Promise<void> {
  const sessionId = ctx.sessionManager.getSessionId();
  // G-017：先关前一个 overlay（session 级隔离）
  const prev = getActiveView(sessionId);
  if (prev) {
    prev.close();
    setActiveView(sessionId, null);
  }

  const notify: NotifyFn = (msg, type) => ctx.ui.notify(msg, type);

  // directId 提示
  if (directId) {
    const all = service.collectRecords(LIST_LIMIT);
    if (!all.some((r) => r.id === directId)) {
      notify(`No record found for id "${directId}", showing all`, "warning");
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
      const unsubscribe = service.onChange(() => {
        if (!state.disposed) tuiLike.requestRender();
      });

      // directId 命中 → 进详情模式（右侧就地展开，底部对齐）
      if (directId) {
        const records = service.collectRecords(LIST_LIMIT);
        const idx = records.findIndex((r) => r.id === directId);
        if (idx >= 0) {
          state.selectedIdx = idx;
          state.detailMode = true;
          state.scrollOffset = Number.MAX_SAFE_INTEGER; // 底部对齐，render clamp 收敛
        }
      }

      const component = new SubagentsListComponent(service, theme, tuiLike, state, unsubscribe, notify);

      // 动画 timer：有 running record 时定期 invalidate + requestRender，
      // 让 spinner 丝滑换帧、elapsed 实时跳动（行数恒定，安全——对照
      // tool-render.ts 的 setInterval 模式 + dev guide §8160a5d13 安全分析）。
      const animTimer = setInterval(() => {
        if (state.disposed) return;
        if (!component.hasRunning()) return; // 无 running 不浪费刷新
        component.invalidate();
        tuiLike.requestRender();
      }, OVERLAY_REFRESH_MS);
      component.setAnimTimer(animTimer);

      // wrappedDone（dev guide §4 顺序：幂等→标记→unsubscribe→clearAnimTimer→clearActiveView→done）
      const wrappedDone = () => {
        if (state.disposed) return; // 幂等
        state.disposed = true; // ① 标记
        unsubscribe(); // ② 解订 store 事件
        clearInterval(animTimer); // ③ 清动画 timer
        setActiveView(sessionId, null); // ④ 清 G-017 句柄（session 级）
        done(undefined); // ⑤ 框架 done（触发 overlay 销毁）
      };
      component.setCloseFn(wrappedDone);
      setActiveView(sessionId, { close: wrappedDone });

      return component;
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center" as const,
        width: "100%",
        maxHeight: "100%",
        // margin:0 → overlay 覆盖整个终端（不留物理空白）。
        // 视觉边距由 buildLines 自画（顶底空白行 + 左右空格列），盖住底下对话流。
        // Pi 的 margin 是「物理留白透出底内容」，这里不能用。
        margin: 0,
      },
    },
  );
}

// ============================================================
// 按键处理（纯函数，可单测）
// ============================================================

/**
 * 按键处理。两阶段焦点（detailMode 控制）：
 *
 *   ╔══════════════════════════════════════════════════════════════════╗
//   ║  阶段 1（list 焦点，detailMode=false）：                            ║
//   ║    Esc 退出（有 filter 先清）/ ↑↓ 导航左列 / Enter 进阶段 2         ║
//   ║    Backspace 删 filter / 可打印字符直接 filter                     ║
//   ║                                                                    ║
//   ║  阶段 2（detail 焦点，detailMode=true）：左侧锚定，滚右侧详情       ║
//   ║    Esc 返回阶段 1 / ↑↓ PgUp/PgDn Home End 滚右侧 eventLog          ║
//   ║    x 停止：background → service.cancel(id)（真正 abort）         ║
//   ║             sync → 仅 syncCancelHint（runtime 无法主动 abort sync） ║
//   ╚══════════════════════════════════════════════════════════════════╝
 *
 * 返回 KeyResult：changed 表示状态变更需重绘；exit 表示调用方应关闭 overlay。
 * 二者正交——Esc 在阶段 1 无 filter 时 changed=false + exit=true。
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
  service: SubagentService | null,
  detailCtx: DetailKeyContext | undefined,
  notify: NotifyFn | undefined,
): KeyResult {
  // ── 阶段 2（detail 焦点，detailMode=true）：左侧锚定，滚右侧详情 ──
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
      const changed = handleCancel(selected, service, state, notify);
      return { changed, exit: false };
    }
    return { changed: false, exit: false };
  }

  // ── 阶段 1（list 焦点，detailMode=false）：↑↓ 导航左列 ──
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
      // 底部对齐：设大值，renderRightDetail 的 clamp 收敛到 max（最新在底，向上看历史）
      state.scrollOffset = Number.MAX_SAFE_INTEGER;
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
 * 不缓存行（records 每次 render 都从 service.collectRecords 拉最新——保证 store 变化后刷新）。
 * 缓存的是「上次 render 的 width×rows」（用于 invalidate 后强制重建）。
 */
class SubagentsListComponent implements Component {
  private cachedKey: string | undefined;
  private cachedLines: string[] | undefined;
  private closeFn: () => void = () => {};
  /** 动画 timer 句柄（dispose 兜底清理）。 */
  private animTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly service: SubagentService,
    private readonly theme: ThemeLike,
    private readonly tui: TuiLike,
    private readonly state: ViewState,
    private readonly unsubscribe: () => void,
    private readonly notify: NotifyFn,
  ) {}

  setCloseFn(fn: () => void): void {
    this.closeFn = fn;
  }

  /** 注入动画 timer 句柄（dispose 兜底清理用）。 */
  setAnimTimer(timer: ReturnType<typeof setInterval>): void {
    this.animTimer = timer;
  }

  /** 是否有 running record（动画 timer 据此决定是否刷新）。 */
  hasRunning(): boolean {
    return this.service.collectRecords(LIST_LIMIT).some((r) => r.status === "running");
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

    const records = applyFilter(this.service.collectRecords(LIST_LIMIT), this.state.filterText);
    const selected = records[this.state.selectedIdx] ?? null;
    // 详情翻屏上下文：视口高 = 右侧 body 高（内框高 - SPLIT_FIXED_LINES），
    // contentLines = 详情内容总行数（含元数据/段头/eventLog/result/error，单一数据源）。
    // 与 renderRightDetail 的 viewH + max 计算保持一致。
    const innerRows = Math.max(MIN_INNER_ROWS, this.termRows() - PAD_ROWS);
    const bodyH = Math.max(1, innerRows - SPLIT_FIXED_LINES);
    const detailCtx: DetailKeyContext = {
      viewportHeight: bodyH,
      contentLines: selected ? this.detailContentLength(selected) : 0,
    };

    const result = processKey(data, records, this.state, selected, this.service, detailCtx, this.notify);

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
   * 构建行数组（全屏覆盖 + 自画视觉边距）。
   *
   *   width  = render 收到的全屏宽（margin:0 → termCols，overlay 覆盖整个终端）
   *   rows   = terminal.rows（满屏高）
   *
   * overlay 不用 Pi 的 margin（那是物理留白会透出底下内容），改 margin:0 全屏覆盖，
   * 自己在框外加 1 行/1 列空白（盖住底下的对话流）：
   *   - 每行：` ` + 框行 + ` `（左右各 1 空格视觉边距）
   *   - 顶/底：各 1 行全宽空白
   *   - 内框宽 = width - 2（左右边距），内框高 = rows - 2（顶底边距）
   *
   * 分三个分支（基于内框尺寸）：
   *   1. 终端太矮（< MIN_TERM_ROWS）→ 紧凑提示，不画框
   *   2. 空列表 → 紧凑小框（不填满全屏）
   *   3. 有 records → 分屏满屏框（detailMode 控制右侧预览 vs 完整翻屏，不再切全屏页）
   */
  private buildLines(width: number, rows: number): string[] {
    // 内框尺寸（减去左右 1 列 + 顶底 1 行的视觉边距）
    const innerWidth = Math.max(MIN_INNER_WIDTH, width - PAD_COLS);
    const innerRows = Math.max(MIN_INNER_ROWS, rows - PAD_ROWS);

    const allRecords = this.service.collectRecords(LIST_LIMIT);
    const records = applyFilter(allRecords, this.state.filterText);

    // 先在内框尺寸下生成框行
    let innerLines: string[];
    if (rows < MIN_TERM_ROWS) {
      innerLines = this.renderTooSmall(innerWidth);
    } else if (allRecords.length === 0) {
      // 真正的空列表（无任何 subagent）→ 紧凑小框
      innerLines = this.renderEmptyBox(innerWidth);
    } else {
      // 有 records（即使 filter 无匹配，也保留分屏布局——只清空左右内容区）
      this.state.selectedIdx = Math.min(this.state.selectedIdx, Math.max(0, records.length - 1));
      innerLines = this.renderSplitBox(records, innerWidth, innerRows);
    }

    return this.applyPadding(innerLines, width, rows);
  }

  /**
   * 给内框行套视觉边距并填满全屏：顶/底各加空白行直到满屏高，每行加左右 1 空格。
   * 这些空白是 overlay 自己画的（盖住底下对话流），区别于 Pi 的物理 margin（透出底内容）。
   * 紧凑框（空列表/太矮）也会被空白填满全屏——保证整个终端被 overlay 覆盖。
   */
  private applyPadding(innerLines: string[], width: number, rows: number): string[] {
    const blank = " ".repeat(width);
    // 左右各加 1 空格的边距行（内框行 visibleWidth 已 = width - 2）
    const padLine = (line: string) => ` ${line} `;
    const result: string[] = [];
    // 顶部空白填满（紧凑框时把框垂直居中）
    const topPad = Math.max(1, Math.floor((rows - innerLines.length) / VERT_CENTER_DIVISOR));
    for (let i = 0; i < topPad; i++) result.push(blank);
    for (const line of innerLines) result.push(padLine(line));
    // 底部空白填满到 rows
    while (result.length < rows) result.push(blank);
    return result;
  }

  // ── 边框着色 helper（统一 borderMuted，避 ANSI 嵌套失色）──

  /** 着色框线字符（borderMuted）。所有 ╭╮╰╯├┤┬┴─│ 统一走这里。 */
  private b(s: string): string {
    return this.theme.fg("borderMuted", s);
  }
  /** 着色单字符填充用的 `─`（供 segFillColored 的 fillStyled）。 */
  private dash(): string {
    return this.theme.fg("borderMuted", "─");
  }
  /** 满宽 `─` 填充串（borderMuted）。n 次单字符着色，ANSI 自然延续。 */
  private dashes(n: number): string {
    return this.dash().repeat(Math.max(0, n));
  }
  /** 顶/底框行：`╭` + 着色标题填充 + `╮`（或 ╰╯）。每段独立着色，无嵌套。 */
  private titleBorder(left: string, titleStyled: string, right: string, contentWidth: number): string {
    return this.b(left) + segFillColored(titleStyled, this.dash(), contentWidth) + this.b(right);
  }
  /** 纯线顶/底框（无标题）：`╭` + `─`×W + `╮`。 */
  private plainBorder(left: string, right: string, contentWidth: number): string {
    return this.b(left) + this.dashes(contentWidth) + this.b(right);
  }
  /** 内容行墙：`│` + 内容(pad 到 contentWidth) + `│`，墙字符 borderMuted。 */
  private walled(content: string, contentWidth: number): string {
    return `${this.b("│")}${padToVisible(content, contentWidth)}${this.b("│")}`;
  }

  // ── 分支 1：终端太小 ──────────────────────────────────

  private renderTooSmall(width: number): string[] {
    const t = this.theme;
    const contentWidth = Math.max(1, width - BORDER_WIDTH);
    const msg = t.fg("warning", `Terminal too small (need >=${MIN_TERM_ROWS} rows)`);
    return [
      this.plainBorder("╭", "╮", contentWidth),
      this.walled(padToVisible(msg, contentWidth), contentWidth),
      this.plainBorder("╰", "╯", contentWidth),
    ];
  }

  // ── 分支 2：空列表紧凑框 ──────────────────────────────

  private renderEmptyBox(width: number): string[] {
    const t = this.theme;
    const contentWidth = Math.max(1, width - BORDER_WIDTH);
    const title = t.fg("accent", t.bold(` ${TITLE_SPLIT} `));
    return [
      this.titleBorder("╭", title, "╮", contentWidth),
      this.walled("", contentWidth),
      this.walled(truncLine(t.fg("dim", "(no subagent records)"), contentWidth), contentWidth),
      this.walled("", contentWidth),
      this.walled(truncLine(t.fg("dim", "Esc to exit"), contentWidth), contentWidth),
      this.plainBorder("╰", "╯", contentWidth),
    ];
  }

  // ── 分支 3：分屏满屏框（detailMode 控制右侧预览 vs 完整翻屏）──

  private renderSplitBox(records: SubagentRecord[], width: number, rows: number): string[] {
    const t = this.theme;
    const contentWidth = Math.max(1, width - BORDER_WIDTH);
    // 左右列宽：左按比例，右占余下（减去分隔符 1 列）
    const leftWidth = Math.max(COL_MIN_WIDTH, Math.floor(contentWidth * LEFT_COL_RATIO));
    const rightWidth = Math.max(COL_MIN_WIDTH, contentWidth - leftWidth - 1);
    const sep = this.b("│");

    // 满屏可用 body 高 = 内框高 - 固定行（顶框/filter/分区线/底分区线/footer/底框 = 6）
    // rows 参数已是内框高（顶底空白边距已在 buildLines 扣除）。
    const bodyH = Math.max(1, rows - SPLIT_FIXED_LINES);

    const selected = records[this.state.selectedIdx] ?? null;
    const inDetail = this.state.detailMode; // 阶段 2：右侧滚动焦点

    const lines: string[] = [];

    // 顶框（嵌入标题，分段着色）
    lines.push(this.titleBorder("╭", t.fg("accent", t.bold(` ${TITLE_SPLIT} `)), "╮", contentWidth));

    // filter 行（阶段 2 时隐藏 filter 提示，显示锚定提示）
    const filterLine = inDetail
      ? t.fg("dim", `Pinned: ${selected?.agent ?? ""} · Esc to return to list`)
      : (this.state.filterText
        ? `${t.fg("dim", "filter: ")}${t.bold(this.state.filterText)}${t.fg("accent", "_")}`
        : `${t.fg("dim", "filter: ")}${t.fg("accent", "_")}`);
    lines.push(this.walled(padToVisible(truncLine(filterLine, contentWidth), contentWidth), contentWidth));

    // 分区线（嵌入左/右标题，分段着色）
    const leftTitleStyled = t.fg("accent", t.bold(` ${TITLE_LEFT} `));
    const rightTitleStyled = inDetail
      ? t.fg("accent", t.bold(` ${TITLE_RIGHT}${this.detailScrollInfo(selected, bodyH)} `))
      : t.fg("accent", t.bold(` ${TITLE_RIGHT} `));
    lines.push(
      this.b("├") + segFillColored(leftTitleStyled, this.dash(), leftWidth)
      + this.b("┬") + segFillColored(rightTitleStyled, this.dash(), rightWidth) + this.b("┤"),
    );

    // body：左列 record 列表 + 右列（预览 or 完整翻屏）
    let leftLines: string[];
    let rightLines: string[];
    if (records.length === 0) {
      // filter 无匹配：保留分屏布局，左右都显示提示
      leftLines = [t.fg("dim", `(no match for "${this.state.filterText}")`)];
      rightLines = [t.fg("dim", "(no record selected)")];
    } else {
      leftLines = this.renderLeftColumn(records, leftWidth);
      rightLines = inDetail
        ? this.renderRightDetail(selected, rightWidth, bodyH)
        : this.renderRightPreview(selected, rightWidth);
    }
    const bodyRows = Math.max(leftLines.length, rightLines.length, bodyH);
    for (let i = 0; i < bodyRows; i++) {
      const l = leftLines[i] ?? "";
      const r = rightLines[i] ?? "";
      const row = `${padToVisible(truncLine(l, leftWidth), leftWidth)}${sep}${padToVisible(truncLine(r, rightWidth), rightWidth)}`;
      lines.push(this.walled(padToVisible(row, contentWidth), contentWidth));
    }

    // 底分区线
    lines.push(this.b("├") + this.dashes(leftWidth) + this.b("┴") + this.dashes(rightWidth) + this.b("┤"));

    // footer（双文案）
    const footer = inDetail
      ? t.fg("dim", "Esc back to list · Up/Dn/PgUp/PgDn/Home/End scroll detail" + this.cancelHint(selected))
      : t.fg("dim", "Up/Dn navigate · Enter detail · type to filter · Esc exit");
    lines.push(this.walled(padToVisible(truncLine(footer, contentWidth), contentWidth), contentWidth));

    // 底框
    lines.push(this.plainBorder("╰", "╯", contentWidth));

    return lines;
  }

  /** 详情模式滚动位置指示（嵌入分区线标题），如 "Detail (5-12/30)"。无内容则空。 */
  private detailScrollInfo(record: SubagentRecord | null, viewH: number): string {
    if (!record) return "";
    const contentLen = this.detailContentLength(record);
    if (contentLen <= viewH) return ""; // 内容一屏装下，不显示
    const max = Math.max(0, contentLen - viewH);
    const start = Math.max(0, Math.min(this.state.scrollOffset, max));
    const end = Math.min(start + viewH, contentLen);
    return ` (${start + 1}-${end}/${contentLen})`;
  }

  /** footer 的取消提示（仅 running 时显示）。 */
  private cancelHint(record: SubagentRecord | null): string {
    if (!record || record.status !== "running") return "";
    return record.mode === "background" ? " · x stop" : " · x stop (hint)";
  }

  /** 左列：record 列表。阶段 2（detailMode）时非锚定行 dim，锚定行用 ▶。 */
  private renderLeftColumn(records: SubagentRecord[], width: number): string[] {
    const t = this.theme;
    const innerWidth = Math.max(COL_INNER_MIN, width - COL_INDENT);
    const inDetail = this.state.detailMode;
    // spinner 当前帧（Date.now() 驱动；animTimer 定期 invalidate → render 重选帧）
    const spinFrame = spinnerGlyph(Math.floor(Date.now() / SPINNER_FRAME_MS));
    return records.map((r, i) => {
      const selected = i === this.state.selectedIdx;
      const glyph = statusGlyph(r.status);
      const icon = glyph.icon ?? spinFrame;
      const iconStr = t.fg(glyph.color, icon);
      const modeTag = r.mode === "background" ? "bg" : "sync";
      const dur = formatElapsedSeconds(elapsedSec(r));
      const label = `${iconStr} ${r.agent} ${t.fg("dim", modeTag)} ${t.fg("dim", dur)}`;
      // 阶段 2：锚定行 accent + ▶；其余行 dim。阶段 1：选中 accent + →，其余正常。
      const content = inDetail
        ? (selected ? t.fg("accent", label) : t.fg("dim", label))
        : (selected ? t.fg("accent", label) : label);
      const prefix = selected ? (inDetail ? "▶ " : "→ ") : "  ";
      return `${prefix}${truncLine(content, innerWidth)}`;
    });
  }

  /** 右列：选中 record 的预览（阶段 1）。 */
  private renderRightPreview(record: SubagentRecord | null, width: number): string[] {
    const t = this.theme;
    if (!record) return [t.fg("dim", "(no record selected)")];

    const lines: string[] = [];
    lines.push(truncLine(`${t.bold(record.agent)} ${t.fg("dim", `· ${record.model}`)}`, width));
    lines.push(truncLine(
      t.fg("dim", `${record.status} · ${record.turns} turns · ${formatTokens(record.totalTokens)} · ${formatElapsedSeconds(elapsedSec(record))}`),
      width,
    ));
    lines.push("");

    // eventLog 现从 turns[] 派生（离散语义事件，无碎片）。
    // 固定高度窗口（对齐 tool-render compact）：fold tool 对后取尾部 PREVIEW_RECENT_LINES 行，
    // 不足 pad dim 空行 → eventLog 区行数恒定，running record 推进时右列不抖动。
    // 空事件单独处理（显示 (no events) 提示而非 pad 空行——空态有专门文案更友好）。
    const recent = record.eventLog.slice(0); // 全量 fold 后再取尾部（窗口含 fold 合并效果）
    if (recent.length === 0) {
      lines.push(truncLine(t.fg("dim", "(no events)"), width));
    } else {
      const folded = formatToolEventPairs(recent, t);
      for (const line of tailFixedLines(folded, PREVIEW_RECENT_LINES, "", t)) {
        lines.push(truncLine(line, width));
      }
    }

    lines.push("");
    lines.push(truncLine(t.fg("dim", "Enter for full detail"), width));
    return lines;
  }

  /**
   * 右列：完整详情（阶段 2，detailMode）。完整 eventLog + result/error + sessionFile，
   * scrollOffset 翻屏。底部对齐（最新在底，向上看历史）——Enter 进阶段 2 时 scrollOffset=max。
   *
   * 内容行生成与 detailContentLength 共用 buildDetailContent（单一数据源）。
   */
  private renderRightDetail(record: SubagentRecord | null, width: number, viewH: number): string[] {
    const t = this.theme;
    if (!record) return [t.fg("dim", "(no record selected)")];

    const content = this.buildDetailContent(record, width);
    // 翻屏（底部对齐：max = content.length - viewH）
    const max = Math.max(0, content.length - viewH);
    if (this.state.scrollOffset > max) this.state.scrollOffset = max;
    const start = Math.max(0, Math.min(this.state.scrollOffset, max));
    this.state.scrollOffset = start; // 回写收敛（End/Home 越界后下次渲染归位）
    const visible = content.slice(start, start + viewH);
    // pad 到 viewH（视口填满）
    while (visible.length < viewH) visible.push("");
    return visible;
  }

  /** 详情内容行（单一数据源：renderRightDetail 渲染 + detailScrollInfo 算长度都走这里）。 */
  private buildDetailContent(record: SubagentRecord, width: number): string[] {
    const t = this.theme;
    const content: string[] = [];

    // 元数据：第 1 行 id + 状态 + turns + tokens
    content.push(truncLine(
      t.fg("dim", `${record.id} · ${record.mode} · ${record.status} · ${record.turns} turns · ${formatTokens(record.totalTokens)}`),
      width,
    ));
    // 元数据：第 2 行 model + thinking（括号分组）
    const metaParts: string[] = [];
    if (record.model) metaParts.push(record.model);
    if (record.thinkingLevel) metaParts.push(`thinking ${record.thinkingLevel}`);
    content.push(metaParts.length > 0
      ? truncLine(t.fg("dim", `(${metaParts.join(" · ")})`), width)
      : "");

    // syncCancelHint
    if (this.state.syncCancelHint) {
      content.push("");
      content.push(truncLine(t.fg("warning", "Cannot stop a sync subagent here — press Esc in the chat to abort"), width));
    }

    content.push("");
    content.push(truncLine(t.fg("accent", t.bold("── Event Log ──")), width));

    // eventLog 从 turns[] 派生（离散语义事件）。tool_start/tool_end 对折叠成 1 行
    // （每个 tool 一行，尾部 ✓/✗）；turn_end/error 原样保留。
    if (record.eventLog.length === 0) {
      content.push(truncLine(t.fg("dim", "(no events)"), width));
    } else {
      for (const line of formatToolEventPairs(record.eventLog, t)) {
        content.push(truncLine(line, width));
      }
    }

    if (record.result) {
      content.push("");
      content.push(truncLine(t.fg("accent", "Result:"), width));
      // 跳过空行：getFullText 用 \n\n 拼接多 turn 文本，split("\n") 会多出空字符串元素
      // （turn 间空行）。trim 判断兼容首尾空白行 + turn 间隔行，紧贴换行不多空。
      for (const l of record.result.split("\n")) {
        if (l.trim().length === 0) continue;
        content.push(truncLine(sanitizeLabel(l), width));
      }
    }
    if (record.error) {
      content.push("");
      content.push(truncLine(t.fg("error", `Error: ${firstLine(record.error)}`), width));
    }
    if (record.sessionFile) {
      content.push("");
      content.push(truncLine(t.fg("dim", `session: ${record.sessionFile}`), width));
    }

    return content;
  }

  /** 详情内容总行数（供 detailScrollInfo 算 max，不重复生成）。 */
  private detailContentLength(record: SubagentRecord): number {
    // 复用 buildDetailContent 的行数：用足够大的宽度避免截断折行影响行数统计。
    return this.buildDetailContent(record, DETAIL_LEN_PROBE_WIDTH).length;
  }


  /** dispose 时清理（Pi overlay 销毁时调用；wrappedDone 已清过，此处兜底防漏）。 */
  dispose(): void {
    this.unsubscribe();
    if (this.animTimer !== undefined) {
      clearInterval(this.animTimer);
      this.animTimer = undefined;
    }
  }
}

// ============================================================
// 内部辅助
// ============================================================

/** 计算 record 已耗时秒（endedAt 优先，否则 now - startedAt）。
 *  委托给 Core 层共享 helper computeElapsedSeconds，消除发散。 */
function elapsedSec(r: SubagentRecord): number {
  return computeElapsedSeconds(r);
}

/** 详情翻屏最大 offset（contentLines - viewportHeight，兜底 0）。
 *  与 renderRightDetail 的 max 计算保持一致（content.length - viewH）。 */
function detailScrollMax(detailCtx: DetailKeyContext | undefined): number {
  const content = detailCtx?.contentLines ?? 0;
  const viewH = detailCtx?.viewportHeight ?? 1;
  return Math.max(0, content - viewH);
}

/** 处理取消按键（x）。background 真正 abort；sync 仅提示。返回是否变化。 */
function handleCancel(
  record: SubagentRecord,
  service: SubagentService | null,
  state: ViewState,
  notify: NotifyFn | undefined,
): boolean {
  if (record.status !== "running") {
    notify?.(`Cannot stop: record is ${record.status}`, "warning");
    return false;
  }
  if (record.mode === "background") {
    if (!service) {
      notify?.("Runtime not ready, cannot stop", "error");
      return false;
    }
    const ok = service.cancel(record.id);
    notify?.(ok ? `Requested stop for ${record.id}` : `Stop failed (record may have ended)`, ok ? "info" : "warning");
    return true;
  }
  // sync：runtime 无法主动 abort（signal 来自 Pi tool 框架），仅提示
  state.syncCancelHint = true;
  notify?.("Press Esc in the chat to abort a sync subagent", "info");
  return true;
}

// firstLine 已上移到 ./format.ts 共享。
