/**
 * Workflow Extension — Concurrency Gate
 *
 * 并发信号量：FIFO 队列 + 有界并发（maxConcurrency=4，D-13）。
 * 每次 enqueue 启动一个独立的 agent 子进程调用，并发槽位释放后从队列取下一个。
 *
 * 层归属：Infra（D-12）。RunRuntime 直接持有具体类，不经过 interface（§domain-models 11）。
 *
 * 职责边界：
 * - 本类只管并发调度 + per-call signal 合并（外部 signal + wall-clock timeoutMs）。
 * - subprocess 执行细节（buildArgs/resolveInvocation/runPiProcess）直接复用
 * pi-runner.ts——与 SubprocessAgentRunner 同源。Engine 层 executeAgentCall
 * 通过 AgentRunner port 调 SubprocessAgentRunner；ConcurrencyGate 不绑定 runner，
 * 保留自包含 spawn 以保证并发场景下的行为正确。
 * - 不含 budget 逻辑（soft limit 由 Engine Budget.isSoftLimitReached 查询）。
 *
 * Session 隔离：每个 ConcurrencyGate 实例归属其创建者（RunRuntime）。
 * 一个 run 实例化一个 gate，避免跨 run 状态泄漏。
 */

import type { AgentCallOpts, AgentResult } from "./models/types.ts";
import { formatFailureContext } from "./format-helpers.ts";
import { makeEmptyPipeline } from "./jsonl-parser.ts";
import { buildArgs, resolveInvocation, runPiProcess } from "./pi-runner.ts";

// ── Constants ─────────────────────────────────────────────────

/**
 * 默认并发上限（D-13）。无数据支撑改其他值，沿用经验值 4。
 */
export const DEFAULT_CONCURRENCY = 4;

// ── Public options ────────────────────────────────────────────

export interface ConcurrencyGateOptions {
 /** 最大并发数，缺省 4（D-13）。 */
  maxConcurrency?: number;
}

// ── Private types ─────────────────────────────────────────────

interface QueueEntry {
  opts: AgentCallOpts;
  resolve: (result: AgentResult) => void;
  startedAt: number;
 /** 外部 abort signal —— 合并到 per-call controller 后传播到子进程。 */
  signal?: AbortSignal;
}

/** withSlot 排队等待项（C-3 修复）。fn/resolve 类型已擦除为 unknown，
 * 调用方 withSlot<T> 内部包装为类型安全的 closure。 */
interface SlotWaiter {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  signal?: AbortSignal;
}

// ── ConcurrencyGate ───────────────────────────────────────────

export class ConcurrencyGate {
  private readonly maxConcurrency: number;
  private readonly queue: QueueEntry[] = [];
 /** withSlot FIFO 等待队列（C-3 修复）。 */
  private readonly slotQueue: SlotWaiter[] = [];
  private active = 0;

  constructor(opts: ConcurrencyGateOptions | number = {}) {
    this.maxConcurrency =
      typeof opts === "number" ? opts : (opts.maxConcurrency ?? DEFAULT_CONCURRENCY);
  }

 /** 当前在飞的 agent 调用数。 */
  get activeCount(): number {
    return this.active;
  }

 /** 排队等待派发的调用数。 */
  get queueLength(): number {
    return this.queue.length;
  }

 /**
 * 入队一次 agent 调用。当并发槽位可用（active < maxConcurrency）时立即派发。
 *
 * 返回的 Promise 在成功与失败时都 resolve——不 reject。错误信息放在
 * result.error 字段（调用方据 error 字段判断失败）。
 *
 * NOTE（C-3 修复）：本方法自包含 spawn pi 子进程——与 SubprocessAgentRunner
 * 是平行的 spawn 路径。Engine 层的 executeAgentCall 用 SubprocessAgentRunner +
 * gate.withSlot 协作（gate 管并发槽位，runner 管 spawn），**不走 enqueue**。
 * enqueue 保留为：(1) ConcurrencyGate 自身的单元测试入口；(2) 未来若需统一 spawn 入口
 * 可再行收口。当前生产路径见 `engine/execute-agent-call.ts` + `error-recovery.ts:dispatchAgentCall`。
 */
  enqueue(opts: AgentCallOpts, signal?: AbortSignal): Promise<AgentResult> {
    return new Promise<AgentResult>((resolve) => {
      const entry: QueueEntry = { opts, resolve, startedAt: Date.now(), signal };
      this.queue.push(entry);

      if (signal) {
        if (signal.aborted) {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) this.queue.splice(idx, 1);
          resolve({
            content: "",
            durationMs: Date.now() - entry.startedAt,
            error: "Operation aborted before start",
            toolCalls: [],
          });
          return;
        }
        const onAbort = (): void => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
            resolve({
              content: "",
              durationMs: Date.now() - entry.startedAt,
              error: "Operation aborted while queued",
              toolCalls: [],
            });
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.drain();
    });
  }

 /** 派发队列直到达并发上限。 */
  private drain(): void {
    while (this.active < this.maxConcurrency && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      this.active++;
      this.run(entry).finally(() => {
        this.active--;
        this.drain();
      });
    }
  }

 /**
 * 获取一个并发槽位，执行 `fn`，释放槽位。
 *
 * **C-3 修复**：Engine 层（executeAgentCall via dispatchAgentCall）用此方法包装
 * runner.run——gate 管并发上限（maxConcurrency=4）+ FIFO 排队，runner 管 spawn
 * pi 子进程。两者职责分离：本方法只做信号量 + FIFO，不 spawn。
 *
 * 若已达上限：fn 排队等待（FIFO），active < maxConcurrency 后才执行。
 * signal abort 时：若 fn 尚未开始（仍在队列中），立即 reject AbortError；
 * 若 fn 已在执行，signal 由 fn 内部消费（runner.run 传播到子进程）。
 *
 * @param fn 槽位获取后执行的异步函数（通常  => runner.run(opts, signal)）
 * @param signal 外部 abort signal（排队期间 abort 立即 reject）
 * @returns fn 的返回值
 * @throws AbortError（signal abort 时 fn 尚未开始）
 */
  async withSlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
 // pre-aborted：立即拒绝（与 enqueue 的 pre-abort 语义一致）
    if (signal?.aborted) {
      const err = new Error("Operation aborted before start");
      err.name = "AbortError";
      throw err;
    }

 // 槽位可用 → 直接执行
    if (this.active < this.maxConcurrency) {
      this.active++;
      try {
        return await fn();
      } finally {
        this.active--;
 // 释放槽位后唤醒 slotQueue 中的 withSlot 等待者。
 // 注意：调 drainSlots（slotQueue），非 drain（enqueue 的 this.queue）。
 // 旧代码误调 drain → withSlot 排队项永不唤醒（C-3 FIFO bug，T-4 测试捕获）。
        this.drainSlots();
      }
    }

 // 槽位满 → 排队等待（FIFO）
    return new Promise<T>((resolve, reject) => {
 // 包装为类型擦除的 waiter：fn 返回 unknown，resolve 接 unknown；
 // 外层 Promise<T> 的 resolve/reject 保持类型安全（T 传入即固定）。
      const entry: SlotWaiter = {
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject: reject as (err: unknown) => void,
        signal,
      };
      this.slotQueue.push(entry);

      if (signal) {
        const onAbort = (): void => {
          const idx = this.slotQueue.indexOf(entry);
          if (idx !== -1) {
            this.slotQueue.splice(idx, 1);
            const err = new Error("Operation aborted while queued");
            err.name = "AbortError";
            reject(err);
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.drainSlots();
    });
  }

 /** 派发 slot 队列直到达并发上限。 */
  private drainSlots(): void {
    while (this.active < this.maxConcurrency && this.slotQueue.length > 0) {
      const entry = this.slotQueue.shift()!;
      this.active++;
      entry.fn().then(
        (v) => entry.resolve(v),
        (err) => entry.reject(err),
      ).finally(() => {
        this.active--;
        this.drainSlots();
      });
    }
  }

 /** 执行单次 agent 调用并以结果 settle promise。 */
  private async run(entry: QueueEntry): Promise<void> {
    const { opts, resolve, startedAt, signal } = entry;

    try {
      const args = buildArgs(opts);
      const { command, args: cmdArgs } = resolveInvocation(args);

      const rawEnv: Record<string, string | undefined> = { ...process.env };
      if (opts.schemaEnv) {
        rawEnv.PI_WORKFLOW_SCHEMA = opts.schemaEnv;
      }
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawEnv)) {
        if (v !== undefined) env[k] = v;
      }

      const pipeline = makeEmptyPipeline();
      let stderr = "";
      let exitCode: number;

 // 合并 per-call AbortController：墙钟 timeoutMs（per-call）+ 外部
 // signal（run 级 abort）都生效。缺此合并则 agent({timeoutMs:5000}) 静默无效。
      const controller = new AbortController();
      const onExternalAbort = (): void => controller.abort();
      if (signal) {
        if (signal.aborted) {
          controller.abort();
        } else {
          signal.addEventListener("abort", onExternalAbort, { once: true });
        }
      }
      const timeoutTimer =
        opts.timeoutMs && opts.timeoutMs > 0
          ? setTimeout(() => controller.abort(), opts.timeoutMs)
          : undefined;
      if (timeoutTimer) timeoutTimer.unref();

      try {
        const result = await runPiProcess({
          command,
          cmdArgs,
          pipeline,
          signal: controller.signal,
          env,
          cwd: opts.cwd,
        });
        exitCode = result.exitCode;
        stderr = result.stderr;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        resolve({
          content: "",
          durationMs: Date.now() - startedAt,
          error: message,
          toolCalls: [],
        });
        return;
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
 // 正常完成时必须摘除外部 signal 的 abort listener，否则随 agent 调用数线性泄漏
 // （signal 生命周期长于单次 run，持久的 listener 引用会阻止 controller GC）。
 // abort 路径因 { once: true } 已自动移除，这里覆盖正常完成路径。
        if (signal && !signal.aborted) {
          signal.removeEventListener("abort", onExternalAbort);
        }
      }

      const durationMs = Date.now() - startedAt;

      if (opts.schema && pipeline.parsedOutput === undefined) {
 // [HISTORICAL] schema-error 必须带 exitCode + stderr，否则 abort/崩溃被误判为
 // "LLM 拒绝调 tool"。对称修复：与 subprocess-agent-runner.ts 保持一致。
 // 详见 subprocess-agent-runner.ts:formatFailureContext 的教训记录。
        const ctx = formatFailureContext(exitCode, stderr);
        if (!pipeline.hasToolCall) {
          resolve({
            content: pipeline.output,
            durationMs: Date.now() - startedAt,
            error: `Agent did not call structured-output tool${ctx}`,
            toolCalls: pipeline.toolCalls,
          });
          return;
        }
        if (exitCode === 0) {
          resolve({
            content: pipeline.output,
            durationMs,
            error: `Agent completed without calling structured-output tool${ctx}`,
            toolCalls: pipeline.toolCalls,
          });
          return;
        }
      }

      resolve({
        content: pipeline.output,
        parsedOutput: pipeline.parsedOutput,
        usage: pipeline.usage.turns > 0 ? pipeline.usage : undefined,
        durationMs,
        error: exitCode === 0 ? undefined : (stderr || `Exit code ${exitCode}`),
        sessionId: pipeline.sessionId,
        toolCalls: pipeline.toolCalls,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        content: "",
        durationMs: Date.now() - startedAt,
        error: message,
        toolCalls: [],
      });
    }
  }
}

