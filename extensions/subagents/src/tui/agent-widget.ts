// src/tui/agent-widget.ts
//
// Live subagent widget — 在编辑器上方实时显示运行中/排队中/刚完成的子 agent 状态。
// 参考 tintinweb/pi-subagents 的 agent-widget.ts。
//
// 渲染通过 ui.setWidget("subagents", lines) + ui.setStatus("subagents", summary) 更新。
// 数据源：SubagentRuntime 的 background 记录 + 正在执行的 runAgent（通过 onWidgetUpdate 回调）。

import { type AgentEventLogEntry,STALLED_TIMEOUT_MS, WIDGET_EVENT_LINES } from "../types.ts";
import { formatEventLogLine, formatStatusSummary, type ThemeLike } from "./format.ts";

/** widget 最多显示行数 */
const MAX_WIDGET_LINES = 12;
/** 超过此数量时只显示 status，不展开 eventLog（FR-2.2） */
const MAX_RUNNING_AGENTS_FOR_EVENT_LOG = 3;
/** 完成状态淡出延迟（ms） */
const FINISHED_LINGER_MS = 5000;
/** summary 截断长度 */
const SUMMARY_MAX = 60;
/** truncate ellipsis length */
const TRUNCATE_TAIL = 3;
/** widget 渲染轮询间隔（ms） */
const RENDER_INTERVAL_MS = 200;

/** 单个 agent 的 widget 状态快照 */
export interface WidgetAgentState {
  readonly id: string;
  readonly agent: string;
  status: "running" | "done" | "failed" | "cancelled";
  /** 当前 turn 数 */
  turns?: number;
  /** 累计 token 数 */
  totalTokens?: number;
  /** 已运行秒数 */
  elapsedSeconds?: number;
  /** 当前工具动作描述 */
  activity?: string;
  /** 完成时的输出摘要（done/failed 时） */
  summary?: string;
  /** 完成时间戳（用于 linger 淡出） */
  finishedAt?: number;
  /** FR-1.1: 事件日志（ring buffer），由 updateWidgetFromEvent 追加 */
  eventLog?: AgentEventLogEntry[];
  /** FR-1.1b: 当前 turn 文本累加缓冲（turn_end 时切片后重置） */
  _currentTurnText?: string;
}

/** 渲染 widget 内容（string[] 行） */
export function renderWidget(
  agents: WidgetAgentState[],
  spinnerFrame: number,
): string[] {
  const running = agents.filter((a) => a.status === "running");
  const finished = agents.filter((a) => a.status !== "running");

  if (running.length === 0 && finished.length === 0) return [];

  const lines: string[] = [];
  // ThemeLike stub（实际由 ui 提供 ANSI，但本函数纯文本输出不依赖 ANSI）
  const fakeTheme: ThemeLike = {
    fg: (_t, s) => s,
    bold: (s) => s,
  };

  // FR-2.1: 第 1 行 status summary + 后续行 eventLog
  if (running.length <= MAX_RUNNING_AGENTS_FOR_EVENT_LOG) {
    const perAgentSummary = running.length;
    const perAgentEvent = Math.max(1, Math.floor((MAX_WIDGET_LINES - perAgentSummary) / running.length));
    let remainingLines = MAX_WIDGET_LINES - perAgentSummary;

    for (const a of running) {
      lines.push(formatStatusSummary(a, spinnerFrame, fakeTheme));
      const eventLog = a.eventLog ?? [];
      const eventLines = Math.min(perAgentEvent, Math.floor(remainingLines / running.length), WIDGET_EVENT_LINES);
      const recent = eventLog.slice(-eventLines);
      const turnEndsTotal = eventLog.filter((e) => e.type === "turn_end").length;
      const turnEndsAfter = eventLog.slice(eventLog.length - recent.length).filter((e) => e.type === "turn_end").length;
      let turnCountBefore = Math.max(0, (a.turns ?? 0) - (turnEndsTotal - turnEndsAfter));
      for (const entry of recent) {
        lines.push(formatEventLogLine(entry, fakeTheme, entry.type === "turn_end" ? turnCountBefore : undefined));
        if (entry.type === "turn_end") turnCountBefore++;
      }
      remainingLines -= recent.length;

      // FR-3.5 G-008: stalled fallback
      const lastEntry = eventLog[eventLog.length - 1];
      if (lastEntry && Date.now() - lastEntry.ts > STALLED_TIMEOUT_MS) {
        lines.push(`  ⚠ ${a.agent} possibly stalled (no events for 5min)`);
      }
    }
    lines.length = Math.min(lines.length, MAX_WIDGET_LINES);
  } else {
    for (const a of running) {
      lines.push(formatStatusSummary(a, spinnerFrame, fakeTheme));
    }
    lines.length = Math.min(lines.length, MAX_WIDGET_LINES);
  }

  // Finished agents（每 agent 1 行，短暂停留后淡出）
  const now = Date.now();
  for (const a of finished) {
    if (a.finishedAt && now - a.finishedAt > FINISHED_LINGER_MS) continue; // 5 秒后淡出
    const icon = a.status === "done" ? "✓" : a.status === "cancelled" ? "■" : "✗";
    const summary = a.summary ? `: ${truncate(a.summary, SUMMARY_MAX)}` : "";
    lines.push(`${icon} ${a.agent}${summary}`);
  }

  return lines.slice(0, MAX_WIDGET_LINES);
}

/** 渲染 status bar 摘要（单行） */
export function renderStatusLine(agents: WidgetAgentState[]): string | undefined {
  const running = agents.filter((a) => a.status === "running").length;
  if (running === 0) return undefined;
  return `${running} agent${running > 1 ? "s" : ""} running`;
}

/** UI 接口（由 ctx.ui 提供，runtime 注入） */
export interface WidgetUI {
  setWidget(key: string, content: string[] | undefined): void;
  setStatus(key: string, text: string | undefined): void;
}

/**
 * Widget 管理器：持有 agent 状态 + 轮询渲染。
 * 由 SubagentRuntime 持有，在 runAgent/startBackground 时更新状态。
 */
export class AgentWidgetManager {
  private readonly agents = new Map<string, WidgetAgentState>();
  private spinnerFrame = 0;
  private ui: WidgetUI | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** 注入 UI（session_start 时调用） */
  attachUI(ui: WidgetUI): void {
    this.ui = ui;
    // 启动 200ms 轮询（刷新 spinner + 淡出完成的 agent）
    if (!this.timer) {
      this.timer = setInterval(() => this.render(), RENDER_INTERVAL_MS);
    }
  }

  /** 注册/更新 agent 状态 */
  updateAgent(state: WidgetAgentState): void {
    this.agents.set(state.id, state);
    this.render();
  }

  /** 移除 agent（清理） */
  removeAgent(id: string): void {
    this.agents.delete(id);
    this.render();
  }

  /** 获取所有状态快照 */
  listAgents(): WidgetAgentState[] {
    return [...this.agents.values()];
  }

  /** 渲染到 UI */
  render(): void {
    if (!this.ui) return;
    this.spinnerFrame++;
    const snapshot = this.listAgents();
    const lines = renderWidget(snapshot, this.spinnerFrame);
    const status = renderStatusLine(snapshot);

    if (lines.length > 0) {
      this.ui.setWidget("subagents", lines);
    } else {
      this.ui.setWidget("subagents", undefined);
    }
    this.ui.setStatus("subagents", status);
  }

  /** 停止轮询（session_shutdown） */
  detach(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.ui?.setWidget("subagents", undefined);
    this.ui?.setStatus("subagents", undefined);
    this.ui = null;
  }
}

/** 截断字符串 */
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - TRUNCATE_TAIL) + "..." : s;
}
