// src/runtime.ts
import * as path from "node:path";

import { loadGlobalConfig, saveGlobalConfig } from "./config/global-config.ts";
import { BgNotifier, type BgNotifyRecord } from "./persistence/bg-notifier.ts";
import { runAgent, type RunAgentContext } from "./core/run-agent.ts";
import { createManagedSession } from "./core/session.ts";
import { inferCategory } from "./category.ts";
import { HistoryStore, buildPersistedRecord } from "./persistence/history-store.ts";
import { DefaultConcurrencyPool } from "./pool/concurrency-pool.ts";
import { AgentRegistry } from "./registry/agent-registry.ts";
import { BuiltinAgentRegistry } from "./registry/builtin-agents.ts";
import { type ModelRegistryLike,resolveModelForAgent } from "./resolution/model-resolver.ts";
import { createSessionModelState, restoreState, serializeState, setAgentModel, setCategoryModel } from "./state/session-model-state.ts";
import {
  type AgentExecutionState,
  completeState,
  createExecutionState,
  executionStateToDetails,
  shouldTriggerUpdate,
  updateStateFromEvent,
} from "./state/execution-state.ts";
import {
  type AgentConfig,
  type AgentEvent,
  type AgentEventLogEntry,
  type AgentResult,
  type BackgroundHandle,
  type BackgroundOptions,
  type BackgroundStatus,
  type CategoryDefinition,
  COMPLETED_AGENTS_MAX,
  type CompletedAgentRecord,
  type ConcurrencyPool,
  type ManagedSession,
  type ManagedSessionOptions,
  type RunAgentOptions,
  type SessionModelState,
  type SubagentHooks,
  type SubagentsGlobalConfig,
  type ResolvedModel,
} from "./types.ts";
import { createThrottle } from "./utils/throttle.ts";
import type { SubagentToolDetails } from "./tui/subagent-render.ts";
export { setRuntime, getRuntime } from "./runtime-slot.ts"; // 单例访问器拆至 runtime-slot.ts（避免本文件超 1000 行上限）

/** Pi ExtensionAPI 的最小接口（duck-typed，用于 appendEntry / events.emit / sendMessage） */
interface PiLike {
  appendEntry(customType: string, data?: unknown): void;
  events: { emit(channel: string, data: unknown): void };
  /** FR-O1.1: 注入消息到主对话并可选触发新 turn（details 透传给 renderer）。 */
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "followUp" | "steer" | "nextTurn" },
  ): void;
}

/** background id 的时间戳进制（base36 紧凑表示） */
const BG_ID_RADIX = 36;
/**
 * widget 摘要截断长度（完成时 result.text 的预览截断）。
 * 注意：与 EVENT_LOG_LABEL_MAX（types.ts，eventLog label 截断）值相同但语义不同——
 * 前者截断最终结果文本预览，后者截断流式 eventLog 条目。有意不复用。
 */
// Wave 5: WIDGET_SUMMARY_MAX 删除（widgetState.summary 不再使用）
/** widget 完成状态淡出延迟（ms） */
const WIDGET_LINGER_MS = 5000;
/** FR-O1.3: background 完成通知去重 TTL 已移至 BgNotifier */
/** FR-O5.9: BgRecord 容量上限（FIFO 淘汰） */
const BG_RECORDS_MAX = 50;

/** 进程内单例持有的 background 记录（含 AbortController 供 cancel）。
 *
 * Wave 1 重构：BgRecord 不再有独立的 eventLog/agent/turns/totalTokens 字段——
 * 全部委托给内嵌的 AgentExecutionState（唯一状态源）。
 * status/startedAt/endedAt/result/error 仍保留在 BgRecord 上，因为
 * .then/.catch/notifyBgCompletion/buildPersistedRecord 直接读这些字段；
 * 它们与 state 的同名字段保持同步（completeState 写 state，BgRecord 镜像）。
 *
 * getBackground() 返回时从 state 展平 turns/totalTokens/model/thinkingLevel/eventLog。
 */
interface BgRecord {
  readonly id: string;
  /** 内嵌统一状态对象（唯一状态源） */
  state: AgentExecutionState;
  /** 完成时的 AgentResult（也存于 state.agentResult，这里保留供 getBackground 展平） */
  result?: AgentResult;
  /** 失败原因（也存于 state.error） */
  error?: string;
  /** 启动时间（也存于 state.startedAt，这里保留供 getBackground 展平） */
  startedAt: number;
  /** 结束时间（也存于 state.endedAt） */
  endedAt?: number;
  /** BgRecord 级状态（与 state.status 同步，供 getBackground/cancelBackground 读） */
  status: BackgroundStatus["status"];
  controller?: AbortController;
  /** Must-fix #2: set by cancelBackground to signal user-initiated cancellation.
   *  .then/.catch check this to skip completion side effects (onComplete/events/
   *  history) for an already-settled cancellation, preventing double-trigger. */
  _settled?: boolean;
}

/**
 * FR-11.5: SubagentRuntime 单例。组合所有能力。
 * 创建时不含 modelRegistry / pi（骨架），session_start 时注入。
 */
export class SubagentRuntime {
  globalConfig: SubagentsGlobalConfig;
  readonly sessionState: SessionModelState;
  readonly globalPool: ConcurrencyPool;
  readonly agentRegistry: AgentRegistry;
  readonly builtinRegistry: BuiltinAgentRegistry;
  private readonly hooks: SubagentHooks[] = [];

  private modelRegistry: ModelRegistryLike | null = null;
  private pi: PiLike | null = null;
  private homeDir: string;
  private cwd: string;
  private agentDir: string;

  /** Background 任务记录表（const 持有，避免模块级 let 触发 check-structure） */
  private readonly _bgRecords = new Map<string, BgRecord>();
  private _bgSeq = 0;
  private _widgetSeq = 0;

  /** FR-O1.5: background 完成通知器（合并窗口 + 去重 + 发送） */
  private _bgNotifier: BgNotifier = new BgNotifier(null);
  /** P2: dispose 后拒绝新的通知（防止 stale pi 调用） */
  private _disposed = false;

  /** FR-3.4: 事件总线，供 overlay 视图订阅实时刷新 */
  private readonly _changeListeners = new Set<() => void>();

  /** Must-fix #1: pending sync-agent linger timers. Cleared on dispose() to
   *  prevent stale-pi notifyChange/archiveSyncAgent calls after session_shutdown
   *  (overlay listeners may hold invalidated Pi handles). Timers are unref'd so
   *  they don't keep the event loop alive. */
  private readonly _lingerTimers = new Set<ReturnType<typeof setTimeout>>();

  /** FR-3.0: 已完成 sync agent 归档记录 */
  private readonly _completedAgents = new Map<string, CompletedAgentRecord>();

  /** ADR-024 L1: 执行记录持久化（跨进程历史） */
  private readonly _history: HistoryStore;

  /** FR-3.1 G-017: 活跃 overlay 句柄（防叠加） */
  private _activeView: { close: () => void } | null = null;

  /** FR-2.0: running agent 状态 map（Wave 4: 统一为 AgentExecutionState） */
  private readonly _runningAgents = new Map<string, AgentExecutionState>();

  /** 当前 session id（/subagents list 按此过滤 history；session_start 时注入） */
  private _sessionId?: string;

  constructor(opts: { cwd: string; homeDir: string; agentDir: string }) {
    this.cwd = opts.cwd;
    this.homeDir = opts.homeDir;
    this.agentDir = opts.agentDir;
    this.globalConfig = loadGlobalConfig(opts.homeDir);
    this.sessionState = createSessionModelState(this.globalConfig.yoloByDefault);
    this.globalPool = new DefaultConcurrencyPool(this.globalConfig.maxConcurrent);
    this.agentRegistry = new AgentRegistry(opts.cwd, opts.homeDir);
    this.builtinRegistry = new BuiltinAgentRegistry();
    this._history = new HistoryStore(opts.homeDir, opts.cwd);
  }

  /** session_start 复用 existing runtime 时重读磁盘 config.json，避免内存停留旧值。 */
  reloadGlobalConfig(): void {
    this.globalConfig = loadGlobalConfig(this.homeDir);
  }

  /** FR-11.5: session_start 时注入 modelRegistry，触发 agent 发现。
   * fail-fast：若注入 null/undefined，立即抛错而非延迟到首次 runAgent。 */
  injectModelRegistry(registry: ModelRegistryLike): void {
    if (!registry) {
      throw new Error(
        "SubagentRuntime.injectModelRegistry: registry is null/undefined — " +
        "check that session_start handler reads ctx.modelRegistry (not event.modelRegistry).",
      );
    }
    this.modelRegistry = registry;
    this.agentRegistry.discoverAll(this.builtinRegistry);
  }

  /** session_start 时注入 pi（用于 appendEntry 持久化 + events.emit 跨扩展通知） */
  injectPi(pi: PiLike): void {
    if (!pi) {
      throw new Error("SubagentRuntime.injectPi: pi is null/undefined.");
    }
    this.pi = pi;
    // Wave 5: 重建 BgNotifier（持有 pi 引用）
    this._bgNotifier.dispose();
    this._bgNotifier = new BgNotifier(pi);
  }

  /** session_start 时注入当前 session id（/resume /fork /new 时更新）。
   *  用于 listHistory 过滤 + buildPersistedRecord 写入。 */
  setSessionId(sessionId: string): void {
    this._sessionId = sessionId;
  }

  /** FR-2.0: 暴露给 /subagents list 的 running agent 快照（替代 widget.listAgents） */
  listRunningAgents(): AgentExecutionState[] {
    return [...this._runningAgents.values()];
  }

  /** FR-3.4: 订阅 runtime 数据变更（overlay 视图用） */
  onChange(fn: () => void): () => void {
    this._changeListeners.add(fn);
    return () => this._changeListeners.delete(fn);
  }

  /** FR-3.4: 通知所有订阅者 */
  notifyChange(): void {
    for (const fn of this._changeListeners) fn();
  }

  /** FR-3.0: 列出已归档的 sync agent */
  listCompleted(): CompletedAgentRecord[] {
    return [...this._completedAgents.values()];
  }

  /** ADR-024 L1: 读取跨进程执行记录（新→旧），按当前 sessionId 过滤 */
  listHistory(limit?: number): import("./types.ts").PersistedAgentRecord[] {
    return limit ? this._history.recent(limit, this._sessionId) : this._history.read(this._sessionId).reverse();
  }

  /** FR-3.0: 归档 sync agent（widget linger 到期时调用） */
  archiveSyncAgent(record: CompletedAgentRecord): void {
    if (this._completedAgents.size >= COMPLETED_AGENTS_MAX) {
      const firstKey = this._completedAgents.keys().next().value;
      if (firstKey !== undefined) this._completedAgents.delete(firstKey);
    }
    // Round 5 SUG#2: 同 id 重复 archive 时先 delete 再 set，让 Map 把它移到队尾——
    // 否则原插入位置保留，下次淘汰会把它删掉，新数据反而被踢。
    this._completedAgents.delete(record.id);
    this._completedAgents.set(record.id, record);
    this.notifyChange();
  }

  /** FR-3.0 + Must-fix #1: schedule sync agent archival after WIDGET_LINGER_MS.
   *  Wave 4: 统一接收 AgentExecutionState。 */
  private scheduleSyncArchive(
    widgetId: string,
    source: AgentExecutionState,
    startedAt: number,
  ): void {
    const timer = setTimeout(() => {
      if (this._disposed) return;
      this.archiveSyncAgent({
        id: widgetId,
        agent: source.agent,
        status: source.status as CompletedAgentRecord["status"],
        eventLog: source.eventLog.slice(),
        turns: source.turns,
        totalTokens: source.totalTokens,
        result: undefined,
        error: source.error,
        startedAt,
        endedAt: source.endedAt,
        model: source.model,
        thinkingLevel: source.thinkingLevel,
      });
      this._runningAgents.delete(widgetId);
      this.notifyChange();
      this._lingerTimers.delete(timer);
    }, WIDGET_LINGER_MS);
    this._lingerTimers.add(timer);
    timer.unref?.();
  }

  /** FR-3.0: 归档 background agent 到 BgRecord（widget linger 到期时调用）。
   * Wave 1: eventLog/agent 现在始终在 state 上（不再需要从 widget 转移），此方法变为 no-op。
   * 保留签名向后兼容（archiveSyncAgent 等可能调用）。 */
  archiveBackgroundAgent(id: string, _data: { eventLog: AgentEventLogEntry[]; agent: string }): void {
    const r = this._bgRecords.get(id);
    if (!r) return;
    // eventLog/agent 已在 createExecutionState 时写入 state，无需再转移
    this.notifyChange();
  }

  /** FR-3.1 G-017: 获取当前 active overlay 句柄 */
  getActiveView(): { close: () => void } | null {
    return this._activeView;
  }

  /** FR-3.1 G-017: 设置当前 active overlay 句柄 */
  setActiveView(view: { close: () => void }): void {
    this._activeView = view;
  }

  /** FR-3.1 G-026: 清除 active overlay 句柄（dispose 时调用） */
  clearActiveView(): void {
    this._activeView = null;
  }

  /**
   * FR-4.7.1: 从 session entries 恢复状态。
   *
   * 注意：Pi 的 custom entry 形状是 { type: "custom", customType, data }。
   * 此前实现误读 e.type === "subagent-model-state"（永不匹配）。已修复为
   * 读取 customType 字段。
   *
   * Round 6 MF#1: 倒序遍历——persistState() 每次追加完整快照，正序 + break
   * 命中第一个=最旧快照，导致一次 session 内多次改模型/YOLO 后，/resume /fork
   * /new 或崩溃恢复恢复的是最初状态，后续变更全部丢失。倒序遍历取最新快照，
   * 与仓库约定一致（goal/coding-workflow/model-switch 读最新 entry 均倒序）。
   */
  restoreFromEntries(entries: unknown[]): void {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as { type?: string; customType?: string; data?: unknown };
      if (e.type === "custom" && e.customType === "subagent-model-state" && e.data) {
        const restored = restoreState(e.data, this.globalConfig.yoloByDefault);
        Object.assign(this.sessionState, restored);
        break;
      }
    }
  }

  /** FR-4.7.1: 持久化 sessionModelState 到当前 session（通过 pi.appendEntry） */
  private persistState(): void {
    this.pi?.appendEntry("subagent-model-state", serializeState(this.sessionState));
  }

  /** 切换 YOLO 模式（会话级）并持久化 */
  toggleYolo(): boolean {
    this.sessionState.yoloMode = !this.sessionState.yoloMode;
    this.persistState();
    return this.sessionState.yoloMode;
  }

  /** 设置某 agent 的会话级模型覆盖并持久化 */
  setSessionAgentModel(agent: string, model: string, thinkingLevel?: string): void {
    setAgentModel(this.sessionState, agent, model, thinkingLevel);
    this.persistState();
  }

  /** 设置某 category 的会话级模型覆盖并持久化 */
  setSessionCategoryModel(category: string, model: string, thinkingLevel?: string): void {
    setCategoryModel(this.sessionState, category, model, thinkingLevel);
    this.persistState();
  }

  /**
   * FR-3.1: 原子批量写 — 将确认结果（多个 perCategory 覆盖）+ 标记 categoryConfirmed
   * 在同一次 persistState 中完成。避免分多次 persistState 产生多条 entry
   * 导致 restoreFromEntries 取最新条时字段不一致（tracing G-010）。
   */
  applyCategoryConfirm(result: { action: "confirmed"; overrides: Record<string, { model: string; thinkingLevel?: string }> }): void {
    for (const [category, val] of Object.entries(result.overrides)) {
      setCategoryModel(this.sessionState, category, val.model, val.thinkingLevel);
    }
    this.sessionState.categoryConfirmed = true;
    this.persistState();
  }

  registerCategory(name: string, defaults: CategoryDefinition): void {
    this.globalConfig.categories[name] = defaults;
  }

  registerHooks(hooks: SubagentHooks): void {
    this.hooks.push(hooks);
  }

  private buildContext(): RunAgentContext {
    if (!this.modelRegistry) {
      throw new Error("SubagentRuntime not initialized: modelRegistry not injected (session_start not fired).");
    }
    return {
      modelRegistry: this.modelRegistry,
      // Hot-reload: 每次 runAgent 重新扫描 .md 文件，用户编辑 agent 后立即生效
      resolveAgent: (name) => {
        this.agentRegistry.discoverAll(this.builtinRegistry);
        return this.agentRegistry.get(name);
      },
      globalConfig: this.globalConfig,
      sessionState: this.sessionState,
      globalPool: this.globalPool,
      cwd: this.cwd,
      agentDir: this.agentDir,
      homeDir: this.homeDir,
    };
  }

  /** FR-11.1: runAgent（同步等待结果） */
  async runAgent(opts: RunAgentOptions): Promise<AgentResult> {
    const ctx = this.buildContext();
    let finalOpts = opts;

    // P1: _skipWidget 时跳过 widget 注册 + sync history 持久化（background 调用时用，
    // 避免双重记录：background 有自己的 _bgRecords + history mode:"background"）
    const skipWidget = opts._skipWidget === true;
    const widgetId = skipWidget ? `run-skip-${++this._widgetSeq}` : `run-${++this._widgetSeq}`;
    // Wave 2/4: 如果调用方传入了 opts.state（AgentExecutionState），优先用它——
    // 消灭 sync 路径的 eventLog 双构建（tool 不再自己创建 toolState）。
    // 否则内部创建 state（向后兼容：未传 state 的调用方如 workflow）。
    const userState = opts.state;
    const startTime = Date.now();
    const state: AgentExecutionState = userState ?? createExecutionState(widgetId, {
      agent: opts.agent ?? "default",
      model: "unknown", // 向后兼容路径无法解析 model（真实调用方应传 state）
      startedAt: startTime,
    });
    // Round 4 S4: 闭包捕获 startTime 供 linger 回调使用
    const archiveStartTime = startTime;
    if (!skipWidget) {
      this._runningAgents.set(widgetId, state);
      this.notifyChange();
    }

    // 拦截 onEvent：当调用方未传 state 时，runtime 负责更新；
    // 当调用方传了 state，tool 的 onEvent 负责更新（避免双更新）。
    const userOnEvent = opts.onEvent;
    const runtimeOwnsState = !userState; // runtime 创建的 state → runtime 更新
    finalOpts = {
      ...opts,
      onEvent: (event) => {
        userOnEvent?.(event);
        if (!skipWidget) {
          if (runtimeOwnsState) {
            updateStateFromEvent(state, event);
          }
          this._runningAgents.set(widgetId, state);
          if (shouldTriggerUpdate(event)) this.notifyChange();
        }
      },
    };

    for (const h of this.hooks) {
      if (h.beforeRun) finalOpts = await h.beforeRun(finalOpts);
    }
    try {
      const result = await runAgent(finalOpts, ctx);
      // widget: 更新为完成状态（P1: skipWidget 时跳过）
      // Round 3 MF#1: core runAgent 捕获 AbortError 后返回 {success:false} 不抛错，
      // 所以本 try 路径必须检查 finalOpts.signal.aborted 才能把用户取消（Esc）
      // 记为 cancelled 而非 failed。与 catch 路径（下方）及 background .then 路径保持一致。
      const aborted = finalOpts.signal?.aborted ?? false;
      const finalStatus: "done" | "failed" | "cancelled" = result.success ? "done" : (aborted ? "cancelled" : "failed");
      const endTime = Date.now();
      // Wave 4: state 总是存在（统一模型），用 completeState 写
      // runtimeOwnsState 时 runtime 负责完成；否则 tool 负责（但这里也调一次确保一致）
      if (runtimeOwnsState || state.status === "running") {
        completeState(state, result, finalStatus);
      }
      if (!skipWidget) {
        this._runningAgents.set(widgetId, state);
        this.notifyChange();
        this.scheduleSyncArchive(widgetId, state, archiveStartTime);
      }

      for (const h of this.hooks) {
        if (h.afterRun) h.afterRun(result, finalOpts);
      }
      // ADR-024 L1: 持久化执行记录（P1: skipWidget 时跳过——background 有自己的 mode:"background" 持久化）
      if (!skipWidget) {
        void this._history.append(
          buildPersistedRecord({
            id: widgetId,
            agent: state.agent,
            status: finalStatus,
            mode: "sync",
            task: finalOpts.task,
            startedAt: startTime,
            endedAt: endTime,
            turns: result.turns,
            totalTokens: result.usage
              ? result.usage.input + result.usage.output + result.usage.cacheRead + result.usage.cacheWrite
              : undefined,
            resultText: result.text,
            sessionFile: result.sessionFile ? path.basename(result.sessionFile) : undefined,
            cwd: this.cwd,
            sessionId: this._sessionId,
            model: state.model,
            thinkingLevel: state.thinkingLevel,
          }),
        );
      }
      return result;
    } catch (err) {
      // FR-3.5 G-025: 用户主动 abort → cancelled；其他 → failed
      const catchStatus: "failed" | "cancelled" = finalOpts.signal?.aborted ? "cancelled" : "failed";
      const errMsg = err instanceof Error ? err.message : String(err);
      const endTime = Date.now();
      const failResult: AgentResult = {
        text: "", turns: state.turns, durationMs: endTime - startTime,
        success: false, error: errMsg, sessionId: "", toolCalls: [],
      };
      completeState(state, failResult, catchStatus);
      if (!skipWidget) {
        this._runningAgents.set(widgetId, state);
        this.notifyChange();
        this.scheduleSyncArchive(widgetId, state, archiveStartTime);
      }

      for (const h of this.hooks) {
        if (h.onError) h.onError(err instanceof Error ? err : new Error(String(err)), finalOpts);
      }
      // ADR-024 L1: 失败/取消也持久化记录（P1: skipWidget 时跳过——background 有自己的持久化）
      if (!skipWidget) {
        void this._history.append(
          buildPersistedRecord({
            id: widgetId,
            agent: state.agent,
            status: catchStatus,
            mode: "sync",
            task: finalOpts.task,
            startedAt: startTime,
            endedAt: endTime,
            turns: state.turns,
            totalTokens: state.totalTokens,
            error: errMsg,
            cwd: this.cwd,
            sessionId: this._sessionId,
            model: state.model,
            thinkingLevel: state.thinkingLevel,
          }),
        );
      }
      throw err;
    }
  }

  /** FR-11.1: createManagedSession（长生命周期，支持 steer） */
  createManagedSession(options: ManagedSessionOptions): ManagedSession {
    return createManagedSession(options, this.buildContext());
  }

  /**
   * Background fire-and-forget：立即返回 handle，agent 在后台执行。
   * 完成时：(1) 回填 status；(2) 触发 opts.onComplete；(3) emit pi.events
   * 'subagents:bg:done'；(4) appendEntry 'subagent-bg-record' 持久化记录。
   *
   * 用 getBackground(id) 查询结果，cancelBackground(id) 取消。
   */
  startBackground(opts: BackgroundOptions): BackgroundHandle {
    // 入口预检：立即验证 runtime 已初始化（modelRegistry 已注入）。
    // 若不预检，detached runAgent() 的异步错误会被下方 .catch 吞掉，
    // 导致 startBackground 返回"假成功"的 handle（status: "running"），
    // 而真实失败只在后续 getBackground(id) 查询时才暴露。
    this.buildContext();

    const id = `bg-${++this._bgSeq}-${Date.now().toString(BG_ID_RADIX)}`;
    const controller = new AbortController();
    const startedAt = Date.now();
    // Wave 1: 创建 AgentExecutionState（model 创建时必填——消灭 poll model 丢失）。
    // Round 1 MF#2: resolveModelForAgent 传 paramOverride（opts.model/thinkingLevel），
    // 让用户显式指定的 model/thinkingLevel 生效到 state，与 runAgent 实际执行一致
    // （影响 getBackground 轮询 + history 持久化的成本追踪/审计）。此前未传 paramOverride
    // 导致 state.model 记 agent 默认模型，与执行模型不符。modelRegistry 不可用时用占位。
    const agentName = opts.agent ?? "default";
    let resolvedModel = "unknown";
    let resolvedThinking: string | undefined;
    try {
      const resolved = this.resolveModelForAgent(agentName, {
        model: opts.model,
        thinkingLevel: opts.thinkingLevel,
      });
      if (resolved) {
        resolvedModel = resolved.model.id;
        resolvedThinking = resolved.thinkingLevel;
      }
    } catch { /* modelRegistry 未注入，用占位 */ }
    const state = createExecutionState(id, {
      agent: agentName,
      model: resolvedModel,
      thinkingLevel: resolvedThinking,
      startedAt,
    });
    const record: BgRecord = { id, state, status: "running", startedAt, controller };
    this._bgRecords.set(id, record);
    // FR-O5.9: FIFO 清理，上限 BG_RECORDS_MAX。
    // S4 修复：只淘汰非 running 的最旧 record——淘汰 running record 会导致
    // cancelBackground(id) 找不到 record 而返回 false，正在执行的 agent 无法取消。
    // 若全是 running（极端并发），不淘汰（宁可暂时超限也不丢失 cancel 能力）。
    while (this._bgRecords.size > BG_RECORDS_MAX) {
      let evicted = false;
      for (const [key, rec] of this._bgRecords) {
        if (rec.status !== "running") {
          this._bgRecords.delete(key);
          evicted = true;
          break;
        }
      }
      if (!evicted) break; // 全是 running，停止淘汰
    }
    this.notifyChange();

    // detached：不 await，完成后回填
    // G-005 修复：通过 onEvent 闭包直接把事件写入 state.eventLog，
    // 不再用 widget.listAgents().find(id.startsWith("run-")) 反查（并发时会串号）。
    // record 是本闭包独占的引用，与其它并发 background 隔离。
    const userBgOnEvent = opts.onEvent;
    // Round 4 MF2: 始终用 controller.signal 喂给 runAgent——runAgent 监听的是这个 signal。
    // opts.signal 是调用方传入的（Pi tool 执行的 signal），cancelBackground 只能 abort controller
    // 不能 abort opts.signal。若把 opts.signal 喂给 runAgent，cancelBackground(controller.abort())
    // 不会传到 agent；完成后 .then 还会把 status 从 cancelled 覆盖回 done/failed。
    // 修复：内部用 controller.signal；同时把 opts.signal 的 abort 转发到 controller（一次性监听），
    // 让外部 Esc 也能终止 background。
    const signal = controller.signal;
    if (opts.signal) {
      if (opts.signal.aborted) {
        controller.abort();
      } else {
        opts.signal.addEventListener(
          "abort",
          () => controller.abort(),
          { once: true },
        );
      }
    }
    // FR-2.5: onUpdate 拦截器——把 runAgent 的事件回流给调用方（对话流 block 实时刷新）
    const userOnUpdate = opts.onUpdate;
    // Bug-fix: 节流 userOnUpdate -> requestRender，降低 pi-tui doRender 的底部锚定
    // 频率，缓解 streaming 期间用户无法滚动（leading+trailing，最终态由 flush 兜底）。
    const throttledUserUpdate = createThrottle(
      (details: SubagentToolDetails) => userOnUpdate?.(details),
      150,
    );
    // Round 5 MF#1: wrap in try/catch to prevent ghost entries when runAgent()
    // throws synchronously (e.g. buildContext() failure) — without this, the
    // record added to _bgRecords above would remain status:"running" forever
    // because the promise chain never gets created.
    try {
    this.runAgent({
      ...opts,
      signal,
      // FR-O4.1: background 低优先级（1000），不抢占 sync（sync 传 0）
      priority: 1000,
      // P1: background 跳过 runAgent 的 widget 注册 + sync history 持久化，
      // 避免双重记录（background 有自己的 _bgRecords + mode:"background" history）。
      _skipWidget: true,
      onEvent: (event: AgentEvent) => {
        userBgOnEvent?.(event);
        // Wave 1: 统一用 updateStateFromEvent 更新 state（eventLog/turns/tokens）
        // 持久缓冲在 state 上（_currentTurnText/_currentThinking），修复 sink reset bug
        updateStateFromEvent(state, event);
        // Bug #2 修复：streaming delta（text/thinking）只累积 eventLog，不触发 onUpdate。
        // 仅离散边界事件（tool/turn/message）触发 tool block 重绘，避免 streaming 期间
        // pi-tui doRender 把 viewport 锚定到底部。
        if (shouldTriggerUpdate(event)) {
          // FR-2.5: 回流给调用方（对话流 block 实时刷新）——用 executionStateToDetails 投影
          throttledUserUpdate(executionStateToDetails(state));
          this.notifyChange();
        }
      },
    })
      .then((result) => {
        record.result = result;
        // Round 5 MF#2: .then 路径需补 abort 判断——SDK 偶发以
        // message_end stopReason="aborted" 结束且 session.prompt() 未抛错，
        // 此时走 .then 而非 .catch；不补判断会把用户 cancel 覆盖为 failed。
        // Round 6 SUG#9: read controller BEFORE delete so the check actually
        // observes the runtime-owned controller (was reading undefined post-delete).
        const aborted = record.controller?.signal.aborted ?? signal.aborted;
        const finalStatus: "done" | "failed" | "cancelled" = aborted
          ? "cancelled"
          : result.success ? "done" : "failed";
        // Wave 1: 用 completeState 统一写 state（status/endedAt/agentResult/result/error）
        completeState(state, result, finalStatus);
        throttledUserUpdate.flush();
        // BgRecord 镜像字段同步（供 getBackground/notifyBgCompletion 直接读）
        record.status = finalStatus;
        record.endedAt = state.endedAt;
        delete record.controller;
        // Must-fix #2: cancelBackground already settled this as a user-initiated
        // cancel. Backfill result/endedAt only — skip onComplete/events/history
        // to prevent re-triggering caller side effects for an already-cancelled task.
        if (record._settled) return;
        opts.onComplete?.(record);
        this.pi?.events.emit("subagents:bg:done", record);
        this.pi?.appendEntry("subagent-bg-record", {
          id,
          agent: state.agent,
          status: record.status,
          sessionId: result.sessionId,
        });
        // ADR-024 L1: background 完成持久化（与 sync 统一）
        void this._history.append(
          buildPersistedRecord({
            id,
            agent: state.agent,
            status: record.status,
            mode: "background",
            task: opts.task,
            startedAt: record.startedAt,
            endedAt: record.endedAt,
            turns: result.turns,
            totalTokens: result.usage
              ? result.usage.input + result.usage.output + result.usage.cacheRead + result.usage.cacheWrite
              : undefined,
            resultText: result.text,
            sessionFile: result.sessionFile ? path.basename(result.sessionFile) : undefined,
            cwd: this.cwd,
            sessionId: this._sessionId,
            model: state.model,
            thinkingLevel: state.thinkingLevel,
          }),
        );
        // FR-O1.1: 回注完成通知到主对话（去重 + 合并窗口在 notifyBgCompletion 内处理）
        this.notifyBgCompletion({
          id: record.id,
          status: record.status as "done" | "failed" | "cancelled",
          agent: state.agent,
          result: record.result,
          startedAt: record.startedAt,
          endedAt: record.endedAt,
        });
        this.notifyChange();
      })
      .catch((err: unknown) => {
        // S1 修复：区分 abort（用户 cancel）vs 真实错误。
        // cancelBackground 先设 record.status="cancelled" 并 controller.abort()，
        // runAgent catch 会 re-throw → 进入此处。
        // Round 3 MF4: 优先读 record.controller?.signal.aborted（runtime 自有 controller），
        // 回退到 signal.aborted（opts.signal）——调用方传入的 signal 与 cancelBackground
        // 无关，混用会误判 status=cancelled，与用户意图不符。
        const aborted = record.controller?.signal.aborted ?? signal.aborted;
        const finalStatus: "failed" | "cancelled" = aborted ? "cancelled" : "failed";
        const errMsg = aborted ? undefined : err instanceof Error ? err.message : String(err);
        // Wave 1: 用 completeState 统一写 state（构造一个失败 AgentResult）
        const failResult: AgentResult = {
          text: "",
          turns: state.turns,
          durationMs: Date.now() - record.startedAt,
          success: false,
          error: errMsg,
          sessionId: "",
          toolCalls: [],
        };
        completeState(state, failResult, finalStatus);
        // BgRecord 镜像字段同步
        record.status = finalStatus;
        record.error = errMsg;
        record.endedAt = state.endedAt;
        delete record.controller;
        // Must-fix #2: cancelBackground already settled this as a user-initiated
        // cancel. Backfill endedAt only — skip onComplete/events/history.
        if (record._settled) return;
        opts.onComplete?.(record);
        this.pi?.events.emit("subagents:bg:done", record);
        // ADR-024 L1: background 失败/取消持久化
        void this._history.append(
          buildPersistedRecord({
            id,
            agent: state.agent,
            status: record.status as "failed" | "cancelled",
            mode: "background",
            task: opts.task,
            startedAt: record.startedAt,
            endedAt: record.endedAt,
            error: record.error,
            cwd: this.cwd,
            sessionId: this._sessionId,
            model: state.model,
            thinkingLevel: state.thinkingLevel,
          }),
        );
        // FR-O1.1: 失败/取消也回注（去重 + 合并窗口在 notifyBgCompletion 内处理）
        this.notifyBgCompletion({
          id: record.id,
          status: record.status as "failed" | "cancelled",
          agent: state.agent,
          error: record.error,
          startedAt: record.startedAt,
          endedAt: record.endedAt,
        });
        this.notifyChange();
      });
    } catch (err: unknown) {
      // Round 5 MF#1: synchronous exception (e.g. buildContext() failure).
      // Mark record failed immediately so it does not linger as a ghost entry.
      const errMsg = err instanceof Error ? err.message : String(err);
      record.status = "failed";
      record.error = errMsg;
      record._settled = true;
      record.endedAt = Date.now();
      completeState(state, {
        text: "",
        turns: 0,
        durationMs: record.endedAt - record.startedAt,
        success: false,
        error: errMsg,
        sessionId: "",
        toolCalls: [],
      }, "failed");
      delete record.controller;
      this.notifyChange();
    }

    return { id, status: "running" };
  }

  /** 查询 background 任务状态（含结果）。
   * Wave 1: 从 record.state 展平所有字段到 BackgroundStatus。 */
  getBackground(id: string): BackgroundStatus | undefined {
    const r = this._bgRecords.get(id);
    if (!r) return undefined;
    return {
      id: r.id,
      status: r.status,
      result: r.result,
      error: r.error,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      // P1#2: 从 state 展平；eventLog .slice() 快照（poll 返回值被调用方持有，避免并发 streaming mutate）
      eventLog: r.state.eventLog.slice(),
      agent: r.state.agent,
      turns: r.state.turns,
      totalTokens: r.state.totalTokens,
      model: r.state.model,
      thinkingLevel: r.state.thinkingLevel,
    };
  }

  /** 取消 background 任务（触发 AbortController → runAgent 内 session.abort） */
  cancelBackground(id: string): boolean {
    const r = this._bgRecords.get(id);
    if (!r || r.status !== "running") return false;
    r.controller?.abort();
    r.status = "cancelled";
    r.endedAt = Date.now();
    // Must-fix #2: mark settled so .then/.catch skip completion side effects
    // (onComplete/events.emit/history) — cancel is user-initiated and already
    // settled here. Queryable via getBackground(id).
    r._settled = true;
    this.notifyChange();
    // FR-O1.2: 通知对话流 cancelled 状态（用户主动取消，理应知道结果）。
    // notifyBgCompletion 内部有 TTL dedup，会拦截后续 .catch 路径的重复通知。
    // history 不写（_settled 守卫跳过 .catch 的 _history.append）——cancel 是用户意图，不计入执行记录。
    this.notifyBgCompletion({
      id: r.id,
      status: "cancelled",
      agent: r.state.agent,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
    });
    // Round 5 SUG#1 + Must-fix #2: cancel 不写 history——.then/.catch 检测到
    // _settled 后同样跳过 onComplete/events/history。用户主动取消的 task 不计入
    // 执行记录（避免 cancel + runAgent 完成路径双写 history 的 race）。
    return true;
  }

  /**
   * P3#5: 取消正在运行的 sync agent（通过 listRunningAgents 暴露的 id 查找）。
   *
   * ⚠️ 能力局限：sync agent 的 AbortController 在 tool execute 闭包里（subagent-tool.ts），
   * runtime 不持有它，无法主动 abort 正在执行的 session.prompt()。与 background 不同——
   * background 的 controller 由 runtime 创建并持有（startBackground），可调 controller.abort()。
   *
   * 因此本方法只标记 state.status="cancelled" + endedAt，让 /subagents list 视觉上反映
   * 用户意图，但**不会真正中断正在跑的 LLM 调用**。真正的中断仍需用户在对话流按 Esc
   * （Pi 的 tool 取消机制走 signal.aborted 路径）。
   *
   * 返回 true=找到并标记 / false=无此 id 或非 running；调用方（detailMode x 键）据返回值决定是否显示「请在对话流按 Esc」提示。
   */
  cancelRunningAgent(id: string): boolean {
    const state = this._runningAgents.get(id);
    if (!state || state.status !== "running") return false;
    state.status = "cancelled";
    state.endedAt = Date.now();
    this._runningAgents.set(id, state);
    this.notifyChange();
    return true;
  }

  /** 列出所有 background 任务状态 */
  listBackground(): BackgroundStatus[] {
    return [...this._bgRecords.values()].map((r) => {
      const { controller: _controller, ...public_ } = r;
      void _controller;
      return public_;
    });
  }

  /**
   * scene → model 字符串解析（workflow 调用，FR-9.9）。
   * scene 名作为 agent 名传入 5 级配置链，category 从 config 推断。
   */
  resolveModelForScene(scene: string): string | undefined {
    if (!this.modelRegistry) return undefined;
    try {
      const result = resolveModelForAgent({
        agentName: scene,
        agentConfig: undefined,
        category: scene,
        globalConfig: this.globalConfig,
        sessionState: this.sessionState,
        modelRegistry: this.modelRegistry,
      });
      // FR-9.9: 返回 provider/modelId（SDK ModelRegistry.find 用 modelId 解析）。
      // 之前用 model.name（展示名）会与 fuzzy matcher 行为不稳定。
      return `${result.model.provider}/${result.model.id}`;
    } catch {
      return undefined;
    }
  }

  /**
   * FR-O2.2 G-026: 查询 agent 配置（供工具层判定 defaultBackground）。
   * 内部调用 agentRegistry.get（含 discover）。找不到返回 undefined。
   */
  getAgentConfig(name?: string): AgentConfig | undefined {
    if (!name) return undefined;
    this.agentRegistry.discoverAll(this.builtinRegistry);
    return this.agentRegistry.get(name);
  }

  /** 校验 agent 名是否存在。不存在则抛错（含已发现 agent 列表）。
   *  用于 tool 层 fail-fast，避免 unknown agent 静默运行为无 systemPrompt 的 generic agent。 */
  assertAgentExists(name?: string): void {
    if (!name) return; // undefined agent = 用默认
    this.agentRegistry.discoverAll(this.builtinRegistry);
    this.agentRegistry.get(name, true);
  }

  /**
   * FR-1.2: 解析 agent 的 model + thinkingLevel（供 tool 构建 details）。
   * 与 resolveModelForScene 不同：这里走完整 agent 发现 + category 推断链，
   * 返回完整 ResolvedModel（含 model.id 和 thinkingLevel）。
   * 解析失败（如 fallback 链全部不可用）→ 返回 undefined，details 不带 model 字段。
   */
  resolveModelForAgent(
    agentName?: string,
    paramOverride?: { model?: string; thinkingLevel?: string },
  ): ResolvedModel | undefined {
    if (!this.modelRegistry) return undefined;
    if (!agentName) return undefined;
    // hot-reload：重新扫描 .md 文件，确保编辑后立即生效（与 buildContext.resolveAgent 一致）
    this.agentRegistry.discoverAll(this.builtinRegistry);
    const agentConfig = this.agentRegistry.get(agentName) ?? this.builtinRegistry.get(agentName);
    const category = inferCategory(agentName, agentConfig, this.globalConfig.agentCategoryOverrides);
    try {
      return resolveModelForAgent({
        agentName,
        agentConfig,
        category,
        globalConfig: this.globalConfig,
        sessionState: this.sessionState,
        modelRegistry: this.modelRegistry,
        paramOverride,
      });
    } catch {
      return undefined;
    }
  }

  /** 持久化全局配置（供 config-wizard 调用） */
  saveGlobalConfig(): Promise<void> {
    return saveGlobalConfig(this.homeDir, this.globalConfig);
  }

  // Wave 5: background 通知逻辑已移至 BgNotifier（persistence/bg-notifier.ts）。
  // 以下为薄委托方法，保持 runtime 的公共 API 不变。

  formatBgCompletionMessage(record: BgNotifyRecord): string {
    return this._bgNotifier.formatBgCompletionMessage(record);
  }

  notifyBgCompletion(record: BgNotifyRecord): void {
    if (this._disposed) return;
    this._bgNotifier.notifyBgCompletion(record);
  }

  flushPendingNotifications(): void {
    this._bgNotifier.flushPendingNotifications();
  }

  /**
   * FR-O1.5 G-029: 清理 runtime 资源。
   * session 结束时调用，清理合并窗口定时器。
   * P2: 设置 _disposed 标志，dispose 后 notifyBgCompletion 短路（stale pi 不调用）。
   * Round 6 SUG#11: 不再 flush——flush 会尝试向已结束的 session 注入消息，与 dispose
   * 语义矛盾。只 clear timer 让 pending 通知随 process 退出自然丢弃。
   */
  dispose(): void {
    if (this._disposed) return; // 幂等
    this._disposed = true;
    // Wave 5: 通知定时器清理委托给 BgNotifier
    this._bgNotifier.dispose();
    // Must-fix #1: clear pending sync-agent linger timers so their callbacks
    // don't fire into the stale session (notifyChange → overlay listeners).
    for (const t of this._lingerTimers) clearTimeout(t);
    this._lingerTimers.clear();
    this.clearActiveView();
  }

  /**
   * Round 4 MF3: 重置 dispose 状态。
   * Pi 的 /resume /fork /new 会在同进程内先 session_shutdown(A) 再 session_start(B)，
   * 进程内单例不变。session_shutdown → dispose() 设 _disposed=true；新 session
   * session_start 注入新 pi 后必须复活，否则所有 background 完成通知被
   * notifyBgCompletion 顶部 `if (this._disposed) return;` 短路。
   */
  revive(): void {
    this._disposed = false;
    this._bgNotifier.revive();
  }
}
