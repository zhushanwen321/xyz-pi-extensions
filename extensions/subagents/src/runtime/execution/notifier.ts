// src/runtime/execution/notifier.ts
//
// Background 完成回注主对话。sync 不用（调用方还在 await，结果直接返回）。
//
// 职责：
//   - 合并窗口：MERGE_WINDOW_MS 内多个完成合并为一条通知
//   - 去重 TTL：同 id 在 TTL 内不重复通知
//   - 通过 pi.sendMessage({ deliverAs:"followUp", triggerTurn:true }) 注入——
//     当前 turn 结束后唤醒父 agent 处理结果（followUp 不打断 streaming、不锁滚动）

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
  /** 注入消息到主对话。
   *  triggerTurn:true + deliverAs:"followUp" → 当前 streaming 结束后唤醒父 agent
   *  处理结果（不打断、不锁滚动）；空闲时立即 prompt 新 turn。 */
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
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

// content 不再截断——它进 LLM context，截断会让 AI 看不到完整结果而被迫 poll。
// block 展示靠 details（renderer 自己 firstLine + truncLine 截断），与 content 解耦。

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
//   ║                     content, display:true,                         ║
//   ║                     triggerTurn:true, deliverAs:"followUp" })      ║
//   ║    4. 清空 pending + timer                                         ║
//   ╚══════════════════════════════════════════════════════════════════╝
 *
 * 滑动窗口：每次有新完成都重置 2s 计时器，密集完成的任务尽量合并到一条通知。
 * 无 running 时立即 flush——避免最后一条等满窗口。
 *
 * deliverAs:"followUp" + triggerTurn:true：完成通知在当前 streaming turn 结束后
 * 唤醒父 agent 处理结果（followUp 不打断 streaming、不锁滚动）。父 agent 收到后
 * 可继续后续逻辑；多条合并的消息在同一个 followUp turn 里处理。
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
   * 滑动窗口策略（每次有新完成就重置 2s 计时器，等待后续 background 批量合并）：
   *   1. push 到 pending
   *   2. 清除旧 timer
   *   3. 若已无 running background → 立即 flush（最后一条，不必等窗口）
   *   4. 否则重启 2s timer（滑动：每次新完成都重置，让密集完成的任务尽量合并）
   */
  notify(record: BgNotifyRecord): void {
    if (this._disposed) return;

    // dedup TTL：同 id 短时间内不重复通知
    const now = Date.now();
    // sweep 过期 dedup 条目（防 Map 无限增长，M2 修复）
    if (this.dedup.size > 0) {
      for (const [id, ts] of this.dedup) {
        if (now - ts >= DEDUP_TTL_MS) this.dedup.delete(id);
      }
    }
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

    // 重启 2s 滑动窗口
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
    // content（进 LLM context）= 完整 result，不截断——截断会让 AI 被迫 poll 拉全量。
    // details（给 TUI renderer）= 完整 record，renderer 自己 firstLine + truncLine 压缩显示。
    // 多条合并时 content 含所有 record 的完整 result（LLM 需要全部）。
    const content = records.length === 1
      ? this.buildLlmContent(records[0])
      : records.map((r) => this.buildLlmContent(r)).join("\n\n---\n\n");
    const details = records.length === 1
      ? records[0]
      : { batch: true, items: records };

    // display:true + triggerTurn:true + deliverAs:"followUp" —— 渲染一个完成 block
    // 让用户在对话流看到「X 完成」，并在当前 streaming turn 结束后唤醒父 agent 处理结果。
    //
    // deliverAs:"followUp" 的理由：不打断正在 streaming 的 turn（避免 steer 中断正在
    // 的工具调用）；streaming 结束后父 agent 自然收到这条消息继续处理。空闲时（非
    // streaming）triggerTurn:true 直接 prompt 一个新 turn。多条合并的消息在同一个
    // followUp turn 里一起处理。
    this.host.sendMessage({
      customType: NOTIFY_CUSTOM_TYPE,
      content,
      display: true,
      details,
    }, { triggerTurn: true, deliverAs: "followUp" });
  }

  /**
   * 构建 content（进 LLM context）——完整 result，不截断。
   *
   * content 是 custom message 的正文，经 convertToLlm 转成 user message 进 LLM context。
   * 旧实现用 PREVIEW_MAX=200 截断，导致 LLM 看到截断结果后被迫发 subagent poll 拉全量——
   * 与 background 模式「不轮询」的设计目标矛盾。修复：content 含完整 result。
   *
   * block 的视觉展示与 content 解耦：renderer 读 details，自己 firstLine + truncLine 压成
   * 单行预览。content 长不影响 block 显示。
   */
  private buildLlmContent(record: BgNotifyRecord): string {
    const agent = record.agent;
    const id = record.id;
    switch (record.status) {
      case "done":
        return `Subagent "${agent}" (${id}) completed. Result:\n${record.result ?? "(empty)"}`;
      case "failed":
        return `Subagent "${agent}" (${id}) failed: ${record.error ?? "(unknown error)"}`;
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
    this.dedup.clear(); // 防 stale dedup 跨 /resume 残留（M2 修复）
  }

  /** /resume /fork /new 后复活。 */
  revive(): void {
    this._disposed = false;
  }
}
