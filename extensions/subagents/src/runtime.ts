// src/runtime.ts
import { loadGlobalConfig, saveGlobalConfig } from "./config/global-config.ts";
import { runAgent, type RunAgentContext } from "./core/run-agent.ts";
import { createManagedSession } from "./core/session.ts";
import { DefaultConcurrencyPool } from "./pool/concurrency-pool.ts";
import { AgentRegistry } from "./registry/agent-registry.ts";
import { BuiltinAgentRegistry } from "./registry/builtin-agents.ts";
import { type ModelRegistryLike,resolveModelForAgent } from "./resolution/model-resolver.ts";
import { createSessionModelState, restoreState, serializeState, setAgentModel, setCategoryModel } from "./state/session-model-state.ts";
import { AgentWidgetManager, type WidgetAgentState, type WidgetUI } from "./tui/agent-widget.ts";
import type {
  AgentResult,
  BackgroundHandle,
  BackgroundOptions,
  BackgroundStatus,
  CategoryDefinition,
  ConcurrencyPool,
  ManagedSession,
  ManagedSessionOptions,
  RunAgentOptions,
  SessionModelState,
  SubagentHooks,
  SubagentsGlobalConfig,
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
  }

  /** FR-11.5: session_start 时注入 modelRegistry，触发 agent 发现 */
  injectModelRegistry(registry: ModelRegistryLike): void {
    this.modelRegistry = registry;
    this.agentRegistry.discoverAll(this.builtinRegistry);
  }

  /** session_start 时注入 pi（用于 appendEntry 持久化 + events.emit 跨扩展通知） */
  injectPi(pi: PiLike): void {
    this.pi = pi;
  }

  /** session_start 时注入 UI（用于 live widget 渲染） */
  attachWidgetUI(ui: WidgetUI): void {
    this.widget.attachUI(ui);
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
    };
    this.widget.updateAgent(widgetState);

    // 拦截 onEvent 更新 widget（turns/tokens/activity）
    const userOnEvent = opts.onEvent;
    finalOpts = {
      ...opts,
      onEvent: (event) => {
        userOnEvent?.(event);
        updateWidgetFromEvent(widgetState, event, startTime);
        this.widget.updateAgent(widgetState);
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
      // 5 秒后清理
      setTimeout(() => this.widget.removeAgent(widgetId), WIDGET_LINGER_MS);

      for (const h of this.hooks) {
        if (h.afterRun) h.afterRun(result, finalOpts);
      }
      return result;
    } catch (err) {
      widgetState.status = "failed";
      widgetState.summary = err instanceof Error ? err.message : String(err);
      widgetState.finishedAt = Date.now();
      this.widget.updateAgent(widgetState);
      setTimeout(() => this.widget.removeAgent(widgetId), WIDGET_LINGER_MS);

      for (const h of this.hooks) {
        if (h.onError) h.onError(err instanceof Error ? err : new Error(String(err)), finalOpts);
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
    const id = `bg-${++this._bgSeq}-${Date.now().toString(BG_ID_RADIX)}`;
    const controller = new AbortController();
    const record: BgRecord = { id, status: "running", startedAt: Date.now(), controller };
    this._bgRecords.set(id, record);

    // detached：不 await，完成后回填
    const signal = opts.signal ?? controller.signal;
    this.runAgent({ ...opts, signal })
      .then((result) => {
        record.result = result;
        record.status = result.success ? "done" : "failed";
        record.endedAt = Date.now();
        delete record.controller;
        opts.onComplete?.(record);
        this.pi?.events.emit("subagents:bg:done", record);
        this.pi?.appendEntry("subagent-bg-record", {
          id,
          agent: opts.agent,
          status: record.status,
          sessionId: result.sessionId,
        });
      })
      .catch((err: unknown) => {
        record.status = "failed";
        record.error = err instanceof Error ? err.message : String(err);
        record.endedAt = Date.now();
        delete record.controller;
        opts.onComplete?.(record);
        this.pi?.events.emit("subagents:bg:done", record);
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

/** 从 AgentEvent 更新 widget 状态（turns/tokens/activity） */
function updateWidgetFromEvent(
  state: WidgetAgentState,
  event: { type: string; toolName?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } },
  startTime: number,
): void {
  const s = state as WidgetAgentState & { turns: number; totalTokens: number; elapsedSeconds: number };
  switch (event.type) {
    case "turn_end":
      s.turns = (s.turns ?? 0) + 1;
      break;
    case "message_end":
      if (event.usage) {
        s.totalTokens = (s.totalTokens ?? 0) + event.usage.input + event.usage.output + event.usage.cacheRead + event.usage.cacheWrite;
      }
      break;
    case "tool_start":
      s.activity = event.toolName ?? "working";
      break;
    case "tool_end":
      s.activity = "thinking…";
      break;
    default:
      break;
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
