// src/tui/list-view.ts
//
// /subagents list 全屏左右分屏 overlay。
//   左列：record 列表（状态图标 + agent + mode + 相对时间）
//   右列：选中 record 详情（eventLog + result/error，可翻屏）
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
/** 左列/右列分隔符。 */
const COL_SEP = "│";
/** 详情区 eventLog 翻屏步长（方向键单步）。 */
const DETAIL_SCROLL_STEP = 1;
/** 详情区 PgUp/PgDn 默认步长（无 viewport 信息时）。 */
const PAGE_SCROLL_DEFAULT = 10;
/** 右列预览的最近 eventLog 条数。 */
const PREVIEW_RECENT_LINES = 3;
/** 秒→毫秒换算。 */
const MS_PER_SECOND = 1000;

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

/** TUI 最小接口（duck-type，只需 requestRender）。 */
interface TuiLike {
  requestRender(): void;
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
        if (!state.disposed) tui.requestRender();
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

      const component = new SubagentsListComponent(hub, theme, tui, state, unsubscribe, notify);

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
        margin: 0,
        width: "100%",
        maxHeight: "100%",
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
 * 全屏左右分屏 list 组件。
 *
 * 不缓存行（records 每次 render 都从 hub.collectRecords 拉最新——保证 store 变化后刷新）。
 * 缓存的是「上次 render 的 width」（用于 invalidate 后强制重建）。
 */
class SubagentsListComponent implements Component {
  private cachedWidth: number | undefined;
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
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (width === this.cachedWidth && this.cachedLines) return this.cachedLines;
    const lines = this.buildLines(width);
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  handleInput(data: string): void {
    if (this.state.disposed) return;

    const records = applyFilter(this.hub.collectRecords(LIST_LIMIT), this.state.filterText);
    const selected = records[this.state.selectedIdx] ?? null;
    const detailCtx: DetailKeyContext = { viewportHeight: 20, contentLines: selected?.eventLog.length };

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

  // ── 内部：渲染 ──────────────────────────────────────────

  /** 构建行数组。 */
  private buildLines(width: number): string[] {
    const t = this.theme;
    const lines: string[] = [];

    // 标题行 + filter 提示
    const filterPart = this.state.filterText
      ? t.fg("dim", ` · filter: `) + t.fg("accent", this.state.filterText)
      : "";
    lines.push(truncLine(`${t.bold("/subagents list")}${filterPart}`, width));

    const records = applyFilter(this.hub.collectRecords(LIST_LIMIT), this.state.filterText);

    if (this.state.detailMode) {
      const selected = records[this.state.selectedIdx] ?? null;
      lines.push(...this.renderDetail(selected, width));
      return lines;
    }

    // 空列表
    if (records.length === 0) {
      lines.push("");
      lines.push(truncLine(t.fg("dim", "(暂无 subagent 记录)"), width));
      lines.push("");
      lines.push(truncLine(t.fg("dim", "Esc 退出"), width));
      return lines;
    }

    // clamp selectedIdx（filter 后可能越界）
    this.state.selectedIdx = Math.min(this.state.selectedIdx, records.length - 1);

    // 左右分屏
    const leftWidth = Math.max(COL_MIN_WIDTH, Math.floor(width * LEFT_COL_RATIO));
    const rightWidth = Math.max(COL_MIN_WIDTH, width - leftWidth - 1);
    const sep = t.fg("borderMuted", COL_SEP);

    // 表头
    lines.push(truncLine(
      `${padToVisible(t.fg("accent", t.bold("Record")), leftWidth)}${sep}${padToVisible(t.fg("accent", t.bold("详情")), rightWidth)}`,
      width,
    ));

    // 主体：左列每条 record + 右列选中 record 的预览
    const leftLines = this.renderLeftColumn(records, leftWidth);
    const rightLines = this.renderRightPreview(records[this.state.selectedIdx] ?? null, rightWidth);
    const bodyRows = Math.max(leftLines.length, rightLines.length);
    for (let i = 0; i < bodyRows; i++) {
      const l = leftLines[i] ?? "";
      const r = rightLines[i] ?? "";
      lines.push(truncLine(`${padToVisible(l, leftWidth)}${sep}${padToVisible(r, rightWidth)}`, width));
    }

    // 底部提示
    lines.push("");
    lines.push(truncLine(t.fg("dim", "↑↓ 导航 · Enter 详情 · 字符过滤 · Esc 退出"), width));

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

  /** 详情视图：完整 eventLog（不折叠）+ result/error + sessionFile。 */
  private renderDetail(record: SubagentRecord | null, width: number): string[] {
    const t = this.theme;
    const lines: string[] = [];

    if (!record) {
      lines.push(truncLine(t.fg("dim", "(无选中 record)"), width));
      lines.push("");
      lines.push(truncLine(t.fg("dim", "Esc 返回"), width));
      return lines;
    }

    // 标题
    lines.push(truncLine(
      `${t.bold(record.agent)} ${t.fg("dim", `· ${record.model}${record.thinkingLevel ? ` · thinking ${record.thinkingLevel}` : ""}`)}`,
      width,
    ));
    lines.push(truncLine(
      t.fg("dim", `${record.id} · ${record.mode} · ${record.status} · ${record.turns} turns · ${formatTokens(record.totalTokens)}`),
      width,
    ));

    // syncCancelHint
    if (this.state.syncCancelHint) {
      lines.push("");
      lines.push(truncLine(t.fg("warning", "sync subagent 无法在此终止——请按对话流 Esc 终止"), width));
    }

    lines.push("");
    lines.push(truncLine(t.fg("accent", t.bold("执行轨迹")), width));

    // eventLog 翻屏窗口
    const logLines: string[] = [];
    if (record.eventLog.length === 0) {
      logLines.push(t.fg("dim", "(无执行轨迹——来自历史记录)"));
    } else {
      for (const entry of record.eventLog) {
        logLines.push(formatEventLine(entry, t));
      }
    }

    // 结果/错误
    if (record.result) {
      logLines.push("");
      logLines.push(t.fg("accent", "结果:"));
      for (const l of record.result.split("\n")) {
        logLines.push(sanitizeLabel(l));
      }
    }
    if (record.error) {
      logLines.push("");
      logLines.push(t.fg("error", `Error: ${firstLine(record.error)}`));
    }
    if (record.sessionFile) {
      logLines.push("");
      logLines.push(t.fg("dim", `session: ${record.sessionFile}`));
    }

    // 应用 scrollOffset 翻屏
    const visible = logLines.slice(this.state.scrollOffset);
    const max = Math.max(0, logLines.length - 1);
    if (this.state.scrollOffset > max) this.state.scrollOffset = max;
    for (const l of visible) {
      lines.push(truncLine(l, width));
    }

    // 底部提示
    lines.push("");
    const canCancel = record.status === "running";
    const cancelHint = canCancel
      ? (record.mode === "background" ? " · x 停止" : " · x 提示停止")
      : "";
    lines.push(truncLine(
      t.fg("dim", `Esc 返回 · ↑↓/PgUp/PgDn/Home/End 翻屏${cancelHint}`),
      width,
    ));

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

/** 详情翻屏最大 offset（contentLines - 1，兜底 0）。 */
function detailScrollMax(detailCtx: DetailKeyContext | undefined): number {
  const content = detailCtx?.contentLines ?? 0;
  return Math.max(0, content - 1);
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
