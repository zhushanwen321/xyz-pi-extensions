// src/tui/subagents-view.ts
//
// /subagents list 全屏两级视图（列表 + 详情）。
// 参考 extensions/workflow/src/interface/views/WorkflowsView.ts 的 overlay 契约。
//
// 内部组件契约：
// - invalidate(): 清除渲染缓存
// - render(width): 返回 string[]
// - handleInput(data): 处理按键
// 销毁由 ctx.ui.custom 的 done() 回调触发。

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { SubagentRuntime } from "../runtime.ts";
import type {
  AgentEventLogEntry,
  AgentResult,
  BackgroundStatus,
  CompletedAgentRecord,
} from "../types.ts";
import { formatEventLogLine, formatTokens, type ThemeLike } from "./format.ts";
import type { WidgetAgentState } from "./agent-widget.ts";

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
}

export interface ViewState {
  level: 0 | 1;
  selectedIdx: number;
  scrollOffset: number;
  disposed: boolean;
}

const STATUS_PRIORITY: Record<BackgroundStatus["status"], number> = {
  running: 0,
  failed: 1,
  cancelled: 2,
  done: 3,
};

const MIN_TERMINAL_ROWS = 8;
const HEADER_LINES = 3;
const FOOTER_LINES = 2;

// ============================================================
// Data merge (FR-3.2)
// ============================================================

/**
 * 合并 widget + bg + completed 数据源。
 * cancelled 状态优先（用户主动行为，widget 可能误报 running/failed）。
 */
export function collectRecords(
  widget: SubagentRecord[],
  bg: SubagentRecord[],
  completed: SubagentRecord[],
): SubagentRecord[] {
  const byId = new Map<string, SubagentRecord>();
  // bg/completed 先（终态权威），widget 后（实时可能更新 running 状态）
  for (const r of [...bg, ...completed]) {
    byId.set(r.id, r);
  }
  for (const r of widget) {
    const existing = byId.get(r.id);
    if (!existing) {
      byId.set(r.id, r);
    } else if (existing.status === "cancelled" && r.status !== "cancelled") {
      // cancelled 优先：保留 existing
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
    return b.startedAt - a.startedAt; // 同状态按 startedAt 降序
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

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 5);
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

function formatRecordRow(record: SubagentRecord, theme: ThemeLike, selected: boolean): string {
  const icon = statusIcon(record.status, theme);
  const turns = record.turns ?? 0;
  const tokens = record.totalTokens ? formatTokens(record.totalTokens) : "-";
  const baseLine = `${icon} ${record.id.padEnd(13)} ${record.agent.padEnd(13)} ${record.status.padEnd(10)} ${turns}t ${tokens}`;
  return selected ? theme.bold(baseLine) : baseLine;
}

// ============================================================
// List view (Level 0)
// ============================================================

export function formatListView(
  records: SubagentRecord[],
  theme: ThemeLike,
  _width: number,
  selectedIdx: number,
): string[] {
  if (records.length === 0) {
    return [
      "┌─ Subagents ───────────────────────────────────────────┐",
      "│  No subagent executions in this session.              │",
      "│                                                       │",
      "│  q 退出                                               │",
      "└───────────────────────────────────────────────────────┘",
    ];
  }

  const lines: string[] = [];
  lines.push("┌─ Subagents ───────────────────────────────────────────────────┐");
  lines.push("│  ID             Agent         Status       Turns  Tokens      │");
  records.forEach((r, i) => {
    lines.push("│  " + formatRecordRow(r, theme, i === selectedIdx));
  });
  lines.push("│                                                               │");
  lines.push("│  j/k 导航 · Enter 详情 · x 取消 · q 退出                       │");
  lines.push("└───────────────────────────────────────────────────────────────┘");
  return lines;
}

// ============================================================
// Detail view (Level 1)
// ============================================================

export function formatDetailView(
  record: SubagentRecord,
  theme: ThemeLike,
  width: number,
  scrollOffset: number,
  terminalRows: number = 30,
): string[] {
  if (terminalRows < MIN_TERMINAL_ROWS) {
    return [`Terminal too small (need ≥${MIN_TERMINAL_ROWS} rows)`];
  }

  const lines: string[] = [];
  const turns = record.turns ?? 0;
  const tokens = record.totalTokens ? formatTokens(record.totalTokens) : "0";
  const elapsed = record.endedAt
    ? formatDuration(record.endedAt - record.startedAt)
    : formatDuration(Date.now() - record.startedAt);

  lines.push(`┌─ ${record.id} ${record.agent} (${record.status})`);
  lines.push(`│  ${turns} turns │ ${tokens} │ ${elapsed} │ started ${formatTime(record.startedAt)}`);
  lines.push("│");

  // Event log
  lines.push("│  Event log:");
  const eventLogLines: string[] = [];
  let turnNumber = 0;
  for (const entry of record.eventLog) {
    if (entry.type === "turn_end") turnNumber++;
    eventLogLines.push("│  " + formatEventLogLine(entry, theme, turnNumber));
  }
  if (eventLogLines.length === 0) eventLogLines.push("│  (no events recorded)");

  const visibleFrom = Math.max(0, scrollOffset);
  const maxVisible = Math.max(1, terminalRows - HEADER_LINES - FOOTER_LINES - 5);
  const visibleTo = Math.min(eventLogLines.length, visibleFrom + maxVisible);
  for (let i = visibleFrom; i < visibleTo; i++) {
    lines.push(eventLogLines[i]);
  }

  // Result section
  if (record.result || record.error) {
    lines.push("│");
    lines.push("│  Result:");
    const resultText = record.error ?? record.result?.text ?? "";
    const resultLines = resultText.split("\n").slice(0, 10);
    for (const l of resultLines) lines.push("│  " + l);
  }

  lines.push("│");
  lines.push("│  j/k 滚动 · q 返回");
  lines.push("└" + "─".repeat(Math.max(1, width - 2)));
  return lines;
}

// ============================================================
// Keyboard (FR-3.5)
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

  if (state.level === 0) {
    if (data === "j" || data === "\x1b[B") {
      if (state.selectedIdx < records.length - 1) { state.selectedIdx++; return true; }
      return false;
    }
    if (data === "k" || data === "\x1b[A") {
      if (state.selectedIdx > 0) { state.selectedIdx--; return true; }
      return false;
    }
    if (data === "\r" || data === "\n") {
      if (records.length > 0) { state.level = 1; state.scrollOffset = 0; return true; }
      return false;
    }
    if (data === "x") {
      if (selectedRecord && selectedRecord.id.startsWith("bg-") && runtime) {
        runtime.cancelBackground(selectedRecord.id);
        return true;
      }
      return false;
    }
    if (data === "q" || data === "\x1b") {
      done();
      return false;
    }
  } else {
    if (data === "j" || data === "\x1b[B") {
      state.scrollOffset++;
      return true;
    }
    if (data === "k" || data === "\x1b[A") {
      if (state.scrollOffset > 0) { state.scrollOffset--; return true; }
      return false;
    }
    if (data === "x") {
      if (selectedRecord && selectedRecord.id.startsWith("bg-") && runtime) {
        runtime.cancelBackground(selectedRecord.id);
        return true;
      }
      return false;
    }
    if (data === "q" || data === "\x1b") {
      state.level = 0;
      state.scrollOffset = 0;
      return true;
    }
  }
  return false;
}

// ============================================================
// Overlay factory
// ============================================================

/**
 * 全屏两级视图工厂。
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
      level: initialDirectId ? 1 : 0,
      selectedIdx: 0,
      scrollOffset: 0,
      disposed: false,
    };
    if (initialDirectId) {
      const idx = allInitial.findIndex((r) => r.id === initialDirectId);
      if (idx >= 0) state.selectedIdx = idx;
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
      // FR-3.1 G-026: 清理 _activeView
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
        const selected = records[state.selectedIdx] ?? null;
        const raw = state.level === 0
          ? formatListView(records, theme, width, state.selectedIdx)
          : selected
            ? formatDetailView(selected, theme, width, state.scrollOffset, tui.terminal.rows)
            : ["(no record selected)"];
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
        const selected = records[state.selectedIdx] ?? null;
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

/** 从 runtime 提取所有 records（合并三数据源） */
function getAllRecords(runtime: SubagentRuntime): SubagentRecord[] {
  const widgetRecords: SubagentRecord[] = runtime.widget.listAgents().map((a) => ({
    id: a.id,
    agent: a.agent,
    status: a.status,
    eventLog: (a as WidgetAgentState & { eventLog?: AgentEventLogEntry[] }).eventLog ?? [],
    turns: a.turns,
    totalTokens: a.totalTokens,
    startedAt: a.finishedAt
      ? a.finishedAt - (a.elapsedSeconds ?? 0) * 1000
      : Date.now() - (a.elapsedSeconds ?? 0) * 1000,
    endedAt: a.finishedAt,
  }));
  const bgRecords: SubagentRecord[] = runtime.listBackground().map((b) => ({
    id: b.id,
    agent: b.agent ?? "default",
    status: b.status,
    eventLog: b.eventLog ?? [],
    turns: undefined,
    totalTokens: undefined,
    startedAt: b.startedAt,
    endedAt: b.endedAt,
    result: b.result,
    error: b.error,
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
  return collectRecords(widgetRecords, bgRecords, completedRecords);
}
