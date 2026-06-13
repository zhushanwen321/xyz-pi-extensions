// src/pool/concurrency-pool.ts
import type { ConcurrencyPool } from "../types.ts";

interface QueueEntry {
  priority: number;
  resolve: () => void;
  seq: number; // 入队顺序（同优先级 FIFO）
}

/**
 * Promise 队列实现的并发池。控制同时进行的任务数，支持优先级插队。
 * FR-7: acquire() 阻塞直到有空位；release() 释放并唤醒下一个。
 */
export class DefaultConcurrencyPool implements ConcurrencyPool {
  private active = 0;
  private readonly queue: QueueEntry[] = [];
  private seqCounter = 0;

  constructor(public readonly maxConcurrent: number) {}

  acquire(priority: number = Infinity): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
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
      // active 不变（一个离开队列，立即进入活跃）
    } else {
      this.active--;
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get queueLength(): number {
    return this.queue.length;
  }
}
