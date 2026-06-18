// src/runtime/runtime.ts
//
// SubagentRuntime —— 进程单例，组合 Core 所有能力。
// session_start 注入 modelRegistry + pi；session_shutdown dispose。
//
// 职责：
//   - 编排：execute() 委托 executor，record 归 store，完成回注 notifier
//   - 配置：globalConfig + sessionState（首次 category 确认拦截）
//   - 生命周期：注入/复活/dispose，跨 session 复用骨架

import { AgentRegistry } from "../core/agent-registry.ts";
import { type ConcurrencyPool,DefaultConcurrencyPool } from "../core/concurrency-pool.ts";
import { project, snapshot } from "../core/execution-record.ts";
import {
  type AgentConfig,
  inferCategory,
  type ModelRegistryLike,
  type ResolvedModel,
  resolveModelForAgent,
} from "../core/model-resolver.ts";
import { getSdk, type SdkLike } from "../core/session-factory.ts";
import type { SessionRunnerContext } from "../core/session-runner.ts";
import type {
  ExecuteOptions,
  ExecutionHandle,
  ExecutionRecord,
  QueryResult,
  RecordSnapshot,
  SessionModelState,
  SubagentRecord,
  SubagentsGlobalConfig,
} from "../types.ts";
import {
  applyCategoryConfirm,
  createSessionState,
  loadGlobalConfig,
  restoreSessionState,
  saveGlobalConfig,
} from "./config.ts";
import { cancelBackground, execute } from "./executor.ts";
import { HistoryStore } from "./history-store.ts";
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

/** Runtime 构造参数（进程级，跨 session 不变）。 */
export interface RuntimeInit {
  cwd: string;
  homeDir: string;
  agentDir: string;
}

/**
 * initSession 的入参（session 级，每次 session_start 注入）。
 * 字段来自 Pi ExtensionContext——duck-typed 解耦，runtime 不直接 import Pi 类型。
 */
export interface SessionInit {
  /** 模型注册表（鉴权 + 发现）。null 立即抛错（fail-fast）。 */
  modelRegistry: ModelRegistryLike | null;
  /** Pi API（sendMessage/appendEntry/events）。 */
  pi: PiLike;
  /** 当前 session ID（history 按 id 过滤）。 */
  sessionId: string;
  /** session 历史条目（/resume /fork 时恢复 sessionState）。 */
  entries: ReadonlyArray<{ type: string; data?: unknown }>;
}

/**
 * 进程单例 Runtime。
 *
 *   session_start(ctx):
 *     1. existing = getRuntime() ?? new SubagentRuntime(init)
 *     2. rt.initSession({ modelRegistry, pi, sessionId, entries })  ← 6 步时序封装于此
 *     3. ctx.hasUI → ctx.ui.setWidget("subagents-progress", ...)
 *     4. pruneWorktrees(cwd) + cleanupExpiredSessionFiles
 *
 *   session_shutdown:
 *     rt.dispose() + cleanupOrphanedWorktreeDirs()
 */
export class SubagentRuntime {
  globalConfig: SubagentsGlobalConfig;
  readonly sessionState: SessionModelState;
  readonly pool: ConcurrencyPool;
  readonly agentRegistry: AgentRegistry;
  readonly store: RecordStore;
  readonly notifier: BgNotifier;
  private readonly history: HistoryStore;
  private readonly cwd: string;
  private readonly homeDir: string;
  private readonly agentDir: string;

  private modelRegistry: ModelRegistryLike | null = null;
  private pi: PiLike | null = null;
  private sdk: SdkLike | null = null;
  private _disposed = false;
  private _sessionId: string | undefined;

  constructor(init: RuntimeInit) {
    this.cwd = init.cwd;
    this.homeDir = init.homeDir;
    this.agentDir = init.agentDir;
    this.globalConfig = loadGlobalConfig(init.homeDir);
    this.sessionState = createSessionState();
    this.pool = new DefaultConcurrencyPool(this.globalConfig.maxConcurrent);
    this.agentRegistry = new AgentRegistry(init.agentDir);
    this.history = new HistoryStore(init.homeDir, init.cwd);
    this.store = new RecordStore(this.history);
    this.notifier = new BgNotifier(this.piAdapter());
  }

  // ── 生命周期 ──────────────────────────────────────────────

  /**
   * session_start 注入——封装 6 步固定时序，调用方（index.ts）只需一行。
   *
   *   1. reloadGlobalConfig（复用实例时拿最新 config；首次与 load 等价）
   *   2. injectModelRegistry（fail-fast：null 抛错）
   *   3. injectPi（notifier 的 piAdapter 闭包自动读到新 pi）
   *   4. setSessionId（history 过滤用）
   *   5. revive（/resume /fork 后从 disposed 复活）
   *   6. restoreFromEntries（恢复 sessionState）
   *
   * modelRegistry/pi/sessionId/entries 都来自 session_start 的 ctx，
   * constructor 时不可用——故必须 post-construction 注入。
   */
  initSession(init: SessionInit): void {
    // 1. 重载配置（复用时拿用户手动编辑的最新值；首次与 load 等价，无副作用）
    this.globalConfig = loadGlobalConfig(this.homeDir);

    // 2. modelRegistry（fail-fast）
    if (init.modelRegistry === null) {
      throw new Error("modelRegistry is required but got null");
    }
    this.modelRegistry = init.modelRegistry;

    // 3. pi（notifier 的 host 是 piAdapter 闭包，pi 更新后闭包自然读到新值）
    this.pi = init.pi;

    // 4. sessionId
    this._sessionId = init.sessionId;

    // 5. revive（dispose 的逆操作：/resume /fork /new 后复活）
    this._disposed = false;
    this.store.revive();
    this.notifier.revive();

    // 6. 从 entries 恢复 sessionState（倒序取最新快照）
    Object.assign(this.sessionState, restoreSessionState(init.entries));
  }

  /** session 结束清理（清定时器，丢弃 pending 通知）。幂等。 */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.notifier.flushPendingNotifications();
    this.store.dispose();
    this.notifier.dispose();
  }

  // ── 执行（统一入口，委托 executor）──────────────────────

  /**
   * 统一执行入口。sync/background 共用，mode 在 ExecuteOptions 决定。
   * 委托 executor.execute，内部完成 SessionRunner.run + store.archive + history。
   */
  async execute(opts: ExecuteOptions): Promise<ExecutionHandle> {
    this.assertReady();
    const ctx = await this.buildSessionRunnerContext();
    return execute(opts, this, ctx);
  }

  /** poll(backgroundId)：查 record 并投影为 QueryResult。不存在 throw。 */
  query(id: string): QueryResult {
    this.assertReady();
    const record = this.store.getMutable(id);
    if (!record) throw new Error(`No subagent record with id "${id}"`);
    return this.recordToQueryResult(record);
  }

  /** 取消 background record（tryTransition CAS 抢锁防重复副作用）。sync 无法主动 abort。 */
  cancel(id: string): boolean {
    this.assertReady();
    const record = this.store.getMutable(id);
    if (!record) return false;
    return cancelBackground(record, this);
  }

  // ── Model 解析 ──────────────────────────────────────────

  /** 解析 agent 的 model + thinkingLevel（执行前调，结果传入 SessionRunner）。 */
  resolveModelForAgent(
    agentName?: string,
    paramOverride?: { model?: string; thinkingLevel?: string },
  ): ResolvedModel | undefined {
    this.assertReady();
    const name = agentName ?? "default";
    const agentConfig = this.agentRegistry.get(name);
    const category = inferCategory(
      name,
      agentConfig,
      this.globalConfig.agentCategoryOverrides,
      "general",
    );
    try {
      return resolveModelForAgent({
        agentName: name,
        agentConfig,
        category,
        globalConfig: this.globalConfig,
        sessionState: this.sessionState,
        modelRegistry: this.modelRegistry!,
        paramOverride,
      });
    } catch {
      return undefined; // 调用方决定静默/抛错
    }
  }

  /** 查询 agent 配置（供 tool 判定 defaultBackground）。 */
  getAgentConfig(name?: string): AgentConfig | undefined {
    return name ? this.agentRegistry.get(name) : undefined;
  }

  /** 校验 agent 名存在（fail-fast，未知 agent 不静默运行为 generic agent）。 */
  assertAgentExists(name?: string): void {
    if (name) this.agentRegistry.get(name, true);
  }

  // ── Store 委托（TUI 只读访问）──────────────────────────

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
    return this.store.collectRecords(limit, this._sessionId);
  }

  /** 持久化全局配置（config-wizard 调用）。 */
  saveGlobalConfig(): Promise<void> {
    return saveGlobalConfig(this.homeDir, this.globalConfig);
  }

  // ── 内部 ────────────────────────────────────────────────

  /** 校验 runtime 就绪（modelRegistry 已注入 + 未 dispose）。 */
  private assertReady(): void {
    if (this.modelRegistry === null) {
      throw new Error("modelRegistry not injected (session_start not called?)");
    }
    if (this._disposed) {
      throw new Error("runtime disposed");
    }
  }

  /**
   * 构造 SessionRunnerContext。sdk lazy 获取 + 缓存（首次 execute 时 dynamic import）。
   * factoryCtx 封装 modelRegistry/resolveAgent/cwd/agentDir/homeDir。
   */
  private async buildSessionRunnerContext(): Promise<SessionRunnerContext> {
    if (this.sdk === null) {
      this.sdk = await getSdk();
    }
    return {
      cwd: this.cwd,
      agentDir: this.agentDir,
      homeDir: this.homeDir,
      factoryCtx: {
        modelRegistry: this.modelRegistry!,
        resolveAgent: (name: string) => this.agentRegistry.get(name),
        cwd: this.cwd,
        agentDir: this.agentDir,
        homeDir: this.homeDir,
      },
      sdk: this.sdk,
    };
  }

  /** notifier 的 NotifierHost 适配器（绑定到 pi.sendMessage）。 */
  private piAdapter(): { sendMessage: PiLike["sendMessage"] } {
    return {
      sendMessage: (message, options) => {
        this.pi?.sendMessage(message, options);
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

  /** notifier 访问器（executor 调用）。 */
  getNotifier(): BgNotifier {
    return this.notifier;
  }

  /** history 访问器（executor 写入执行记录用）。 */
  getHistory(): HistoryStore {
    return this.history;
  }

  /** applyCategoryConfirm 委托（tool 首次确认后调）。 */
  applyCategoryConfirm(result: {
    action: "confirmed" | "cancelled";
    overrides: Record<string, { model: string; thinkingLevel?: string }>;
  }): void {
    if (result.action === "confirmed") {
      applyCategoryConfirm(this.sessionState, result);
    }
  }
}

// ============================================================
// 进程单例访问器（session_start 重建）
// ============================================================

let _runtime: SubagentRuntime | null = null;

/** 获取进程单例。session_start 前为 null。 */
export function getRuntime(): SubagentRuntime | null {
  return _runtime;
}

/** 设置进程单例（session_start 首次创建时）。 */
export function setRuntime(rt: SubagentRuntime): void {
  _runtime = rt;
}
