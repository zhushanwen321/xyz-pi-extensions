// src/runtime/subagent-hub.ts
//
// 执行编排 + 记录 + 通知领域 Hub。"跑一次子代理 + 管理执行状态"。
//
// 与 ModelConfigHub（配置/模型解析域）正交——本 Hub 持有其引用但不暴露给外部。
// executor 逻辑已合并进本文件——它是 SubagentHub.execute 的编排逻辑，
// 没有独立状态/生命周期，不需要独立文件。合并后行为方法自然 private。
//
// 上游：subagent-tool（execute/query/cancel）、TUI（onChange/listRunning/collectRecords）。
// session_start 时经 initSession 注入 pi；modelRegistry/entries 归 ModelConfigHub.initModel。

import { type ConcurrencyPool,DefaultConcurrencyPool } from "../core/concurrency-pool.ts";
import {
  completeRecord,
  createRecord,
  project,
  snapshot,
  toPersisted,
  tryTransition,
} from "../core/execution-record.ts";
import type { AgentConfig } from "../core/model-resolver.ts";
import type { SdkLike } from "../core/session-factory.ts";
import { run, type SessionRunnerContext } from "../core/session-runner.ts";
import type {
  AgentEvent,
  AgentResult,
  ExecuteOptions,
  ExecutionHandle,
  ExecutionMode,
  ExecutionRecord,
  QueryResult,
  RecordSnapshot,
  ResolvedModel,
  SubagentRecord,
  SubagentToolDetails,
} from "../types.ts";
import { HistoryStore } from "./history-store.ts";
import type { ModelConfigHub } from "./model-config-hub.ts";
import type { BgNotifyRecord, NotifierHost } from "./notifier.ts";
import { BgNotifier } from "./notifier.ts";
import { RecordStore } from "./record-store.ts";

/** Pi ExtensionAPI 的最小接口（duck-typed）。 */
interface PiLike {
  appendEntry(customType: string, data?: unknown): void;
  events: { emit(channel: string, data: unknown): void };
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean },
  ): void;
}

/** Hub 构造参数（进程级）。 */
export interface SubagentHubInit {
  cwd: string;
  /** 配置/模型域 Hub（execute 内部调其 resolveModel）。 */
  modelHub: ModelConfigHub;
}

/** session_start 注入参数（session 级）。 */
export interface HubSessionInit {
  pi: PiLike;
  sessionId: string;
}

/** background 优先级（低，让步）；sync 优先级（高，抢占）。 */
const PRIORITY_BACKGROUND = 1000;
const PRIORITY_SYNC = 0;

/** 触发 onUpdate 的事件类型（streaming delta 不触发，避免每 token 刷新）。 */
const TRIGGERING_EVENT_TYPES = new Set<AgentEvent["type"]>([
  "tool_start",
  "tool_end",
  "turn_end",
  "message_end",
  "error",
  "compaction",
]);

/** resolveIdentity 的产物——一次确定、写入 record 后不再变。 */
interface ResolvedIdentity {
  agent: string;
  agentConfig: AgentConfig | undefined;
  resolved: ResolvedModel;
}

/**
 * 执行编排 Hub。进程级单例。
 *
 *   session_start:
 *     1. modelHub = getModelConfigHub() ?? new ModelConfigHub({homeDir, agentDir})
 *     2. hub = getHub() ?? new SubagentHub({cwd, modelHub})
 *     3. modelHub.initModel({modelRegistry, sessionId, entries})
 *     4. hub.initSession({pi, sessionId})
 *
 *   session_shutdown:
 *     hub.dispose()
 */
export class SubagentHub {
  private readonly pool: ConcurrencyPool;
  private readonly store: RecordStore;
  private readonly history: HistoryStore;
  private readonly notifier: BgNotifier;
  private readonly modelHub: ModelConfigHub;
  private readonly cwd: string;

  private pi: PiLike | null = null;
  private sdk: SdkLike | null = null;
  private _disposed = false;
  private _seq = 0;

  constructor(init: SubagentHubInit) {
    this.cwd = init.cwd;
    this.modelHub = init.modelHub;
    this.pool = new DefaultConcurrencyPool(this.modelHub.getGlobalConfig().maxConcurrent);
    this.history = new HistoryStore(this.modelHub.getAgentDir(), init.cwd);
    this.store = new RecordStore(this.history);
    this.notifier = new BgNotifier(this.piAdapter());
  }

  // ── 生命周期（index.ts 调）──────────────────────────────

  /** session_start 注入 pi + revive（modelRegistry/entries 归 ModelConfigHub.initModel）。 */
  initSession(init: HubSessionInit): void {
    this.pi = init.pi;
    // revive（dispose 的逆操作：/resume /fork /new 后复活）
    this._disposed = false;
    this.store.revive();
    this.notifier.revive();
  }

  /** session 结束清理（清定时器，丢弃 pending 通知）。幂等。 */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.notifier.flushPendingNotifications();
    this.store.dispose();
    this.notifier.dispose();
  }

  // ── 执行（subagent-tool 调）────────────────────────────

  /**
   * 预解析 model（renderCall 标题行用，同步）。
   * 代理 modelHub.resolveModel——renderCall 在 execute 前调用，但 model 解析是同步的，
   * 让标题行能提前显示 model/thinking，不必等 execute。
   * hub 未就绪时抛（调用方 catch 降级）。
   */
  resolveModel(
    agent: string,
    override?: { model?: string; thinkingLevel?: string },
  ): ResolvedModel {
    return this.modelHub.resolveModel(agent, override);
  }

  /**
   * 统一执行入口。sync/background 共用，mode 由 opts.wait + agentConfig.defaultBackground 判定。
   * 内部完成：mode 判定 → 确认（经回调）→ 模型解析 → 执行 → 收尾。
   *
   * mode 判定规则（内化在 Hub，不暴露给 tool 层）：
   *   wait === false → background（用户显式要求异步）
   *   wait === true → sync（用户显式要求同步）
   *   wait === undefined + agentConfig.defaultBackground === true → background
   *   否则 → sync
   */
  async execute(opts: ExecuteOptions): Promise<ExecutionHandle> {
    this.assertReady();

    // mode 判定（业务规则归 Hub，tool 层只传 wait 意图）
    const mode = this.resolveMode(opts);
    const ctx = await this.buildSessionRunnerContext();

    // ── 1. IDENTITY 解析（确认 → agentConfig → resolveModel）──
    const identity = await this.resolveIdentity(opts);

    // ── 2. RECORD 创建 + 注册 ──
    const record = this.createRecordForMode(identity, opts, mode);

    // ── 3. MODE 分叉：signal/priority（仅此 2 处即时差异）──
    const signal = mode === "background"
      ? record.controller!.signal
      : opts.signal;
    const priority = mode === "background" ? PRIORITY_BACKGROUND : PRIORITY_SYNC;

    // ── 4-7. sync 直接 await；background 包 detached 立即返回 id ──
    if (mode === "sync") {
      await this.runAndFinalize(record, opts, ctx, identity, signal, priority);
      return { mode: "sync", record: snapshot(record), details: project(record) };
    }

    // background：立即返回 backgroundId + 启动时的 details（status=running），
    // 步骤 4-6 在 detached promise 里跑。
    const bgDetails = project(record);
    bgDetails.backgroundId = record.id;
    this.kickOffBackground(record, opts, ctx, identity, signal, priority);
    return { mode: "background", backgroundId: record.id, details: bgDetails };
  }

  /** poll(backgroundId)：查 record 并投影为 QueryResult。不存在 throw。 */
  query(id: string): QueryResult {
    this.assertReady();
    const record = this.store.getMutable(id);
    if (!record) throw new Error(`No subagent record with id "${id}"`);
    return this.recordToQueryResult(record);
  }

  /** 取消 background record（tryTransition CAS 抢锁防重复副作用）。 */
  cancel(id: string): boolean {
    this.assertReady();
    const record = this.store.getMutable(id);
    if (!record) return false;
    return this.cancelBackground(record);
  }

  // ── 状态查询（TUI 调）──────────────────────────────────

  /** 订阅 store 变更（widget/list requestRender）。返回取消订阅。 */
  onChange(listener: () => void): () => void {
    return this.store.onChange(listener);
  }

  /** 列出 running record 快照（widget 计数用）。 */
  listRunning(): RecordSnapshot[] {
    return this.store.listRunning();
  }

  /** 合并四源 record（/subagents list 消费）。 */
  collectRecords(limit: number): SubagentRecord[] {
    return this.store.collectRecords(limit, this.modelHub.sessionId);
  }

  // ── 执行内部：mode 判定 + 身份解析 + record 创建 ──────────

  /** mode 业务规则：wait 显式 > agentConfig.defaultBackground > sync 兜底。 */
  private resolveMode(opts: ExecuteOptions): ExecutionMode {
    if (opts.wait === false) return "background";
    if (opts.wait === true) return "sync";
    // wait === undefined：看 agent 的 defaultBackground
    const agentConfig = this.modelHub.getAgentConfig(opts.agent);
    if (agentConfig?.defaultBackground === true) return "background";
    return "sync";
  }

  /** 步骤 1：身份解析。agentConfig → resolveModel。 */
  private async resolveIdentity(opts: ExecuteOptions): Promise<ResolvedIdentity> {
    // D-1：取消首次确认拦截——categoryConfirmed 默认 true，直接解析。
    // agent 名 + 配置
    const agent = opts.agent ?? "default";
    const agentConfig = this.modelHub.getAgentConfig(agent);

    // 模型解析（5 级 fallback）
    const resolved = this.modelHub.resolveModel(agent, {
      model: opts.model,
      thinkingLevel: opts.thinkingLevel,
    });

    return { agent, agentConfig, resolved };
  }

  /** 步骤 2：按 mode 生成 id + controller，创建 record 并注册。 */
  private createRecordForMode(
    identity: ResolvedIdentity,
    opts: ExecuteOptions,
    mode: ExecutionMode,
  ): ExecutionRecord {
    const seq = ++this._seq;
    const id = mode === "background"
      ? `bg-${seq}-${Date.now()}`
      : `run-${seq}`;
    const controller = mode === "background" ? new AbortController() : undefined;

    const record = createRecord(id, {
      agent: identity.agent,
      model: `${identity.resolved.model.provider}/${identity.resolved.model.id}`,
      thinkingLevel: identity.resolved.thinkingLevel,
      mode,
      task: opts.task,
      startedAt: Date.now(),
      controller,
    });

    this.store.register(record);
    return record;
  }

  // ── 执行内部：run + finalize（sync/bg 共用）──────────────

  /** 共享的"干活 + 收尾"——sync 直接 await，background 在 detached 里调。 */
  private async runAndFinalize(
    record: ExecutionRecord,
    opts: ExecuteOptions,
    ctx: SessionRunnerContext,
    identity: ResolvedIdentity,
    signal: AbortSignal | undefined,
    priority: number,
  ): Promise<AgentResult> {
    await this.pool.acquire(priority);
    // onEvent 包装：AgentEvent → onUpdate(project(record)) 回流调用方
    const onEvent = opts.onUpdate
      ? (event: AgentEvent): void => this.onEventThrottled(record, event, opts.onUpdate!)
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
      this.pool.release();
    }

    // status 唯一判定点：success ? done : (aborted ? cancelled : failed)
    const status: "done" | "failed" | "cancelled" = result.success
      ? "done"
      : signal?.aborted ? "cancelled" : "failed";

    // CAS 抢锁：抢到则完整收尾；没抢到（cancel 已先设 cancelled）则跳过
    if (tryTransition(record, status)) {
      await this.finalizeRecord(record, result, status);
    }
    return result;
  }

  /** background 的步骤 4-6：包进 detached promise（不 await），execute 立即返回。 */
  private kickOffBackground(
    record: ExecutionRecord,
    opts: ExecuteOptions,
    ctx: SessionRunnerContext,
    identity: ResolvedIdentity,
    signal: AbortSignal | undefined,
    priority: number,
  ): void {
    void this.runAndFinalize(record, opts, ctx, identity, signal, priority)
      .then(() => {
        // background 回注：仅当本路径抢到 CAS（status 已转 done/failed）才 notify。
        // cancel 抢先时 status=cancelled，cancelBackground 自己 notify，此处跳过。
        if (record.status !== "cancelled") {
          this.notifyComplete(record);
        }
      })
      .catch(() => {
        // detached 吞错：runAndFinalize 内部已 finalize record，不外抛
      });
  }

  /** 取消 background record。CAS 抢锁——抢到则 notify，不写 history。 */
  private cancelBackground(record: ExecutionRecord): boolean {
    record.controller?.abort();
    if (!tryTransition(record, "cancelled")) {
      return false; // detached 已 finalize，cancel 来晚了
    }
    // 抢到锁：completeRecord（用空 result 填 cancelled）+ notify。不走 finalizeRecord（cancel 不写 history）。
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
    this.notifyComplete(record);
    return true;
  }

  /** 收尾三件套：completeRecord + store.archive + history.append。 */
  private async finalizeRecord(
    record: ExecutionRecord,
    result: AgentResult,
    status: "done" | "failed" | "cancelled",
  ): Promise<void> {
    completeRecord(record, result, status);
    this.store.archive(record);
    await this.history.append(toPersisted(record, this.cwd));
  }

  /** background 完成回注（record → BgNotifyRecord 映射 + notifier.notify）。 */
  private notifyComplete(record: ExecutionRecord): void {
    this.notifier.notify(this.toNotifyRecord(record));
  }

  /** AgentEvent 节流回流到 onUpdate（streaming delta 不触发）。 */
  private onEventThrottled(
    record: ExecutionRecord,
    event: AgentEvent,
    onUpdate: (details: SubagentToolDetails) => void,
  ): void {
    if (TRIGGERING_EVENT_TYPES.has(event.type)) {
      onUpdate(project(record));
    }
  }

  // ── 内部 ────────────────────────────────────────────────

  /** 校验 Hub 就绪（pi 已注入 + 未 dispose）。 */
  private assertReady(): void {
    if (this.pi === null) {
      throw new Error("pi not injected (initSession not called?)");
    }
    if (this._disposed) {
      throw new Error("hub disposed");
    }
  }

  /** 构造 SessionRunnerContext。sdk lazy 获取 + 缓存。 */
  private async buildSessionRunnerContext(): Promise<SessionRunnerContext> {
    if (this.sdk === null) {
      const { getSdk } = await import("../core/session-factory.ts");
      this.sdk = await getSdk();
    }
    return {
      cwd: this.cwd,
      agentDir: this.modelHub.getAgentDir(),
      factoryCtx: {
        modelRegistry: this.modelHub.getModelRegistry(),
        resolveAgent: (name: string) => this.modelHub.getAgentConfig(name),
        cwd: this.cwd,
        agentDir: this.modelHub.getAgentDir(),
        skillDirs: this.modelHub.getDiscoverySkillDirs(),
      },
      sdk: this.sdk,
    };
  }

  /** notifier 的 NotifierHost 适配器（绑定到 pi.sendMessage + store 查询）。 */
  private piAdapter(): NotifierHost {
    return {
      sendMessage: (message, options) => {
        // deliverAs:"followUp" 让完成通知在当前 streaming turn 结束后唤醒父 agent
        // （不打断正在的工具调用）；triggerTurn:true 空闲时直接 prompt 新 turn。
        this.pi?.sendMessage(message, options);
      },
      hasRunningBackground: () => {
        // 有 running 的 background record → 滑动窗口继续等；否则立即 flush
        return this.store.listRunning().some((r) => r.mode === "background");
      },
    };
  }

  /** ExecutionRecord → QueryResult（poll 返回的只读视图）。 */
  private recordToQueryResult(record: ExecutionRecord): QueryResult {
    const snap = snapshot(record);
    const details = project(record);
    return {
      id: snap.id,
      status: snap.status,
      agent: snap.agent,
      model: snap.model,
      thinkingLevel: snap.thinkingLevel,
      turns: snap.turns,
      totalTokens: snap.totalTokens,
      startedAt: snap.startedAt,
      endedAt: snap.endedAt,
      elapsedSeconds: details.elapsedSeconds,
      result: snap.result,
      error: snap.error,
      eventLog: [...snap.eventLog],
      mode: snap.mode,
    };
  }

  /** record → BgNotifyRecord（notifier.notify 入参映射，内部不外露）。 */
  private toNotifyRecord(record: ExecutionRecord): BgNotifyRecord {
    const snap = snapshot(record);
    return {
      id: snap.id,
      status: snap.status as "done" | "failed" | "cancelled",
      agent: snap.agent,
      result: snap.result,
      error: snap.error,
      startedAt: snap.startedAt,
      endedAt: snap.endedAt,
    };
  }
}

// ============================================================
// 进程单例访问器（session_start 重建）
// ============================================================

// 用 globalThis[Symbol.for] 持有进程单例，避免 jiti 因路径字符串不同加载多份模块
// 导致单例分裂。场景：其它扩展 import "@zhushanwen/pi-subagents" 与本扩展被 Pi host
// 直接加载，若 jiti 缓存 key 用路径字符串（非 realpath），两份 subagent-hub.ts 各持
// 一个 _hub，setHub 写 A、getHub 读 B(null)。globalThis 跨所有模块实例共享，彻底消除。
// 详见 docs/pi-extension-standards.md §7.5。
const HUB_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.hub");

type HubSlot = { current: SubagentHub | null };

function getHubSlot(): HubSlot {
  const record = globalThis as unknown as Record<symbol, unknown>;
  if (!record[HUB_SLOT_KEY]) record[HUB_SLOT_KEY] = { current: null };
  return record[HUB_SLOT_KEY] as HubSlot;
}

/** 获取进程单例。session_start 前为 null。 */
export function getHub(): SubagentHub | null {
  return getHubSlot().current;
}

/** 设置进程单例（session_start 首次创建时）。 */
export function setHub(hub: SubagentHub): void {
  getHubSlot().current = hub;
}
