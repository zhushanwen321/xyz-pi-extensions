/**
 * Workflow Extension — Concurrency Gate（W2-T8）
 *
 * 并发信号量：FIFO 队列 + 有界并发（maxConcurrency=4，D-13）。
 * 每次 enqueue 启动一个独立的 agent 子进程调用，并发槽位释放后从队列取下一个。
 *
 * 层归属：Infra（D-12）。RunRuntime 直接持有具体类，不经过 interface（§domain-models 11）。
 *
 * 关键变化（相对旧 infra/agent-pool.ts）：
 *   - 类名 AgentPool → ConcurrencyGate（无 Impl 后缀，D-12 直接具体类）
 *   - 删除 budget 相关：setBudget / maybeEmitSoftWarning / budgetRef /
 *     totalCallCount / softWarningSent / onSoftLimitReached（soft limit 移到
 *     Engine Budget.isSoftLimitReached() 查询，由 lifecycle 调用）
 *   - 删除 runName（仅 soft-limit 回调用到）
 *   - 类型来源改为 engine/models/types.js（不再从 agent-pool 导出 AgentCallOpts/AgentResult）
 *   - AgentResult 形态统一为 T1 形态（content 字段，非 output；无 success/error 字段——
 *     错误用抛出或 error 字段；durationMs 可选）。注意：旧 pool 内部构造 result 的逻辑
 *     仍需 content/error/durationMs 字段名对齐 T1 AgentResult。
 *   - 保留：FIFO 队列、per-run 实例化、per-call AbortController 合并（外部 signal + timeoutMs）
 *
 * Session 隔离：每个 ConcurrencyGate 实例归属其创建者（RunRuntime）。
 * 一个 run 实例化一个 gate，避免跨 run 状态泄漏。
 *
 * NOTE：subprocess 执行逻辑仍调用旧 buildArgs/resolveInvocation/runPiProcess
 * （pi-runner.js，T10 迁移为 SubprocessAgentRunner）。本文件只管并发调度，
 * 不绑定具体 runner——T18 executeAgentCall 注入 AgentRunner port。
 * 此处的 buildArgs/runPiProcess 直接 import 是过渡：T10 完成后 SubprocessAgentRunner
 * 会承接此职责，ConcurrencyGate 仅保留 queue/signal 合并职责（见 T10 卡片）。
 * 当前实现保留与旧 pool 一致的「自包含 spawn」行为以保证行为不变。
 */

import type { AgentCallOpts, AgentResult } from "../engine/models/types.js";
import { makeEmptyPipeline } from "./jsonl-parser.js";
import { buildArgs, resolveInvocation, runPiProcess } from "./pi-runner.js";

// ── Constants ─────────────────────────────────────────────────

/**
 * 默认并发上限（D-13）。
 * 保持 4——无数据支撑改 5，旧 AgentPool DEFAULT_CONCURRENCY=4 沿用。
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

// ── ConcurrencyGate ───────────────────────────────────────────

export class ConcurrencyGate {
  private readonly maxConcurrency: number;
  private readonly queue: QueueEntry[] = [];
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
   * result.error 字段（与旧 AgentPool.enqueue 契约一致，调用方据 error 判断失败）。
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

      // 合并 per-call AbortController：墙钟 timeoutMs（per-call）+ 外部 pool/orchestrator
      // signal 都生效。缺此合并则 agent({timeoutMs:5000}) 静默无效。
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
        const result = await runPiProcess(
          command,
          cmdArgs,
          pipeline,
          controller.signal,
          env,
        );
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
        if (!pipeline.hasToolCall) {
          resolve({
            content: pipeline.output,
            durationMs: Date.now() - startedAt,
            error: "Agent did not call structured-output tool",
            toolCalls: pipeline.toolCalls,
          });
          return;
        }
        if (exitCode === 0) {
          resolve({
            content: pipeline.output,
            durationMs,
            error: "Agent completed without calling structured-output tool",
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
