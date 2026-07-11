// src/interface/subagent-actions.ts
//
// subagent tool 的内部 handler + 唯一 adapter。
//
// 分层（spec FR-2）：
//   1. startHandler / listHandler / cancelHandler —— 纯领域对象进出，不碰 {content, details}
//   2. adapter(action, 领域对象) —— 唯一包装为 AgentToolResult<SubagentToolResult>
//
// content（JSON 字符串）给 LLM，details（SubagentToolResult）给 renderResult，同源同处生成。

import type { AgentToolResult } from "@mariozechner/pi-coding-agent";

import { computeElapsedSeconds } from "../execution/execution-record.ts";
import type { ModelInfo } from "../execution/model-resolver.ts";
import type { SubagentService } from "../execution/subagent-service.ts";
import type {
  BgResponse,
  CancelResponse,
  ListResponse,
  SubagentListItem,
  SubagentRecord,
  SubagentToolResult,
} from "../execution/types.ts";
import {
  guiComponent,
  type GuiContext,
  guiResult,
  isGuiCapable,
} from "./gui-adapter.ts";

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
  model?: string;
  thinkingLevel?: string;
  skillPath?: string;
  appendSystemPrompt?: string[];
  schema?: Record<string, unknown>;
  maxTurns?: number;
  graceTurns?: number;
  /** fork 模式：继承主 session 上下文（D-018 两级降级）。 */
  fork?: boolean;
  /** worktree 模式：文件系统隔离运行（D-008 tmpdir）。 */
  worktree?: boolean;
  /** 覆盖子 agent 工作目录（默认 mainCwd）。 */
  cwd?: string;
}

/** start 领域对象（adapter 包成 bgResponse）。 */
export type StartHandlerResult = {
  kind: "bg";
  subagentId: string;
  sessionFile: string | undefined;
  response: BgResponse;
};

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

// ============================================================
// start handler
// ============================================================

export async function startHandler(
  service: SubagentService,
  input: StartHandlerInput | undefined,
  signal: AbortSignal | undefined,
  ctxModel?: ModelInfo,
): Promise<StartHandlerResult> {
  if (!input) throw new Error("startParam is required for action:'start'");
  // task 必填 + 空白校验（G-008）
  const task = input.task?.trim();
  if (!task) throw new Error("startParam.task is required (and must not be whitespace-only)");

  const handle = await service.execute({
    task,
    agent: input.agent,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    skillPath: input.skillPath,
    appendSystemPrompt: input.appendSystemPrompt,
    schema: input.schema,
    maxTurns: input.maxTurns,
    graceTurns: input.graceTurns,
    fork: input.fork,
    worktree: input.worktree,
    cwd: input.cwd,
    ctxModel,
    signal,
    // background 不回流 onUpdate：detached 运行，完成由 notify 驱动新 turn。
    onUpdate: undefined,
  });

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
  // step 2: controller 检查（controller 为 undefined 表示 record 已终态或未启动）
  if (rec.mode !== "background") {
    throw new Error(`Cannot cancel subagent ${id} (unsupported mode: ${rec.mode})`);
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

export function adapter(
  input: AdapterInput,
  ctx?: GuiContext,
): AgentToolResult<SubagentToolResult> {
  const { action } = input;
  let result: SubagentToolResult;
  if (action === "start") {
    const d = input.domain;
    result = { action, subagentId: d.subagentId, sessionFile: d.sessionFile ?? null, bgResponse: d.response };
  } else if (action === "list") {
    result = { action, subagentId: null, sessionFile: null, listResponse: input.domain.response };
  } else {
    result = { action, subagentId: input.domain.subagentId, sessionFile: null, cancelResponse: input.domain.response };
  }

  // content JSON：LLM 看的结构化结果（schema 模式 parsedOutput 作为嵌套 JSON 值可接受）。
  const text = JSON.stringify(result);

  // GUI 协议：RPC 模式下附加结构化渲染数据
  const details: Record<string, unknown> = { ...result };
  if (ctx && isGuiCapable(ctx)) {
    details.__gui__ = guiResult(buildGuiComponent(action, input, result));
  }

  return {
    content: [{ type: "text", text }],
    details: details as unknown as SubagentToolResult,
  };
}

/** 按 action 构造对应的 GuiComponent。 */
function buildGuiComponent(
  action: string,
  input: AdapterInput,
  _result: SubagentToolResult,
) {
  if (action === "start") {
    return guiComponent("subagent-trace", {
      agent: "subagent",
      status: "running" as const,
    });
  }
  if (action === "list") {
    const listResp = input.domain as ListHandlerResult;
    return guiComponent("task-list", {
      title: `Subagents (${listResp.response.running} running)`,
      items: listResp.response.items.map((it) => ({
        label: `${it.agent} · ${it.subagentId}`,
        status: it.status === "running" ? "in_progress" as const
          : it.status === "done" ? "completed" as const
          : it.status === "failed" ? "failed" as const
          : "pending" as const,
      })),
      summary: `${listResp.response.running}/${listResp.response.items.length} running`,
    });
  }
  // cancel
  return guiComponent("stats-line", {
    items: [{ label: "cancelled", value: (input.domain as CancelHandlerResult).subagentId, severity: "warn" }],
  });
}
