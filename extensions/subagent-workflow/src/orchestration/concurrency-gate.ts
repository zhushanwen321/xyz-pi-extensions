/**
 * Workflow Extension — Concurrency Gate
 *
 * 并发信号量薄封装。Engine 层 dispatchAgentCall 通过 withSlot 包装
 * executeAgentCall，gate 仅处理 signal abort 检查。实际并发调度
 * 由 SubagentService 内部的 ConcurrencyPool 统一管理。
 *
 * Wave 3 (D-A7)：withSlot 退化为 abort 薄封装，不独立占池。
 * 并发槽位由 execution/ConcurrencyPool（SubagentService 持有）统一管理，
 * 消除 gate + pool 双重计数的 2N 问题（T3.20）。
 *
 * 层归属：Infra（D-12）。RunRuntime 直接持有具体类。
 */

// ── Constants ─────────────────────────────────────────────────

/**
 * 默认并发上限（D-13）。保留常量向后兼容。
 * 实际并发由 ConcurrencyPool 管理。
 */
export const DEFAULT_CONCURRENCY = 4;

// ── Public options ────────────────────────────────────────────

export interface ConcurrencyGateOptions {
 /** 最大并发数，缺省 4（D-13）。保留向后兼容。 */
  maxConcurrency?: number;
}

// ── ConcurrencyGate ───────────────────────────────────────────

export class ConcurrencyGate {
  private readonly maxConcurrency: number;

  constructor(opts: ConcurrencyGateOptions | number = {}) {
    this.maxConcurrency =
      typeof opts === "number" ? opts : (opts.maxConcurrency ?? DEFAULT_CONCURRENCY);
  }

 /** 当前在飞的 agent 调用数（不独立计槽，恒为 0）。 */
  get activeCount(): number {
    return 0;
  }

 /** 排队等待派发的调用数（不独立计槽，恒为 0）。 */
  get queueLength(): number {
    return 0;
  }

 /**
  * 获取一个并发槽位，执行 `fn`。
  *
  * Wave 3 简化：不独立管理槽位。仅做 signal pre-abort 检查，
  * 直接执行 fn。实际并发调度由 SubagentService 的 ConcurrencyPool 负责。
  *
  * @param fn 槽位获取后执行的异步函数
  * @param signal 外部 abort signal（pre-aborted 时立即 reject）
  * @returns fn 的返回值
  * @throws AbortError（signal 已 abort 时）
  */
  async withSlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      const err = new Error("Operation aborted before start");
      err.name = "AbortError";
      throw err;
    }
    return fn();
  }
}
