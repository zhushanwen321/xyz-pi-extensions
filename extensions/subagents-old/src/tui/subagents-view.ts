// src/tui/subagents-view.ts
//
// /subagents list 全屏左右分屏视图（仿 workflow WorkflowsView.ts）。
// 左列 = agent 列表（❯ 选中 + 状态图标 + 对齐列），右列 = 选中 record 的详情。
// 默认可直接输入 filter · ↑↓ 导航 · Enter 进入详情 · x stop · Esc 退出。
//
// 内部组件契约（ctx.ui.custom overlay）：
// - invalidate(): 清除渲染缓存
// - render(width): 返回 string[]
// - handleInput(data): 处理按键
// 销毁由 done() 回调触发。
//
// 架构：纯渲染逻辑（无 runtime 依赖）拆到 subagents-view-render.ts，本文件只保留
// overlay 工厂（createSubagentsView + getAllRecords，依赖 SubagentRuntime/ExtensionContext）
// + 数据合并 + 按键处理。纯函数与类型从 render 模块 re-export，保持既有 import 路径不变。

import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { SubagentRuntime } from "../runtime.ts";
import type { CompletedAgentRecord } from "../types.ts";
import type { ThemeLike } from "./format.ts";
import type {
  DetailKeyContext as _DetailKeyContext,
  SubagentRecord,
  ViewState,
} from "./subagents-view-render.ts";
import {
  applyFilter as _applyFilter,
  formatRecordRow as _formatRecordRow,
  renderView as _renderView,
  STATUS_PRIORITY_FALLBACK,
} from "./subagents-view-render.ts";

// 纯函数 + 类型 re-export（保持 subagents-view.ts 作为既有 import 入口不变）
export type { DetailKeyContext,SubagentRecord, ViewState } from "./subagents-view-render.ts";
export { applyFilter, formatRecordRow, renderView } from "./subagents-view-render.ts";

// ============================================================
// Layout: status ordering
// ============================================================

const STATUS_PRIORITY: Record<SubagentRecord["status"], number> = {
  running: 0,
  failed: 1,
  cancelled: 2,
  done: 3,
};

// ============================================================
// Data merge (FR-3.2)
// ============================================================

/**
 * 合并 widget + bg + completed + history 数据源。
 * cancelled 状态优先（用户主动行为，widget 可能误报 running/failed）。
 * 内存源（widget/bg/completed）优先于 history（含实时状态 + 完整 eventLog）。
 */
export function collectRecords(
  widget: SubagentRecord[],
  bg: SubagentRecord[],
  completed: SubagentRecord[],
  history: SubagentRecord[] = [],
): SubagentRecord[] {
  const byId = new Map<string, SubagentRecord>();
  for (const r of history) {
    byId.set(r.id, r);
  }
  for (const r of [...bg, ...completed]) {
    byId.set(r.id, r);
  }
  for (const r of widget) {
    const existing = byId.get(r.id);
    if (!existing) {
      byId.set(r.id, r);
    } else if (existing.status === "cancelled" && r.status !== "cancelled") {
      continue;
    } else {
      byId.set(r.id, r);
    }
  }
  return sortRecords([...byId.values()]);
}

export function sortRecords(records: SubagentRecord[]): SubagentRecord[] {
  return [...records].sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status] ?? STATUS_PRIORITY_FALLBACK;
    const pb = STATUS_PRIORITY[b.status] ?? STATUS_PRIORITY_FALLBACK;
    if (pa !== pb) return pa - pb;
    return b.startedAt - a.startedAt;
  });
}

// ============================================================
// Keyboard
// ============================================================

const DEFAULT_DETAIL_VIEWPORT = 10; // 无 detailCtx 时的视口高度回退（ESLint no-magic-numbers）
const DETAIL_VIEWPORT_ROW_DEDUCT = 3; // termRows - 3 = 详情视口高度（与 renderDetailView 一致）

export function processKey(
  data: string,
  records: SubagentRecord[],
  state: ViewState,
  _theme: ThemeLike,
  selectedRecord: SubagentRecord | null,
  done: () => void,
  runtime: { cancelBackground: (id: string) => boolean; cancelRunningAgent: (id: string) => boolean } | null,
  detailCtx?: _DetailKeyContext,
): boolean {
  if (state.disposed) return false;

  const filtered = _applyFilter(records, state.filterText);

  // ── 详情模式（Enter 进入的全屏详情）：↑↓ 行级 / PgUp PgDn 大跨度 / Home End 跳顶底 / x stop / Esc 返回 ──
  if (state.detailMode) {
    if (matchesKey(data, Key.escape)) {
      state.detailMode = false;
      state.syncCancelHint = false; // 退出详情清提示
      return true;
    }
    // P3#5: x 停止键——仅详情模式可用（分屏模式 x 作为 filter 字符）。
    // background agent → runtime.cancelBackground 真正取消；
    // sync agent → runtime.cancelRunningAgent 标记状态 + 设 syncCancelHint 提示用户走对话流 Esc。
    if (data === "x") {
      if (selectedRecord && selectedRecord.status === "running" && runtime) {
        if (selectedRecord.mode === "background") {
          runtime.cancelBackground(selectedRecord.id);
          state.syncCancelHint = false;
        } else {
          // sync agent：runtime 无法主动 abort（AbortController 在 tool 闭包），
          // 标记 cancelled + 提示用户在对话流按 Esc 真正中断。
          runtime.cancelRunningAgent(selectedRecord.id);
          state.syncCancelHint = true;
        }
        return true;
      }
      return false;
    }
    // 计算翻屏步长（视口高度）和最大滚动偏移
    const vh = detailCtx?.viewportHeight ?? DEFAULT_DETAIL_VIEWPORT;
    const pageStep = Math.max(1, vh);
    const maxOffset = detailCtx?.contentLines !== undefined && detailCtx.contentLines > 0
      ? Math.max(0, detailCtx.contentLines - vh)
      : Number.MAX_SAFE_INTEGER;
    const clamp = (v: number): number => Math.max(0, Math.min(v, maxOffset));

    if (matchesKey(data, "home")) {
      state.scrollOffset = 0;
      return true;
    }
    if (matchesKey(data, "end")) {
      state.scrollOffset = clamp(maxOffset);
      return true;
    }
    if (matchesKey(data, "pageDown")) {
      state.scrollOffset = clamp(state.scrollOffset + pageStep);
      return true;
    }
    if (matchesKey(data, "pageUp")) {
      state.scrollOffset = clamp(state.scrollOffset - pageStep);
      return true;
    }
    if (matchesKey(data, Key.down)) {
      state.scrollOffset = clamp(state.scrollOffset + 1);
      return true;
    }
    if (matchesKey(data, Key.up)) {
      state.scrollOffset = clamp(state.scrollOffset - 1);
      return true;
    }
    return false;
  }

  // ── 分屏模式 ──

  // Esc 退出视图
  if (matchesKey(data, Key.escape)) {
    done();
    return false;
  }
  // ↑↓ 导航（用 matchesKey 兼容 legacy/Kitty 协议所有终端模式）
  if (matchesKey(data, Key.down)) {
    if (state.selectedIdx < filtered.length - 1) { state.selectedIdx++; state.scrollOffset = 0; return true; }
    return false;
  }
  if (matchesKey(data, Key.up)) {
    if (state.selectedIdx > 0) { state.selectedIdx--; state.scrollOffset = 0; return true; }
    return false;
  }
  // Enter 进入详情全屏
  if (matchesKey(data, Key.enter)) {
    if (filtered.length > 0) {
      state.detailMode = true;
      state.scrollOffset = 0;
      state.syncCancelHint = false; // 进入新详情清提示
      return true;
    }
    return false;
  }
  // Backspace 删除 filter 字符（也匹配 Ctrl+H）
  if (matchesKey(data, Key.backspace) || data === "\x7f") {
    state.filterText = state.filterText.slice(0, -1);
    state.selectedIdx = 0;
    state.scrollOffset = 0;
    return true;
  }
  // P3#5: 分屏模式不再拦截 x——它现在作为 filter 字符（原 x 停止键移到 detailMode，
  // 避免「想 filter 含 x 的 agent 名却误触发停止」的冲突，见 TUI 指南 §第三部分.3）。
  // 可打印字符 → filter 输入（默认可直接输入，无需进入 filter 模式）
  // 排除单字符 ANSI 序列前缀 ESC（\x1b）—— 已被上面 escape 拦截
  if (data.length === 1 && data >= " " && data <= "~") {
    state.filterText += data;
    state.selectedIdx = 0;
    state.scrollOffset = 0;
    return true;
  }
  return false;
}

// ============================================================
// View factory (ctx.ui.custom overlay)
// ============================================================

/**
 * 全屏左右分屏视图工厂。
 * 仿 WorkflowsView.ts 的 overlay 契约。
 */
export function createSubagentsView(
  runtime: SubagentRuntime,
  theme: ThemeLike,
  ctx: ExtensionContext,
  directId?: string,
): Promise<void> {
  if (!ctx.hasUI) {
    return Promise.reject(new Error("/subagents list requires interactive mode"));
  }

  // FR-3.1 G-017: 防 overlay 叠加
  const active = runtime.getActiveView();
  if (active) active.close();

  return ctx.ui.custom<void>((_tui: unknown, _theme: unknown, _kb: unknown, done: () => void) => {
    // FR-3.1 G-002: directId 不存在 → 通知 + 回退 Level 0
    let initialDirectId = directId;
    const allInitial = getAllRecords(runtime);
    if (initialDirectId && !allInitial.find((r) => r.id === initialDirectId)) {
      ctx.ui.notify(`Subagent '${initialDirectId}' not found`, "warning");
      initialDirectId = undefined;
    }

    const state: ViewState = {
      selectedIdx: 0,
      scrollOffset: 0,
      filterText: "",
      detailMode: false,
      disposed: false,
      syncCancelHint: false,
    };
    if (initialDirectId) {
      const idx = allInitial.findIndex((r) => r.id === initialDirectId);
      if (idx >= 0) {
        state.selectedIdx = idx;
        state.detailMode = true; // directId 直接进入详情
      }
    }

    const cache = { width: undefined as number | undefined, lines: undefined as string[] | undefined };
    const tui = _tui as { requestRender(): void; terminal: { rows: number } };
    const requestRender = () => tui.requestRender();

    const unsubscribe = runtime.onChange(() => {
      if (!state.disposed) requestRender();
    });

    const wrappedDone = () => {
      if (state.disposed) return;
      state.disposed = true;
      unsubscribe();
      runtime.clearActiveView();
      done();
    };

    runtime.setActiveView({ close: wrappedDone });

    return {
      invalidate(): void {
        cache.width = undefined;
        cache.lines = undefined;
      },
      render(width: number): string[] {
        if (cache.lines && cache.width === width) return cache.lines;
        const records = getAllRecords(runtime);
        const filtered = _applyFilter(records, state.filterText);
        // clamp selectedIdx to filtered range
        if (state.selectedIdx >= filtered.length) {
          state.selectedIdx = Math.max(0, filtered.length - 1);
        }
        const raw = _renderView(records, theme, width, state, tui.terminal.rows);
        const termHeight = tui.terminal.rows;
        const lines = raw.length < termHeight
          ? [...raw, ...Array.from({ length: termHeight - raw.length }, () => "")]
          : raw;
        cache.width = width;
        cache.lines = lines;
        return lines;
      },
      handleInput(data: string): void {
        if (state.disposed) return;
        const records = getAllRecords(runtime);
        const filtered = _applyFilter(records, state.filterText);
        const selected = filtered[state.selectedIdx] ?? null;
        // 详情全屏翻屏上下文：视口高度（与 renderDetailView 计算一致）。
        // contentLines 不传——End/PgDn 越界由 renderDetailView 的 clamp + 回写收敛。
        const detailCtx: _DetailKeyContext | undefined = state.detailMode
          ? { viewportHeight: Math.max(1, tui.terminal.rows - DETAIL_VIEWPORT_ROW_DEDUCT) }
          : undefined;
        const changed = processKey(data, records, state, theme, selected, wrappedDone, runtime, detailCtx);
        if (changed) {
          cache.width = undefined;
          cache.lines = undefined;
          requestRender();
        }
      },
    };
  }, {
    overlay: true,
    overlayOptions: { anchor: "center" as const, width: "100%", maxHeight: "100%", margin: 1 },
  });
}

// ============================================================
// Data source aggregation
// ============================================================

const HISTORY_LIST_LIMIT = 100; // ADR-024 L1: /subagents list 拉取的历史记录上限

/** 从 runtime 提取所有 records（合并四数据源，已按当前 sessionId 过滤 history） */
function getAllRecords(runtime: SubagentRuntime): SubagentRecord[] {
  const widgetRecords: SubagentRecord[] = runtime.listRunningAgents().map((a) => ({
    id: a.id,
    agent: a.agent,
    status: a.status,
    // P1#2: 快照 eventLog——a 是运行中的 AgentExecutionState，其 eventLog 被 streaming
    // 事件 push/shift 原地 mutate。overlay 打开期间若传裸引用，右列详情渲染会读到中途态。
    eventLog: a.eventLog?.slice() ?? [],
    turns: a.turns,
    totalTokens: a.totalTokens,
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    model: a.model,
    thinkingLevel: a.thinkingLevel,
  }));
  const bgRecords: SubagentRecord[] = runtime.listBackground().map((b) => ({
    id: b.id,
    agent: b.agent ?? "default",
    status: b.status,
    // b.eventLog 当前为 undefined（listBackground 不展平 eventLog），走 [] fallback；
    // .slice() 防御性处理——若将来 listBackground 重新展平，此处自动快照。
    eventLog: b.eventLog?.slice() ?? [],
    turns: b.turns,
    totalTokens: b.totalTokens,
    startedAt: b.startedAt,
    endedAt: b.endedAt,
    result: b.result,
    error: b.error,
    mode: "background" as const,
    model: b.model,
    thinkingLevel: b.thinkingLevel,
  }));
  const completedRecords: SubagentRecord[] = runtime.listCompleted().map((c: CompletedAgentRecord) => ({
    id: c.id,
    agent: c.agent,
    status: c.status,
    eventLog: c.eventLog,
    turns: c.turns,
    totalTokens: c.totalTokens,
    startedAt: c.startedAt,
    endedAt: c.endedAt,
    result: c.result,
    error: c.error,
    model: c.model,
    thinkingLevel: c.thinkingLevel,
  }));
  // ADR-024 L1: 跨进程历史记录（listHistory 内部已按当前 sessionId 过滤）
  const historyRecords: SubagentRecord[] = runtime.listHistory(HISTORY_LIST_LIMIT).map((h) => ({
    id: h.id,
    agent: h.agent,
    status: h.status,
    eventLog: [],
    turns: h.turns,
    totalTokens: h.totalTokens,
    startedAt: h.startedAt,
    endedAt: h.endedAt,
    error: h.error ?? h.resultPreview,
    sessionFile: h.sessionFile,
    mode: h.mode,
    model: h.model,
    thinkingLevel: h.thinkingLevel,
  }));
  return collectRecords(widgetRecords, bgRecords, completedRecords, historyRecords);
}
