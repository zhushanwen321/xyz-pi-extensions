/**
 * Workflow Extension — Subprocess Agent Runner
 *
 * AgentRunner port 的 Infra 实现。
 *
 * 每次 run 调用 spawn 一个独立的 pi --mode json 子进程，流式解析 JSONL 响应，
 * 返回统一形态的 AgentResult。signal abort 时向子进程发 SIGKILL。
 *
 * 层归属：Infra（D-12）。implements Engine 层的 AgentRunner port ——
 * Engine 通过 port 注入此实现，测试可注入 mock runner。
 *
 * 设计：
 * - SubprocessAgentRunner class implements AgentRunner，封装 spawn/解析/错误归一。
 * - 底层 spawn 细节（buildArgs / resolveInvocation / runPiProcess）由 pi-runner.ts
 * 提供；ConcurrencyGate 也直接复用同一套底层函数（见 concurrency-gate.ts）。
 * - run 返回 AgentResult 形态（content/error/usage/toolCalls/sessionId/parsedOutput）。
 * - 子进程不复用——每次 run 新 spawn（spec Constraints）。
 * - schema 缺失 structured-output 调用时返回 error 字段（不抛错，调用方判 error）。
 */

import type { AgentRunner } from "../engine/models/ports.js";
import type { AgentCallOpts, AgentResult } from "../engine/models/types.js";
import { makeEmptyPipeline } from "./jsonl-parser.js";
import { buildArgs, resolveInvocation, runPiProcess } from "./pi-runner.js";

// ── SubprocessAgentRunner ────────────────────────────────────

export class SubprocessAgentRunner implements AgentRunner {
 /**
 * 执行单次 agent 调用：spawn pi --mode json，流式收集 JSONL，返回 AgentResult。
 *
 * 错误处理契约：run 不 reject——失败信息放在 result.error 字段
 * （与 ConcurrencyGate.run 一致，调用方判 error 字段）。
 * spawn 本身抛错时返回 content="" + error 的 AgentResult。
 *
 * signal 传播：传入的 AbortSignal 触发时，runPiProcess 内部向子进程发 SIGKILL，
 * 返回 exitCode=1 + "aborted" stderr，本方法据此填充 result.error。
 *
 * per-call timeoutMs：opts.timeoutMs > 0 时合并进同一 AbortController——到期 abort
 * 子进程（agent({timeoutMs:5000}) 生效）。与 ConcurrencyGate.run 路径对称。
 */
  async run(opts: AgentCallOpts, signal: AbortSignal, onEvent?: (raw: Record<string, unknown>) => void): Promise<AgentResult> {
    const startedAt = Date.now();

 // 合并 per-call AbortController：墙钟 timeoutMs（per-call）+ 外部
 // signal（run 级 abort）都生效。缺此合并则 agent({timeoutMs:5000}) 静默无效
 // （与 ConcurrencyGate.run 路径一致——生产链路 dispatchAgentCall → withSlot →
 // executeAgentCall → runner.run 全程走本方法，不经 gate.enqueue 的合并分支）。
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const timeoutTimer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => controller.abort(), opts.timeoutMs)
        : undefined;
    if (timeoutTimer) timeoutTimer.unref();

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

      try {
        const result = await runPiProcess(command, cmdArgs, pipeline, controller.signal, env, onEvent);
        exitCode = result.exitCode;
        stderr = result.stderr;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: "",
          durationMs: Date.now() - startedAt,
          error: message,
          toolCalls: [],
        };
      }

      const durationMs = Date.now() - startedAt;

 // schema 要求 structured-output 但未调用 → 失败（盲点修复，FR-1.4）
 // [HISTORICAL] error 字段必须带上 exitCode + stderr：abort/崩溃/spawn 失败都会让
 // pipeline 无任何 tool_call（pi 被 SIGKILL 时 pipeline.hasToolCall=false 且 parsedOutput=undefined），
 // 此分支会命中。旧实现只返回 "Agent did not call structured-output tool"，丢弃了 stderr 里
 // 的 "Operation aborted, sending SIGKILL" / 真实崩溃信息，导致 abort 类失败被误判为
 // "LLM 拒绝调 tool"。教训来源：daily-news-impact 三轮根因分析全被此误导信息带偏。
      if (opts.schema && pipeline.parsedOutput === undefined) {
        const ctx = formatFailureContext(exitCode, stderr);
        if (!pipeline.hasToolCall) {
          return {
            content: pipeline.output,
            durationMs,
            error: `Agent did not call structured-output tool${ctx}`,
            toolCalls: pipeline.toolCalls,
          };
        }
        if (exitCode === 0) {
          return {
            content: pipeline.output,
            durationMs,
            error: `Agent completed without calling structured-output tool${ctx}`,
            toolCalls: pipeline.toolCalls,
          };
        }
      }

      return {
        content: pipeline.output,
        parsedOutput: pipeline.parsedOutput,
        usage: pipeline.usage.turns > 0 ? pipeline.usage : undefined,
        durationMs,
        error: exitCode === 0 ? undefined : (stderr || `Exit code ${exitCode}`),
        sessionId: pipeline.sessionId,
        toolCalls: pipeline.toolCalls,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: "",
        durationMs: Date.now() - startedAt,
        error: message,
        toolCalls: [],
      };
    } finally {
 // 清理 per-call 计时器，并摘除外部 signal 的 abort listener（与 ConcurrencyGate.run
 // 对称：正常完成时必须摘除，否则随 agent 调用数线性泄漏——signal 生命周期长于单次
 // run，持久的 listener 引用会阻止 controller GC；abort 路径因 { once: true } 自动移除）。
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (!signal.aborted) {
        signal.removeEventListener("abort", onExternalAbort);
      }
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * 格式化 schema 失败时的执行上下文（exitCode + stderr 摘要）。
 *
 * [HISTORICAL] schema-error 分支必须暴露真实失败原因。abort/崩溃场景下 pi 子进程
 * 未输出任何 JSONL，pipeline.hasToolCall=false，旧实现仅返回 "Agent did not call
 * structured-output tool" 覆盖了 stderr 里的 "Operation aborted, sending SIGKILL"
 * 等关键诊断信息。本 helper 把 exitCode + stderr（截断）拼到 error 字段尾部。
 *
 * 仅在 stderr 非空或 exitCode≠0 时附加（成功 exit 0 + 空 stderr 时不附加，
 * 保持原有"纯 schema 错误"语义）。
 */
function formatFailureContext(exitCode: number, stderr: string): string {
  const parts: string[] = [];
  if (exitCode !== 0) parts.push(`exitCode=${exitCode}`);
  const trimmed = stderr.trim();
  if (trimmed) parts.push(`stderr=${trimmed.slice(0, 500)}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}
