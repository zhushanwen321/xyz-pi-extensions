// src/core/concurrency-pool.ts
//
// 并发控制 + 优先级排队。background=1000（单一优先级，保留 priority 机制供未来扩展）。

/** 队列条目：优先级 + resolver + rejecter + 入队序号（同优先级 FIFO）。 */
interface QueueEntry {
  priority: number;
  resolve: () => void;
  reject: (err: Error) => void;
  seq: number;
  /** abort listener（用于 resolve/abort 时清理）。 */
  onAbort?: () => void;
  /** 关联的 signal（用于 resolve 时 removeEventListener）。 */
  signal?: AbortSignal;
}

/** 并发池接口（可注入，便于测试 mock）。 */
export interface ConcurrencyPool {
  /** 按优先级排队获取槽位（0=最高）。可选 effectiveMaxConcurrent 覆盖实例级默认配额。可选 AbortSignal 在 abort 时 reject 排队条目。 */
  acquire(priority: number, effectiveMaxConcurrent?: number, signal?: AbortSignal): Promise<void>;
  /** 归还槽位。必须无条件执行（finally）。 */
  release(): void;
  /** 当前已占用槽位数（诊断/widget 用）。 */
  readonly active: number;
  /** 实例级最大并发配额。调用方可据此计算分层配额（max(1, maxConcurrent - depth)）。 */
  readonly maxConcurrent: number;
}

/**
 * 默认实现：maxConcurrent 槽位 + 优先级队列。
 *
 *   acquire(priority, effectiveMaxConcurrent?):
 *     effective = effectiveMaxConcurrent ?? maxConcurrent
 *     active < effective → active++, resolve
 *     否则 → 入队 { priority, resolve, seq }, 队列按 priority 升序 + seq FIFO
 *
 *   release():
 *     queue 非空 → 出队最高优先级 resolve（active 不变）
 *     queue 空 → active--（防下溢）
 */
export class DefaultConcurrencyPool implements ConcurrencyPool {
  private _active = 0;
  private readonly queue: QueueEntry[] = [];
  private seqCounter = 0;

  /** 下限 1——maxConcurrent=0 会让 acquire 永久排队死锁（C3 修复）。 */
  readonly maxConcurrent: number;

  constructor(maxConcurrent: number) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
  }

  acquire(priority: number, effectiveMaxConcurrent?: number, signal?: AbortSignal): Promise<void> {
    // effectiveMaxConcurrent 覆盖实例级默认配额（分层配额：调用方传 max(1, maxConcurrent - depth)）。
    // 不修改实例级 maxConcurrent——实例配额是全局共享上限，分层配额是本次 acquire 的局部上限。
    const effective = effectiveMaxConcurrent ?? this.maxConcurrent;
    if (this._active < effective) {
      this._active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = { priority, resolve, reject, seq: this.seqCounter++ };
      // H2: abort 时 reject 排队条目并从 queue 移除，防止永久挂起
      if (signal) {
        if (signal.aborted) {
          // S1: abort reject 需带 name="AbortError"，对齐 concurrency-gate.ts 的 AbortError 语义
          const err = new Error("acquire aborted");
          err.name = "AbortError";
          reject(err);
          return;
        }
        entry.signal = signal;
        entry.onAbort = (): void => {
          const idx = this.queue.indexOf(entry);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
            // S1: abort reject 需带 name="AbortError"，与 pre-aborted 分支一致
            const err = new Error("acquire aborted");
            err.name = "AbortError";
            reject(err);
          }
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.queue.push(entry);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      // 取优先级最高（priority 最小）的；同优先级 FIFO（seq 最小）
      let bestIdx = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const cur = this.queue[i];
        const best = this.queue[bestIdx];
        if (cur.priority < best.priority || (cur.priority === best.priority && cur.seq < best.seq)) {
          bestIdx = i;
        }
      }
      const next = this.queue.splice(bestIdx, 1)[0];
      // H2: 条目已获槽位——移除 abort listener（防 listener 泄漏到长生命周期 signal）
      if (next.onAbort && next.signal) {
        next.signal.removeEventListener("abort", next.onAbort);
      }
      next.resolve();
      // active 不变（一个离开队列立即进入活跃）
    } else if (this._active > 0) {
      // 防御性下界：release 调用次数多于 acquire 时不让 active 为负
      this._active -= 1;
    }
  }

  get active(): number {
    return this._active;
  }
}
