/**
 * Workflow Extension — Agent Pool (进程内执行版)
 *
 * 改造前：spawn pi --mode json 子进程，解析 JSONL。
 * 改造后：调用 @zhushanwen/pi-subagents 的 runtime.runAgent()（进程内 createAgentSession）。
 *
 * 保留类名 AgentPool、AgentCallOpts、AgentResult 以减少 orchestrator 改动面。
 */

import { randomUUID } from "node:crypto";
import { getRuntime } from "@zhushanwen/pi-subagents";
import type { RunAgentOptions } from "@zhushanwen/pi-subagents";

import type { WorkflowBudget, ToolCallEntry } from "../domain/state.js";

// ── Public types（保留原接口，减少 orchestrator 改动）──────────

export interface AgentCallOpts {
  /** Task prompt */
  prompt: string;
  /** Structured-output schema（传给 runAgent.schema） */
  schema?: Record<string, unknown>;
  /** 显式模型 "provider/modelId"（覆盖配置链） */
  model?: string;
  /** Scene name（传给 model-resolver 解析） */
  scene?: string;
  /** Skill name → 解析为 skillPath */
  skill?: string;
  /** Resolved skill path（agent-opts-resolver 设置） */
  skillPath?: string;
  /** 日志用描述 */
  description?: string;
  /** Agent name（传给 runAgent.agent） */
  agent?: string;
  /** systemPrompt 内容数组（agent-opts-resolver 设置，替代 systemPromptFiles） */
  appendSystemPrompt?: string[];
}

export interface AgentResult {
  callId: string;
  /** Agent 文本输出（映射自 subagents AgentResult.text） */
  output: string;
  parsedOutput?: unknown;
  usage?: AgentUsage;
  durationMs: number;
  success: boolean;
  error?: string;
  sessionId?: string;
  toolCalls: ToolCallEntry[];
}

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

// ── Pool ──────────────────────────────────────────────────────

const SOFT_MAX_AGENTS_WARNING = 500;

export interface AgentPoolOptions {
  maxConcurrency?: number;
  runName?: string;
  onSoftLimitReached?: (info: {
    runName: string;
    totalCalls: number;
    budget: WorkflowBudget;
  }) => void;
}

/**
 * 轻量级 AgentPool — 包装 subagents runtime.runAgent()，保留并发控制和 soft limit。
 */
export class AgentPool {
  private readonly maxConcurrency: number;
  private readonly onSoftLimitReached?: AgentPoolOptions["onSoftLimitReached"];
  private readonly runName: string;
  private active = 0;
  private totalCallCount = 0;
  private softWarningSent = false;
  private budgetRef?: WorkflowBudget;

  constructor(opts: AgentPoolOptions | number = {}) {
    if (typeof opts === "number") {
      this.maxConcurrency = opts;
      this.onSoftLimitReached = undefined;
      this.runName = "unknown";
    } else {
      this.maxConcurrency = opts.maxConcurrency ?? 4;
      this.onSoftLimitReached = opts.onSoftLimitReached;
      this.runName = opts.runName ?? "unknown";
    }
  }

  setBudget(budget: WorkflowBudget): void {
    this.budgetRef = budget;
  }

  /**
   * 入队 agent 调用。调用 subagents runtime.runAgent()，映射结果。
   * 从不 reject——错误封装在 AgentResult.error 中。
   */
  async enqueue(opts: AgentCallOpts, signal?: AbortSignal): Promise<AgentResult> {
    const callId = `agent-${randomUUID().slice(0, 8)}`;
    const startedAt = Date.now();

    if (signal?.aborted) {
      return {
        callId, output: "", durationMs: Date.now() - startedAt,
        success: false, error: "Operation aborted before start", toolCalls: [],
      };
    }

    this.active++;
    this.totalCallCount++;
    if (this.budgetRef) this.maybeEmitSoftWarning(this.budgetRef);

    try {
      const runtime = getRuntime();
      if (!runtime) {
        return {
          callId, output: "", durationMs: Date.now() - startedAt,
          success: false, error: "SubagentRuntime not initialized", toolCalls: [],
        };
      }

      const runOpts: RunAgentOptions = {
        task: opts.prompt,
        agent: opts.agent,
        model: opts.model,
        schema: opts.schema,
        skillPath: opts.skillPath,
        appendSystemPrompt: opts.appendSystemPrompt,
        signal,
      };

      const subResult = await runtime.runAgent(runOpts);

      return mapResult(subResult, callId, startedAt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        callId, output: "", durationMs: Date.now() - startedAt,
        success: false, error: message, toolCalls: [],
      };
    } finally {
      this.active--;
    }
  }

  private maybeEmitSoftWarning(budget: WorkflowBudget): void {
    if (this.totalCallCount > SOFT_MAX_AGENTS_WARNING && !this.softWarningSent) {
      this.softWarningSent = true;
      try { this.onSoftLimitReached?.({ runName: this.runName, totalCalls: this.totalCallCount, budget }); }
      catch { /* callback errors must not affect dispatch */ }
    }
  }
}

/**
 * FR-9.5: subagents AgentResult → workflow AgentResult 映射。
 */
function mapResult(sub: {
  text: string;
  parsedOutput?: unknown;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  turns: number;
  durationMs: number;
  success: boolean;
  error?: string;
  sessionId: string;
  toolCalls: Array<{ toolName: string; args?: unknown; result?: { details?: unknown }; isError: boolean }>;
}, callId: string, _startedAt: number): AgentResult {
  return {
    callId,
    output: sub.text,
    parsedOutput: sub.parsedOutput,
    usage: sub.usage ? {
      input: sub.usage.input,
      output: sub.usage.output,
      cacheRead: sub.usage.cacheRead,
      cacheWrite: sub.usage.cacheWrite,
      cost: sub.usage.cost,
      // contextTokens = 本次 prompt 的 token 总消耗（输入+输出+缓存读+缓存写）。
      // 原先硬编码为 0，导致预算控制失效；改为四项之和。
      contextTokens: sub.usage.input + sub.usage.output + sub.usage.cacheRead + sub.usage.cacheWrite,
      turns: sub.turns,
    } : undefined,
    durationMs: sub.durationMs,
    success: sub.success,
    error: sub.success ? undefined : sub.error,
    sessionId: sub.sessionId || undefined,
    toolCalls: sub.toolCalls.map((tc) => ({
      name: tc.toolName,
      // 优先展示调用参数预览（UI 原本意图）；args 缺失时回退到 result.details，
      // 保持向后兼容（老版本 subagents 未填充 args 的场景）。
      input: tc.args
        ? JSON.stringify(tc.args).slice(0, 200)
        : (tc.result?.details ? JSON.stringify(tc.result.details).slice(0, 200) : ""),
    })),
  };
}
