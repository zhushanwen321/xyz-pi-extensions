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

import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { SubagentRuntime } from "../runtime.ts";
import type {
  AgentEventLogEntry,
  AgentResult,
  BackgroundStatus,
  CompletedAgentRecord,
} from "../types.ts";
import { formatEventLogLine, formatTokens, type ThemeLike } from "./format.ts";

// ============================================================
// Types
// ============================================================

export interface SubagentRecord {
  readonly id: string;
  readonly agent: string;
  status: BackgroundStatus["status"];
  eventLog: AgentEventLogEntry[];
  turns?: number;
  totalTokens?: number;
  startedAt: number;
  endedAt?: number;
  result?: AgentResult;
  error?: string;
  /** ADR-024 L2: subagent session 文件名（存在时可回看完整对话） */
  sessionFile?: string;
  /** ADR-024 L1: 执行模式（列表显示用） */
  mode?: "sync" | "background";
  /** model 信息（详情区显示） */
  model?: string;
}

export interface ViewState {
  selectedIdx: number;
  scrollOffset: number;      // 右列 eventLog 滚动
  filterText: string;        // filter 输入内容（默认可直接输入，无需进入 filter 模式）
  detailMode: boolean;       // Enter 进入详情全屏（右列占满），Esc 返回分屏
  disposed: boolean;
}

const STATUS_PRIORITY: Record<BackgroundStatus["status"], number> = {
  running: 0,
  failed: 1,
  cancelled: 2,
  done: 3,
};

const SIDEBAR_WIDTH = 38;   // 左列宽（含 ❯ 指针 + 状态图标 + agent + turns + tokens）
const MIN_TERMINAL_ROWS = 8;

// ============================================================
// ANSI-aware visible-width helpers
// ============================================================

/** Pad string to target visible width (right-pad with spaces). ANSI-safe. */
function padVisible(s: string, width: number): string {
  const vw = visibleWidth(s);
  if (vw >= width) return s;
  return s + " ".repeat(width - vw);
}

/** Truncate string to visible width, appending ellipsis if truncated. ANSI-safe. */
function truncVisible(s: string, maxWidth: number): string {
  if (visibleWidth(s) <= maxWidth) return s;
  if (maxWidth <= 1) return visibleWidth(s) > 0 ? "…" : s;
  return truncateToWidth(s, maxWidth - 1) + "…";
}

/** 把文本按可见宽度自动换行。用 visibleWidth 测量（ANSI-safe），按 grapheme 切分。
 *  超长单词（单个 word > maxWidth）强制截断。返回多行字符串数组。 */
function wrapVisible(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const vw = visibleWidth(text);
  if (vw <= maxWidth) return [text];

  // 简单贪心换行：按 visibleWidth 逐字符累积，超 maxWidth 断行。
  // ANSI 转义序列不计宽度（visibleWidth 会剥离），但需要保留在输出中。
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  // 用 segmenter 按 grapheme 切，避免 emoji/宽字符被劈成两半
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { segment } of segmenter.segment(text)) {
    const segWidth = visibleWidth(segment);
    if (currentWidth + segWidth > maxWidth && currentWidth > 0) {
      lines.push(current);
      current = segment;
      currentWidth = segWidth;
    } else {
      current += segment;
      currentWidth += segWidth;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [text];
}

// ============================================================
// Data merge (FR-3.2) — unchanged from original
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
    const pa = STATUS_PRIORITY[a.status] ?? 99;
    const pb = STATUS_PRIORITY[b.status] ?? 99;
    if (pa !== pb) return pa - pb;
    return b.startedAt - a.startedAt;
  });
}

// ============================================================
// Format helpers
// ============================================================

function statusIcon(status: BackgroundStatus["status"], theme: ThemeLike): string {
  switch (status) {
    case "done": return theme.fg("success", "✓");
    case "running": return theme.fg("warning", "⟳");
    case "failed": return theme.fg("error", "✗");
    case "cancelled": return theme.fg("muted", "■");
  }
}

function statusLabel(status: BackgroundStatus["status"], theme: ThemeLike): string {
  switch (status) {
    case "done": return theme.fg("success", "done");
    case "running": return theme.fg("warning", "running");
    case "failed": return theme.fg("error", "failed");
    case "cancelled": return theme.fg("muted", "cancelled");
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 5);
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** 格式化单条 record 为左列行（固定列宽 + padVisible 对齐）。 */
export function formatRecordRow(record: SubagentRecord, theme: ThemeLike, selected: boolean): string {
  const pointer = selected ? "❯ " : "  ";
  const icon = statusIcon(record.status, theme);
  const mode = record.mode === "background" ? "bg" : "  ";
  // 列宽：agent 14 + turns 5 + tokens 8 = 27，加 icon(1) + mode(2) + 分隔符
  const agent = padVisible(truncVisible(record.agent, 14), 14);
  const turns = padVisible(`${record.turns ?? 0}t`, 5);
  const tokens = padVisible(record.totalTokens ? formatTokens(record.totalTokens) : "-", 8);
  const line = `${pointer}${icon} ${mode} ${agent} ${turns} ${tokens}`;
  return selected ? theme.bold(line) : line;
}

// ============================================================
// Split-pane render (仿 WorkflowsView mergeBody)
// ============================================================

/** 把左列和右列按行拼接，左列 padVisible 到 SIDEBAR_WIDTH，中间用 │ 分隔。 */
function mergeBody(leftLines: string[], rightLines: string[], mainWidth: number): string[] {
  const bodyHeight = Math.max(leftLines.length, rightLines.length);
  const result: string[] = [];
  const emptyLeft = " ".repeat(SIDEBAR_WIDTH);
  for (let i = 0; i < bodyHeight; i++) {
    const left = padVisible(leftLines[i] ?? "", SIDEBAR_WIDTH);
    const right = padVisible(rightLines[i] ?? "", mainWidth);
    result.push(left + "│" + right);
  }
  return result.length > 0 ? result : [emptyLeft + "│" + " ".repeat(mainWidth)];
}

/** 渲染左列：agent 列表。 */
function renderLeftColumn(
  records: SubagentRecord[],
  theme: ThemeLike,
  state: ViewState,
  bodyHeight: number,
): string[] {
  const lines: string[] = [];
  const filtered = applyFilter(records, state.filterText);
  lines.push(theme.fg("muted", `Agents (${filtered.length}/${records.length})`));
  lines.push("─".repeat(SIDEBAR_WIDTH));

  // 视口滚动：当选中行超出可见区时滚动
  const headerLines = 2;
  const visibleRows = Math.max(1, bodyHeight - headerLines);
  let startIdx = 0;
  if (state.selectedIdx >= visibleRows) {
    startIdx = state.selectedIdx - visibleRows + 1;
  }
  const endIdx = Math.min(filtered.length, startIdx + visibleRows);

  for (let i = startIdx; i < endIdx; i++) {
    lines.push(formatRecordRow(filtered[i]!, theme, i === state.selectedIdx));
  }

  // 空状态
  if (filtered.length === 0) {
    lines.push(theme.fg("dim", "  (no matching agents)"));
  }

  return lines;
}

/** 渲染右列：选中 record 的详情。 */
function renderRightColumn(
  record: SubagentRecord | null,
  theme: ThemeLike,
  mainWidth: number,
  state: ViewState,
  bodyHeight: number,
): string[] {
  const lines: string[] = [];
  if (!record) {
    lines.push(theme.fg("dim", "Select an agent to view details"));
    return lines;
  }

  lines.push(theme.fg("muted", "Detail"));
  lines.push("─".repeat(mainWidth));

  // 状态行
  const elapsed = record.endedAt
    ? formatDuration(record.endedAt - record.startedAt)
    : formatDuration(Date.now() - record.startedAt);
  lines.push(`${statusIcon(record.status, theme)} ${statusLabel(record.status, theme)} · ${record.agent}`);
  if (record.model) {
    lines.push(theme.fg("dim", record.model));
  }

  // stats 行
  const turns = record.turns ?? 0;
  const tokens = record.totalTokens ? formatTokens(record.totalTokens) : "0";
  const mode = record.mode === "background" ? "background" : "sync";
  lines.push(theme.fg("dim", `${turns} turns · ${tokens} · ${elapsed} · ${mode} · started ${formatTime(record.startedAt)}`));
  lines.push("");

  // Event log（带滚动，自动换行）
  const filteredLog = (record.eventLog ?? []).filter((e) => e.type !== "turn_end");
  lines.push(theme.fg("muted", "Event log:"));
  if (filteredLog.length === 0) {
    lines.push(theme.fg("dim", "  (no events)"));
  } else {
    // 计算可用高度：bodyHeight - 已占用行数
    const usedLines = lines.length + 2; // +2 for result section spacing
    const maxLogLines = Math.max(1, bodyHeight - usedLines - 4);
    const logStart = Math.max(0, Math.min(state.scrollOffset, Math.max(0, filteredLog.length - maxLogLines)));
    const logEnd = Math.min(filteredLog.length, logStart + maxLogLines);
    for (let i = logStart; i < logEnd; i++) {
      const entry = filteredLog[i]!;
      const raw = formatEventLogLine(entry, theme);
      // 自动换行（保留 ANSI 样式），每行缩进 2 空格
      for (const wl of wrapVisible(raw, mainWidth - 2)) {
        lines.push("  " + wl);
      }
    }
    if (filteredLog.length > maxLogLines) {
      lines.push(theme.fg("dim", `  (${logStart + 1}-${logEnd} of ${filteredLog.length})`));
    }
  }

  // Result / Error（自动换行）
  if (record.result?.text || record.error) {
    lines.push("");
    lines.push(theme.fg("muted", record.error ? "Error:" : "Result:"));
    const text = record.error ?? record.result?.text ?? "";
    const resultLines = text.split("\n").slice(0, 5);
    for (const l of resultLines) {
      for (const wl of wrapVisible(l, mainWidth - 2)) {
        lines.push(theme.fg("dim", "  " + wl));
      }
    }
  }

  return lines;
}

// ============================================================
// Full view render
// ============================================================

export function renderView(
  records: SubagentRecord[],
  theme: ThemeLike,
  width: number,
  state: ViewState,
  termRows: number,
): string[] {
  if (termRows < MIN_TERMINAL_ROWS) {
    return [`Terminal too small (need ≥${MIN_TERMINAL_ROWS} rows)`];
  }

  const contentWidth = width - 2; // ╭...╮ 边框
  const mainWidth = Math.max(10, contentWidth - SIDEBAR_WIDTH - 1); // -1 for │

  const lines: string[] = [];

  // ── Header ──
  lines.push("╭" + "─".repeat(contentWidth) + "╮");
  // filter 默认可直接输入：显示当前 filterText + 光标 _
  const filterDisplay = theme.fg("dim", `filter: `) + theme.bold(`${state.filterText}_`);
  lines.push("│" + padVisible(filterDisplay, contentWidth) + "│");
  lines.push("├" + "─".repeat(SIDEBAR_WIDTH) + "┬" + "─".repeat(mainWidth) + "┤");

  // ── Body (split pane) ──
  const headerFooterLines = 5; // ╭ + filter + ├┬┤ + footer ├┴┤ + ╰ + footer text
  const bodyHeight = Math.max(3, termRows - headerFooterLines);

  const filtered = applyFilter(records, state.filterText);
  const selectedRecord = filtered[state.selectedIdx] ?? filtered[0] ?? null;

  const leftLines = renderLeftColumn(records, theme, state, bodyHeight);
  const rightLines = renderRightColumn(selectedRecord, theme, mainWidth, state, bodyHeight);
  const bodyLines = mergeBody(leftLines, rightLines, mainWidth);

  // pad body to bodyHeight
  const emptyBodyLine = " ".repeat(SIDEBAR_WIDTH) + "│" + " ".repeat(mainWidth);
  while (bodyLines.length < bodyHeight) bodyLines.push(emptyBodyLine);

  for (const bodyLine of bodyLines) {
    lines.push("│" + padVisible(bodyLine, contentWidth) + "│");
  }

  // ── Footer ──
  lines.push("├" + "─".repeat(SIDEBAR_WIDTH) + "┴" + "─".repeat(mainWidth) + "┤");
  const navPart = state.detailMode ? "↑↓ 滚动" : "↑↓ 导航";
  const enterPart = state.detailMode ? "Esc 返回" : "Enter 详情";
  const stopPart = "x stop";
  const quitPart = "Esc 退出";
  const footer = `${navPart} · ${enterPart} · ${stopPart} · ${quitPart}`;
  lines.push("│" + padVisible(theme.fg("muted", footer), contentWidth) + "│");
  lines.push("╰" + "─".repeat(contentWidth) + "╯");

  return lines;
}

// ============================================================
// Filter
// ============================================================

/** 按 filterText 过滤 records（匹配 agent 名或 id，大小写不敏感）。 */
export function applyFilter(records: SubagentRecord[], filterText: string): SubagentRecord[] {
  const q = filterText.trim().toLowerCase();
  if (!q) return records;
  return records.filter((r) =>
    r.agent.toLowerCase().includes(q) || r.id.toLowerCase().includes(q),
  );
}

// ============================================================
// Keyboard
// ============================================================

export function processKey(
  data: string,
  records: SubagentRecord[],
  state: ViewState,
  _theme: ThemeLike,
  selectedRecord: SubagentRecord | null,
  done: () => void,
  runtime: { cancelBackground: (id: string) => boolean } | null,
): boolean {
  if (state.disposed) return false;

  const filtered = applyFilter(records, state.filterText);

  // ── 详情模式（Enter 进入的全屏详情）：↑↓ 滚动 eventLog，Esc 返回分屏 ──
  if (state.detailMode) {
    if (matchesKey(data, Key.escape)) {
      state.detailMode = false;
      return true;
    }
    if (matchesKey(data, Key.down)) {
      state.scrollOffset++;
      return true;
    }
    if (matchesKey(data, Key.up)) {
      if (state.scrollOffset > 0) state.scrollOffset--;
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
    if (filtered.length > 0) { state.detailMode = true; state.scrollOffset = 0; return true; }
    return false;
  }
  // Backspace 删除 filter 字符（也匹配 Ctrl+H）
  if (matchesKey(data, Key.backspace) || data === "\x7f") {
    state.filterText = state.filterText.slice(0, -1);
    state.selectedIdx = 0;
    state.scrollOffset = 0;
    return true;
  }
  // x stop
  if (data === "x") {
    if (selectedRecord && selectedRecord.status === "running" && runtime) {
      runtime.cancelBackground(selectedRecord.id);
      return true;
    }
    return false;
  }
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
        const filtered = applyFilter(records, state.filterText);
        // clamp selectedIdx to filtered range
        if (state.selectedIdx >= filtered.length) {
          state.selectedIdx = Math.max(0, filtered.length - 1);
        }
        const raw = renderView(records, theme, width, state, tui.terminal.rows);
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
        const filtered = applyFilter(records, state.filterText);
        const selected = filtered[state.selectedIdx] ?? null;
        const changed = processKey(data, records, state, theme, selected, wrappedDone, runtime);
        if (changed) {
          cache.width = undefined;
          cache.lines = undefined;
          requestRender();
        }
      },
    };
  }, {
    overlay: true,
    overlayOptions: { anchor: "center" as const, width: "100%", maxHeight: "100%", margin: 0 },
  });
}

// ============================================================
// Data source aggregation
// ============================================================

/** 从 runtime 提取所有 records（合并四数据源，已按当前 sessionId 过滤 history） */
function getAllRecords(runtime: SubagentRuntime): SubagentRecord[] {
  const widgetRecords: SubagentRecord[] = runtime.listRunningAgents().map((a) => ({
    id: a.id,
    agent: a.agent,
    status: a.status,
    eventLog: a.eventLog ?? [],
    turns: a.turns,
    totalTokens: a.totalTokens,
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    model: a.model,
  }));
  const bgRecords: SubagentRecord[] = runtime.listBackground().map((b) => ({
    id: b.id,
    agent: b.agent ?? "default",
    status: b.status,
    eventLog: b.eventLog ?? [],
    turns: b.turns,
    totalTokens: b.totalTokens,
    startedAt: b.startedAt,
    endedAt: b.endedAt,
    result: b.result,
    error: b.error,
    mode: "background" as const,
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
  }));
  // ADR-024 L1: 跨进程历史记录（listHistory 内部已按当前 sessionId 过滤）
  const HISTORY_LIST_LIMIT = 100;
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
  }));
  return collectRecords(widgetRecords, bgRecords, completedRecords, historyRecords);
}
