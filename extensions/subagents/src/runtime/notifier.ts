// src/runtime/notifier.ts
//
// Background 完成回注主对话。sync 不用（调用方还在 await，结果直接返回）。
//
// 职责：
//   - 合并窗口：2000ms 内多个完成合并为一条通知
//   - 去重 TTL：同 id 短时间内不重复通知
//   - 通过 pi.sendMessage({ triggerTurn:true }) 注入，唤醒父 agent 下一 turn


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

/** 合并窗口（ms）。 */


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
  constructor(private readonly host: NotifierHost) {
    throw new Error("not implemented");
  }

  /** 入队一条完成通知（去重 + 合并窗口）。dispose 后短路。 */
  notify(record: BgNotifyRecord): void {
    //  1. if (this._disposed) return
    //  2. dedup Map 检查 id
    //  3. pending.push(record)
    //  4. 若 timer 未启动 → setTimeout(flushPending, MERGE_WINDOW_MS)
    void record;
    throw new Error("not implemented");
  }

  /** 立即 flush（session_shutdown 调用，防丢失）。 */
  flushPendingNotifications(): void {
    //  clearTimeout + 合并发送 + 清空 pending
    throw new Error("not implemented");
  }

  /** 格式化单条/多条完成消息（供 sendMessage 的 content）。 */
  formatBgCompletionMessage(record: BgNotifyRecord): string {
    //  根据 status（done/failed/cancelled）+ agent + result/error 拼消息
    void record;
    throw new Error("not implemented");
  }

  /** session 结束：清 timer，丢弃 pending。 */
  dispose(): void {
    //  clearTimeout + _disposed=true
    throw new Error("not implemented");
  }

  /** /resume /fork /new 后复活。 */
  revive(): void {
    //  _disposed=false
    throw new Error("not implemented");
  }
}
