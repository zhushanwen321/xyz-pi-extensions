// src/core/session-reconstructor.ts
//
// 从 subagent 的 session.jsonl 重建完整的 SubagentRecord 数据。
//
// 背景：subagent 执行时 SDK 把完整对话（assistant text/thinking/toolCall + usage +
// toolResult）实时 flush 进 session.jsonl。终态后内存 record 被立即淘汰（archive），
// collectRecords 读时用本模块从 session.jsonl 重建 turns[]，恢复 eventLog/result/error
// 等富数据——session.jsonl 是唯一 source of truth（history.jsonl 已废弃）。
//
// 身份恢复：session.jsonl 的 header 不含 ExecutionRecord.id / agent / mode，故
// session-runner 在创建 session 后立即写一条 custom entry（customType:"subagent-identity"）
// 携带 {id, agent, mode, task, startedAt}。本模块读这条 entry 恢复身份。
//
// 纯函数 + 防御性 I/O：任何文件缺失/损坏/格式漂移/缺 identity entry 均返回 undefined
// （不抛），消费方降级跳过该 record 而非崩溃。与 execution-record.ts 同层（Core 纯数据变换）。
//
// 直接读文件 + 逐行 JSON.parse（session.jsonl = newline-delimited JSON），不依赖 SDK
// SessionManager 类——避免 tsconfig paths fallback 把 class 降级为 interface 的坑。

import * as fs from "node:fs";

import type {
  AgentEventLogEntry,
  AgentUsage,
  ExecutionMode,
  ExecutionStatus,
  InternalToolCall,
  Turn,
} from "../types.ts";
import { extractLabelFromArgs } from "./execution-record.ts";

// ============================================================
// 类型（SDK jsonl 结构的最小子集——窄化为重建所需字段）
// ============================================================

/** assistant message 的 usage（pi-ai Usage 的最小消费字段）。 */
interface JsonlUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

/** assistant content block 联合（text/thinking/toolCall——重建只消费这三类）。 */
interface TextBlock { type: "text"; text: string; }
interface ThinkingBlock { type: "thinking"; thinking: string; }
interface ToolCallBlock { type: "toolCall"; id: string; name: string; arguments?: unknown; }
type AssistantContentBlock = TextBlock | ThinkingBlock | ToolCallBlock;

/** assistant message（pi-ai AssistantMessage 的最小消费字段）。 */
interface JsonlAssistantMessage {
  role: "assistant";
  content: AssistantContentBlock[];
  usage?: JsonlUsage;
  stopReason?: string;
  errorMessage?: string;
  timestamp: number;
}

/** toolResult message（pi-ai ToolResultMessage 的最小消费字段）。 */
interface JsonlToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content?: unknown[];
  details?: unknown;
  isError?: boolean;
  timestamp: number;
}

/** user message（重建 turns[] 时跳过，仅用于类型穷尽）。 */
interface JsonlUserMessage {
  role: "user";
  content: unknown;
  timestamp: number;
}

type JsonlMessage = JsonlUserMessage | JsonlAssistantMessage | JsonlToolResultMessage;

/** custom entry 的 data（session-runner 写入的 subagent-identity）。 */
export interface SubagentIdentityData {
  id: string;
  agent: string;
  mode: ExecutionMode;
  task: string;
  startedAt: number;
  /** 根 Pi session ID（session 隔离过滤用）。旧文件可能缺失。 */
  rootSessionId?: string;
  /** 直接父 subagent record ID。旧文件缺失 → undefined（顶层）。 */
  parentRecordId?: string;
  /** subagent 递归深度。旧文件缺失 → 0（顶层）。 */
  depth?: number;
  /** [MF#4] 本 session 的 fork 深度（session-runner 写入 parentForkDepth+1）。旧文件可能缺失。 */
  forkDepth?: number;
  /** @deprecated 兼容旧文件：旧 identity entry 写的是 parentSessionId，读取时 fallback 到 rootSessionId。 */
  parentSessionId?: string;
}

/** SDK jsonl entry（getEntries() 返回，header 已排除）。 */
interface JsonlEntry {
  type: string;
  message?: JsonlMessage;
  customType?: string;
  data?: unknown;
  /** model_change entry 的字段。 */
  provider?: string;
  modelId?: string;
  /** thinking_level_change entry 的字段。 */
  thinkingLevel?: string;
  /** entry 级别的时间戳（ISO 字符串，SDK 逐行写入）。供 endedAt 推导。 */
  timestamp?: string;
}

// ============================================================
// 公开类型
// ============================================================

/** custom entry 的 customType 标识（session-runner 写 / reconstructor 读，约定常量）。 */
export const IDENTITY_CUSTOM_TYPE = "subagent-identity";

/** 重建产出的完整 SubagentRecord 数据（身份 + 可变状态 + 派生 eventLog）。 */
export interface ReconstructedRecord {
  // ── 身份（来自 custom entry）──
  id: string;
  agent: string;
  mode: ExecutionMode;
  task: string;
  startedAt: number;
  /** 根 Pi session ID（session 隔离过滤用）。旧文件可能缺失。 */
  rootSessionId: string | undefined;
  /** 直接父 subagent record ID。旧文件缺失 → undefined（顶层）。 */
  parentRecordId: string | undefined;
  /** subagent 递归深度。旧文件缺失 → 0（顶层）。 */
  depth: number;
  /** [MF#4] 本 session 的 fork 深度（来自 identity custom entry；旧文件为 undefined）。 */
  forkDepth: number | undefined;
  sessionFile: string;
  // ── 可变状态（来自 message entries）──
  status: ExecutionStatus;
  turns: Turn[];
  turnCount: number;
  totalTokens: number;
  lastError: string | undefined;
  model: string;
  thinkingLevel: string | undefined;
  /** 最后一条 entry 的时间戳（ms）。供 finalize/crashed 重建填 endedAt，避免耗时无限增长。 */
  endedAt: number | undefined;
  /** 各 turn text 拼接的完整正文（镜像 getFullText）。 */
  result: string | undefined;
  /** 来自最后一条 error/aborted assistant message（无则 undefined）。 */
  error: string | undefined;
  /** 从 turns[] 派生的离散语义事件序列（与活态 record 同形）。 */
  eventLog: AgentEventLogEntry[];
}

// ============================================================
// 内部 helper
// ============================================================

/** turn_end 摘要截断长度（镜像 execution-record.ts TURN_SUMMARY_MAX）。 */
const TURN_SUMMARY_MAX = 80;

/** 从 turns[] 派生 eventLog（镜像 execution-record.ts getEventLog，但接受最小结构）。 */
function deriveEventLog(
  turns: Turn[],
  lastError: string | undefined,
  startedAt: number,
): AgentEventLogEntry[] {
  const log: AgentEventLogEntry[] = [];
  for (const turn of turns) {
    for (const tc of turn.toolCalls) {
      const label = extractLabelFromArgs(tc.toolName, tc.args);
      const ts = tc.startedTs;
      log.push({ type: "tool_start", label, ts, status: "running" });
      if (tc._status !== "running") {
        log.push({ type: "tool_end", label, ts, status: tc._status });
      }
    }
    if (turn.closed) {
      const summary = turn.text.length > 0
        ? (turn.text.length > TURN_SUMMARY_MAX ? turn.text.slice(0, TURN_SUMMARY_MAX) : turn.text)
        : "turn";
      log.push({ type: "turn_end", label: summary, ts: turn.closedTs ?? startedAt });
    }
  }
  if (lastError) {
    log.push({ type: "error", label: lastError, ts: Date.now() });
  }
  return log;
}

/** 空 turn（镜像 execution-record.ts 的 emptyTurn，但本模块独立——避免循环依赖）。 */
function emptyTurn(): Turn {
  return { text: "", thinking: "", toolCalls: [], usageDelta: undefined, closed: false };
}

/** JsonlUsage → AgentUsage（cost 取 cost.total，与 session-runner 扁平化一致）。 */
function toAgentUsage(u: JsonlUsage): AgentUsage {
  return {
    input: u.input ?? 0,
    output: u.output ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    cost: u.cost?.total,
  };
}

/** 累加 AgentUsage（field-wise，镜像 execution-record.ts addUsage）。 */
function addUsage(prev: AgentUsage | undefined, next: AgentUsage): AgentUsage {
  if (prev === undefined) return { ...next };
  return {
    input: prev.input + next.input,
    output: prev.output + next.output,
    cacheRead: prev.cacheRead + next.cacheRead,
    cacheWrite: prev.cacheWrite + next.cacheWrite,
    cost: (prev.cost ?? 0) + (next.cost ?? 0),
  };
}

/** 校验 custom entry data 是否为合法 SubagentIdentityData。 */
function isIdentityData(data: unknown): data is SubagentIdentityData {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.agent === "string" &&
    (d.mode === "sync" || d.mode === "background") &&
    typeof d.task === "string" &&
    typeof d.startedAt === "number"
  );
}/**
 * 待匹配的 toolCall（assistant 发起，等 toolResult 回填）。
 * 记录在 assistant Turn 上，toolResult 到达时按 toolCallId 找到并填充。
 */
interface PendingToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
  /** 所属 Turn（toolResult 回填时推进这个 Turn 的 toolCalls）。 */
  turn: Turn;
  /** assistant message timestamp（作为 InternalToolCall.startedTs）。 */
  startedTs: number;
}

// ============================================================
// 公开函数
// ============================================================

/**
 * 从 session.jsonl 重建完整 SubagentRecord 数据。
 *
 *   ╔══════════════════════════════════════════════════════════════════╗
 *   ║  1. readFileSync(sessionFile) + 逐行 JSON.parse（跳 header）       ║
 *   ║     （损坏行静默跳过；失败 → undefined）                           ║
 *   ║  2. 扫 custom entry（customType:"subagent-identity"）→ 身份        ║
 *   ║     缺 identity → undefined（无法构造 record）                     ║
 *   ║  3. 顺序遍历 message entries：                                    ║
 *   ║     - role:"assistant" → 开新 Turn                                ║
 *   ║       text/thinking 累积；usage → usageDelta                      ║
 *   ║       toolCall block → 待匹配队列；stopReason error → lastError  ║
 *   ║     - role:"toolResult" → 配对 toolCallId                         ║
 *   ║       产 InternalToolCall(done/failed)推进请求 Turn              ║
 *   ║  4. 闭合所有 turn；算 turnCount/totalTokens/result/eventLog       ║
 *   ╚══════════════════════════════════════════════════════════════════╝
 *
 * 返回 undefined：文件缺失/空/损坏/缺 identity entry/无 assistant message。
 * 不抛——消费方（collectRecords）降级跳过该 record。
 *
 * status 由最后一条 assistant message 的 stopReason 推导（error/aborted → failed，
 * 其余 → done）。cancelled 由 tombstone override（record-store 层），本函数不感知。
 */
export function reconstructFromFile(sessionFile: string): ReconstructedRecord | undefined {
  // 读文件 + 逐行 JSON.parse（session.jsonl = newline-delimited JSON）。
  // 第 1 行是 session header（跳过）；后续每行一个 entry。
  // 损坏行静默跳过（与 SDK parseSessionEntries 行为一致）。
  let raw: string;
  try {
    raw = fs.readFileSync(sessionFile, "utf-8");
  } catch {
    return undefined; // 文件缺失 → 降级。
  }

  const entries: JsonlEntry[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    if (i === 0) {
      // 第 1 行是 session header（type:"session"），跳过。
      try {
        const head = JSON.parse(line) as JsonlEntry;
        if (head.type === "session") continue;
      } catch (_e) {
        void _e; // 首行损坏 → 跳过，继续解析后续。
        continue;
      }
    }
    try {
      const parsed = JSON.parse(line) as JsonlEntry;
      if (parsed && typeof parsed.type === "string") {
        entries.push(parsed);
      }
    } catch (_e) {
      void _e; // 损坏行跳过（不阻断后续行）。
    }
  }

  if (entries.length === 0) return undefined;

  // ── 扫身份 custom entry（必须存在，否则无法构造 record）──
  let identity: SubagentIdentityData | undefined;
  let model = "";
  let thinkingLevel: string | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === IDENTITY_CUSTOM_TYPE) {
      if (isIdentityData(entry.data)) identity = entry.data;
    } else if (entry.type === "model_change") {
      // model_change: {provider, modelId} → "provider/modelId"（与 record.model 同形）。
      if (typeof entry.provider === "string" && typeof entry.modelId === "string") {
        model = `${entry.provider}/${entry.modelId}`;
      }
    } else if (entry.type === "thinking_level_change") {
      if (typeof entry.thinkingLevel === "string") thinkingLevel = entry.thinkingLevel;
    }
  }
  if (!identity) return undefined; // 缺身份 → 无法构造 record。

  // ── 重建 turns[] ──
  const turns: Turn[] = [];
  const pending: PendingToolCall[] = [];
  let lastError: string | undefined;
  let totalTokens = 0;
  /** 最后一条 assistant message 的 stopReason（推导终态 status）。 */
  let lastStopReason: string | undefined;
  /** 最后一条 entry 的时间戳（ms），推导 endedAt（避免重建 record 耗时随墙钟无限增长）。 */
  let lastEntryTsMs: number | undefined;

  for (const entry of entries) {
    // entry 级别 timestamp（ISO）→ ms。优先用 entry 级别（每条都有），message.timestamp 作兼底。
    if (typeof entry.timestamp === "string") {
      const ms = Date.parse(entry.timestamp);
      if (!Number.isNaN(ms)) lastEntryTsMs = ms;
    }
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;
    if (typeof msg.timestamp === "number") {
      lastEntryTsMs = msg.timestamp;
    }

    if (msg.role === "assistant") {
      const turn = emptyTurn();
      turns.push(turn);

      for (const block of msg.content) {
        if (block.type === "text") {
          turn.text += block.text;
        } else if (block.type === "thinking") {
          turn.thinking += block.thinking;
        } else if (block.type === "toolCall") {
          pending.push({
            toolCallId: block.id,
            toolName: block.name,
            args: block.arguments,
            turn,
            startedTs: msg.timestamp,
          });
        }
      }

      if (msg.usage) {
        const u = toAgentUsage(msg.usage);
        turn.usageDelta = addUsage(turn.usageDelta, u);
        totalTokens += u.input + u.output + u.cacheRead + u.cacheWrite;
      }

      // stopReason 驱动 lastError（与 updateFromEvent 一致）：
      // error/aborted → 设 lastError；stop（正常结束）→ 清 lastError（镜像 turn_end 的清除语义，
      // 即前序 turn 的瞬态 error 在后续成功 turn 后恢复，不误判 success=false）。
      lastStopReason = msg.stopReason;
      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        lastError = msg.errorMessage ?? msg.stopReason;
      } else if (msg.stopReason === "stop") {
        lastError = undefined;
      }
    } else if (msg.role === "toolResult") {
      const idx = pending.findIndex((p) => p.toolCallId === msg.toolCallId);
      if (idx >= 0) {
        const p = pending[idx];
        pending.splice(idx, 1);
        const tc: InternalToolCall = {
          toolName: p.toolName,
          args: p.args,
          result: { content: msg.content, details: msg.details },
          isError: msg.isError ?? false,
          _status: msg.isError ? "failed" : "done",
          startedTs: p.startedTs,
        };
        p.turn.toolCalls.push(tc);
      }
      // 未配对（孤儿 toolResult）→ 丢弃。
    }
    // role:"user" → 跳过（task 来自 identity custom entry）。
  }

  if (turns.length === 0) return undefined; // 无 assistant message → 空壳，降级。

  // 闭合所有 turn（重建的是历史，全是已完成 turn）。
  for (const turn of turns) {
    turn.closed = true;
  }

  const turnCount = turns.length;
  const resultText = turns
    .map((t) => t.text)
    .filter((t) => t.length > 0)
    .join("\n\n");

  // eventLog 从 turns[] 派生（与活态 record 的 getEventLog 同形，消费方无感知差异）。
  const eventLog = deriveEventLog(turns, lastError, identity.startedAt);

  // 终态 status：最后一条 assistant message 的 stopReason 推导（与 finalizeRecord 的判定一致）。
  // error/aborted → failed；其余（stop/toolUse/length）→ done。
  // cancelled 由 tombstone override（record-store 层），本函数不感知。
  const status: ExecutionStatus =
    lastStopReason === "error" || lastStopReason === "aborted" ? "failed" : "done";

  // rootSessionId 归一化：新文件读 rootSessionId，旧文件 fallback parentSessionId。
  const rootSessionId = identity.rootSessionId ?? identity.parentSessionId;
  return {
    ...identity,
    rootSessionId,
    parentRecordId: identity.parentRecordId,
    depth: identity.depth ?? 0,
    forkDepth: identity.forkDepth,
    sessionFile,
    status,
    turns,
    turnCount,
    totalTokens,
    lastError,
    model,
    thinkingLevel,
    endedAt: lastEntryTsMs,
    result: resultText.length > 0 ? resultText : undefined,
    error: lastError,
    eventLog,
  };
}
