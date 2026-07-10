// src/core/session-runner.ts
//
// spawn pi --mode json 子进程执行 session 的编排器。零 mode 感知。
//
// spawn 改造后：session 在独立子进程跑（进程隔离），事件经 stdout JSON 流回流。
// runSpawn 是唯一执行入口（sync/background 共用）。mode 分叉在 Runtime.execute 顶部。
// 设计信息见 docs/subagents/spawn-refactor-plan.md。

import { type ChildProcess,execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";

import { writeAliveMarker } from "./alive-store.ts";
import type {
  AgentEvent,
  AgentResult,
  ExecutionRecord,
  SdkEvent,
  WorktreeHandle,
} from "./types.ts";
import { updateFromEvent } from "./execution-record.ts";
import type {
  AgentConfig,
  ResolvedModel,
} from "./model-resolver.ts";
import { collectResult } from "./output-collector.ts";
import { getSubagentSessionDir } from "./path-encoding.ts";
import { getPiInvocation } from "./pi-invocation.ts";
import { MAX_FORK_DEPTH } from "./session-context-resolver.ts";
import { IDENTITY_CUSTOM_TYPE, type SubagentIdentityData } from "./session-reconstructor.ts";
import {
  deriveSessionFilePath,
  findSessionFileByHeaderId,
  parseSpawnLine,
  type SpawnSessionHeader,
} from "./spawn-event-adapter.ts";
import {
  cleanupTempPrompt,
  writePromptToTempFile,
} from "./temp-prompt.ts";
import { createTurnLimiter, WRAP_UP_HINT } from "./turn-limiter.ts";

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

/** 子进程整体超时（ms）。兜底防止子进程卡死在单个 tool 内（hang 的 bash/网络读），
 *  导致 turn_end 永不触发、maxTurns limiter 失效、background 槽位/worktree/alive marker 泄漏。
 *  30 分钟足够覆盖正常长任务（如全量测试/大文件分析），超限则 SIGTERM。 */
const SPAWN_WATCHDOG_MS = 30 * 60 * 1000;

/** stderr 累积上限（字符）。防止失控子进程打满父进程内存。保留尾部便于诊断。 */
const STDERR_MAX_CHARS = 64 * 1024;

// ============================================================
// 孤儿进程兜底（C1）
// ============================================================
//
// [C1] track 所有 runSpawn 创建的子进程（sync + background），供 dispose 兜底 kill。
//
// 背景：sync record 的 controller 是 undefined（见 createRecordForMode L420 附近），
// 所以 RecordStore.abortRunningControllers 只能 kill background 子进程（有 controller 的）。
// 主进程异常退出（SIGKILL/崩溃/session_shutdown dispose）时，sync 子进程会成孤儿。
//
// 本 Set 是 dispose 的最后兜底——在 abortRunningControllers（background controller.abort 路径）
// 之后，遍历所有仍存活的子进程（含 sync）发 SIGTERM。正常退出路径（子进程 close）会从 Set 移除，
// 不受影响。background 子进程可能被 controller.abort 路径先 kill 一次，再被本遍历 kill 一次
// （对已退出的 child.kill 返回 false，无害）。
const spawnedChildren = new Set<ChildProcess>();

/**
 * kill 所有未退出的 spawned 子进程（dispose 兜底用）。
 *
 * 遍历 spawnedChildren Set，对每个未 killed 的子进程发 `child.kill(signal)`。
 * 已退出的子进程在 close/error 事件时已从 Set 移除（`spawnedChildren.delete`），
 * 故 Set 中只剩「活着的」或「已被 kill 但 close 事件尚未回调的」。后者用 `child.killed`
 * 跳过——避免对一个已 kill 的子进程重复 kill。
 *
 * 用于 SubagentService.dispose（进程退出路径）：覆盖 sync 子进程（controller 为 undefined，
 * abortRunningControllers 跳过它们）。background 子进程此时已被 abortRunningControllers 经
 * controller.abort 路径 kill，本函数对它们的二次 kill 是无害 noop（已 killed）。
 *
 * 不 await 子进程退出（dispose 要快速返回）。
 *
 * @returns 被 kill 的子进程数（诊断用）
 */
export function killAllSpawnedChildren(signal: NodeJS.Signals = "SIGTERM"): number {
  let n = 0;
  for (const child of spawnedChildren) {
    // 跳过已 kill 的（killed=true 表示已调过 child.kill；已退出的在 close/error 时已从 Set 移除）。
    // 不依赖 exitCode/signalCode：close 事件回调可能晚于 dispose，此时它们仍为 null，但子进程
    // 可能已被 controller.abort 路径 kill（killed=true）。
    if (child.killed) continue;
    try {
      child.kill(signal);
      n++;
    } catch {
      // best-effort：单个 kill 失败不影响其他子进程
    }
  }
  return n;
}

// ============================================================
// 依赖注入容器 + 入参
// ============================================================

/** SessionRunner 的依赖注入容器（由 Runtime 提供，解耦 Core 与 Pi SDK 实例）。 */
export interface SessionRunnerContext {
  /** 进程当前工作目录（作为 spawn 子进程的 cwd 基准）。 */
  cwd: string;
  /** agent 配置目录（由 Pi 核心 getAgentDir() 决定，默认 ~/.pi/agent）。 */
  agentDir: string;
  /** 额外 skill 目录（从 discovery.json 读，靠前覆盖靠后）。供子进程 --skill 注入。 */
  skillDirs: string[];
  /** 主 agent cwd（fork sessionDir 编码用）。fork 未开启时等于 cwd。 */
  mainCwd: string;
  /** 主 agent session 文件路径（fork 源）。fork 未开启时 undefined。 */
  mainSessionFile?: string;
  /**
   * worktree 子进程 pid 就绪回调（first header 时触发）。
   * Runtime 层接线为 WorktreeManager.registerPid，用于注册表补全 pid。
   * 解耦 Core 与 Runtime——session-runner 不直接依赖 WorktreeManager。
   */
  onWorktreePid?: (branch: string, pid: number) => void;
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
  /** 是否继承父会话上下文（fork 模式，只继承上下文）。 */
  fork?: boolean;
  /** 预创建的 worktree handle（undefined=不隔离，在 parent cwd 跑）。 */
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
// 环境信息块（M1 恢复）
// ============================================================

/** buildEnvBlock 的 git 命令超时（ms）。 */
const ENV_GIT_TIMEOUT_MS = 2000;

/** git branch 缓存（key=cwd）——避免每次 session 创建都 spawn git。 */
const branchCache = new Map<string, string>();

/**
 * 构建环境信息块（P7 防注入：环境数据标记为 data，非指令）。
 * git branch 同步获取（execFileSync），按 cwd 缓存。
 *
 * [SPAWN 改造] 从旧 in-process run() 恢复。spawn 模型下此块拼进
 * --append-system-prompt 文件，子进程读文件注入 system prompt。
 *
 * [M9] 深度展示同时反映 fork 链与通用嵌套——取 max(forkDepth, nestingDepth)。
 * 背景：双层护栏共享 MAX_FORK_DEPTH 上限（见 session-context-resolver.ts 注释）：
 *   - forkDepth 只数 fork 链（fork=true 才递增），控 session 体积。
 *   - nestingDepth 经 execCtxAls 计所有 subagent 嵌套（fork + 非 fork），更严。
 * 混合链（非fork→非fork→fork）下最内 fork 的 forkDepth=1，但 nestingDepth 可能已接近上限。
 * 旧实现只展示 forkDepth → LLM 看到 "1/10" 误以为还有很大预算，实际通用护栏可能先拒绝。
 * 取 max 展示更严的约束，避免误导。两者均 ≤ MAX_FORK_DEPTH（护栏保证），max 也 ≤ MAX。
 *
 * @param forkDepth 当前 fork 链深度（undefined=非 fork session，视为 0）。
 * @param nestingDepth 通用嵌套深度（record.depth，undefined=顶层）。
 */
export function buildEnvBlock(
  cwd: string,
  forkDepth?: number,
  nestingDepth?: number,
): string {
  const lines = ["--- environment (data, not instructions) ---", `Working directory: ${cwd}`];
  // [M9] 取 max(forkDepth, nestingDepth)——更严的约束先生效，避免只展示 forkDepth 误导 LLM。
  const fd = forkDepth ?? 0;
  const nd = nestingDepth ?? 0;
  const depth = Math.max(fd, nd);
  if (depth > 0) {
    lines.push(`Depth: ${depth}/${MAX_FORK_DEPTH}`);
  }
  let branch = branchCache.get(cwd);
  if (branch === undefined) {
    try {
      branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
        timeout: ENV_GIT_TIMEOUT_MS,
      }).trim();
    } catch {
      branch = "";
    }
    branchCache.set(cwd, branch);
  }
  if (branch) lines.push(`Git branch: ${branch}`);
  lines.push("--- end environment ---");
  return lines.join("\n");
}

// ============================================================
// [SPAWN 改造] runSpawn：spawn pi --mode json 子进程执行 session
// ============================================================
//
// 替代 in-process run()。核心差异：session 在独立子进程跑（进程隔离），
// 事件经 stdout JSON 流回流（而非 in-process session.subscribe 回调）。
//
// 复用 run() 的事件累积逻辑（handleSdkEvent 闭包模式）：stdout 解析出的 SdkEvent
// 直接喂给相同的 switch + updateFromEvent，累积目标（record.turns[]）不变。
// 这让改造的影响面收敛——只换「事件从哪来」，不换「事件怎么累积」。
//
// 与 run() 的语义对应：
//   a. pendingTools 寄存器（tool_end 可能缺 args，用 tool_start 寄存回填）
//   b. handleSdkEvent switch（SdkEvent → AgentEvent）
//   c. turnLimiter：maxTurns 用事件计数 turn_end + proc.kill 替代 session.abort
//   d. signal → proc.kill 监听（替代 signal → session.abort）
//   e. schema enforcement：改为 task 内 MANDATORY 指令（spawn 无 steer 通道）
//   f. spawn + pump stdout（替代 session.prompt）
//   g. collectResult → AgentResult（完全复用）
//   h. proc cleanup（替代 session.dispose）
//
// fork 保留：--fork <mainSessionFile> 传父 session，子进程建分支会话。
//   depth 经环境变量 PI_SUBAGENT_FORK_DEPTH 传给子进程（W3 子进程侧初始化读取）。

/** 子进程退出码阈值：>=128 表示被信号终止（SIGTERM=143 等）。 */
const SIGNAL_EXIT_CODE_THRESHOLD = 128;

/**
 * 组装 pi CLI 参数（不含 task 本身，task 作为最后一个位置参数）。
 *
 * 抽取自 runSpawn 便于单测（纯函数，不依赖进程状态）。
 */
export function buildSpawnArgs(
  params: {
    model: string | undefined;
    thinkingLevel: string | undefined;
    agentTools: string[] | undefined;
    appendSystemPromptPath: string | undefined;
    sessionDir: string;
    forkSource: string | undefined;
    skillPaths: string[] | undefined;
  },
  task: string,
): string[] {
  const args: string[] = ["--mode", "json", "-p", "--session-dir", params.sessionDir];
  if (params.model) args.push("--model", params.model);
  if (params.thinkingLevel && params.model) {
    // thinking level 通过 model 后缀 :level 传递（pi CLI 约定）
    // model 已 push，这里只补后缀到同一 token
    const lastIdx = args.length - 1;
    args[lastIdx] = `${args[lastIdx]}:${params.thinkingLevel}`;
  }
  if (params.agentTools && params.agentTools.length > 0) {
    args.push("--tools", params.agentTools.join(","));
  }
  if (params.appendSystemPromptPath) {
    args.push("--append-system-prompt", params.appendSystemPromptPath);
  }
  if (params.forkSource) {
    args.push("--fork", params.forkSource);
  }
  // [M3 恢复] skill 路径：主 session 的 skillDirs + 调用方传入的 skillPath。
  // pi CLI 支持 --skill 多次使用，每个路径单独 push。
  if (params.skillPaths && params.skillPaths.length > 0) {
    for (const sp of params.skillPaths) {
      args.push("--skill", sp);
    }
  }
  args.push(task);
  return args;
}

/**
 * spawn pi 子进程执行 session。
 *
 * 契约与 run() 一致：正常路径不抛错（prompt 失败/turn-limit abort/子进程崩溃
 * 均合成 failed AgentResult 返回）。创建期异常（spawn 本身失败）会抛。
 */
export async function runSpawn(
  record: ExecutionRecord,
  task: string,
  opts: RunOptions,
  ctx: SessionRunnerContext,
): Promise<AgentResult> {
  const startTime = Date.now();

  // a. transient 寄存器（同 run()：tool_end 缺 args 时回填）
  const pendingTools = new Map<string, { toolName: string; args?: unknown }>();

  // b. turnLimiter（spawn 版：abort = proc.kill；steer 是 no-op）
  // [M1] pi --mode json 是 single-shot，无运行时 steer 通道。补偿：启动时通过
  // --append-system-prompt 预置 WRAP_UP_HINT（见上方 appendParts），让 agent 感知
  // 接近上限时主动收尾。maxTurns soft limit 仍依赖 graceTurns 后的 abort 兑现。
  let proc: ChildProcess | undefined;
  const limiter = createTurnLimiter({
    maxTurns: opts.maxTurns ?? 0,
    graceTurns: opts.graceTurns ?? DEFAULT_GRACE_TURNS,
    steer: () => {
      // no-op：spawn 无运行时 steer 通道，补偿已在启动时注入 WRAP_UP_HINT。
    },
    abort: () => {
      proc?.kill("SIGTERM");
    },
  });

  // c. schema 指令拼到 task 末尾（替代 in-process 的 turn_end steer 循环）
  const instruction = opts.schema ? formatSchemaInstruction(opts.schema) : ""
  const fullTask = task + instruction;

  // ── SDK 事件累积器（闭包模式与 run() 完全相同）──
  const accumulateMessageEnd = (raw: SdkEvent): void => {
    const msg = raw.message;
    if (msg?.usage) {
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

  // agentEvent 统一出口：updateFromEvent + onTurnEnd（limiter）+ opts.onEvent
  const agentEvent = (event: AgentEvent): void => {
    updateFromEvent(record, event);
    if (event.type === "turn_end") limiter.onTurnEnd(record.turnCount);
    opts.onEvent?.(event);
  };

  // d. session 目录（与 in-process 一致：list/恢复可发现同一目录）
  const sessionDir = getSubagentSessionDir(ctx.agentDir, ctx.mainCwd);
  fs.mkdirSync(sessionDir, { recursive: true });

  // e. worktree 模式：checkout 路径作为 spawn cwd（隔离文件系统）
  // worktree checkout 已由 worktree-manager 在 execute 前创建，此处只取路径。
  const spawnCwd = opts.worktree?.path ?? ctx.cwd;

  // f. fork source：父 session 文件路径（--fork 参数）
  const forkSource = opts.fork ? ctx.mainSessionFile : undefined;

  // g. appendSystemPrompt 落盘（env block + agent body + 调用方片段拼成 --append-system-prompt 文件）
  // [M1 恢复] 环境块（cwd / fork depth / git branch）拼在最前面，与旧 in-process
  // buildAppendSystemPrompt 顺序一致——parts[0] 是环境块，其后 agent systemPrompt、再后调用方片段。
  const ownForkDepth = opts.fork ? (opts.parentForkDepth ?? 0) + 1 : undefined;
  let tempPromptFile: { dir: string; filePath: string } | undefined;
  // [M9] buildEnvBlock 取 max(forkDepth, nestingDepth)：record.depth === nestingDepth（都从
  // execCtxAls 派生，见 createRecordForMode L425-427 与 execute L257-258），传它让 env block
  // 展示更严的约束（混合嵌套链下通用护栏可能先于 fork 护栏拒绝）。
  const appendParts: string[] = [buildEnvBlock(ctx.cwd, ownForkDepth, record.depth)];
  if (opts.agentConfig?.systemPrompt) appendParts.push(opts.agentConfig.systemPrompt);
  if (opts.appendSystemPrompt) appendParts.push(...opts.appendSystemPrompt);
  // [M1 补偿] spawn 模式无运行时 steer 通道（pi --mode json 是 single-shot），
  // 改为启动时预置 wrap-up 提示——agent 感知接近上限时主动收尾。
  // 长期方案：切到 pi --mode rpc（支持运行时 steer），见 follow-up。
  if (opts.maxTurns && opts.maxTurns > 0) appendParts.push(WRAP_UP_HINT);
  if (appendParts.length > 0) {
    tempPromptFile = await writePromptToTempFile(record.agent, appendParts.join("\n\n"));
  }

  // h. fork depth 经环境变量传给子进程（子进程 subagents 扩展 W3 读取）
  const childEnv = { ...process.env };
  if (opts.fork && opts.parentForkDepth !== undefined) {
    childEnv.PI_SUBAGENT_FORK_DEPTH = String(opts.parentForkDepth + 1);
  }

  // i. 组装 args + spawn
  // [M3 恢复] skillPaths: 主 session 的 skillDirs + 调用方传入的 skillPath（与旧 in-process run 一致）。
  // skillDirs 由 SubagentService.buildSessionRunnerContext 从 discovery.json 读入。
  const skillPaths = [...ctx.skillDirs, opts.skillPath].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  const modelId = opts.resolved.model.id;
  const spawnArgs = buildSpawnArgs(
    {
      model: `${opts.resolved.model.provider}/${modelId}`,
      thinkingLevel: opts.resolved.thinkingLevel,
      agentTools: opts.agentConfig?.tools,
      appendSystemPromptPath: tempPromptFile?.filePath,
      sessionDir,
      forkSource,
      skillPaths: skillPaths.length > 0 ? skillPaths : undefined,
    },
    fullTask,
  );
  const invocation = getPiInvocation(spawnArgs);

  // 解析出的 session header（stdout 首行，含 session id）
  let sessionHeader: SpawnSessionHeader | undefined;
  // 累积 stderr（错误诊断用）
  let stderrBuffer = "";

  try {
    const child = spawn(invocation.command, invocation.args, {
      cwd: spawnCwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    proc = child;
    // [C1] track 子进程供 dispose 兜底 kill（sync + background 均注册——sync 无 controller，
    // abortRunningControllers 跳过它，靠本 Set 兜底）。close/error 后移除（已退出无需再 kill）。
    spawnedChildren.add(child);

    // stdout/stderr 用 utf8 编码：stream 自动按字符边界切分，避免多字节
    // UTF-8（CJK/emoji）跨 chunk 时 toString() 产生 U+FFFD 替换符导致 JSON.parse 失败。
    // [m2] 先 setEncoding 再注册 signal listener/watchdog：若 setEncoding 抛错，try/finally
    //（下方）只清理 tempPromptFile，watchdog/signal listener 尚未注册则无需清理——避免泄漏。
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    // d. signal → proc.kill 监听（一次性，替代 session.abort）
    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    // 前置检查：signal 在 spawn 前已 aborted 时 addEventListener 不会触发 onAbort，
    // 子进程会跑到自然结束。立即 kill 兑现取消语义。
    if (opts.signal?.aborted) onAbort();

    // e. watchdog：子进程整体超时兜底。卡死在单 tool 内（turn_end 永不触发）时
    //    limiter 失效，此 timer 保证最终 SIGTERM，防止 background 槽位/资源泄漏。
    // [R0] unref：不阻止 Node 进程退出。安全性由 SubagentService.dispose 保证——
    // 主进程退出时（session_shutdown reason=quit）dispose 会 abort running controller
    // → 本监听器 kill 子进程。无此 unref，30 分钟 timer 会拖住 event loop 阻止退出。
    const watchdog = setTimeout(() => child.kill("SIGTERM"), SPAWN_WATCHDOG_MS);
    watchdog.unref();

    // stdout pump：逐行解析 → handleSdkEvent
    let stdoutBuffer = "";
    child.stdout.on("data", (data: string) => {
      stdoutBuffer += data;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? ""; // 保留最后未完整行
      for (const line of lines) {
        const parsed = parseSpawnLine(line);
        if (!parsed) continue;
        if (parsed.kind === "header") {
          sessionHeader = parsed.header;
          // 回填 record.sessionFile（deriveSessionFilePath 推导路径）
          record.sessionFile = deriveSessionFilePath(parsed.header, sessionDir);
          // [持久化 C] alive marker：running 期间崩溃恢复用。子进程 pid + session id。
          // 与 in-process 逻辑对齐（记 sessionFile + pid），改为子进程 pid。
          if (record.sessionFile && child.pid) {
            try {
              writeAliveMarker(record.sessionFile, {
                pid: child.pid,
                id: parsed.header.id,
                startedAt: Date.now(),
              });
            } catch {
              // best-effort：alive marker 失败不影响执行
            }
          }
          // [全局注册表] worktree 模式：补全注册表条目的 pid。
          // create 时 pid 未知写 0 占位，此处拿到 child.pid 后回调 WorktreeManager.registerPid。
          // 取代旧的 .session mapping sidecar——注册表是 reaper 的唯一数据源。
          if (opts.worktree && child.pid) {
            ctx.onWorktreePid?.(opts.worktree.branch, child.pid);
          }
        } else if (parsed.kind === "event") {
          if (isSdkEvent(parsed.event)) handleSdkEvent(parsed.event);
        }
        // invalid 行忽略（stdout 可能有调试输出）
      }
    });

    child.stderr.on("data", (data: string) => {
      // 截断防 OOM：失控子进程持续打 stderr 会耗尽父进程内存。保留尾部便于诊断。
      stderrBuffer = (stderrBuffer + data).slice(-STDERR_MAX_CHARS);
    });

    // 等待子进程退出
    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", (code: number | null) => {
        // [C1] 子进程已退出，从 orphan-tracking Set 移除（dispose 兜底无需再 kill 它）
        spawnedChildren.delete(child);
        // 处理 stdout 末尾残留行
        if (stdoutBuffer.trim()) {
          const parsed = parseSpawnLine(stdoutBuffer);
          if (parsed?.kind === "event" && isSdkEvent(parsed.event)) {
            handleSdkEvent(parsed.event);
          }
        }
        resolve(code ?? 0);
      });
      child.on("error", (err: Error) => {
        // spawn 本身失败（command not found 等）
        spawnedChildren.delete(child);
        record.lastError = err.message;
        resolve(SIGNAL_EXIT_CODE_THRESHOLD); // 非零退出
      });
    });

    opts.signal?.removeEventListener("abort", onAbort);
    clearTimeout(watchdog);

    // [持久化 A] sessionFile 兜底校验 + identity entry。
    // session.jsonl 由子进程写入，父进程在子进程退出后（写入完成）補写身份条目。
    // reconstructFromFile 依赖 IDENTITY_CUSTOM_TYPE custom entry 重建 record 身份，
    // 缺失则 /subagents list 磁盘源为空（终态 record 全丢失）。[回归修复]
    if (sessionHeader && record.sessionFile) {
      // 兜底：deriveSessionFilePath 推导的路径可能不存在（pi 命名规则变化），
      // 用 sessionId 后缀匹配实际文件。匹配到则修正 record.sessionFile。
      if (!fs.existsSync(record.sessionFile)) {
        const actual = findSessionFileByHeaderId(sessionDir, sessionHeader.id);
        if (actual) record.sessionFile = actual;
      }
      // 补写 identity custom entry（子进程已退出，append 安全）。
      if (fs.existsSync(record.sessionFile)) {
        const identity: SubagentIdentityData = {
          id: record.id,
          agent: record.agent,
          mode: record.mode,
          task: record.task,
          startedAt: record.startedAt,
          rootSessionId: record.rootSessionId,
          parentRecordId: record.parentRecordId,
          depth: record.depth,
          forkDepth: (opts.parentForkDepth ?? 0) + 1,
        };
        try {
          fs.appendFileSync(
            record.sessionFile,
            `${JSON.stringify({ type: "custom", customType: IDENTITY_CUSTOM_TYPE, data: identity })}\n`,
            "utf-8",
          );
        } catch (err) {
          // best-effort：identity 写入失败不影响执行结果，但会影响 /subagents list 重建。
          // 记录到 stderr（非阻断）—— 终态 record 会从 list 消失，这是可观测的退化信号。
          console.error(`[subagents] identity append failed for ${record.sessionFile}:`, err);
        }
      }
    }

    // 判定成功/失败（三来源：exitCode + record.lastError + abort 原因）
    let success: boolean;
    let error: string | undefined;
    if (record.lastError) {
      // LLM/provider error 或 abort error 已收口进 record.lastError
      success = false;
      error = record.lastError;
    } else if (exitCode !== 0 && exitCode < SIGNAL_EXIT_CODE_THRESHOLD) {
      // 非信号退出的非零 exit code = 子进程自身报错
      success = false;
      error = stderrBuffer.trim() || `pi subprocess exited with code ${exitCode}`;
    } else if (opts.signal?.aborted) {
      // 用户/调用方 signal 取消（非 maxTurns）——不算成功，但也不算 error
      success = false;
      error = undefined;
    } else {
      // exitCode === 0 或被信号终止（maxTurns 达限 kill）——均视为正常完成
      success = true;
      error = record.lastError;
    }

    // g. collectResult（完全复用——全部从 record 读）
    return collectResult(record, {
      startTime,
      success,
      error,
      sessionId: sessionHeader?.id ?? record.id,
      sessionFile: record.sessionFile,
    });
  } finally {
    // h. 清理临时 prompt 文件
    if (tempPromptFile) {
      await cleanupTempPrompt(tempPromptFile);
    }
  }
}
