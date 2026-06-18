// src/runtime/executor.ts
//
// 统一执行入口。sync/background 的唯一分叉点集中在此函数顶部，
// SessionRunner.run 完全不感知 mode。
//
// 这是旧实现 runAgent + startBackground 两份重复逻辑的收敛点：
//   - state 创建/更新：唯一在 SessionRunner（通过 record）
//   - history 写入：唯一在此函数完成阶段（抢到 CAS 的一方）
//   - aborted → status 判定：唯一在此函数（经 tryTransition CAS 抢锁）
//   - 仅 4 处真正的 mode 差异（见下方框图）

import {
  completeRecord,
  createRecord,
  project,
  snapshot,
  tryTransition,
} from "../core/execution-record.ts";
import type { AgentConfig } from "../core/model-resolver.ts";
import { run, type SessionRunnerContext } from "../core/session-runner.ts";
import type {
  AgentEvent,
  AgentResult,
  ExecuteOptions,
  ExecutionHandle,
  ExecutionRecord,
  ResolvedModel,
  SubagentToolDetails,
} from "../types.ts";
import type { ConfirmCategoryCallback, ModelConfigHub } from "./model-config-hub.ts";
import type { SubagentHub } from "./subagent-hub.ts";

/** sync linger 时间（completed map 保留时长）。 */
const SYNC_LINGER_MS = 5000;

/** background FIFO 上限（绝不淘汰 running）。 */
const BG_FIFO_MAX = 50;

/** background 优先级（低，让步）；sync 优先级（高，抢占）。 */
const PRIORITY_BACKGROUND = 1000;
const PRIORITY_SYNC = 0;

// ============================================================
// 统一执行入口
// ============================================================

/**
 * 统一执行入口。被 SubagentHub.execute 委托调用。
 *
 *   ╔════════════════════════════════════════════════════════════════════╗
//   ║  EXECUTE(opts, ctx):                                                ║
//   ║                                                                     ║
//   ║  ── 1. IDENTITY 解析（一次确定）────────────────────────────────── ║
//   ║     resolveIdentity(opts, runtime) → { agent, model, thinkingLevel, ║
//   ║                                        agentConfig, resolved }      ║
//   ║       写入 record，不再变                                           ║
//   ║                                                                     ║
//   ║  ── 2. RECORD 创建 + 注册 ─────────────────────────────── ║
//   ║     createRecordForMode(identity, opts, runtime)                    ║
//   ║       → createRecord + store.register                               ║
//   ║                                                                     ║
//   ║  ── 3. MODE 分叉（仅此 4 处差异）──────────────────────────────── ║
//   ║     ┌─────────────────────┬────────────────────────┐               ║
//   ║     │ sync                │ background              │               ║
//   ║     ├─────────────────────┼────────────────────────┤               ║
//   ║     │ signal = opts.signal│ signal = ctrl.signal    │ ◄── 差异④     ║
//   ║     │ priority = 0        │ priority = 1000         │ ◄── 差异②     ║
//   ║     │ 调用方 await        │ 立即返回 backgroundId    │ ◄── 差异①     ║
//   ║     │ 无 notifier         │ notifier.notify(record) │ ◄── 差异③     ║
//   ║     └─────────────────────┴────────────────────────┘               ║
//   ║     ★ 其余完全共用 ★                                               ║
//   ║                                                                     ║
//   ║  ── 4/5. 执行 + 收尾（共用 runAndFinalize）───────────────────── ║
//   ║     pool.acquire → run → tryTransition CAS 抢锁 → completeRecord   ║
//   ║     → store.archive → history.append                                ║
//   ║                                                                     ║
//   ║  ── 6. BACKGROUND 回注（差异③）──────────────────────────────── ║
//   ║     if (mode==="background") notifier.notify(snapshot(record))      ║
//   ║                                                                     ║
//   ║  ── 7. 返回 ──────────────────────────────────────────────────── ║
//   ║     sync: { mode:"sync", record: snapshot(record) }                 ║
//   ║     bg:   { mode:"background", backgroundId: record.id }            ║
//   ╚════════════════════════════════════════════════════════════════════╝
 *
 * background 的 detached：sync 走 await，background 把步骤 4-6 包进
 * detached promise（kickOffBackground）不 await，步骤 7 立即返回 handle。
 * cancel 与 detached 的收尾竞争经 tryTransition CAS 抢锁（见 execution-flow.md §4）。
 */
export async function execute(
  opts: ExecuteOptions,
  hub: SubagentHub,
  modelHub: ModelConfigHub,
  ctx: SessionRunnerContext,
): Promise<ExecutionHandle> {
  // ── 1. IDENTITY 解析（一次确定，写入 record 不再变）──
  // 确认（经 opts.onConfirmCategory 回调）在 resolveIdentity 内部编排
  const identity = await resolveIdentity(opts, modelHub);

  // ── 2. RECORD 创建 + 注册（id 生成 + controller + createRecord + register）──
  const record = createRecordForMode(identity, opts, hub);

  // ── 3. MODE 分叉：signal/priority（仅此 2 处即时差异，返回/通知差异在 6/7）──
  const signal = opts.mode === "background"
    ? record.controller!.signal
    : opts.signal;
  const priority = opts.mode === "background" ? PRIORITY_BACKGROUND : PRIORITY_SYNC;

  // ── 4-7. 分叉：sync 直接 await；background 包 detached 立即返回 id ──
  if (opts.mode === "sync") {
    await runAndFinalize(record, opts, hub, ctx, identity, signal, priority);
    // 7. sync 返回完整 record（调用方一直在 await）
    return { mode: "sync", record: snapshot(record) };
  }

  // background：立即返回 backgroundId，步骤 4-6 在 detached promise 里跑
  kickOffBackground(record, opts, hub, ctx, identity, signal, priority);
  return { mode: "background", backgroundId: record.id };
}

// ============================================================
// 步骤 1：身份解析（叶子）
// ============================================================

/** resolveIdentity 的产物——一次确定、写入 record 后不再变。 */
export interface ResolvedIdentity {
  agent: string;
  agentConfig: AgentConfig | undefined;
  resolved: ResolvedModel;
}

/**
 * 步骤 1：身份解析。确认（经回调）→ agentConfig → resolveModel。
 *   1. await modelHub.ensureConfirmed(opts.onConfirmCategory)（首次确认拦截）
 *   2. agent = opts.agent ?? "default"
 *   3. agentConfig = modelHub.getAgentConfig(agent)
 *   4. resolved = modelHub.resolveModel(agent, { model, thinkingLevel })
 *   5. !resolved → throw（让调用方决定）
 *
 * 注意：第 4 轮实现。当前为骨架——保留签名供 execute 调用链编译。
 */
async function resolveIdentity(opts: ExecuteOptions, modelHub: ModelConfigHub): Promise<ResolvedIdentity> {
  // 1. 首次 category 确认（已确认则跳过；无回调则 headless 跳过）
  await modelHub.ensureConfirmed(
    opts.onConfirmCategory
      ? ((input) => opts.onConfirmCategory!(input)) as ConfirmCategoryCallback
      : undefined,
  );

  // 2. agent 名 + 配置
  const agent = opts.agent ?? "default";
  const agentConfig = modelHub.getAgentConfig(agent);

  // 3. 模型解析（5 级 fallback，含确认后的 sessionState）
  const resolved = modelHub.resolveModel(agent, {
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
  });

  return { agent, agentConfig, resolved };
}

// ============================================================
// 步骤 2：record 创建（叶子）
// ============================================================

/**
 * 步骤 2：按 mode 生成 id + controller，创建 record 并注册到 store。
 *   - id: background → `bg-${seq}-${ts}`；sync → `run-${seq}`
 *   - controller: background → new AbortController()；sync → undefined
 *   - createRecord(identity + mode + controller) + store.register
 */
let _seq = 0;

function createRecordForMode(
  identity: ResolvedIdentity,
  opts: ExecuteOptions,
  hub: SubagentHub,
): ExecutionRecord {
  const seq = ++_seq;
  const id = opts.mode === "background"
    ? `bg-${seq}-${Date.now()}`
    : `run-${seq}`;
  const controller = opts.mode === "background" ? new AbortController() : undefined;

  const record = createRecord(id, {
    agent: identity.agent,
    model: identity.resolved.model.id,
    thinkingLevel: identity.resolved.thinkingLevel,
    mode: opts.mode,
    task: opts.task,
    startedAt: Date.now(),
    controller,
  });

  hub.registerRecord(record);
  return record;
}

// ============================================================
// 步骤 4-5：执行 + 收尾（sync/background 共用）
// ============================================================

/**
 * 共享的"干活 + 收尾"——sync 直接 await，background 在 detached 里调。
 *
 *   ╔══════════════════════════════════════════════════════════════╗
//   ║  1. pool.acquire(priority)   ← 抢并发槽（finally 必释放）      ║
//   ║  2. result = await run(record, task, { resolved, agentConfig,  ║
//   ║       appendSystemPrompt, skillPath, schema, maxTurns,         ║
//   ║       graceTurns, signal, onEvent }, ctx)                      ║
//   ║  3. status = result.success ? "done"                           ║
//   ║       : (signal.aborted ? "cancelled" : "failed")              ║
//   ║  4. tryTransition(record, status)  ← CAS 抢锁                  ║
//   ║       抢到 → completeRecord + archive + history.append          ║
//   ║       没抢到 → cancel 已抢先（status=cancelled），跳过          ║
//   ║  finally: pool.release()                                       ║
//   ╚══════════════════════════════════════════════════════════════╝
 *
 * status 判定唯一在此（收敛旧实现 4 处分散判定，见 execution-flow.md §5）。
 */
async function runAndFinalize(
  record: ExecutionRecord,
  opts: ExecuteOptions,
  hub: SubagentHub,
  ctx: SessionRunnerContext,
  identity: ResolvedIdentity,
  signal: AbortSignal | undefined,
  priority: number,
): Promise<AgentResult> {
  await hub.acquireSlot(priority);
  // onEvent 包装：把 AgentEvent 转成 onUpdate(project(record)) 回流调用方（节流在叶子）。
  // run() 内部已调 updateFromEvent(record, event)，这里投影后回调 widget/render。
  const onEvent = opts.onUpdate
    ? (event: AgentEvent): void => { onEventThrottled(record, event, opts.onUpdate!); }
    : undefined;

  let result: AgentResult;
  try {
    result = await run(record, opts.task, {
      resolved: identity.resolved,
      agentConfig: identity.agentConfig,
      appendSystemPrompt: opts.appendSystemPrompt,
      skillPath: opts.skillPath,
      schema: opts.schema,
      maxTurns: opts.maxTurns,
      graceTurns: opts.graceTurns,
      signal,
      onEvent,
    }, ctx);
  } finally {
    hub.releaseSlot();
  }

  // status 唯一判定点：success ? done : (aborted ? cancelled : failed)
  const status: "done" | "failed" | "cancelled" = result.success
    ? "done"
    : signal?.aborted ? "cancelled" : "failed";

  // CAS 抢锁：抢到则经 hub.finalizeRecord 收尾（completeRecord + archive + history）；
  // 没抢到（cancel 已先设 cancelled）则跳过
  if (tryTransition(record, status)) {
    await hub.finalizeRecord(record, result, status);
  }
  return result;
}

// ============================================================
// background detached 包装
// ============================================================

/**
 * background 的步骤 4-6：包进 detached promise（不 await），execute 立即返回。
 * 完成后 notifier.notify 回注主对话（差异③）。错误不外抛（detached 吞掉，
 * record 已被 runAndFinalize 内部 finalize 为 failed）。
 */
function kickOffBackground(
  record: ExecutionRecord,
  opts: ExecuteOptions,
  hub: SubagentHub,
  ctx: SessionRunnerContext,
  identity: ResolvedIdentity,
  signal: AbortSignal | undefined,
  priority: number,
): void {
  //  detached（不 await）：runAndFinalize → 若抢到 CAS 则 notify
  //  .catch 吞错（runAndFinalize 内部已 finalize，这里只防 detached rejection 外溢）
  void runAndFinalize(record, opts, hub, ctx, identity, signal, priority)
    .then(() => {
      // 6. background 回注：仅当本路径抢到 CAS（status 已转 done/failed）才 notify。
      // cancel 抢先时 status=cancelled，cancelBackground 自己 notify，此处跳过。
      if (record.status !== "cancelled") {
        hub.notifyComplete(record);
      }
    })
    .catch(() => {
      // detached 吞错：runAndFinalize 内部已 finalize record，不外抛
    });
  void SYNC_LINGER_MS; void BG_FIFO_MAX;
}

// ============================================================
// 取消（仅 background）
// ============================================================

/**
 * 取消 background record。hub 持有 controller（经 record），可真正 abort。
 * 经 tryTransition CAS 抢锁——抢到则 notify（用户意图），不写 history。
 * 抢不到（detached 已先 finalize 为 done/failed）则什么都不做。
 */
export function cancelBackground(record: ExecutionRecord, hub: SubagentHub): boolean {
  // 1. controller.abort()——发取消信号，run() 内部 session 会停下
  record.controller?.abort();
  // 2. CAS 抢锁：只有 running 能转 cancelled
  if (!tryTransition(record, "cancelled")) {
    return false; // detached 已 finalize，cancel 来晚了，不重复副作用
  }
  // 3. 抢到锁：completeRecord（用空 result 填 cancelled）+ notify。
  //    cancel 直接调 completeRecord（不走 hub.finalizeRecord——cancel 不写 history，finalizeRecord 会写）。
  //    notify 经 hub.notifyComplete（record→BgNotifyRecord 映射内化在 hub）。
  const cancelledResult: AgentResult = {
    text: "",
    turns: record.turns,
    durationMs: 0,
    success: false,
    error: "cancelled by user",
    sessionId: record.id,
    toolCalls: [],
  };
  completeRecord(record, cancelledResult, "cancelled");
  hub.notifyComplete(record);
  return true;
}

// ============================================================
// 内部 helper
// ============================================================

/**
 * 把 AgentEvent 节流回流到 onUpdate（widget/render 刷新）。
 *   - text_delta/thinking_delta：只累积不触发（避免 streaming 每 token 拉回底部）
 *   - tool_start/tool_end/turn_end/message_end/error：触发 project(record) → onUpdate
 * 节流逻辑参考旧实现 shouldTriggerUpdate（execution-state.ts）。
 */
const TRIGGERING_EVENT_TYPES = new Set<AgentEvent["type"]>([
  "tool_start",
  "tool_end",
  "turn_end",
  "message_end",
  "error",
  "compaction",
]);

function onEventThrottled(
  record: ExecutionRecord,
  event: AgentEvent,
  onUpdate: (details: SubagentToolDetails) => void,
): void {
  // text_delta/thinking_delta 只累积不触发（streaming 每 token 不拉回）
  if (TRIGGERING_EVENT_TYPES.has(event.type)) {
    onUpdate(project(record));
  }
}
