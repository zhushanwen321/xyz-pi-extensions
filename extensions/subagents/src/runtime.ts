// src/runtime.ts
import * as path from "node:path";

import { loadGlobalConfig, saveGlobalConfig } from "./config/global-config.ts";
import { runAgent, type RunAgentContext } from "./core/run-agent.ts";
import { createManagedSession } from "./core/session.ts";
import { HistoryStore, buildPersistedRecord } from "./persistence/history-store.ts";
import { DefaultConcurrencyPool } from "./pool/concurrency-pool.ts";
import { AgentRegistry } from "./registry/agent-registry.ts";
import { BuiltinAgentRegistry } from "./registry/builtin-agents.ts";
import { type ModelRegistryLike,resolveModelForAgent } from "./resolution/model-resolver.ts";
import { createSessionModelState, restoreState, serializeState, setAgentModel, setCategoryModel } from "./state/session-model-state.ts";
import { AgentWidgetManager, type WidgetAgentState, type WidgetUI } from "./tui/agent-widget.ts";
import { extractLabelFromArgs } from "./tui/format.ts";
import {
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
  MAX_EVENT_LOG_ENTRIES,
  type RunAgentOptions,
  type SessionModelState,
  type SubagentHooks,
  type SubagentsGlobalConfig,
  THINKING_CHUNK,
  TEXT_OUTPUT_CHUNK,
  TURN_SUMMARY_MAX,
} from "./types.ts";

/** Pi ExtensionAPI 的最小接口（duck-typed，用于 appendEntry / events.emit） */
interface PiLike {
  appendEntry(customType: string, data?: unknown): void;
  events: { emit(channel: string, data: unknown): void };
}

/** background id 的时间戳进制（base36 紧凑表示） */
const BG_ID_RADIX = 36;
/** widget 摘要截断长度 */
const WIDGET_SUMMARY_MAX = 100;
/** widget 完成状态淡出延迟（ms） */
const WIDGET_LINGER_MS = 5000;

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

  /** FR-3.4: 事件总线，供 overlay 视图订阅实时刷新 */
  private readonly _changeListeners = new Set<() => void>();

  /** FR-3.0: 已完成 sync agent 归档记录 */
  private readonly _completedAgents = new Map<string, CompletedAgentRecord>();

  /** ADR-024 L1: 执行记录持久化（跨进程历史） */
  private readonly _history: HistoryStore;

  /** FR-3.1 G-017: 活跃 overlay 句柄（防叠加） */
  private _activeView: { close: () => void } | null = null;

  /** Live widget 管理器（实时显示 agent 状态） */
  readonly widget = new AgentWidgetManager();

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

  /** session_start 时注入 UI（用于 live widget 渲染） */
  attachWidgetUI(ui: WidgetUI): void {
    this.widget.attachUI(ui);
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

    // Live widget: 注册 running 状态
    const widgetId = `run-${++this._widgetSeq}`;
    const startTime = Date.now();
    const widgetState: WidgetAgentState = {
      id: widgetId,
      agent: opts.agent ?? "default",
      status: "running",
      elapsedSeconds: 0,
      eventLog: [],
    };
    this.widget.updateAgent(widgetState);
    this.notifyChange();

    // 拦截 onEvent 更新 widget（turns/tokens/activity + eventLog）
    const userOnEvent = opts.onEvent;
    finalOpts = {
      ...opts,
      onEvent: (event) => {
        userOnEvent?.(event);
        updateWidgetFromEvent(widgetState, event, startTime);
        this.widget.updateAgent(widgetState);
        this.notifyChange();
      },
    };

    for (const h of this.hooks) {
      if (h.beforeRun) finalOpts = await h.beforeRun(finalOpts);
    }
    try {
      const result = await runAgent(finalOpts, ctx);
      // widget: 更新为完成状态
      widgetState.status = result.success ? "done" : "failed";
      widgetState.turns = result.turns;
      widgetState.totalTokens = result.usage
        ? result.usage.input + result.usage.output + result.usage.cacheRead + result.usage.cacheWrite
        : undefined;
      widgetState.summary = result.text.slice(0, WIDGET_SUMMARY_MAX);
      widgetState.finishedAt = Date.now();
      this.widget.updateAgent(widgetState);
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
        this.widget.removeAgent(widgetId);
        this.notifyChange();
      }, WIDGET_LINGER_MS);

      for (const h of this.hooks) {
        if (h.afterRun) h.afterRun(result, finalOpts);
      }
      // ADR-024 L1: 持久化执行记录（best-effort，不阻塞 return）
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
      return result;
    } catch (err) {
      // FR-3.5 G-025: 用户主动 abort → cancelled；其他 → failed
      widgetState.status = finalOpts.signal?.aborted ? "cancelled" : "failed";
      widgetState.summary = err instanceof Error ? err.message : String(err);
      widgetState.finishedAt = Date.now();
      this.widget.updateAgent(widgetState);
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
        this.widget.removeAgent(widgetId);
        this.notifyChange();
      }, WIDGET_LINGER_MS);

      for (const h of this.hooks) {
        if (h.onError) h.onError(err instanceof Error ? err : new Error(String(err)), finalOpts);
      }
      // ADR-024 L1: 失败/取消也持久化记录
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
    this.notifyChange();

    // detached：不 await，完成后回填
    // runAgent 内部创建 widgetState（widgetId="run-N"），5s 后归档到 _completedAgents。
    // 但 background agent 的权威数据源是 _bgRecords（id="bg-N-..."）。
    // 因此 runAgent 完成时，同时把 eventLog 写入 BgRecord。
    const signal = opts.signal ?? controller.signal;
    this.runAgent({ ...opts, signal })
      .then((result) => {
        record.result = result;
        record.status = result.success ? "done" : "failed";
        record.endedAt = Date.now();
        record.eventLog = this.widget.listAgents().find((a) => a.id.startsWith("run-"))?.eventLog ?? [];
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
        this.notifyChange();
      })
      .catch((err: unknown) => {
        record.status = "failed";
        record.error = err instanceof Error ? err.message : String(err);
        record.endedAt = Date.now();
        record.eventLog = this.widget.listAgents().find((a) => a.id.startsWith("run-"))?.eventLog ?? [];
        record.agent = opts.agent ?? "default";
        delete record.controller;
        opts.onComplete?.(record);
        this.pi?.events.emit("subagents:bg:done", record);
        // ADR-024 L1: background 失败持久化
        void this._history.append(
          buildPersistedRecord({
            id,
            agent: record.agent,
            status: "failed",
            mode: "background",
            task: opts.task,
            startedAt: record.startedAt,
            endedAt: record.endedAt,
            error: record.error,
            cwd: this.cwd,
          }),
        );
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

  /** 持久化全局配置（供 config-wizard 调用） */
  saveGlobalConfig(): Promise<void> {
    return saveGlobalConfig(this.homeDir, this.globalConfig);
  }
}

/**
 * 从 AgentEvent 更新 widget 状态（turns/tokens/activity + eventLog 追加）。
 * FR-1.1b: text_delta 累加，turn_end 切片生成摘要。
 * FR-1.3: tool_start/tool_end/turn_end push 到 eventLog（ring buffer）。
 */
export function updateWidgetFromEvent(
  state: WidgetAgentState,
  event: {
    type: string;
    toolName?: string;
    args?: unknown;
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    delta?: string;
    isError?: boolean;
  },
  startTime: number,
): void {
  const s = state;
  if (!s.eventLog) s.eventLog = [];

  switch (event.type) {
    case "tool_start": {
      const label = extractLabelFromArgs(event.toolName ?? "working", event.args);
      s.activity = event.toolName ?? "working";
      s.eventLog.push({ type: "tool_start", label, ts: Date.now(), status: "running" });
      break;
    }
    case "tool_end": {
      const label = extractLabelFromArgs(event.toolName ?? "working", event.args);
      s.activity = "thinking…";
      s.eventLog.push({ type: "tool_end", label, ts: Date.now(), status: event.isError ? "failed" : "done" });
      break;
    }
    case "text_delta": {
      s._currentTurnText = (s._currentTurnText ?? "") + (event.delta ?? "");
      // FR-1.1b: 节流切片——累计达 TEXT_OUTPUT_CHUNK 产生一条 text_output log entry
      if ((s._currentTurnText ?? "").length >= TEXT_OUTPUT_CHUNK) {
        s.eventLog.push({ type: "text_output", label: s._currentTurnText!.slice(0, 100), ts: Date.now() });
        s._currentTurnText = "";
      }
      break;
    }
    case "thinking_delta": {
      s._currentThinking = (s._currentThinking ?? "") + (event.delta ?? "");
      // FR-1.1a: 节流切片——累计达 THINKING_CHUNK 产生一条 thinking log entry
      if ((s._currentThinking ?? "").length >= THINKING_CHUNK) {
        s.eventLog.push({ type: "thinking", label: s._currentThinking!.slice(0, 100), ts: Date.now() });
        s._currentThinking = "";
      }
      break;
    }
    case "turn_end": {
      // FR-1.1b: flush 残留的 text/thinking 缓冲。
      // 注意：先取 summary 再 flush——turn_end 的 label 用本 turn 的完整文本，
      // 同时 text_output entry 切片独立产出（与 summary 不互斥）。
      const turnSummary = (s._currentTurnText ?? "").slice(0, TURN_SUMMARY_MAX);
      if (s._currentTurnText) {
        s.eventLog.push({ type: "text_output", label: s._currentTurnText.slice(0, 100), ts: Date.now() });
        s._currentTurnText = "";
      }
      if (s._currentThinking) {
        s.eventLog.push({ type: "thinking", label: s._currentThinking.slice(0, 100), ts: Date.now() });
        s._currentThinking = "";
      }
      s.eventLog.push({ type: "turn_end", label: turnSummary, ts: Date.now() });
      s.turns = (s.turns ?? 0) + 1;
      break;
    }
    case "message_end": {
      if (event.usage) {
        s.totalTokens = (s.totalTokens ?? 0) + event.usage.input + event.usage.output + event.usage.cacheRead + event.usage.cacheWrite;
      }
      break;
    }
    default:
      break;
  }

  // Ring buffer: 超上限移除最旧
  while (s.eventLog.length > MAX_EVENT_LOG_ENTRIES) {
    s.eventLog.shift();
  }
  s.elapsedSeconds = Math.floor((Date.now() - startTime) / MS_PER_SECOND);
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
