// src/runtime/execution/notifier.ts
//
// Background 完成回注主对话。sync 不用（调用方还在 await，结果直接返回）。
//
// 职责：
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
  /** 执行所用 model（RecordSnapshot.model），用于完成通知显示。 */
  model?: string;
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

/** 发送给主对话的 customType（bg-notify-render 消费）。 */
const NOTIFY_CUSTOM_TYPE = "subagent-bg-notify";

// content 不再截断——它进 LLM context，截断会让 AI 看不到完整结果而被迫 poll。
// block 展示靠 details（renderer 自己 firstLine + truncLine 截断），与 content 解耦。

// ============================================================
// BgNotifier
// ============================================================

/**
 * Background 完成通知器。每条 record 直接发送，无合并窗口。
 *
 * deliverAs:"followUp" + triggerTurn:true：完成通知在当前 streaming turn 结束后
 * 唤醒父 agent 处理结果（followUp 不打断 streaming、不锁滚动）。
 */
export class BgNotifier {
  private _disposed = false;

  constructor(private readonly host: NotifierHost) {}

  /** 发送一条完成通知。dispose 后短路。 */
  notify(record: BgNotifyRecord): void {
    if (this._disposed) return;

    const content = this.buildLlmContent(record);
    const details = record;

    this.host.sendMessage({
      customType: NOTIFY_CUSTOM_TYPE,
      content,
      display: true,
      details,
    }, { triggerTurn: true, deliverAs: "followUp" });
  }

  /** 空操作，保留签名兼容 SubagentService.dispose 调用。 */
  flushPendingNotifications(): void {}

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


  /** session 结束。 */
  dispose(): void {
    this._disposed = true;
  }

  /** /resume /fork /new 后复活。 */
  revive(): void {
    this._disposed = false;
  }
}
