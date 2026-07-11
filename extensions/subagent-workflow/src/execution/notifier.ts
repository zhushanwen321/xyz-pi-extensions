// src/execution/notifier.ts
//
// Background 完成回注主对话。sync 不用（调用方还在 await，结果直接返回）。
//
// 职责：
//   - 合并窗口：MERGE_WINDOW_MS 内多个完成合并为一条通知
//   - 去重 TTL：同 id 在 TTL 内不重复通知
//   - 通过 pi.sendMessage({ deliverAs:"followUp", triggerTurn:true }) 注入——
//     当前 turn 结束后唤醒父 agent 处理结果（followUp 不打断 streaming、不锁滚动）

/** 一条待发送的完成通知记录。 */
export interface BgNotifyRecord {
  id: string;
  status: "done" | "failed" | "cancelled";
  agent: string;
  /** 执行所用 model（RecordSnapshot.model），用于完成通知显示。 */
  model?: string;
  result?: string;
  error?: string;
  startedAt: number;
  endedAt: number | undefined;
  /** [MF#1] fork+worktree 模式下子 agent 改动的 patch 路径（worktree 外，cleanup 后留存）。
   *  done 时通知文本显式提示 `git apply`，否则 background 子 agent 在隔离 worktree 的改动
   *  会静默丢失——父 LLM 不知 patch 路径，无法应用。 */
  patchFile?: string;
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

/** 合并窗口（ms）。窗口内多个完成合并为一条消息。 */
const MERGE_WINDOW_MS = 60_000;
/** 去重 TTL（ms）。同 id 在此窗口内不重复通知。 */
const DEDUP_TTL_MS = 60_000;

/** 发送给主对话的 customType（bg-notify-render 消费）。 */
const NOTIFY_CUSTOM_TYPE = "subagent-bg-notify";

/**
 * Background 完成通知器（滑动窗口合并）。
 *
 *   notify(record):
 *     1. dedup TTL 检查：同 id 在 TTL 内 → 跳过
 *     2. 入 pending 队列
 *     3. 清除旧 timer（滑动窗口重置）
 *     4. 已无 running background → 立即 flush（最后一批）
 *     5. 否则重启 MERGE_WINDOW_MS timer（等后续完成合并）
 *
 *   flushPendingNotifications():  timer 到期 / 无 running / shutdown 触发
 *     1. 取出 pending 全部 record
 *     2. 合并为一条消息（多条时列 bullet list）
 *     3. sendMessage({ customType:"subagent-bg-notify",
 *                     content, display:true,
 *                     triggerTurn:true, deliverAs:"followUp" })
 *     4. 清空 pending + timer
 *
 * 滑动窗口：每次有新完成都重置 60s 计时器，密集完成的任务尽量合并到一条通知。
 * 无 running 时立即 flush——避免最后一条等满窗口。
 */
export class BgNotifier {
  private readonly pending: BgNotifyRecord[] = [];
  /** dedup：id → 上次通知时间戳。 */
  private readonly dedup = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private _disposed = false;

  constructor(private readonly host: NotifierHost) {}

  /**
   * 入队一条完成通知（去重 + 滑动窗口合并）。dispose 后短路。
   */
  notify(record: BgNotifyRecord): void {
    if (this._disposed) return;

    const now = Date.now();
    // sweep 过期 dedup 条目（防 Map 无限增长）
    if (this.dedup.size > 0) {
      for (const [id, ts] of this.dedup) {
        if (now - ts >= DEDUP_TTL_MS) this.dedup.delete(id);
      }
    }
    const lastSeen = this.dedup.get(record.id);
    if (lastSeen !== undefined && now - lastSeen < DEDUP_TTL_MS) return;
    this.dedup.set(record.id, now);

    this.pending.push(record);

    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (!this.host.hasRunningBackground()) {
      this.flushPendingNotifications();
      return;
    }

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
      ? this.buildLlmContent(records[0])
      : records.map((r) => this.buildLlmContent(r)).join("\n\n---\n\n");
    const details = records.length === 1
      ? records[0]
      : { batch: true, items: records };

    this.host.sendMessage({
      customType: NOTIFY_CUSTOM_TYPE,
      content,
      display: true,
      details,
    }, { triggerTurn: true, deliverAs: "followUp" });
  }

  private buildLlmContent(record: BgNotifyRecord): string {
    const agent = record.agent;
    const id = record.id;
    switch (record.status) {
      case "done": {
        const base = `Subagent "${agent}" (${id}) completed. Result:\n${record.result ?? "(empty)"}`;
        if (record.patchFile) {
          return `${base}\n\nThis subagent ran in an isolated worktree; its file changes were captured as a patch:\n  ${record.patchFile}\nTo bring these changes into the current repo, run: \`git apply ${record.patchFile}\``;
        }
        return base;
      }
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
    this.dedup.clear();
  }

  /** /resume /fork /new 后复活。 */
  revive(): void {
    this._disposed = false;
  }
}
