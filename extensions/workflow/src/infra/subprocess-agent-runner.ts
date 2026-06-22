/**
 * Workflow Extension — Subprocess Agent Runner（W2-T10）
 *
 * AgentRunner port 的 Infra 实现（原 pi-runner.ts）。
 *
 * 每次 run() 调用 spawn 一个独立的 pi --mode json 子进程，流式解析 JSONL 响应，
 * 返回统一形态的 AgentResult（T1）。signal abort 时向子进程发 SIGKILL。
 *
 * 层归属：Infra（D-12）。implements Engine 层的 AgentRunner port（T2）——
 * Engine 通过 port 注入此实现，测试可注入 mock runner。
 *
 * 关键变化（相对旧 infra/pi-runner.ts）：
 *   - 新增 SubprocessAgentRunner class implements AgentRunner（而非散落的 3 个自由函数）
 *   - 旧 buildArgs / resolveInvocation / runPiProcess 仍保留导出（ConcurrencyGate 等
 *     过渡期调用方仍依赖；W3 T18 executeAgentCall 写完后 ConcurrencyGate 仅保留 queue
 *     职责，runner 承接 spawn，但这是 T18 的迁移范围，T10 不破坏现有调用方）
 *   - run() 返回 T1 AgentResult 形态（content/error/usage/toolCalls/sessionId/parsedOutput）
 *   - 子进程不复用——每次 run() 新 spawn（spec Constraints）
 *   - schema 缺失 structured-output 调用时返回 error 字段（不抛错，调用方判 error）
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
   * 错误处理契约：run() 不 reject——失败信息放在 result.error 字段
   * （与旧 AgentPool.enqueue / ConcurrencyGate.run 一致，调用方判 error 字段）。
   * spawn 本身抛错时返回 content="" + error 的 AgentResult。
   *
   * signal 传播：传入的 AbortSignal 触发时，runPiProcess 内部向子进程发 SIGKILL，
   * 返回 exitCode=1 + "aborted" stderr，本方法据此填充 result.error。
   */
  async run(opts: AgentCallOpts, signal: AbortSignal): Promise<AgentResult> {
    const startedAt = Date.now();

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
        const result = await runPiProcess(command, cmdArgs, pipeline, signal, env);
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
      if (opts.schema && pipeline.parsedOutput === undefined) {
        if (!pipeline.hasToolCall) {
          return {
            content: pipeline.output,
            durationMs,
            error: "Agent did not call structured-output tool",
            toolCalls: pipeline.toolCalls,
          };
        }
        if (exitCode === 0) {
          return {
            content: pipeline.output,
            durationMs,
            error: "Agent completed without calling structured-output tool",
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
    }
  }
}
