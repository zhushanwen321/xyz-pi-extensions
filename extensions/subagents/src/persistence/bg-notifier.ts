// src/persistence/bg-notifier.ts
//
// FR-O1: Background 完成通知系统。
// 从 runtime.ts 拆出（避免 runtime.ts 超 1000 行上限）。
//
// 职责：
//   - formatBgCompletionMessage: 格式化单条完成通知
//   - notifyBgCompletion: TTL 去重 + 合并窗口（G-028 首条零延迟，后续合并）
//   - flushPendingNotifications: 合并窗口到期，合并发送
//   - dispose: 清理定时器

import { buildCompletionKey, getGlobalSeenMap, markSeenWithTtl } from "./completion-dedupe.ts";
import type { AgentResult } from "../types.ts";

/** FR-O1.3: background 完成通知去重 TTL（10 分钟，移植自 notify.ts:56） */
const BG_NOTIFY_TTL_MS = 10 * 60 * 1000;
/** FR-O1.5 G-028: 合并窗口时长 */
const BG_MERGE_WINDOW_MS = 2000;

/** 通知记录形状（与 BgRecord 完成时的展平字段一致） */
export interface BgNotifyRecord {
  id: string;
  status: "done" | "failed" | "cancelled";
  agent?: string;
  result?: AgentResult;
  error?: string;
  endedAt?: number;
  startedAt: number;
}

/** Pi sendMessage 最小接口 */
interface PiSendLike {
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options?: { triggerTurn?: boolean; deliverAs?: "followUp" | "steer" | "nextTurn" },
  ): void;
  appendEntry(customType: string, data?: unknown): void;
}

/**
 * Background 完成通知器。管理合并窗口 + 去重 + 发送。
 */
export class BgNotifier {
  private readonly _pi: PiSendLike | null;
  private readonly _pendingNotifications: BgNotifyRecord[] = [];
  private _mergeWindowTimer?: ReturnType<typeof setTimeout>;
  private _disposed = false;

  constructor(pi: PiSendLike | null) {
    this._pi = pi;
  }

  /** FR-O1.2: 格式化单条完成通知文本 */
  formatBgCompletionMessage(record: BgNotifyRecord): string {
    const statusWord = record.status === "done" ? "completed" : record.status;
    const agent = record.agent ?? "default";
    const lines = [`Background task ${statusWord}: **${agent}**`];
    const body = record.result?.text ?? record.error ?? "(no output)";
    const truncated = body.length > 500 ? body.slice(0, 500) + "..." : body;
    lines.push("", truncated);
    lines.push("", `backgroundId: ${record.id}`);
    if (record.result?.sessionFile) {
      lines.push(`Session file: ${record.result.sessionFile}`);
    }
    return lines.join("\n");
  }

  /**
   * FR-O1.1 + FR-O1.3 + FR-O1.5 + FR-O1.7: 发送 background 完成通知到主对话。
   *
   * 合并窗口策略（G-028 决策）：
   * - 首个完成事件**立即发送**，同时启动 BG_MERGE_WINDOW_MS 合并窗口
   * - 窗口内的后续完成事件入队，窗口到期时合并成一条消息发送
   * - 这样单个 background 零延迟，多个几乎同时完成的 background 被合并防刷屏
   *
   * 含 TTL 去重（防 cancel + abort catch 双发）+ try/catch 兜底（G-025 stale runtime）。
   */
  notifyBgCompletion(record: BgNotifyRecord): void {
    if (this._disposed) return;
    const seen = getGlobalSeenMap("__subagents_bg_notify_seen__");
    const key = buildCompletionKey(
      { id: record.id, agent: record.agent, success: record.status === "done" },
      "bg-notify",
    );
    if (markSeenWithTtl(seen, key, Date.now(), BG_NOTIFY_TTL_MS)) return; // 重复，跳过

    // G-028: 首个事件立即发送，后续入合并窗口
    if (this._pendingNotifications.length === 0 && !this._mergeWindowTimer) {
      this.sendSingleNotification(record);
      this._mergeWindowTimer = setTimeout(() => {
        this._mergeWindowTimer = undefined;
        this.flushPendingNotifications();
      }, BG_MERGE_WINDOW_MS);
      this._mergeWindowTimer.unref?.();
    } else {
      this._pendingNotifications.push(record);
    }
  }

  /** FR-O1.7: 发送单条通知（含 try/catch 兜底，G-025 stale runtime） */
  private sendSingleNotification(record: BgNotifyRecord): void {
    const content = this.formatBgCompletionMessage(record);
    try {
      this._pi?.sendMessage(
        { customType: "subagent-bg-notify", content, display: false },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch {
      try {
        this._pi?.appendEntry("subagent-bg-record", { id: record.id, status: record.status });
      } catch {
        // 两层都 stale，放弃（结果仍可通过 getBackground 查询）
      }
    }
  }

  /** FR-O1.5 G-029: flush 合并窗口中 pending 的通知，合并为一条消息发送 */
  flushPendingNotifications(): void {
    if (this._disposed) return;
    if (this._mergeWindowTimer) {
      clearTimeout(this._mergeWindowTimer);
      this._mergeWindowTimer = undefined;
    }
    const pending = this._pendingNotifications.splice(0);
    if (pending.length === 0) return;
    const lines = pending.map((r) => {
      const status = r.status === "done" ? "completed" : r.status;
      const agent = r.agent ?? "default";
      const body = (r.result?.text ?? r.error ?? "(no output)").slice(0, 200);
      const sessionLine = r.result?.sessionFile ? `\n  Session file: ${r.result.sessionFile}` : "";
      return `Background task ${status}: **${agent}** (${r.id})\n  ${body}${sessionLine}`;
    });
    const content = `${pending.length} background tasks completed:\n\n${lines.join("\n\n")}`;
    try {
      this._pi?.sendMessage(
        { customType: "subagent-bg-notify", content, display: false },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch {
      // stale runtime，放弃合并发送（结果仍可通过 getBackground 查询）
    }
  }

  /** FR-O1.5 G-029: 清理资源。只 clear timer，不 flush（flush 会向已结束 session 注入消息）。 */
  dispose(): void {
    this._disposed = true;
    if (this._mergeWindowTimer) {
      clearTimeout(this._mergeWindowTimer);
      this._mergeWindowTimer = undefined;
    }
    this._pendingNotifications.length = 0;
  }

  /** Round 4 MF3: 重置 dispose 状态（配合 runtime.revive） */
  revive(): void {
    this._disposed = false;
  }
}
