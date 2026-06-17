// src/core/concurrency-pool.ts
//
// 并发控制 + 优先级排队。sync=0 高（抢占），background=1000 低（让步）。

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
//   ║   if (active < max) → active++, resolve
//   ║   else → 入队 { priority, resolve }, 队列按 priority 升序排序
//   ║
//   ║ release():
//   ║   if (queue 非空) → 出队最高优先级, resolve（active 不变）
//   ║   else → active--
 */
export class DefaultConcurrencyPool implements ConcurrencyPool {
  readonly active = 0;

  constructor(maxConcurrent: number) {
    //  存 maxConcurrent + 初始化 pending 队列
    void maxConcurrent;
    throw new Error("not implemented");
  }

  acquire(priority: number): Promise<void> {
    void priority;
    throw new Error("not implemented");
  }

  release(): void {
    throw new Error("not implemented");
  }
}
