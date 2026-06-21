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
/**
 * collectRecords 的取数下限。includeFinished=false 时先取够多再过滤 running，
 * 避免「limit=5 但前 5 条全 done → running 全被过滤掉」。
 * includeFinished=true 时 collect 上限即 limit。
 */
const MIN_COLLECT_FOR_FILTER = 100;

/** 毫秒/秒换算（duration 实时计算用）。 */
const MS_PER_SECOND = 1000;

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
 * list session 作用域（诚实声明 G3-003）：
 * collectRecords(limit) 由 service 内部按 modelService.sessionId 过滤 history 源；
 * 内存源（live/completed/bg）天然跨 session 可见——/new /resume /fork 后可能残留
 * 前 session 的 record（通常很少，多为刚 cancel 的 background）。
 * 不新增 sessionId 到 ExecutionRecord（YAGNI，修跨 session 清理是独立问题）。
 */

/** SubagentRecord → SubagentListItem（8 字段，duration 实时计算）。 */
function recordToListItem(r: SubagentRecord): SubagentListItem {
  const end = r.endedAt ?? Date.now();
  const duration = Math.max(0, Math.floor((end - r.startedAt) / MS_PER_SECOND));
  return {
    subagentId: r.id,
    agent: r.agent,
    status: r.status,
    mode: r.mode,
    duration,
    model: r.model,
    totalTokens: r.totalTokens,
    sessionFile: r.sessionFile,
  };
}

/** 把内层 SubagentToolDetails（sync streaming）包成外层 SubagentToolResult（onUpdate 回流用）。 */
function liftSync(details: SubagentToolDetails): SubagentToolResult {
  return {
    action: "start",
    // streaming 期 subagentId 未知，终态由 adapter 填；此处给 null 保持类型合法。
    subagentId: null,
    sessionFile: details.sessionFile ?? null,
    syncResponse: {
      status: details.status,
      mode: "sync",
      agent: details.agent,
      model: details.model,
      thinkingLevel: details.thinkingLevel,
      turns: details.turns,
      totalTokens: details.totalTokens,
      elapsedSeconds: details.elapsedSeconds,
      eventLog: details.eventLog,
      currentActivity: details.currentActivity,
      result: details.result,
      error: details.error,
      parsedOutput: details.parsedOutput,
      sessionFile: details.sessionFile,
    },
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
  const d = handle.details;
  return {
    kind: "sync",
    subagentId: handle.record.id,
    sessionFile: d.sessionFile,
    response: {
      status: d.status,
      mode: "sync",
      agent: d.agent,
      model: d.model,
      thinkingLevel: d.thinkingLevel,
      turns: d.turns,
      totalTokens: d.totalTokens,
      elapsedSeconds: d.elapsedSeconds,
      eventLog: d.eventLog,
      currentActivity: d.currentActivity,
      result: d.result,
      error: d.error,
      parsedOutput: d.parsedOutput,
      sessionFile: d.sessionFile,
    },
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

  // collectRecords 合并四源（service 内部已按 sessionId 过滤 history 源），
  // 按 status priority + startedAt desc 排好序。
  // includeFinished=false 时先多取再过滤 running（避免 limit 截断把 running 滤没）。
  const collectLimit = includeFinished ? limit : MIN_COLLECT_FOR_FILTER;
  const all = service.collectRecords(collectLimit);
  const filtered = includeFinished ? all : all.filter((r) => r.status === "running");
  const items: SubagentListItem[] = filtered.slice(0, limit).map(recordToListItem);
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

  // step 1: id 不存在（findRecord 查内存三源，不查 history）
  const rec = service.findRecord(id);
  if (!rec) throw new Error(`No subagent record with id "${id}"`);
  // step 2: mode 非 background（sync record controller 为 undefined，不可 cancel）
  if (rec.mode !== "background") {
    throw new Error("Cannot cancel sync subagent (only background can be cancelled)");
  }
  // step 3: service.cancel boolean（list-view 契约不变）；false = 已终态（CAS 抢锁失败）
  if (!service.cancel(id)) {
    throw new Error(`Subagent ${id} already finished (status: ${rec.status})`);
  }
  return { subagentId: id, response: { cancelled: true } };
}

// ============================================================
// adapter（领域对象 → SubagentToolResult + {content, details}）
// ============================================================

export function adapter(
  action: "start" | "list" | "cancel",
  domain: StartHandlerResult | ListHandlerResult | CancelHandlerResult,
): AgentToolResult<SubagentToolResult> {
  let result: SubagentToolResult;
  if (action === "start") {
    const d = domain as StartHandlerResult;
    result = d.kind === "sync"
      ? { action, subagentId: d.subagentId, sessionFile: d.sessionFile ?? null, syncResponse: d.response }
      : { action, subagentId: d.subagentId, sessionFile: d.sessionFile ?? null, bgResponse: d.response };
  } else if (action === "list") {
    const d = domain as ListHandlerResult;
    result = { action, subagentId: null, sessionFile: null, listResponse: d.response };
  } else {
    const d = domain as CancelHandlerResult;
    result = { action, subagentId: d.subagentId, sessionFile: null, cancelResponse: d.response };
  }

  // content JSON：LLM 看的结构化结果（schema 模式 parsedOutput 作为嵌套 JSON 值可接受）。
  const text = JSON.stringify(result);
  return {
    content: [{ type: "text", text }],
    details: result,
  };
}
