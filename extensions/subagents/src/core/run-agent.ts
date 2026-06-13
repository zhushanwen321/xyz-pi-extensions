// src/core/run-agent.ts
import type {
  RunAgentOptions, AgentResult,
  AgentConfig, SubagentsGlobalConfig, SessionModelState, ConcurrencyPool,
} from "../types.ts";
import { createEventBridge } from "./event-bridge.ts";
import { collectResponseText } from "./output-collector.ts";
import { createTurnLimiter } from "./turn-limiter.ts";
import { resolveModelForAgent, type ModelRegistryLike } from "../resolution/model-resolver.ts";
import { filterTools } from "../resolution/tool-filter.ts";
import { inferCategory } from "../category.ts";

/** runAgent 的依赖注入容器（由 SubagentRuntime 提供） */
export interface RunAgentContext {
  modelRegistry: ModelRegistryLike;
  resolveAgent: (name: string) => AgentConfig | undefined;
  globalConfig: SubagentsGlobalConfig;
  sessionState: SessionModelState;
  globalPool: ConcurrencyPool;
  /** cwd（传给 createAgentSession） */
  cwd: string;
  /** agentDir（传给 createAgentSession） */
  agentDir: string;
}

/** AgentSession 的最小可用接口（duck-typed，与 SDK AgentSession 结构兼容） */
interface AgentSessionLike {
  prompt(task: string, options?: unknown): Promise<void>;
  steer(message: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(fn: (event: unknown) => void): () => void;
  sessionId: string;
  messages: ReadonlyArray<{ role: string; usage?: Record<string, unknown>; content?: ReadonlyArray<{ type: string; text?: string }> }>;
  getAllTools(): Array<{ name: string }>;
  setActiveToolsByName(names: string[]): void;
}

/** 动态 import Pi SDK（避免循环依赖 + 允许 vitest alias mock） */
async function getSdk() {
  const mod = await import("@mariozechner/pi-coding-agent");
  return mod as unknown as {
    DefaultResourceLoader: new (opts: Record<string, unknown>) => { reload(): Promise<void> };
    SessionManager: { inMemory(cwd?: string): unknown };
    createAgentSession: (opts: Record<string, unknown>) => Promise<{ session: AgentSessionLike }>;
  };
}

/**
 * FR-1.1: runAgent — 一次性执行 agent，返回 AgentResult。
 * 在主线程调用（Worker 线程无 Pi SDK 上下文）。
 */
export async function runAgent(opts: RunAgentOptions, ctx: RunAgentContext): Promise<AgentResult> {
  const startTime = Date.now();

  // 步骤 2: 并发控制（提前 acquire，保持原有行为）
  const pool = opts.pool ?? ctx.globalPool;
  await pool.acquire(opts.priority);

  try {
    // 步骤 1: 解析 agent 配置（在 try 内，确保所有异常被捕获）
    const agentConfig = opts.agent ? ctx.resolveAgent(opts.agent) : undefined;
    const agentName = opts.agent ?? "default";

    // 步骤 1c: category 推断
    const category = inferCategory(agentName, agentConfig, ctx.globalConfig.agentCategoryOverrides);

    // 步骤 1a: 模型解析（含 fallback 链）
    const resolved = resolveModelForAgent({
      agentName, agentConfig, category,
      globalConfig: ctx.globalConfig, sessionState: ctx.sessionState,
      modelRegistry: ctx.modelRegistry,
      paramOverride: { model: opts.model, thinkingLevel: opts.thinkingLevel },
    });

    const { DefaultResourceLoader, SessionManager, createAgentSession } = await getSdk();

    // 步骤 3: 构建 ResourceLoader（不含 tool 配置）
    const resourceLoader = new DefaultResourceLoader({
      cwd: ctx.cwd, agentDir: ctx.agentDir,
      appendSystemPrompt: opts.appendSystemPrompt,
      additionalSkillPaths: opts.skillPath ? [opts.skillPath] : undefined,
    });
    await resourceLoader.reload();

    // FR-6 tool 过滤配置
    const toolFilterConfig = {
      builtinTools: agentConfig?.builtinTools,
      extensions: agentConfig?.extensions,
      excludeTools: agentConfig?.excludeTools ?? [],
    };

    // 创建 session
    const { session } = await createAgentSession({
      model: resolved.model,
      thinkingLevel: resolved.thinkingLevel as never,
      resourceLoader,
      sessionManager: SessionManager.inMemory(ctx.cwd),
    });

    // 创建后过滤 tool
    const allTools = session.getAllTools().map((t) => ({ name: t.name }));
    const filterResult = filterTools({ allTools, config: toolFilterConfig });
    if (filterResult.allowedTools && filterResult.allowedTools.length < allTools.length) {
      session.setActiveToolsByName(filterResult.allowedTools);
    }

    // 事件桥接
    const bridge = createEventBridge(opts.onEvent ?? (() => {}));

    // turn 限制器
    const limiter = createTurnLimiter({
      maxTurns: opts.maxTurns ?? 0,
      graceTurns: opts.graceTurns ?? 2,
      steer: (msg) => { void session.steer(msg); },
      abort: () => { void session.abort(); },
    });

    const unsubscribe = session.subscribe((event: unknown) => {
      bridge.handle(event as never);
      if ((event as { type: string }).type === "turn_end") {
        limiter.onTurnEnd(bridge.turnCount);
      }
    });

    // AbortSignal
    let signalListener: (() => void) | undefined;
    if (opts.signal) {
      if (opts.signal.aborted) { void session.abort(); }
      else {
        signalListener = () => { void session.abort(); };
        opts.signal.addEventListener("abort", signalListener);
      }
    }

    let success = true;
    let error: string | undefined;

    try {
      let task = opts.task;
      if (opts.schema) {
        task = task + "\n\n" + formatSchemaInstruction(opts.schema);
      }
      await session.prompt(task);
    } catch (err) {
      success = false;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      unsubscribe();
      if (signalListener && opts.signal) opts.signal.removeEventListener("abort", signalListener);
    }

    // I2: 检查 event-bridge 捕获的 message_end error 事件（prompt 可能不抛但 stopReason=error）
    if (success && bridge.lastError) {
      success = false;
      error = bridge.lastError;
    }

    // 收集结果
    const text = collectResponseText(session.messages);

    let parsedOutput: unknown;
    for (const tc of bridge.toolCalls) {
      if (tc.toolName === "structured-output" && tc.result?.details) {
        parsedOutput = tc.result.details;
        break;
      }
    }

    const accumulated = bridge.usage;
    const hasUsage = accumulated.input > 0 || accumulated.output > 0;

    return {
      text,
      parsedOutput,
      usage: hasUsage ? accumulated : undefined,
      turns: bridge.turnCount,
      durationMs: Date.now() - startTime,
      success,
      error,
      sessionId: session.sessionId,
      toolCalls: bridge.toolCalls,
    };
  } catch (err) {
    return {
      text: "",
      turns: 0,
      durationMs: Date.now() - startTime,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      sessionId: "",
      toolCalls: [],
    };
  } finally {
    pool.release();
  }
}

function formatSchemaInstruction(schema: Record<string, unknown>): string {
  return [
    "MANDATORY: Structured Output Requirement",
    "You MUST call the `structured-output` tool with your final answer.",
    "The schema for the structured output is:",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
  ].join("\n");
}
