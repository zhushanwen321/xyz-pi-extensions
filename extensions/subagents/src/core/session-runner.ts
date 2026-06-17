// src/core/session-runner.ts
//
// 唯一的 session 执行入口。零 mode 感知——只负责"跑一次 session + 更新 record"。
//
// 这是 sync/background 两路径完全共用的核心。mode 分叉在 Runtime.execute 顶部，
// 不渗透到此处。Core 不知道谁调用它、是否 await、是否回注通知。
//
// 本文件合并了旧实现的 4 个文件：
//   run-agent.ts (262) + session-factory.ts (295) + event-bridge.ts (148)
//   + output-collector.ts (18) = 723 行核心执行逻辑。
// 设计信息见 docs/subagents/session-runner.md。

import type {
  AgentEvent,
  AgentResult,
  AgentUsage,
  ExecutionRecord,
  ToolCall,
  ToolCallResult,
} from "../types.ts";
import type { AgentConfig, ModelRegistryLike, ResolvedModel } from "./model-resolver.ts";

// ============================================================
// 依赖注入容器
// ============================================================

/** SessionRunner 的依赖注入容器（由 Runtime 提供，解耦 Core 与 Pi SDK 实例）。 */
export interface SessionRunnerContext {
  /** 进程当前工作目录（传给 createAgentSession）。 */
  cwd: string;
  /** agent 配置目录（~/.pi/agent）。 */
  agentDir: string;
  /** home 目录（worktree baseDir / session 持久化目录）。 */
  homeDir: string;
}

/** SessionRunner.run 的入参。 */
export interface RunOptions {
  /** 已 resolve 的模型（Runtime 在调用前解析，Core 不重复解析）。 */
  resolved: ResolvedModel;
  /** agent 配置（含 systemPrompt/tools/isolation）。 */
  agentConfig: AgentConfig | undefined;
  /** 注入到子 session 的额外 system prompt 片段。 */
  appendSystemPrompt: string[] | undefined;
  /** 注入到子 session 的 skill 路径。 */
  skillPath: string | undefined;
  /** 结构化输出 schema（存在时 enforcement：漏调 structured-output 则 steer）。 */
  schema: Record<string, unknown> | undefined;
  /** hard turn limit。 */
  maxTurns: number | undefined;
  /** soft limit 后宽限轮数（默认 2）。 */
  graceTurns: number | undefined;
  /** 中断信号（Runtime 创建，来源：sync=Pi tool 框架 / bg=controller.signal）。 */
  signal: AbortSignal | undefined;
  /** event 回流——SessionRunner 内部 updateFromEvent 后，再回调调用方（widget/notify）。 */
  onEvent: ((event: AgentEvent) => void) | undefined;
}

// ============================================================
// SDK 类型（duck-typed 最小子集，测试可 mock）
// ============================================================

/** SDK AgentSessionEvent 的最小可用子集（duck-typed，避免强耦合 SDK 类型）。 */
export type SdkEvent = {
  type: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: ToolCallResult;
  isError?: boolean;
  message?: {
    usage?: AgentUsage & { cost?: { total: number } };
    stopReason?: string;
    errorMessage?: string;
  };
  assistantMessageEvent?: { type?: string; delta?: string };
  reason?: string;
};

/** 运行时 guard：subscribe 回调收到的 event 形状未知，校验 type 字段后再交给 handle。
 *  防止 SDK 事件结构变化时 switch(raw.type) 静默失配（全走 default 不报错）。 */
export function isSdkEvent(x: unknown): x is SdkEvent {
  //  typeof x === "object" && x !== null && typeof (x as { type?: unknown }).type === "string"
  void x;
  throw new Error("not implemented");
}

/** AgentSession 的最小可用接口（duck-typed，与 SDK AgentSession 结构兼容）。 */
export interface AgentSessionLike {
  prompt(task: string, options?: unknown): Promise<void>;
  steer(message: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(fn: (event: unknown) => void): () => void;
  sessionId: string;
  /** 暴露 sessionManager 以读取 sessionFile 路径。 */
  readonly sessionManager: {
    getSessionFile(): string | undefined;
    getSessionId(): string;
  };
  messages: ReadonlyArray<{
    role: string;
    content?: ReadonlyArray<{ type: string; text?: string }>;
  }>;
  getAllTools(): Array<{ name: string }>;
  setActiveToolsByName(names: string[]): void;
}

/** Pi SDK 动态 import 的形状（runAgent/ManagedSession 通过 getSdk() 获取）。 */
export interface SdkLike {
  DefaultResourceLoader: new (opts: Record<string, unknown>) => { reload(): Promise<void> };
  /** SessionManager 支持 inMemory（测试）和 create（持久化）两种工厂。 */
  SessionManager: {
    inMemory(cwd?: string): unknown;
    create(cwd: string, sessionDir?: string): unknown;
  };
  createAgentSession: (opts: Record<string, unknown>) => Promise<{ session: AgentSessionLike }>;
}

// ============================================================
// EventBridge（SDK 事件 → AgentEvent + 累积器）
// ============================================================

/**
 * 把 SDK AgentSessionEvent 转换为 subagents AgentEvent，并累计 turn/toolCall/usage。
 *
 *   ╔════════════════════════════════════════════════════════════════════╗
//   ║  事件映射（详见 docs/subagents/session-runner.md §2）：              ║
//   ║    tool_execution_start  → {tool_start, toolName, args}            ║
//   ║      └─ pendingTools.set(id, {toolName, args})                     ║
//   ║    tool_execution_end    → {tool_end, toolName, args, result, isError} ║
//   ║      └─ toolCalls.push + pendingTools.delete                       ║
//   ║    message_update(thinking_delta) → {thinking_delta, delta}        ║
//   ║      ⚠ 必须在 text_delta 之前判断（两者都带 delta 字段）           ║
//   ║    message_update(text)  → {text_delta, delta}                     ║
//   ║    turn_end              → {turn_end}  + turnCount++               ║
//   ║    message_end(usage)    → {message_end, usage} + usageAccum +=    ║
//   ║    message_end(error)    → {error, error} + lastError = msg        ║
//   ║    compaction_start      → {compaction}                            ║
//   ║    其他                  → 丢弃                                    ║
//   ╚════════════════════════════════════════════════════════════════════╝
 *
 * bridge 累积器（turnCount/toolCalls/usage/lastError）供 collectResult 构造 AgentResult；
 * 转发的 AgentEvent 供 updateFromEvent 更新 record——两套数据同源（handle 驱动）。
 */
export interface EventBridge {
  /** 传给 session.subscribe 的处理器。 */
  handle(raw: SdkEvent): void;
  /** 重置所有跨 prompt 累积状态（ManagedSession 每轮 prompt 前调）。 */
  resetForPrompt(): void;
  /** 已完成 turn 数（turn_end 累积）。 */
  readonly turnCount: number;
  /** 累积的 tool 调用（tool_execution_end 累积）。 */
  readonly toolCalls: ToolCall[];
  /** 累积的 usage（所有 message_end 求和）。 */
  readonly usage: AgentUsage & { cost: number };
  /** 最后一次 message_end 的 stopReason=error/aborted 错误信息。 */
  readonly lastError: string | undefined;
}

/** 创建 EventBridge 实例。onEvent 是调用方的 updateFromEvent wrapper。 */
export function createEventBridge(onEvent: (event: AgentEvent) => void): EventBridge {
  //  1. 初始化累积器：turnCount=0, toolCalls=[], usageAccum={0...}, lastError=undefined
  //  2. pendingTools = new Map<toolCallId, {toolName, args}>()
  //  3. handle(raw): switch(raw.type) 按映射表转换（thinking_delta 在 text_delta 之前）
  //  4. resetForPrompt(): 清零所有累积器（ManagedSession 跨轮复用 bridge 时调）
  void onEvent;
  throw new Error("not implemented");
}

// ============================================================
// Session 工厂（createAndConfigureSession）
// ============================================================

/** 创建 session 所需的依赖（由 SubagentRuntime 提供）。 */
export interface SessionFactoryContext {
  modelRegistry: ModelRegistryLike;
  resolveAgent: (name: string) => AgentConfig | undefined;
  cwd: string;
  agentDir: string;
  /** home 目录（用于计算 subagent session 持久化目录）。 */
  homeDir: string;
}

/** createAndConfigureSession 的输入选项。 */
export interface CreateSessionInput {
  /** 已解析的模型（由 resolveModelForAgent 产出）。 */
  resolved: ResolvedModel;
  /** systemPrompt 追加内容（调用方可传 agent body 等）。 */
  appendSystemPrompt?: string[];
  /** skill 路径。 */
  skillPath?: string;
  /** agent 配置（提取 tool 过滤策略）。 */
  agentConfig?: AgentConfig;
  /** 事件回调。 */
  onEvent?: (event: AgentEvent) => void;
}

/** createAndConfigureSession 的输出。 */
export interface BuiltSession {
  session: AgentSessionLike;
  bridge: EventBridge;
  unsubscribe: () => void;
  /** subagent session 文件绝对路径（未持久化时为 undefined）。 */
  sessionFile?: string;
}

/** 动态 import Pi SDK（集中在此处，便于测试 mock）。 */
export async function getSdk(): Promise<SdkLike> {
  //  return (await import("@mariozechner/pi-coding-agent")) as unknown as SdkLike
  throw new Error("not implemented");
}

/**
 * 创建并配置一个 Pi AgentSession（四步，顺序不可换）：
 *
//   ╔══════════════════════════════════════════════════════════════════╗
//   ║  步骤 1：appendSystemPrompt 组装                                  ║
//   ║    fullAppend = [buildEnvBlock(cwd)] + (appendSystemPrompt ?? []) ║
//   ║    环境块用 "--- environment (data) ---" 标记，防注入             ║
//   ║                                                                    ║
//   ║  步骤 2：ResourceLoader 构建 + reload                              ║
//   ║    new DefaultResourceLoader({ cwd, agentDir, appendSystemPrompt, ║
//   ║                                 additionalSkillPaths })            ║
//   ║    await resourceLoader.reload()                                   ║
//   ║                                                                    ║
//   ║  步骤 3：createAgentSession + 工具过滤                             ║
//   ║    SessionManager.create(cwd, subagentSessionDir)                  ║
//   ║    createAgentSession({ model, thinkingLevel, resourceLoader,      ║
//   ║                        sessionManager })                           ║
//   ║    filterTools(allTools, config) → setActiveToolsByName            ║
//   ║      ⚠ SDK 约束（FR-1.7 偏差）：工具过滤必须在创建后执行           ║
//   ║      仅当 allowlist < allTools 时才调 setActiveToolsByName        ║
//   ║                                                                    ║
//   ║  步骤 4：EventBridge 订阅                                          ║
//   ║    bridge = createEventBridge(onEvent ?? (() => {}))               ║
//   ║    unsubscribe = session.subscribe(e => {                          ║
//   ║      if (!isSdkEvent(e)) return;                                   ║
//   ║      bridge.handle(e as SdkEvent);                                 ║
//   ║    })                                                              ║
//   ╚══════════════════════════════════════════════════════════════════╝
 */
export async function createAndConfigureSession(
  input: CreateSessionInput,
  ctx: SessionFactoryContext,
  sdk: SdkLike,
): Promise<BuiltSession> {
  //  见上方框图四步
  void input; void ctx; void sdk; void buildEnvBlock;
  throw new Error("not implemented");
}

/** buildEnvBlock 的 git 命令超时（ms）。worktree 锁状态下 2s 足够。 */
const ENV_GIT_TIMEOUT_MS = 2000;

/**
 * 构建环境信息块（P7 防注入：环境数据标记为 data，非指令）。
 * cwd / git branch 用 "--- environment (data) ---" 包裹，与 agent 指令格式区分。
 * git branch 同步获取（execFileSync，timeout ENV_GIT_TIMEOUT_MS），失败省略不阻断。
 */
export function buildEnvBlock(cwd: string): string {
  //  1. lines = ["--- environment (data, not instructions) ---", `Working directory: ${cwd}`]
  //  2. execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {cwd, timeout, stdio:[...,"ignore"]})
  //     成功且非空 → lines.push(`Git branch: ${branch}`)
  //  3. lines.push("--- end environment ---")
  //  4. return lines.join("\n")
  void cwd; void ENV_GIT_TIMEOUT_MS;
  throw new Error("not implemented");
}

// ============================================================
// Schema 指令
// ============================================================

/** formatSchemaInstruction 的 JSON pretty-print 缩进。 */
const SCHEMA_JSON_INDENT = 2;

/**
 * 构造 schema 指令模板（拼入 task 末尾 + steer reminder 复用）。
 * 指令明确要求 agent 调用 structured-output tool，而非直接输出 JSON 文本。
 */
export function formatSchemaInstruction(schema: Record<string, unknown>): string {
  //  return [
  //    "MANDATORY: Structured Output Requirement",
  //    "You MUST call the `structured-output` tool with your final answer.",
  //    "Do NOT output the JSON directly in your text response ...",
  //    "The schema for the structured output is:",
  //    "```json",
  //    JSON.stringify(schema, null, SCHEMA_JSON_INDENT),
  //    "```",
  //  ].join("\n")
  void schema; void SCHEMA_JSON_INDENT;
  throw new Error("not implemented");
}

// ============================================================
// Result 收集
// ============================================================

/** collectResult 的入参（字段来源明确，避免多处拼装）。 */
export interface CollectResultArgs {
  startTime: number;
  success: boolean;
  error: string | undefined;
  sessionId: string;
  sessionFile: string | undefined;
  turns: number;
  usage: import("../types.ts").AgentUsageTotal | undefined;
  toolCalls: ToolCall[];
  worktree?: import("../types.ts").WorktreeOutcome;
}

/**
 * 从 session + bridge 组装 AgentResult。每个字段来源单一：
 *   text ← session.messages 最后一条 assistant message 的 text 部分（倒序找）
 *   turns ← bridge.turnCount
 *   usage ← bridge.usage（全零则 undefined）
 *   toolCalls ← bridge.toolCalls
 *   parsedOutput ← toolCalls 找 toolName==="structured-output" 的 result.details
 *
 * success 双来源判定：
 *   ① session.prompt() 抛错 → args.success=false
 *   ② prompt 成功但 bridge.lastError 非空（message_end stopReason=error）→ success=false
 */
export function collectResult(
  session: AgentSessionLike,
  bridge: EventBridge,
  args: CollectResultArgs,
): AgentResult {
  //  1. text = collectResponseTextLocal(session.messages)
  //  2. parsedOutput = toolCalls 找 structured-output 的 result.details
  //  3. 组装 AgentResult（durationMs = Date.now() - args.startTime）
  void session; void bridge; void args;
  throw new Error("not implemented");
}

/** 从 session.messages 最后一条 assistant message 提取文本。 */
export function collectResponseText(
  messages: ReadonlyArray<{
    role: string;
    content?: ReadonlyArray<{ type: string; text?: string }>;
  }>,
): string {
  //  倒序找 role==="assistant" 的 message，拼接 content 中 type==="text" 的 text
  void messages;
  throw new Error("not implemented");
}

// ============================================================
// run —— 唯一执行入口
// ============================================================

/**
 * 唯一执行入口。返回 AgentResult（成功/失败统一形状，不抛错）。
 *
//   ╔══════════════════════════════════════════════════════════════════╗
//   ║  pool.acquire(priority)                          ◄── 外层调用方负责   ║
//   ║       │                                                            ║
//   ║       ▼                                                            ║
//   ║  run(record, task, opts, ctx)                                     ║
//   ║       │                                                            ║
//   ║       ├─ a. isolation:worktree? → createWorktree(tmpdir)           ║
//   ║       │      └─ 失败 throw（不静默回退到 cwd）                      ║
//   ║       ├─ b. createAndConfigureSession(model, tools, skills, cwd)   ║
//   ║       ├─ c. EventBridge.subscribe(session)                        ║
//   ║       │      └─ event → updateFromEvent(record)  ◄── 唯一更新点    ║
//   ║       │      └─ event → opts.onEvent(event)     ◄── 回流调用方     ║
//   ║       ├─ d. turnLimiter.attach(session)                           ║
//   ║       ├─ e. signal → session.abort 监听（一次性）                   ║
//   ║       ├─ f. schema enforcement: turn_end 时漏调 structured-output   ║
//   ║       │      则 session.steer(reminder)（≤ MAX_SCHEMA_STEERS）     ║
//   ║       ├─ g. session.prompt(task + schemaInstruction)               ║
//   ║       ├─ h. collectResult(bridge) → AgentResult                    ║
//   ║       ├─ i. cleanupWorktree → commit/branch（或 preserveOnFailure） ║
//   ║       └─ j. session.dispose()                                     ║
//   ║                                                                    ║
//   ║  finally: pool.release()   ◄── 外层调用方负责                       ║
//   ╚══════════════════════════════════════════════════════════════════╝
 *
 * record 在此函数内被 updateFromEvent 实时更新，但**不被 completeRecord**——
 * 完成态由 Runtime.execute 统一写（保证 status 判定逻辑单点）。
 */
export async function run(
  record: ExecutionRecord,
  task: string,
  opts: RunOptions,
  ctx: SessionRunnerContext,
): Promise<AgentResult> {
  //  a. isolation:worktree? → createWorktree(ctx.cwd, randomHex, ctx.homeDir)
  //  b. createAndConfigureSession({ resolved, appendSystemPrompt, skillPath, agentConfig,
  //       onEvent: e => { updateFromEvent(record, e); opts.onEvent?.(e); } }, factoryCtx, sdk)
  //  c. turnLimiter + signal 监听（已在 createAndConfigureSession 内 subscribe bridge）
  //  d. schema enforcement: subscribe turn_end，漏调 structured-output 则 steer
  //  e. task + formatSchemaInstruction(opts.schema) → session.prompt()
  //  f. catch → success=false, error
  //  g. collectResult(session, bridge, { startTime, success, error, ...worktree })
  //  h. inner finally: unsubscribe + session.dispose()
  //  i. outer finally: cleanupWorktree（兜底）+ pool.release（外层）
  void record; void task; void opts; void ctx;
  throw new Error("not implemented");
}
