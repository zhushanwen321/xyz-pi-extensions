// src/runtime.ts
import * as path from "node:path";

import { loadGlobalConfig, saveGlobalConfig } from "./config/global-config.ts";
import { buildCompletionKey, getGlobalSeenMap, markSeenWithTtl } from "./persistence/completion-dedupe.ts";
import { runAgent, type RunAgentContext } from "./core/run-agent.ts";
import { createManagedSession } from "./core/session.ts";
import { inferCategory } from "./category.ts";
import { HistoryStore, buildPersistedRecord } from "./persistence/history-store.ts";
import { DefaultConcurrencyPool } from "./pool/concurrency-pool.ts";
import { AgentRegistry } from "./registry/agent-registry.ts";
import { BuiltinAgentRegistry } from "./registry/builtin-agents.ts";
import { type ModelRegistryLike,resolveModelForAgent } from "./resolution/model-resolver.ts";
import { createSessionModelState, restoreState, serializeState, setAgentModel, setCategoryModel } from "./state/session-model-state.ts";
import type { WidgetAgentState } from "./tui/agent-widget.ts";
import { updateRecordEventLog, updateWidgetFromEvent } from "./event-log-builder.ts";
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

/** Pi ExtensionAPI 的最小接口（duck-typed，用于 appendEntry / events.emit / sendMessage） */
interface PiLike {
  appendEntry(customType: string, data?: unknown): void;
  events: { emit(channel: string, data: unknown): void };
  /** FR-O1.1: 注入消息到主对话并可选触发新 turn */
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options?: { triggerTurn?: boolean },
  ): void;
}

/** background id 的时间戳进制（base36 紧凑表示） */
const BG_ID_RADIX = 36;
/**
 * widget 摘要截断长度（完成时 result.text 的预览截断）。
 * 注意：与 EVENT_LOG_LABEL_MAX（types.ts，eventLog label 截断）值相同但语义不同——
 * 前者截断最终结果文本预览，后者截断流式 eventLog 条目。有意不复用。
 */
const WIDGET_SUMMARY_MAX = 100;
/** widget 完成状态淡出延迟（ms） */
const WIDGET_LINGER_MS = 5000;
/** FR-O1.3: background 完成通知去重 TTL（10 分钟，移植自 notify.ts:56） */
const BG_NOTIFY_TTL_MS = 10 * 60 * 1000;
/** FR-O1.5: 合并窗口大小（首个立即发送，窗口内的后续合并） */
const BG_MERGE_WINDOW_MS = 2000;
/** FR-O5.9: BgRecord 容量上限（FIFO 淘汰） */
const BG_RECORDS_MAX = 50;

/** 进程内单例持有的 background 记录（含 AbortController 供 cancel）。
 * status 此处可写（BackgroundStatus.status 是 readonly，但内部记录需变异） */
interface BgRecord {
  readonly id: string;
  status: BackgroundStatus["status"];
  result?: AgentResult;
  error?: string;
  startedAt: number;
  endedAt?: number;
  controller?: AbortController;
  /** FR-3.0: 留存 eventLog（widget 淺出前转移） */
  eventLog?: AgentEventLogEntry[];
  /** FR-3.0a: agent 名持久化 */
  agent?: string;
}

/**
 * FR-11.5: SubagentRuntime 单例。组合所有能力。
 * 创建时不含 modelRegistry / pi（骨架），session_start 时注入。
 */
export class SubagentRuntime {
  readonly globalConfig: SubagentsGlobalConfig;
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

  /** FR-O1.5: 合并窗口 pending 通知队列 + 定时器 */
  private readonly _pendingNotifications: Array<{
    id: string;
    status: "done" | "failed" | "cancelled";
    agent?: string;
    result?: AgentResult;
    error?: string;
    startedAt: number;
    endedAt?: number;
  }> = [];
  private _mergeWindowTimer?: ReturnType<typeof setTimeout>;
  /** P2: dispose 后拒绝新的通知（防止 stale pi 调用） */
  private _disposed = false;

  /** FR-3.4: 事件总线，供 overlay 视图订阅实时刷新 */
  private readonly _changeListeners = new Set<() => void>();

  /** FR-3.0: 已完成 sync agent 归档记录 */
  private readonly _completedAgents = new Map<string, CompletedAgentRecord>();

  /** ADR-024 L1: 执行记录持久化（跨进程历史） */
  private readonly _history: HistoryStore;

  /** FR-3.1 G-017: 活跃 overlay 句柄（防叠加） */
  private _activeView: { close: () => void } | null = null;

  /** FR-2.0: running agent 状态 map（替代已删除的 AgentWidgetManager 渲染层） */
  private readonly _runningAgents = new Map<string, WidgetAgentState>();

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
  }

  /** FR-2.0: 暴露给 /subagents list 的 running agent 快照（替代 widget.listAgents） */
  listRunningAgents(): WidgetAgentState[] {
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

  /** ADR-024 L1: 读取跨进程执行记录（新→旧） */
  listHistory(limit?: number): import("./types.ts").PersistedAgentRecord[] {
    return limit ? this._history.recent(limit) : this._history.read().reverse();
  }

  /** FR-3.0: 归档 sync agent（widget linger 到期时调用） */
  archiveSyncAgent(record: CompletedAgentRecord): void {
    if (this._completedAgents.size >= COMPLETED_AGENTS_MAX) {
      const firstKey = this._completedAgents.keys().next().value;
      if (firstKey !== undefined) this._completedAgents.delete(firstKey);
    }
    this._completedAgents.set(record.id, record);
    this.notifyChange();
  }

  /** FR-3.0: 归档 background agent 到 BgRecord（widget linger 到期时调用） */
  archiveBackgroundAgent(id: string, data: { eventLog: AgentEventLogEntry[]; agent: string }): void {
    const r = this._bgRecords.get(id);
    if (!r) return;
    r.eventLog = data.eventLog;
    r.agent = data.agent;
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
   */
  restoreFromEntries(entries: unknown[]): void {
    for (const entry of entries) {
      const e = entry as { type?: string; customType?: string; data?: unknown };
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
    const startTime = Date.now();
    const widgetState: WidgetAgentState = {
      id: widgetId,
      agent: opts.agent ?? "default",
      status: "running",
      elapsedSeconds: 0,
      eventLog: [],
    };
    if (!skipWidget) {
      this._runningAgents.set(widgetState.id, widgetState);
      this.notifyChange();
    }

    // 拦截 onEvent 更新 widget（turns/tokens/activity + eventLog）
    const userOnEvent = opts.onEvent;
    finalOpts = {
      ...opts,
      onEvent: (event) => {
        userOnEvent?.(event);
        if (!skipWidget) {
          updateWidgetFromEvent(widgetState, event, startTime);
          this._runningAgents.set(widgetState.id, widgetState);
          this.notifyChange();
        }
      },
    };

    for (const h of this.hooks) {
      if (h.beforeRun) finalOpts = await h.beforeRun(finalOpts);
    }
    try {
      const result = await runAgent(finalOpts, ctx);
      // widget: 更新为完成状态（P1: skipWidget 时跳过）
      widgetState.status = result.success ? "done" : "failed";
      widgetState.turns = result.turns;
      widgetState.totalTokens = result.usage
        ? result.usage.input + result.usage.output + result.usage.cacheRead + result.usage.cacheWrite
        : undefined;
      widgetState.summary = result.text.slice(0, WIDGET_SUMMARY_MAX);
      widgetState.finishedAt = Date.now();
      if (!skipWidget) {
        this._runningAgents.set(widgetState.id, widgetState);
        this.notifyChange();
        // 5 秒后归档 + 清理
        setTimeout(() => {
          this.archiveSyncAgent({
            id: widgetId,
            agent: widgetState.agent,
            status: widgetState.status as CompletedAgentRecord["status"],
            eventLog: widgetState.eventLog ?? [],
            turns: widgetState.turns,
            totalTokens: widgetState.totalTokens,
            result: undefined,
            error: widgetState.summary,
            startedAt: Date.now() - (widgetState.elapsedSeconds ?? 0) * 1000,
            endedAt: widgetState.finishedAt,
          });
          this._runningAgents.delete(widgetId);
          this.notifyChange();
        }, WIDGET_LINGER_MS);
      }

      for (const h of this.hooks) {
        if (h.afterRun) h.afterRun(result, finalOpts);
      }
      // ADR-024 L1: 持久化执行记录（P1: skipWidget 时跳过——background 有自己的 mode:"background" 持久化）
      if (!skipWidget) {
        void this._history.append(
          buildPersistedRecord({
            id: widgetId,
            agent: widgetState.agent,
            status: widgetState.status as "done" | "failed",
            mode: "sync",
            task: finalOpts.task,
            startedAt: startTime,
            endedAt: widgetState.finishedAt,
            turns: widgetState.turns,
            totalTokens: widgetState.totalTokens,
            resultText: result.text,
            sessionFile: result.sessionFile ? path.basename(result.sessionFile) : undefined,
            cwd: this.cwd,
          }),
        );
      }
      return result;
    } catch (err) {
      // FR-3.5 G-025: 用户主动 abort → cancelled；其他 → failed
      widgetState.status = finalOpts.signal?.aborted ? "cancelled" : "failed";
      widgetState.summary = err instanceof Error ? err.message : String(err);
      widgetState.finishedAt = Date.now();
      if (!skipWidget) {
        this._runningAgents.set(widgetState.id, widgetState);
        this.notifyChange();
        setTimeout(() => {
          this.archiveSyncAgent({
            id: widgetId,
            agent: widgetState.agent,
            status: widgetState.status as CompletedAgentRecord["status"],
            eventLog: widgetState.eventLog ?? [],
            turns: widgetState.turns,
            totalTokens: widgetState.totalTokens,
            result: undefined,
            error: widgetState.summary,
            startedAt: Date.now() - (widgetState.elapsedSeconds ?? 0) * 1000,
            endedAt: widgetState.finishedAt,
          });
          this._runningAgents.delete(widgetId);
          this.notifyChange();
        }, WIDGET_LINGER_MS);
      }

      for (const h of this.hooks) {
        if (h.onError) h.onError(err instanceof Error ? err : new Error(String(err)), finalOpts);
      }
      // ADR-024 L1: 失败/取消也持久化记录（P1: skipWidget 时跳过——background 有自己的持久化）
      if (!skipWidget) {
        void this._history.append(
          buildPersistedRecord({
            id: widgetId,
            agent: widgetState.agent,
            status: widgetState.status as "failed" | "cancelled",
            mode: "sync",
            task: finalOpts.task,
            startedAt: startTime,
            endedAt: widgetState.finishedAt,
            turns: widgetState.turns,
            totalTokens: widgetState.totalTokens,
            error: widgetState.summary,
            cwd: this.cwd,
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
    const record: BgRecord = { id, status: "running", startedAt: Date.now(), controller };
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
    // G-005 修复：通过 onEvent 闭包直接把事件写入 record.eventLog，
    // 不再用 widget.listAgents().find(id.startsWith("run-")) 反查（并发时会串号）。
    // record 是本闭包独占的引用，与其它并发 background 隔离。
    const userBgOnEvent = opts.onEvent;
    const bgStartTime = record.startedAt;
    const signal = opts.signal ?? controller.signal;
    // FR-2.5: onUpdate 拦截器——把 runAgent 的事件回流给调用方（对话流 block 实时刷新）
    const userOnUpdate = opts.onUpdate;
    let bgTurns = 0;
    let bgTokens = 0;
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
        // FR-1.3: record 闭包捕获（race fix G-005）+ updateRecordEventLog 切片
        if (!record.eventLog) record.eventLog = [];
        updateRecordEventLog(record.eventLog, event, bgStartTime);
        if (event.type === "turn_end") bgTurns += 1;
        if (event.type === "message_end" && event.usage) {
          bgTokens += event.usage.input + event.usage.output + event.usage.cacheRead + event.usage.cacheWrite;
        }
        // FR-2.5: 回流给调用方（对话流 block 实时刷新）
        userOnUpdate?.({
          eventLog: [...record.eventLog],
          status: "running",
          turns: bgTurns,
          totalTokens: bgTokens,
          elapsedSeconds: Math.floor((Date.now() - bgStartTime) / MS_PER_SECOND),
        });
        this.notifyChange();
      },
    })
      .then((result) => {
        record.result = result;
        record.status = result.success ? "done" : "failed";
        record.endedAt = Date.now();
        record.agent = opts.agent ?? "default";
        delete record.controller;
        opts.onComplete?.(record);
        this.pi?.events.emit("subagents:bg:done", record);
        this.pi?.appendEntry("subagent-bg-record", {
          id,
          agent: opts.agent,
          status: record.status,
          sessionId: result.sessionId,
        });
        // ADR-024 L1: background 完成持久化（与 sync 统一）
        void this._history.append(
          buildPersistedRecord({
            id,
            agent: record.agent,
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
          }),
        );
        // FR-O1.1: 回注完成通知到主对话（去重 + 合并窗口在 notifyBgCompletion 内处理）
        this.notifyBgCompletion({
          id: record.id,
          status: record.status as "done" | "failed",
          agent: record.agent,
          result: record.result,
          startedAt: record.startedAt,
          endedAt: record.endedAt,
        });
        this.notifyChange();
      })
      .catch((err: unknown) => {
        // S1 修复：区分 abort（用户 cancel）vs 真实错误。
        // cancelBackground 先设 record.status="cancelled" 并 controller.abort()，
        // runAgent catch 会 re-throw → 进入此处。若 signal.aborted 则保留 cancelled，
        // 不覆盖为 failed（与 cancelBackground 的用户意图一致）。
        const aborted = signal.aborted;
        record.status = aborted ? "cancelled" : "failed";
        record.error = aborted ? undefined : err instanceof Error ? err.message : String(err);
        record.endedAt = Date.now();
        record.agent = opts.agent ?? "default";
        delete record.controller;
        opts.onComplete?.(record);
        this.pi?.events.emit("subagents:bg:done", record);
        // ADR-024 L1: background 失败/取消持久化
        void this._history.append(
          buildPersistedRecord({
            id,
            agent: record.agent,
            status: record.status as "failed" | "cancelled",
            mode: "background",
            task: opts.task,
            startedAt: record.startedAt,
            endedAt: record.endedAt,
            error: record.error,
            cwd: this.cwd,
          }),
        );
        // FR-O1.1: 失败/取消也回注（去重 + 合并窗口在 notifyBgCompletion 内处理）
        this.notifyBgCompletion({
          id: record.id,
          status: record.status as "failed" | "cancelled",
          agent: record.agent,
          error: record.error,
          startedAt: record.startedAt,
          endedAt: record.endedAt,
        });
        this.notifyChange();
      });

    return { id, status: "running" };
  }

  /** 查询 background 任务状态（含结果） */
  getBackground(id: string): BackgroundStatus | undefined {
    const r = this._bgRecords.get(id);
    if (!r) return undefined;
    // 不暴露 controller
    const { controller: _controller, ...public_ } = r;
    void _controller;
    return public_;
  }

  /** 取消 background 任务（触发 AbortController → runAgent 内 session.abort） */
  cancelBackground(id: string): boolean {
    const r = this._bgRecords.get(id);
    if (!r || r.status !== "running") return false;
    r.controller?.abort();
    r.status = "cancelled";
    r.endedAt = Date.now();
    this.notifyChange();
    // ADR-024 L1: 用户主动取消也记录历史
    // 注意：runAgent 的 catch 路径会再写一条 "failed"（因为 abort 抛错）。
    // 这里写 cancelled 以保留用户意图。去重由 list 视图的 id + 最新时间戳处理。
    void this._history.append(
      buildPersistedRecord({
        id,
        agent: r.agent ?? "default",
        status: "cancelled",
        mode: "background",
        task: "(cancelled by user)",
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        cwd: this.cwd,
      }),
    );
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
      return `${result.model.provider}/${result.model.name}`;
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

  /**
   * FR-1.2: 解析 agent 的 model + thinkingLevel（供 tool 构建 details）。
   * 与 resolveModelForScene 不同：这里走完整 agent 发现 + category 推断链，
   * 返回完整 ResolvedModel（含 model.id 和 thinkingLevel）。
   * 解析失败（如 fallback 链全部不可用）→ 返回 undefined，details 不带 model 字段。
   */
  resolveModelForAgent(agentName?: string): ResolvedModel | undefined {
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
      });
    } catch {
      return undefined;
    }
  }

  /** 持久化全局配置（供 config-wizard 调用） */
  saveGlobalConfig(): Promise<void> {
    return saveGlobalConfig(this.homeDir, this.globalConfig);
  }

  /**
   * FR-O1.2: 格式化 background 完成通知文本。
   * 主 agent 能基于此文本续接工作。
   */
  formatBgCompletionMessage(record: {
    id: string;
    status: "done" | "failed" | "cancelled";
    agent?: string;
    result?: AgentResult;
    error?: string;
    endedAt?: number;
    startedAt: number;
  }): string {
    const statusWord = record.status === "done" ? "completed" : record.status;
    const agent = record.agent ?? "default";
    const lines = [`Background task ${statusWord}: **${agent}**`];
    const body = record.result?.text ?? record.error ?? "(no output)";
    // 截断正文到 ~500 字符
    const truncated = body.length > 500 ? body.slice(0, 500) + "..." : body;
    lines.push("", truncated);
    lines.push("", `backgroundId: ${record.id}`);
    if (record.result?.sessionFile) {
      lines.push(`Session file: ${record.result.sessionFile}`);
    }
    return lines.join("\n");
  }

  /**
   * FR-O1.1 + FR-O1.3 + FR-O1.5 + FR-O1.7: 发送 background 完成通知到主对话。
   *
   * 合并窗口策略（G-028 决策）：
   * - 首个完成事件**立即发送**，同时启动 BG_MERGE_WINDOW_MS 合并窗口
   * - 窗口内的后续完成事件入队，窗口到期时合并成一条消息发送
   * - 这样单个 background 零延迟，多个几乎同时完成的 background 被合并防刷屏
   *
   * 含 TTL 去重（防 cancel + abort catch 双发）+ try/catch 兜底（G-025 stale runtime）。
   */
  notifyBgCompletion(record: {
    id: string;
    status: "done" | "failed" | "cancelled";
    agent?: string;
    result?: AgentResult;
    error?: string;
    endedAt?: number;
    startedAt: number;
  }): void {
    // P2: dispose 后不再发通知（session 已结束，pi 会 stale）
    if (this._disposed) return;
    const seen = getGlobalSeenMap("__subagents_bg_notify_seen__");
    const key = buildCompletionKey(
      { id: record.id, agent: record.agent, success: record.status === "done" },
      "bg-notify",
    );
    if (markSeenWithTtl(seen, key, Date.now(), BG_NOTIFY_TTL_MS)) return; // 重复，跳过

    // G-028: 首个事件立即发送，后续入合并窗口
    if (this._pendingNotifications.length === 0 && !this._mergeWindowTimer) {
      // 队列空 + 无定时器 → 立即发送这个，并启动合并窗口收集后续
      this.sendSingleNotification(record);
      this._mergeWindowTimer = setTimeout(() => {
        this._mergeWindowTimer = undefined;
        this.flushPendingNotifications();
      }, BG_MERGE_WINDOW_MS);
      this._mergeWindowTimer.unref?.();
    } else {
      // 窗口内 → 入队
      this._pendingNotifications.push(record);
    }
  }

  /** FR-O1.7: 发送单条通知（含 try/catch 兜底，G-025 stale runtime） */
  private sendSingleNotification(record: {
    id: string;
    status: "done" | "failed" | "cancelled";
    agent?: string;
    result?: AgentResult;
    error?: string;
    startedAt: number;
    endedAt?: number;
  }): void {
    const content = this.formatBgCompletionMessage(record);
    try {
      this.pi?.sendMessage(
        { customType: "subagent-bg-notify", content, display: true },
        { triggerTurn: true },
      );
    } catch {
      // G-025: stale runtime 同步抛错——不标记 background failed（agent 已完成）
      try {
        this.pi?.appendEntry("subagent-bg-record", { id: record.id, status: record.status });
      } catch {
        // 两层都 stale，放弃（结果仍可通过 getBackground 查询）
      }
    }
  }

  /** FR-O1.5 G-029: flush 合并窗口中 pending 的通知，合并为一条消息发送 */
  flushPendingNotifications(): void {
    if (this._mergeWindowTimer) {
      clearTimeout(this._mergeWindowTimer);
      this._mergeWindowTimer = undefined;
    }
    const pending = this._pendingNotifications.splice(0);
    if (pending.length === 0) return;
    // 合并为一条消息
    const lines = pending.map((r) => {
      const status = r.status === "done" ? "completed" : r.status;
      const agent = r.agent ?? "default";
      const body = (r.result?.text ?? r.error ?? "(no output)").slice(0, 200);
      return `Background task ${status}: **${agent}** (${r.id})\n  ${body}`;
    });
    const content = `${pending.length} background tasks completed:\n\n${lines.join("\n\n")}`;
    try {
      this.pi?.sendMessage(
        { customType: "subagent-bg-notify", content, display: true },
        { triggerTurn: true },
      );
    } catch {
      // stale runtime，放弃合并发送（结果仍可通过 getBackground 查询）
    }
  }

  /**
   * FR-O1.5 G-029: 清理 runtime 资源。
   * session 结束时调用，清理合并窗口定时器并 flush 残留通知。
   * P2: 设置 _disposed 标志，dispose 后 notifyBgCompletion 短路（stale pi 不调用）。
   */
  dispose(): void {
    if (this._disposed) return; // 幂等
    this._disposed = true;
    this.flushPendingNotifications();
    this.clearActiveView();
  }
}


/** ms → s 换算 */
const MS_PER_SECOND = 1000;

// 进程内单例（用 const 对象持有，避免模块级 let 触发 check-structure）
const _runtimeSlot: { current?: SubagentRuntime } = {};

export function setRuntime(rt: SubagentRuntime): void {
  _runtimeSlot.current = rt;
}

export function getRuntime(): SubagentRuntime | undefined {
  return _runtimeSlot.current;
}
