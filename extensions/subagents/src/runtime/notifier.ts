// src/runtime/notifier.ts
//
// Background 完成回注主对话。sync 不用（调用方还在 await，结果直接返回）。
//
// 职责：
//   - 合并窗口：MERGE_WINDOW_MS 内多个完成合并为一条通知
//   - 去重 TTL：同 id 在 TTL 内不重复通知
//   - 通过 pi.sendMessage({ triggerTurn:false }) 注入，渲染完成 block 给用户看
//     但不唤醒父 agent（避免 streaming 锁底，用户可自由滚动查看）

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
  /** 是否还有 running 的 background 任务（用于滑动窗口立即 flush 判断）。 */
  hasRunningBackground(): boolean;
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
 * Background 完成通知器（滑动窗口合并）。
 *
 *   ╔══════════════════════════════════════════════════════════════════╗
//   ║  notify(record):                                                   ║
//   ║    1. dedup TTL 检查：同 id 在 TTL 内 → 跳过                        ║
//   ║    2. 入 pending 队列                                              ║
//   ║    3. 清除旧 timer（滑动窗口重置）                                  ║
//   ║    4. 已无 running background → 立即 flush（最后一批）              ║
//   ║    5. 否则重启 MERGE_WINDOW_MS timer（等后续完成合并）              ║
//   ║                                                                    ║
//   ║  flushPending():  timer 到期 / 无 running / shutdown 触发           ║
//   ║    1. 取出 pending 全部 record                                      ║
//   ║    2. 合并为一条消息（多条时列 bullet list）                        ║
//   ║    3. sendMessage({ customType:"subagent-bg-notify",               ║
//   ║                     content, display:true, triggerTurn:false })    ║
//   ║    4. 清空 pending + timer                                         ║
//   ╚══════════════════════════════════════════════════════════════════╝
 *
 * 滑动窗口：每次有新完成都重置 20s 计时器，密集完成的任务尽量合并到一条通知。
 * 无 running 时立即 flush——避免最后一条等满 20s。
 *
 * triggerTurn:false 不唤醒父 agent——完成通知只渲染 display block 给用户看，
 * 不触发 streaming（避免终端 scrollback 锁底，用户可自由滚动）。主 agent 后续
 * poll 或用户手动提示时再处理结果。
 */
export class BgNotifier {
  private readonly pending: BgNotifyRecord[] = [];
  /** dedup：id → 上次通知时间戳。 */
  private readonly dedup = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private _disposed = false;

  constructor(private readonly host: NotifierHost) {}

  /**
   * 入队一条完成通知（去重 + 滑动窗口合并）。dispose 后短路。
   *
   * 滑动窗口策略（每次有新完成就重置 20s 计时器，等待后续 background 批量合并）：
   *   1. push 到 pending
   *   2. 清除旧 timer
   *   3. 若已无 running background → 立即 flush（最后一条，不必等窗口）
   *   4. 否则重启 20s timer（滑动：每次新完成都重置，让密集完成的任务尽量合并）
   */
  notify(record: BgNotifyRecord): void {
    if (this._disposed) return;

    // dedup TTL：同 id 短时间内不重复通知
    const now = Date.now();
    const lastSeen = this.dedup.get(record.id);
    if (lastSeen !== undefined && now - lastSeen < DEDUP_TTL_MS) return;
    this.dedup.set(record.id, now);

    this.pending.push(record);

    // 清除旧 timer（滑动窗口：重置计时）
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    // 已无 running background → 立即 flush（最后一批，不必等窗口）
    if (!this.host.hasRunningBackground()) {
      this.flushPendingNotifications();
      return;
    }

    // 重启 20s 滑动窗口
    this.timer = setTimeout(() => this.flushPendingNotifications(), MERGE_WINDOW_MS);
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

    // display:true + triggerTurn:false —— 渲染一个 customMessageBg 色完成 block
    // 让用户在对话流看到「X 完成」，但不唤醒父 agent（避免 streaming 锁底）。
    //
    // triggerTurn:false 的理由：triggerTurn:true 会触发父 agent 新 turn，streaming
    // 期间 Pi 持续写 \r\n（tui.ts:1330），终端 scrollback 把视图钉在底部——用户无法
    // 滚动查看历史。background 的本意是「不主动打扰」，完成通知给用户看即可，主 agent
    // 后续 poll 或用户手动提示时再处理结果。
    this.host.sendMessage({
      customType: NOTIFY_CUSTOM_TYPE,
      content,
      display: true,
    }, { triggerTurn: false });
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
