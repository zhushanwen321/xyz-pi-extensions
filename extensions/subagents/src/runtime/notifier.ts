// src/runtime/notifier.ts
//
// Background 完成回注主对话。sync 不用（调用方还在 await，结果直接返回）。
//
// 职责：
//   - 合并窗口：MERGE_WINDOW_MS 内多个完成合并为一条通知
//   - 去重 TTL：同 id 在 TTL 内不重复通知
//   - 通过 pi.sendMessage({ triggerTurn:true }) 注入，唤醒父 agent 下一 turn

// ============================================================
// 类型
// ============================================================

/** 一条待发送的完成通知记录。 */
export interface BgNotifyRecord {
  id: string;
  status: "done" | "failed" | "cancelled";
  agent: string;
  result?: string;
  error?: string;
  startedAt: number;
  endedAt: number | undefined;
}

/** notifier 依赖的 pi 最小接口（解耦，便于测试）。 */
export interface NotifierHost {
  /** 注入消息到主对话，可选触发新 turn。 */
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean },
  ): void;
}

// ============================================================
// 常量
// ============================================================

/** 合并窗口（ms）。窗口内多个完成合并为一条消息。 */
const MERGE_WINDOW_MS = 2000;

/** 去重 TTL（ms）。同 id 在此窗口内不重复通知。 */
const DEDUP_TTL_MS = 5000;

/** 发送给主对话的 customType（bg-notify-render 消费）。 */
const NOTIFY_CUSTOM_TYPE = "subagent-bg-notify";

/** result/error 预览截断长度（防超长结果撑爆通知消息）。 */
const PREVIEW_MAX = 200;

// ============================================================
// BgNotifier
// ============================================================

/**
 * Background 完成通知器。
 *
 *   ╔══════════════════════════════════════════════════════════════════╗
//   ║  notify(record):                                                   ║
//   ║    1. dedup TTL 检查：同 id 在 TTL 内 → 跳过                        ║
//   ║    2. 入 pending 队列                                              ║
//   ║    3. 若无 pending timer → 启动 MERGE_WINDOW_MS 定时器              ║
//   ║                                                                    ║
//   ║  flushPending():  timer 到期触发                                   ║
//   ║    1. 取出 pending 全部 record                                      ║
//   ║    2. 合并为一条消息（多条时列 bullet list）                        ║
//   ║    3. sendMessage({ customType:"subagent-bg-notify",               ║
//   ║                     content, display:true, triggerTurn:true })     ║
//   ║    4. 清空 pending + timer                                         ║
//   ╚══════════════════════════════════════════════════════════════════╝
 *
 * triggerTurn:true 让父 agent 在下一 turn 看到「subagent X 完成」，
 * 无需 LLM 主动 poll。
 */
export class BgNotifier {
  private readonly pending: BgNotifyRecord[] = [];
  /** dedup：id → 上次通知时间戳。 */
  private readonly dedup = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private _disposed = false;

  constructor(private readonly host: NotifierHost) {}

  /** 入队一条完成通知（去重 + 合并窗口）。dispose 后短路。 */
  notify(record: BgNotifyRecord): void {
    if (this._disposed) return;

    // dedup TTL：同 id 短时间内不重复通知
    const now = Date.now();
    const lastSeen = this.dedup.get(record.id);
    if (lastSeen !== undefined && now - lastSeen < DEDUP_TTL_MS) return;
    this.dedup.set(record.id, now);

    this.pending.push(record);
    // 若无 pending timer → 启动合并窗口定时器
    if (this.timer === undefined) {
      this.timer = setTimeout(() => this.flushPendingNotifications(), MERGE_WINDOW_MS);
    }
  }

  /** 立即 flush（session_shutdown 调用，防丢失）。 */
  flushPendingNotifications(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) return;

    const records = this.pending.splice(0);
    const content = records.length === 1
      ? this.formatBgCompletionMessage(records[0])
      : records.map((r) => `- ${this.formatBgCompletionMessage(r)}`).join("\n");

    // display:true —— 渲染一个 customMessageBg 色完成 block（与 tool block 区分），
    // 让用户/主 agent 在对话流看到「X 完成」。triggerTurn:true 唤醒父 agent 下一 turn。
    // （对照 Pi 引擎 interactive-mode.ts:3069-3076：display:true 时调
    //   bg-notify-render 渲染完成摘要 block。）
    this.host.sendMessage({
      customType: NOTIFY_CUSTOM_TYPE,
      content,
      display: true,
    }, { triggerTurn: true });
  }

  /** 格式化单条完成消息（供 sendMessage 的 content）。 */
  formatBgCompletionMessage(record: BgNotifyRecord): string {
    const agent = record.agent;
    const id = record.id;
    const preview = (text?: string): string =>
      text ? (text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) : text) : "";
    switch (record.status) {
      case "done":
        return `Subagent "${agent}" (${id}) completed. Result: ${preview(record.result) || "(empty)"}`;
      case "failed":
        return `Subagent "${agent}" (${id}) failed: ${preview(record.error) || "(unknown error)"}`;
      case "cancelled":
        return `Subagent "${agent}" (${id}) cancelled.`;
    }
  }

  /** session 结束：清 timer，丢弃 pending。 */
  dispose(): void {
    this._disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending.length = 0;
  }

  /** /resume /fork /new 后复活。 */
  revive(): void {
    this._disposed = false;
  }
}
