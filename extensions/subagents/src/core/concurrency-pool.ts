// src/core/concurrency-pool.ts
//
// 并发控制 + 优先级排队。sync=0 高（抢占），background=1000 低（让步）。

/** 队列条目：优先级 + resolver + 入队序号（同优先级 FIFO）。 */
interface QueueEntry {
  priority: number;
  resolve: () => void;
  seq: number;
}

/** 并发池接口（可注入，便于测试 mock）。 */
export interface ConcurrencyPool {
  /** 按优先级排队获取槽位（0=最高）。释放前阻塞。 */
  acquire(priority: number): Promise<void>;
  /** 归还槽位。必须无条件执行（finally）。 */
  release(): void;
  /** 当前已占用槽位数（诊断/widget 用）。 */
  readonly active: number;
}

/**
 * 默认实现：maxConcurrent 槽位 + 优先级队列。
 *
 *   acquire(priority):
 *     active < max → active++, resolve
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

  constructor(private readonly maxConcurrent: number) {}

  acquire(priority: number): Promise<void> {
    if (this._active < this.maxConcurrent) {
      this._active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push({ priority, resolve, seq: this.seqCounter++ });
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
