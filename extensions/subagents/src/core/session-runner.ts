// src/core/session-runner.ts
//
// 唯一的一次性 session 执行编排器。零 mode 感知——只负责"跑一次 session + 更新 record"。
//
// 这是 sync/background 两路径完全共用的核心。mode 分叉在 Runtime.execute 顶部，
// 不渗透到此处。Core 不知道谁调用它、是否 await、是否回注通知。
//
// 编排层（Orchestration）：站在基础层（session-factory / output-collector）之上，
// 负责执行时序、SDK 事件累积与清理。不持有 Pi SDK 实例，只通过 factory 间接用。
// 设计信息见 docs/subagents/session-runner.md。

import { execFileSync } from "node:child_process";
import * as path from "node:path";

import { writeAliveMarker } from "../runtime/execution/alive-store.ts";
import type {
  AgentConfig,
  AgentSessionLike,
  ResolvedModel,
  ResourceLoaderLike,
  ResourceLoaderOptions,
  SdkLike,
} from "../types.ts";
import type {
  AgentEvent,
  AgentResult,
  ExecutionRecord,
  SdkEvent,
  WorktreeHandle,
} from "../types.ts";
import { getAllToolCalls, updateFromEvent } from "./execution-record.ts";
import type { ModelRegistryLike } from "./model-resolver.ts";
import { collectResult } from "./output-collector.ts";
import { encodeCwd } from "./path-encoding.ts";
import { resolveSessionContext } from "./session-context-resolver.ts";
import { IDENTITY_CUSTOM_TYPE } from "./session-reconstructor.ts";
import { createTurnLimiter } from "./turn-limiter.ts";

/**
 * 运行时 guard：subscribe 回调收到的 event 形状未知，校验 type 字段后再交给 handle。
 * 防止 SDK 事件结构变化时 switch(raw.type) 静默失配（全走 default 不报错）。
 */
function isSdkEvent(x: unknown): x is SdkEvent {
  if (typeof x !== "object" || x === null) return false;
  if (!("type" in x)) return false;
  return typeof (x as SdkEvent).type === "string";
}

// ============================================================
// 常量
// ============================================================

/** 默认 grace turns（soft limit 后宽限轮数，对齐旧实现 DEFAULT_GRACE_TURNS）。 */
const DEFAULT_GRACE_TURNS = 2;

/** schema 契约 enforcement：agent 漏调 structured-output 时最多 steer 重试次数。
 *  对齐 structured-output 扩展原 setupWorkflowHook 的 MAX_HOOK_RETRIES=2。 */
const MAX_SCHEMA_STEERS = 2;

/** structured-output 工具名（与 structured-output 扩展 TOOL_NAME 一致）。 */
const STRUCTURED_OUTPUT_TOOL = "structured-output";

// ============================================================
// 依赖注入容器 + 入参
// ============================================================

/** SessionRunner 的依赖注入容器（由 Runtime 提供，解耦 Core 与 Pi SDK 实例）。 */
export interface SessionRunnerContext {
  /** 进程当前工作目录（传给 createAgentSession）。 */
  cwd: string;
  /** agent 配置目录（由 Pi 核心 getAgentDir() 决定，默认 ~/.pi/agent）。 */
  agentDir: string;
  /** 模型注册表（鉴权 + 发现）。 */
  modelRegistry: ModelRegistryLike;
  /** agent 解析器（by name → AgentConfig）。 */
  resolveAgent: (name: string) => AgentConfig | undefined;
  /** 额外 skill 目录（从 discovery.json 读，靠前覆盖靠后）。 */
  skillDirs: string[];
  /** Pi SDK 实例（由 Runtime 在 session_start 时 dynamic import 一次后注入）。 */
  sdk: SdkLike;
  /** 主 agent cwd（fork sessionDir 编码用）。fork 未开启时等于 cwd。 */
  mainCwd: string;
  /** 主 agent session 文件路径（fork 源）。fork 未开启时 undefined。 */
  mainSessionFile?: string;
}

/** SessionRunner.run 的入参。 */
export interface RunOptions {
  /** 已 resolve 的模型（Runtime 在调用前解析，Core 不重复解析）。 */
  resolved: ResolvedModel;
  /** agent 配置（含 systemPrompt/tools）。 */
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
  /** fork 模式：创建 worktree 隔离执行。 */
  fork?: boolean;
  /** fork 模式下外部提供的 worktree handle。 */
  worktree?: WorktreeHandle;
  /** 父级 fork depth（用于深度限制 + identity entry）。 */
  parentForkDepth?: number;
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
  return [
    "MANDATORY: Structured Output Requirement",
    "You MUST call the `structured-output` tool with your final answer.",
    "Do NOT output the JSON directly in your text response — you MUST use the structured-output tool.",
    "The schema for the structured output is:",
    "```json",
    JSON.stringify(schema, null, SCHEMA_JSON_INDENT),
    "```",
  ].join("\n");
}

// ============================================================
// session 工厂（从 session-factory.ts 合并）
// ============================================================

/** createAndConfigureSession 的输入选项。 */
interface CreateSessionInput {
  /** 已解析的模型（由 resolveModel 产出）。 */
  resolved: ResolvedModel;
  /** systemPrompt 追加内容（调用方可传 agent body 等）。 */
  appendSystemPrompt?: string[];
  /** skill 路径。 */
  skillPath?: string;
  /** agent 配置（提取 tool 过滤策略）。 */
  agentConfig?: AgentConfig;
  /** fork 模式标志。 */
  fork?: boolean;
  /** fork 模式下外部提供的 worktree handle。 */
  worktree?: WorktreeHandle;
  /** 父级 fork depth。 */
  parentForkDepth?: number;
  /** 执行记录 ID（worktree=true 时计算 effectiveCwd 需要）。 */
  recordId?: string;
}

/** createAndConfigureSession 的输出。 */
interface BuiltSession {
  session: AgentSessionLike;
  /** subagent session 文件绝对路径（未持久化时为 undefined）。 */
  sessionFile?: string;
}

/** 动态 import Pi SDK。 */
async function getSdk(): Promise<SdkLike> {
  const mod = await import("@mariozechner/pi-coding-agent");
  // 运行时 guard：验证 SDK 关键方法存在
  const sdkMod = mod as Record<string, unknown>;
  if (typeof sdkMod.createAgentSession !== "function") {
    throw new Error("SDK missing createAgentSession function");
  }
  if (!sdkMod.SessionManager || typeof (sdkMod.SessionManager as Record<string, unknown>).create !== "function") {
    throw new Error("SDK missing SessionManager.create function");
  }
  // eslint-disable-next-line taste/no-unsafe-cast
  return mod as unknown as SdkLike;
}
/** re-export getSdk 给 subagent-service lazy import 用。 */
export { getSdk };

/**
 * 组装 appendSystemPrompt（env block + agent systemPrompt + 调用方片段）。
 *
 * 顺序：env block → agent systemPrompt → 调用方 appendSystemPrompt。
 *
 * [HISTORICAL] 此前 agentConfig.systemPrompt 从未被注入——导致指定 worker/scout 子进程
 * 拿不到 agent.md 正文。修复：在此处显式注入。
 */
export function buildAppendSystemPrompt(
  appendSystemPrompt: string[] | undefined,
  cwd: string,
  agentConfig?: { systemPrompt?: string },
): string[] {
  const parts = [buildEnvBlock(cwd)];
  const agentPrompt = agentConfig?.systemPrompt?.trim();
  if (agentPrompt) parts.push(agentPrompt);
  parts.push(...(appendSystemPrompt ?? []));
  return parts;
}

/** 构建 DefaultResourceLoader。 */
function buildResourceLoader(
  sdk: SdkLike,
  opts: ResourceLoaderOptions,
): ResourceLoaderLike {
  return new sdk.DefaultResourceLoader(opts);
}

/** 计算 subagent session 持久化目录。 */
export function getSubagentSessionDir(agentDir: string, cwd: string): string {
  return path.join(agentDir, "subagents", encodeCwd(cwd), "sessions");
}

/**
 * 三层工具过滤 + setActiveToolsByName。
 *
 * ⚠ SDK 约束（spec FR-1.7 偏差）：工具过滤必须创建后执行——
 *   createAgentSession({tools}) 构造时传 allowlist 需预知工具全集，但扩展工具要等
 *   resourceLoader 加载后才注册。因此只能创建后用 setActiveToolsByName 兜底。
 */
export function applyToolFilter(
  session: AgentSessionLike,
  agentConfig: AgentConfig | undefined,
): void {
  const allowlist = agentConfig?.tools;
  if (!allowlist || allowlist.length === 0) return;

  const allTools = session.getAllTools();
  const allowed = allTools
    .map((t) => t.name)
    .filter((name) => allowlist.includes(name));
  if (allowed.length === 0) {
    throw new Error(
      `Agent tool allowlist [${allowlist.join(", ")}] matched none of the ${allTools.length} registered tools. Check agent config or install the missing tool extension.`,
    );
  }
  if (allowed.length < allTools.length) {
    session.setActiveToolsByName(allowed);
  }
}

/** buildEnvBlock 的 git 命令超时（ms）。 */
const ENV_GIT_TIMEOUT_MS = 2000;

/** git branch 缓存（key=cwd）——避免每次 session 创建都 spawn git。 */
const branchCache = new Map<string, string>();

/**
 * 构建环境信息块（P7 防注入：环境数据标记为 data，非指令）。
 * git branch 同步获取（execFileSync），按 cwd 缓存。
 */
export function buildEnvBlock(cwd: string): string {
  const lines = ["--- environment (data, not instructions) ---", `Working directory: ${cwd}`];
  let branch = branchCache.get(cwd);
  if (branch === undefined) {
    try {
      branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
        timeout: ENV_GIT_TIMEOUT_MS,
      }).trim();
    } catch (_err) {
      void _err;
      branch = "";
    }
    branchCache.set(cwd, branch);
  }
  if (branch) lines.push(`Git branch: ${branch}`);
  lines.push("--- end environment ---");
  return lines.join("\n");
}

/**
 * 创建并配置一个 Pi AgentSession。
 *
 * fork 分流逻辑（D-018 两级降级链）：
 *   1. resolveSessionContext → {shouldFork, forkSource, effectiveCwd, sessionDir}
 *   2. shouldFork && forkSource → 优先 createBranchedSession（原地 mutate，体积更小）
 *   3. catch → 降级 forkFrom（AC-6.3 两级）
 *   4. !shouldFork → SessionManager.create（现有路径）
 *
 * 非 fork 路径四步（顺序不可换）：
 *   步骤 1：appendSystemPrompt 组装（含环境块，防注入）
 *   步骤 2：ResourceLoader 构建 + reload（发现 skills/agents）
 *   步骤 3：createAgentSession + 工具过滤
 *   步骤 4：subscribe（SDK 约束：至少一个 subscriber）
 */
async function createAndConfigureSession(
  input: CreateSessionInput,
  ctx: SessionRunnerContext,
  sdk: SdkLike,
): Promise<BuiltSession> {
  // ── fork 分流：resolveSessionContext 纯函数判定意图 ──
  const resolved = resolveSessionContext({
    fork: input.fork,
    worktree: input.worktree !== undefined,
    cwd: ctx.cwd,
    mainCwd: ctx.mainCwd,
    mainSessionFile: ctx.mainSessionFile,
    parentForkDepth: input.parentForkDepth,
    agentDir: ctx.agentDir,
    recordId: input.recordId,
  });

  if (resolved.shouldFork && resolved.forkSource) {
    // D-018: 优先 createBranchedSession，失败降级 forkFrom
    try {
      const branched = await createForkSession(
        sdk, resolved.forkSource, resolved.effectiveCwd, resolved.sessionDir, input,
      );
      console.log(
        `[subagents] fork session: createBranched depth=${(input.parentForkDepth ?? 0) + 1}`,
      );
      return branched;
    } catch (primaryErr) {
      // 两级降级：createBranchedSession 失败 → forkFrom
      try {
        const forked = await forkSessionFrom(
          sdk, resolved.forkSource, resolved.effectiveCwd, resolved.sessionDir, input,
        );
        console.log(
          `[subagents] fork session: forkFrom (fallback) depth=${(input.parentForkDepth ?? 0) + 1}`,
        );
        return forked;
      } catch (fallbackErr) {
        // 两级均失败 → 抛出（run() 的 catch 合成 failed result）
        const msg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
        const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        throw new Error(
          `fork session failed: createBranchedSession(${msg}), forkFrom(${fbMsg})`,
        );
      }
    }
  }

  // ── 非 fork 路径（现有行为不变）──
  console.log("[subagents] session: from-scratch");
  return createSessionFromScratch(input, ctx, sdk);
}

/**
 * fork 路径 1: createBranchedSession（D-018 优先，原地 mutate，体积更小）。
 * SDK SessionManager.createBranchedSession 返回完整 session。
 */
async function createForkSession(
  sdk: SdkLike,
  forkSource: string,
  effectiveCwd: string,
  sessionDir: string,
  _input: CreateSessionInput,
): Promise<BuiltSession> {
  if (!sdk.createBranchedSession) {
    throw new Error("createBranchedSession not available in SDK");
  }
  const { session } = await sdk.createBranchedSession({
    sessionFile: forkSource,
    cwd: effectiveCwd,
    sessionDir,
  });
  // fork 路径写 alive marker（sessionFile 就绪后立即写，窗口期最小化）
  const sessionFile = session.sessionManager.getSessionFile();
  if (sessionFile) {
    writeAliveMarker(sessionFile, {
      pid: process.pid,
      id: session.sessionId,
      startedAt: Date.now(),
    });
  }
  return { session, sessionFile: sessionFile ?? undefined };
}

/**
 * fork 路径 2: forkFrom（D-018 降级，AC-6.3 两级）。
 * SDK SessionManager.forkFrom 返回完整 session。
 */
async function forkSessionFrom(
  sdk: SdkLike,
  forkSource: string,
  effectiveCwd: string,
  sessionDir: string,
  _input: CreateSessionInput,
): Promise<BuiltSession> {
  if (!sdk.forkFrom) {
    throw new Error("forkFrom not available in SDK");
  }
  const { session } = await sdk.forkFrom(forkSource, {
    cwd: effectiveCwd,
    sessionDir,
  });
  // fork 路径写 alive marker
  const sessionFile = session.sessionManager.getSessionFile();
  if (sessionFile) {
    writeAliveMarker(sessionFile, {
      pid: process.pid,
      id: session.sessionId,
      startedAt: Date.now(),
    });
  }
  return { session, sessionFile: sessionFile ?? undefined };
}

/**
 * 非 fork 路径：原有四步创建逻辑（行为不变）。
 */
async function createSessionFromScratch(
  input: CreateSessionInput,
  ctx: SessionRunnerContext,
  sdk: SdkLike,
): Promise<BuiltSession> {
  // 步骤 1：appendSystemPrompt 组装
  const fullAppend = buildAppendSystemPrompt(input.appendSystemPrompt, ctx.cwd, input.agentConfig);

  // 步骤 2：ResourceLoader 构建 + reload
  const additionalSkillPaths = [...ctx.skillDirs, input.skillPath].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  const resourceLoader = buildResourceLoader(sdk, {
    cwd: ctx.cwd,
    agentDir: ctx.agentDir,
    appendSystemPrompt: fullAppend,
    additionalSkillPaths: additionalSkillPaths.length > 0 ? additionalSkillPaths : undefined,
  });
  await resourceLoader.reload();

  // 步骤 3：createAgentSession + 工具过滤
  const subagentSessionDir = getSubagentSessionDir(ctx.agentDir, ctx.cwd);
  const { session } = await sdk.createAgentSession({
    model: input.resolved.model,
    thinkingLevel: input.resolved.thinkingLevel,
    cwd: ctx.cwd,
    resourceLoader,
    modelRegistry: ctx.modelRegistry,
    sessionManager: sdk.SessionManager.create(ctx.cwd, subagentSessionDir),
  });

  // 步骤 4：工具过滤（subscribe 由 run() 负责）
  try {
    applyToolFilter(session, input.agentConfig);
    return {
      session,
      sessionFile: session.sessionManager.getSessionFile() ?? undefined,
    };
  } catch (err) {
    try { session.dispose(); } catch (disposeErr) {
      // dispose 是清理，失败不应掩盖原始 err。把 disposeErr 作为 cause 链上去，
      // 既不静默吞掉，又不覆盖主错误（err 仍是被抛出的那一个）。
      if (err instanceof Error) {
        err.cause = disposeErr;
      }
      console.error("[subagents] session.dispose() threw during cleanup:", disposeErr);
    }
    throw err;
  }
}

// ============================================================
// run —— 唯一执行入口
// ============================================================

/**
 * 唯一执行入口。返回 AgentResult（成功/失败统一形状）。
 *
 * **契约：正常执行路径不抛错**（prompt 失败、bridge.lastError、turn-limit abort
 * 等均被捕获并合成 failed AgentResult 返回）。**但创建期异常会抛**
 * （createAndConfigureSession 失败）——finally 只负责清理
 * 已创建的资源，不吞创建异常。调用方（runAndFinalize）须 catch 后
 * 调 finalizeFailed 合成 failed result，避免异常逃逸到 tool 层。
 *
 *   ╔══════════════════════════════════════════════════════════════════╗
 *   ║  pool.acquire(priority)                          ◄── 外层调用方负责   ║
 *   ║       │                                                            ║
 *   ║       ▼                                                            ║
 *   ║  run(record, task, opts, ctx)                                     ║
 *   ║       │                                                            ║
 *   ║       ├─ a. createAndConfigureSession(model, tools, skills, cwd)   ║
 *   ║       ├─ b. SDK 事件累积器（updateFromEvent + usage/toolCall）     ║
 *   ║       ├─ c. turnLimiter（steer/abort 绑到 session）               ║
 *   ║       ├─ d. signal → session.abort 监听（一次性）                   ║
 *   ║       ├─ e. schema enforcement: turn_end 时漏调 structured-output   ║
 *   ║       │      则 session.steer(reminder)（≤ MAX_SCHEMA_STEERS）     ║
 *   ║       ├─ f. session.prompt(task + schemaInstruction)               ║
 *   ║       ├─ g. collectResult → AgentResult                            ║
 *   ║       └─ h. session.dispose()                                     ║
 *   ║                                                                    ║
 *   ║  finally: pool.release()   ◄── 外层调用方负责                       ║
 *   ╚══════════════════════════════════════════════════════════════════╝
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
  const startTime = Date.now();

  // a. transient 寄存器：pendingTools 是 SDK 契约补全层（tool_end 可能不带 args，
  // 需用 tool_start 时寄存的 args 回填）。非结果数据，不进 record。
  // turnCount/toolCalls/usage/lastError 已收口进 record.turns[]，不再旁路累积。
  const pendingTools = new Map<string, { toolName: string; args?: unknown }>();

  // b. turnLimiter + schema enforcement 闭包（built 创建后初始化）。
  let onTurnEnd: ((currentTurns: number) => void) | undefined;
  let onAbort: (() => void) | undefined;

  // ── SDK 事件累积器（从 EventBridge.handle 搬过来的 switch 逻辑）──
  // accumulateMessageEnd：发 AgentEvent（message_end 带 usage / error 带 message），
  // 由 updateFromEvent 收口进 record.turns[].usageDelta + record.lastError + record.totalTokens。
  // LLM provider 常在错误响应里也携带 usage（计费需如此）。必须先发 message_end(usage)，
  // 再独立判断 error/aborted，否则携带 usage 的错误响应会跳过 error 事件，
  // 导致 session-runner 把 errored session 误判为 success=true。[HISTORICAL]
  const accumulateMessageEnd = (raw: SdkEvent): void => {
    const msg = raw.message;
    if (msg?.usage) {
      // SDK usage.cost 形如 { total: number }；拍平成 AgentUsage.cost（number），
      // 供 getTotalUsage 累加。缺省时 cost=undefined（getTotalUsage 按 0 累加）。
      const { cost: costObj, ...usageBase } = msg.usage;
      const usage = { ...usageBase, cost: costObj?.total };
      agentEvent({ type: "message_end", usage });
    }
    const stopReason = msg?.stopReason;
    if (stopReason === "error" || stopReason === "aborted") {
      const errMsg = msg?.errorMessage ?? raw.reason ?? stopReason;
      agentEvent({ type: "error", message: errMsg });
    }
  };

  const handleSdkEvent = (raw: SdkEvent): void => {
    switch (raw.type) {
      case "tool_execution_start": {
        const toolName = raw.toolName ?? "";
        if (raw.toolCallId) {
          pendingTools.set(raw.toolCallId, { toolName, args: raw.args });
        }
        agentEvent({ type: "tool_start", toolName, args: raw.args });
        return;
      }
      case "tool_execution_end": {
        const toolName = raw.toolName ?? "";
        let args = raw.args;
        if (raw.toolCallId) {
          const pending = pendingTools.get(raw.toolCallId);
          if (pending) {
            if (args === undefined) args = pending.args;
            pendingTools.delete(raw.toolCallId);
          }
        }
        // 透传 result 到 AgentEvent——updateFromEvent 把完整 ToolCall（含 result）收口进 turn.toolCalls。
        agentEvent({ type: "tool_end", toolName, args, result: raw.result, isError: raw.isError });
        return;
      }
      case "message_update": {
        const ame = raw.assistantMessageEvent;
        if (ame?.type === "thinking_delta") {
          agentEvent({ type: "thinking_delta", delta: ame.delta ?? "" });
        } else if (ame?.delta !== undefined) {
          agentEvent({ type: "text_delta", delta: ame.delta });
        }
        return;
      }
      case "turn_end": {
        agentEvent({ type: "turn_end" });
        return;
      }
      case "message_end": {
        accumulateMessageEnd(raw);
        return;
      }
      case "compaction_start": {
        agentEvent({ type: "compaction" });
        return;
      }
      default:
        return;
    }
  };

  // agentEvent 统一出口：updateFromEvent（收口进 record.turns[]）+ onTurnEnd + opts.onEvent
  const agentEvent = (event: AgentEvent): void => {
    updateFromEvent(record, event);
    if (event.type === "turn_end") onTurnEnd?.(record.turnCount);
    opts.onEvent?.(event);
  };

  // a/b. create session + subscribe SDK events（无 EventBridge 中间层）。
  let built: BuiltSession | undefined;
  let sessionUnsubscribe: (() => void) | undefined;
  try {
    built = await createAndConfigureSession(
      {
        resolved: opts.resolved,
        appendSystemPrompt: opts.appendSystemPrompt,
        skillPath: opts.skillPath,
        agentConfig: opts.agentConfig,
        fork: opts.fork,
        worktree: opts.worktree,
        parentForkDepth: opts.parentForkDepth,
        recordId: record.id,
      },
      ctx,
      ctx.sdk,
    );

    // session 创建成功：回填 sessionFile（FR-7 窗口期方案）。
    record.sessionFile = built.session.sessionManager.getSessionFile() ?? undefined;

    // 写 identity custom entry：session.jsonl 的 header 不含 ExecutionRecord.id/agent/mode，
    // 故在此写一条 custom entry 携带身份，collectRecords 重建时读它恢复 record 身份。
    // session.jsonl 是唯一 source of truth（history.jsonl 已废弃）。
    // forkDepth+1 标记本 session 的 fork 深度（reconstruct 时用来恢复 fork 层级）。
    built.session.sessionManager.appendCustomEntry(IDENTITY_CUSTOM_TYPE, {
      id: record.id,
      agent: record.agent,
      mode: record.mode,
      task: record.task,
      startedAt: record.startedAt,
      forkDepth: (opts.parentForkDepth ?? 0) + 1,
    });

    // subscribe SDK events → handleSdkEvent → agentEvent → updateFromEvent + onTurnEnd + opts.onEvent
    const sdkSub = built.session.subscribe((raw: unknown) => {
      if (!isSdkEvent(raw)) return;
      handleSdkEvent(raw);
    });
    sessionUnsubscribe = sdkSub;

    // 局部引用：闭包内 built 可能被 TS 视为 undefined，提取 concrete ref。
    const session = built.session;

    // c. turnLimiter：steer/abort 绑到 session
    const limiter = createTurnLimiter({
      maxTurns: opts.maxTurns ?? 0,
      graceTurns: opts.graceTurns ?? DEFAULT_GRACE_TURNS,
      steer: (msg) => {
        void session.steer(msg);
      },
      abort: () => {
        void session.abort();
      },
    });

    // d. signal→abort 监听（一次性）
    onAbort = (): void => {
      void session.abort();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    // e. schema enforcement 计数器 + onTurnEnd 闭包
    let schemaSteerCount = 0;
    onTurnEnd = (currentTurns: number): void => {
      limiter.onTurnEnd(currentTurns);

      // schema enforcement：漏调 structured-output 则 steer 提醒（≤ MAX_SCHEMA_STEERS）
      if (!opts.schema) return;
      // 从 record.turns[] 扁平化读 toolCalls（收口后闭包 toolCalls 已删除）
      const calledStructuredOutput = getAllToolCalls(record).some(
        (tc) => tc.toolName === STRUCTURED_OUTPUT_TOOL,
      );
      if (calledStructuredOutput) return;
      if (schemaSteerCount >= MAX_SCHEMA_STEERS) return;
      schemaSteerCount += 1;
      const reminder =
        "[MANDATORY] You MUST call the `structured-output` tool now.\n" +
        "Your task requires structured output — do NOT respond with plain text.\n" +
        "Call structured-output with the schema below and your result as data.\n\n" +
        formatSchemaInstruction(opts.schema);
      void session.steer(reminder);
    };

    // f. session.prompt（schema 指令拼到 task 末尾）
    let success = true;
    let error: string | undefined;
    try {
      const instruction = opts.schema ? formatSchemaInstruction(opts.schema) : "";
      await session.prompt(task + instruction);
      // 双来源 success 判定：prompt 成功但 record.lastError 非空也算失败
      // （error 事件已由 updateFromEvent 收口进 record.lastError）
      if (record.lastError) {
        success = false;
        error = record.lastError;
      }
    } catch (err) {
      success = false;
      error = err instanceof Error ? err.message : String(err);
    }

    // g. collectResult 组装 AgentResult——全部从 record 读（收口后不再依赖闭包累积器）。
    // text 从 turns[] 聚合（getFullText），turns/toolCalls/usage 从 record 派生。
    return collectResult(record, {
      startTime,
      success,
      error,
      sessionId: built.session.sessionId,
      sessionFile: built.session.sessionManager.getSessionFile() ?? undefined,
    });
  } finally {
    // h. 清理：signal listener → unsubscribe（session.subscribe）→ dispose
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    sessionUnsubscribe?.();
    built?.session.dispose();
  }
}
