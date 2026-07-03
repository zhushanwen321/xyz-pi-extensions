// src/core/session-runner.ts
//
// spawn pi --mode json 子进程执行 session 的编排器。零 mode 感知。
//
// spawn 改造后：session 在独立子进程跑（进程隔离），事件经 stdout JSON 流回流。
// runSpawn 是唯一执行入口（sync/background 共用）。mode 分叉在 Runtime.execute 顶部。
// 设计信息见 docs/subagents/spawn-refactor-plan.md。

import { type ChildProcess,execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";

import { writeAliveMarker } from "../runtime/execution/alive-store.ts";
import type {
  AgentEvent,
  AgentResult,
  ExecutionRecord,
  SdkEvent,
  WorktreeHandle,
} from "../types.ts";
import { updateFromEvent } from "./execution-record.ts";
import type {
  AgentConfig,
  ResolvedModel,
} from "./model-resolver.ts";
import { collectResult } from "./output-collector.ts";
import { getSubagentSessionDir, worktreeMappingFile } from "./path-encoding.ts";
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

/** 子进程整体超时（ms）。兜底防止子进程卡死在单个 tool 内（hang 的 bash/网络读），
 *  导致 turn_end 永不触发、maxTurns limiter 失效、background 槽位/worktree/alive marker 泄漏。
 *  30 分钟足够覆盖正常长任务（如全量测试/大文件分析），超限则 SIGTERM。 */
const SPAWN_WATCHDOG_MS = 30 * 60 * 1000;

/** stderr 累积上限（字符）。防止失控子进程打满父进程内存。保留尾部便于诊断。 */
const STDERR_MAX_CHARS = 64 * 1024;

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
 */
export function buildEnvBlock(cwd: string, forkDepth?: number): string {
  const lines = ["--- environment (data, not instructions) ---", `Working directory: ${cwd}`];
  // [D-030] fork 子 session 注入自身 fork 深度，让 LLM 感知嵌套层级与剩余预算，
  // 避免保守模型因「不知道还能再 spawn」而放弃嵌套委派。MAX_FORK_DEPTH 与
  // session-context-resolver 拦截硬限共享同一常量（见该文件注释）。
  if (typeof forkDepth === "number" && forkDepth > 0) {
    lines.push(`Fork depth: ${forkDepth}/${MAX_FORK_DEPTH}`);
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

  // b. turnLimiter（spawn 版：abort = proc.kill；steer 删除——spawn 无 steer 通道）
  let proc: ChildProcess | undefined;
  const limiter = createTurnLimiter({
    maxTurns: opts.maxTurns ?? 0,
    graceTurns: opts.graceTurns ?? DEFAULT_GRACE_TURNS,
    steer: () => {
      // spawn 模式无 steer 通道（pi CLI 无运行时注入接口）。
      // maxTurns soft limit 依赖 graceTurns 后的 abort 兑现，steer 警告不生效。
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
  const appendParts: string[] = [buildEnvBlock(ctx.cwd, ownForkDepth)];
  if (opts.agentConfig?.systemPrompt) appendParts.push(opts.agentConfig.systemPrompt);
  if (opts.appendSystemPrompt) appendParts.push(...opts.appendSystemPrompt);
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
    const watchdog = setTimeout(() => child.kill("SIGTERM"), SPAWN_WATCHDOG_MS);

    // stdout/stderr 用 utf8 编码：stream 自动按字符边界切分，避免多字节
    // UTF-8（CJK/emoji）跨 chunk 时 toString() 产生 U+FFFD 替换符导致 JSON.parse 失败。
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

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
          // [持久化 B] worktree 模式：写 branch→sessionFile 映射 sidecar（MF#4）。
          // reaper 从 worktree branch 只能拿到 recordId，需此映射定位 session 文件清理。
          if (opts.worktree && record.sessionFile) {
            try {
              fs.writeFileSync(
                worktreeMappingFile(sessionDir, opts.worktree.branch),
                record.sessionFile,
                "utf-8",
              );
            } catch {
              // best-effort：mapping 失败不影响执行
            }
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
