// src/tools/subagent-actions.ts
//
// subagent tool 的内部 handler + 唯一 adapter。
//
// 分层（spec FR-2）：
//   1. startHandler / listHandler / cancelHandler —— 纯领域对象进出，不碰 {content, details}
//   2. adapter(action, 领域对象) —— 唯一包装为 AgentToolResult<SubagentToolResult>
//
// content（JSON 字符串）给 LLM，details（SubagentToolResult）给 renderResult，同源同处生成。

import type { AgentToolResult } from "@mariozechner/pi-coding-agent";

import { computeElapsedSeconds } from "../core/execution-record.ts";
import type { ModelInfo } from "../core/model-resolver.ts";
import type { SubagentService } from "../runtime/subagent-service.ts";
import type {
  BgResponse,
  CancelResponse,
  ListResponse,
  SubagentListItem,
  SubagentRecord,
  SubagentToolDetails,
  SubagentToolResult,
  SyncResponse,
} from "../types.ts";

// ============================================================
// 常量
// ============================================================

/** list 默认 limit。 */
const DEFAULT_LIST_LIMIT = 20;
/** list limit 上限。 */
const MAX_LIST_LIMIT = 100;

/** background 启动提示文案（spec FR-3 bgResponse.message）。 */
const BG_MESSAGE = "detached, will notify on completion";

// ============================================================
// 入参 / 出参类型
// ============================================================

/** start 入参（从 tool params.startParam 来，task 必填）。 */
export interface StartHandlerInput {
  task?: string;
  agent?: string;
  wait?: boolean;
  model?: string;
  thinkingLevel?: string;
  skillPath?: string;
  appendSystemPrompt?: string[];
  schema?: Record<string, unknown>;
  maxTurns?: number;
  graceTurns?: number;
}

/** start 领域对象（adapter 包成 syncResponse 或 bgResponse）。 */
export type StartHandlerResult =
  | { kind: "sync"; subagentId: string; sessionFile: string | undefined; response: SyncResponse }
  | { kind: "bg"; subagentId: string; sessionFile: string | undefined; response: BgResponse };

export interface ListHandlerInput {
  includeFinished?: boolean;
  limit?: number;
}

/** list 领域对象（adapter 包成 listResponse，最外层 subagentId/sessionFile 为 null）。 */
export interface ListHandlerResult {
  response: ListResponse;
}

export interface CancelHandlerInput {
  subagentId?: string;
}

/** cancel 领域对象（adapter 包成 cancelResponse）。 */
export interface CancelHandlerResult {
  subagentId: string;
  response: CancelResponse;
}

// ============================================================
// helpers（模块内）
// ============================================================

/**
 * list 数据源（诚实声明 G3-003）：
 * collectRecords(limit, statusFilter) 合并内存(running) + 磁盘(sessions/*.jsonl 重建)。
 * 磁盘源天然跨 session 可见——/new /resume /fork 后前 session 的终态 record 仍在
 * sessions 目录里（直到 30 天 GC）。内存源仅当前 session 的 running record。
 * 不新增 sessionId 到 ExecutionRecord（YAGNI，修跨 session 清理是独立问题）。
 */

/** SubagentRecord → SubagentListItem（8 字段，duration 实时计算）。 */
function recordToListItem(r: SubagentRecord): SubagentListItem {
  return {
    subagentId: r.id,
    agent: r.agent,
    status: r.status,
    mode: r.mode,
    duration: computeElapsedSeconds(r),
    model: r.model,
    totalTokens: r.totalTokens,
    sessionFile: r.sessionFile,
  };
}

/**
 * 把内层 SubagentToolDetails（sync 路径）包成外层 SubagentToolResult（onUpdate 回流用）。
 *
 * SyncResponse 是 SubagentToolDetails 的子类型（mode 收窄为字面量 "sync"）。
 * 调用方保证此函数只在 sync 路径调用——details.mode 运行时必为 "sync"。
 * 字段无搬运（结构兼容，直接透传）。
 */
function liftSync(details: SubagentToolDetails): SubagentToolResult {
  return {
    action: "start",
    // streaming 期 subagentId 未知，终态由 adapter 填；此处给 null 保持类型合法。
    subagentId: null,
    sessionFile: details.sessionFile ?? null,
    // details 已由 sync 路径产出（mode==="sync"），结构兼容 SyncResponse。
    syncResponse: details as SyncResponse,
  };
}

// ============================================================
// start handler
// ============================================================

export async function startHandler(
  service: SubagentService,
  input: StartHandlerInput | undefined,
  signal: AbortSignal | undefined,
  onUpdate?: (partialResult: AgentToolResult<SubagentToolResult>) => void,
  ctxModel?: ModelInfo,
): Promise<StartHandlerResult> {
  if (!input) throw new Error("startParam is required for action:'start'");
  // task 必填 + 空白校验（G-008）
  const task = input.task?.trim();
  if (!task) throw new Error("startParam.task is required (and must not be whitespace-only)");

  const handle = await service.execute({
    task,
    agent: input.agent,
    wait: input.wait,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    skillPath: input.skillPath,
    appendSystemPrompt: input.appendSystemPrompt,
    schema: input.schema,
    maxTurns: input.maxTurns,
    graceTurns: input.graceTurns,
    ctxModel,
    signal,
    onUpdate: onUpdate
      // sync streaming 回流：把 project 产出的内层 SubagentToolDetails 包成 SubagentToolResult
      // （与 renderResult 同源）。background 不回流（execute return 后无 onUpdate）。
      ? (details) => {
          onUpdate({
            content: [{ type: "text", text: details.result ?? "" }],
            details: liftSync(details),
          });
        }
      : undefined,
  });

  if (handle.mode === "background") {
    return {
      kind: "bg",
      subagentId: handle.subagentId,
      sessionFile: handle.sessionFile,
      response: {
        status: "running",
        mode: "background",
        message: BG_MESSAGE,
      },
    };
  }

  // sync 完成：record 已 settled，details 含 mode/sessionFile/elapsedSeconds。
  // SyncResponse 是 SubagentToolDetails 的子类型（mode==="sync"）；sync 路径产出保证。
  return {
    kind: "sync",
    subagentId: handle.record.id,
    sessionFile: handle.details.sessionFile,
    response: handle.details as SyncResponse,
  };
}

// ============================================================
// list handler
// ============================================================

export function listHandler(
  service: SubagentService,
  input: ListHandlerInput | undefined,
): ListHandlerResult {
  const includeFinished = input?.includeFinished === true;
  // limit 夹紧：默认 20，范围 [1, 100]
  const rawLimit = input?.limit ?? DEFAULT_LIST_LIMIT;
  const limit = Math.max(1, Math.min(rawLimit, MAX_LIST_LIMIT));

  // collectRecords 是 service 核心能力：statusFilter 决定 running-only 还是全部。
  // 防截断（先多取再过滤）已下沉到 store 层——这里直接传 limit + filter。
  const filter = includeFinished ? "all" : "running";
  const all = service.collectRecords(limit, filter);
  const items: SubagentListItem[] = all.map(recordToListItem);
  const running = items.filter((i) => i.status === "running").length;

  return { response: { running, items } };
}

// ============================================================
// cancel handler
// ============================================================

export async function cancelHandler(
  service: SubagentService,
  input: CancelHandlerInput | undefined,
): Promise<CancelHandlerResult> {
  const id = input?.subagentId?.trim();
  if (!id) throw new Error("cancelParam.subagentId is required for action:'cancel'");

  // step 1: id 不存在（findRecord 只查内存 running record，不从 session.jsonl 重建）
  const rec = service.findRecord(id);
  if (!rec) throw new Error(`No subagent record with id "${id}"`);
  // step 2: mode 非 background（sync record controller 为 undefined，不可 cancel）
  if (rec.mode !== "background") {
    throw new Error("Cannot cancel sync subagent (only background can be cancelled)");
  }
  // step 3: service.cancel boolean（list-view 契约不变）；false = 已终态（CAS 抢锁失败）。
  // 注意：不嵌入 rec.status——findRecord 快照可能已过期（TOCTOU：cancel 期间 detached
  // 路径 CAS 到 done/failed）。重新查当前状态，避免「status: running」与「already finished」矛盾。
  if (!service.cancel(id)) {
    // CAS 失败 = record 在 cancel 期间被 detached 路径 finalize（done/failed）。
    // re-query 查当前真实状态。终态 record 被 archive 立即移出内存，
    // 诚实报告 "unknown (evicted from memory)" 而非回落到可能过期的 rec.status（BL-3）。
    const now = service.findRecord(id);
    const statusDesc = now ? now.status : "unknown (evicted from memory)";
    throw new Error(`Subagent ${id} could not be cancelled (it likely just finished; status: ${statusDesc})`);
  }
  return { subagentId: id, response: { cancelled: true } };
}

// ============================================================
// adapter（领域对象 → SubagentToolResult + {content, details}）
// ============================================================

/**
 * action ↔ domain 配对的承重类型（替代三处松散 `as`）。
 * 调用方必须传匹配的 {action, domain}——TS 在调用点校验，错配编译报错。
 */
type AdapterInput =
  | { action: "start"; domain: StartHandlerResult }
  | { action: "list"; domain: ListHandlerResult }
  | { action: "cancel"; domain: CancelHandlerResult };

export function adapter(input: AdapterInput): AgentToolResult<SubagentToolResult> {
  const { action } = input;
  let result: SubagentToolResult;
  if (action === "start") {
    const d = input.domain;
    result = d.kind === "sync"
      ? { action, subagentId: d.subagentId, sessionFile: d.sessionFile ?? null, syncResponse: d.response }
      : { action, subagentId: d.subagentId, sessionFile: d.sessionFile ?? null, bgResponse: d.response };
  } else if (action === "list") {
    result = { action, subagentId: null, sessionFile: null, listResponse: input.domain.response };
  } else {
    result = { action, subagentId: input.domain.subagentId, sessionFile: null, cancelResponse: input.domain.response };
  }

  // content JSON：LLM 看的结构化结果（schema 模式 parsedOutput 作为嵌套 JSON 值可接受）。
  const text = JSON.stringify(result);
  return {
    content: [{ type: "text", text }],
    details: result,
  };
}
