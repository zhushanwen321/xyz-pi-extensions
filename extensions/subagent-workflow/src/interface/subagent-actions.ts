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
import {
  guiComponent,
  type GuiContext,
  guiResult,
  isGuiCapable,
} from "@xyz-agent/extension-protocol";

import { SLUG_MAX_LENGTH } from "../execution/execute-options-mapper.ts";
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
import { mapRunIcon, mapRunStatus } from "./gui-mappers.ts";

// ============================================================
// 常量
// ============================================================

/** list 默认 limit。 */
const DEFAULT_LIST_LIMIT = 20;
/** list limit 上限。 */
const MAX_LIST_LIMIT = 100;

/** background 启动提示文案（spec FR-3 bgResponse.message）。 */
const BG_MESSAGE = "detached, will notify on completion (auto-injected message, do not poll)";

/** subagentId（UUID）在 GUI header 的截断显示长度。 */
const SUBAGENT_ID_PREVIEW = 8;

// ============================================================
// 入参 / 出参类型
// ============================================================

/** start 入参（从 tool params.startParam 来，task + slug 必填）。 */
export interface StartHandlerInput {
  task?: string;
  /** 短标签（≤20 字符），必填。 */
  slug?: string;
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
  /** 短标签，来自 record（handle.details.slug）。用于 result 行展示。 */
  slug: string;
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
    slug: r.slug,
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
  // slug 必填 + 空白校验 + 长度校验（≤ SLUG_MAX_LENGTH 字符）
  const slug = input.slug?.trim();
  if (!slug) throw new Error("startParam.slug is required (and must not be whitespace-only)");
  if (slug.length > SLUG_MAX_LENGTH) throw new Error(`startParam.slug must be ≤${SLUG_MAX_LENGTH} chars (got ${slug.length}). Shorten to a kebab-case label, e.g. "fix-login", "extract-urls".`);

  const handle = await service.execute({
    task,
    slug,
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
    slug: handle.details.slug,
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
  if (!rec) throw new Error(`No subagent record with id "${id}". It may have finished — use action:'list' with includeFinished:true to verify.`);
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
    result = { action, subagentId: d.subagentId, sessionFile: d.sessionFile ?? null, slug: d.slug, bgResponse: d.response };
  } else if (action === "list") {
    result = { action, subagentId: null, sessionFile: null, listResponse: input.domain.response };
  } else {
    result = { action, subagentId: input.domain.subagentId, sessionFile: null, cancelResponse: input.domain.response };
  }

  // content JSON：LLM 看的结构化结果（schema 模式 parsedOutput 作为嵌套 JSON 值可接受）。
  const text = JSON.stringify(result);

  // GUI 协议：RPC 模式下附加结构化渲染数据（union 各成员已声明 __gui__?，无需强转）
  const details: SubagentToolResult = ctx && isGuiCapable(ctx)
    ? { ...result, __gui__: guiResult(buildGuiComponent(action, input, result)) }
    : result;

  // [W3 修复] list action 追加 reminder text block：LLM 调 list 时提醒不要轮询。
  // reminder 作为第二个 text block（独立追加，不污染 details/JSON schema）。
  // 只有 list 触发——start 的 reminder 已在 BG_MESSAGE 里；cancel 无需。
  const reminder = action === "list"
    ? "\n\nReminder: Subagent completion is auto-notified via injected message (deliverAs: steer). Do NOT poll in a loop — there is no poll action. Use action:'list' only when you concretely need state, then continue working or stop."
    : "";

  return {
    content: [{ type: "text", text }, { type: "text", text: reminder }],
    details,
  };
}

/** 按 action 构造对应的 GuiComponent。 */
export function buildGuiComponent(
  action: string,
  input: AdapterInput,
  _result: SubagentToolResult,
) {
  if (action === "start") {
    // subagent-trace 多层语义（agent名+slug+状态）用 card(stats-line) 组合表达。
    // 利用 input.domain 的身份信息，让并发 subagent 可区分。
    const d = input.domain as StartHandlerResult;
    return guiComponent("card", {
      header: d.slug ? `${d.slug}` : d.subagentId.slice(0, SUBAGENT_ID_PREVIEW),
      body: [guiComponent("stats-line", {
        items: [{ value: "running", severity: "ok" }],
      })],
    });
  }
  if (action === "list") {
    const listResp = input.domain as ListHandlerResult;
    return guiComponent("list-tree", {
      items: listResp.response.items.map((it) => ({
        label: it.slug ? `${it.agent} · ${it.slug} · ${it.subagentId}` : `${it.agent} · ${it.subagentId}`,
        status: mapRunStatus(it.status),
        icon: mapRunIcon(it.status),
      })),
    });
  }
  // cancel
  return guiComponent("stats-line", {
    items: [{ label: "cancelled", value: (input.domain as CancelHandlerResult).subagentId, severity: "warn" }],
  });
}
