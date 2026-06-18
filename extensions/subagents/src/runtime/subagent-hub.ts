// src/runtime/subagent-hub.ts
//
// 执行编排 + 记录 + 通知领域 Hub。"跑一次子代理 + 管理执行状态"。
//
// 与 ModelConfigHub（配置/模型解析域）正交——本 Hub 持有其引用但不暴露给外部。
// executor 经 Hub 的行为方法（acquireSlot/finalizeRecord 等）操作内部组件，
// 不越级访问 pool/store/notifier/history。
//
// 上游：subagent-tool（execute/query/cancel）、TUI（onChange/listRunning/collectRecords）。
// session_start 时经 initSession 注入 pi；modelRegistry/entries 归 ModelConfigHub.initModel。

import { type ConcurrencyPool,DefaultConcurrencyPool } from "../core/concurrency-pool.ts";
import { completeRecord, project, snapshot, toPersisted } from "../core/execution-record.ts";
import type { SdkLike } from "../core/session-factory.ts";
import type { SessionRunnerContext } from "../core/session-runner.ts";
import type {
  AgentResult,
  ExecutionHandle,
  ExecutionRecord,
  QueryResult,
  RecordSnapshot,
  SubagentRecord,
} from "../types.ts";
import type { ExecuteOptions } from "../types.ts";
import { cancelBackground,execute } from "./executor.ts";
import { HistoryStore } from "./history-store.ts";
import type { ModelConfigHub } from "./model-config-hub.ts";
import type { BgNotifyRecord } from "./notifier.ts";
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

  constructor(init: SubagentHubInit) {
    this.cwd = init.cwd;
    this.modelHub = init.modelHub;
    this.pool = new DefaultConcurrencyPool(this.modelHub.getGlobalConfig().maxConcurrent);
    this.history = new HistoryStore(this.modelHub.getGlobalConfigHomeDir(), init.cwd);
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
   * 统一执行入口。sync/background 共用，mode 在 ExecuteOptions 决定。
   * 内部完成：确认（经 opts.onConfirmCategory）→ 模型解析 → executor 执行 → 收尾。
   */
  async execute(opts: ExecuteOptions): Promise<ExecutionHandle> {
    this.assertReady();
    const ctx = await this.buildSessionRunnerContext();
    return execute(opts, this, this.modelHub, ctx);
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
    return cancelBackground(record, this);
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

  // ── modelHub 委托（tool/command 层调）──────────────────────

  /** 查询 agent 配置（tool 层判 defaultBackground）。 */
  getAgentConfig(name?: string) {
    return this.modelHub.getAgentConfig(name);
  }

  /** 校验 agent 名存在（tool 层 fail-fast）。 */
  assertAgentExists(name?: string): void {
    this.modelHub.assertAgentExists(name);
  }

  // ── executor 行为方法（executor 经这些操作组件，不越级访问）──

  /** 抢并发槽（executor.runAndFinalize 调）。 */
  acquireSlot(priority: number): Promise<void> {
    return this.pool.acquire(priority);
  }

  /** 释放并发槽（executor.runAndFinalize finally 调）。 */
  releaseSlot(): void {
    this.pool.release();
  }

  /** 注册新 record（executor.createRecordForMode 调）。 */
  registerRecord(record: ExecutionRecord): void {
    this.store.register(record);
  }

  /**
   * 收尾三件套：completeRecord + store.archive + history.append。
   * executor.runAndFinalize 抢到 CAS 后调。
   */
  async finalizeRecord(
    record: ExecutionRecord,
    result: AgentResult,
    status: "done" | "failed" | "cancelled",
  ): Promise<void> {
    completeRecord(record, result, status);
    this.store.archive(record);
    await this.history.append(toPersisted(record, this.cwd));
  }

  /**
   * background 完成回注（executor.kickOffBackground / cancelBackground 调）。
   * 内部做 record → BgNotifyRecord 映射，executor 不接触映射细节。
   */
  notifyComplete(record: ExecutionRecord): void {
    this.notifier.notify(this.toNotifyRecord(record));
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

  /**
   * 构造 SessionRunnerContext。sdk lazy 获取 + 缓存。
   * factoryCtx 从 modelHub 取 modelRegistry/resolveAgent。
   */
  private async buildSessionRunnerContext(): Promise<SessionRunnerContext> {
    if (this.sdk === null) {
      const { getSdk } = await import("../core/session-factory.ts");
      this.sdk = await getSdk();
    }
    return {
      cwd: this.cwd,
      agentDir: this.modelHub.getAgentDir(),
      homeDir: this.modelHub.getGlobalConfigHomeDir(),
      factoryCtx: {
        modelRegistry: this.modelHub.getModelRegistry(),
        resolveAgent: (name: string) => this.modelHub.getAgentConfig(name),
        cwd: this.cwd,
        agentDir: this.modelHub.getAgentDir(),
        homeDir: this.modelHub.getGlobalConfigHomeDir(),
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

let _hub: SubagentHub | null = null;

/** 获取进程单例。session_start 前为 null。 */
export function getHub(): SubagentHub | null {
  return _hub;
}

/** 设置进程单例（session_start 首次创建时）。 */
export function setHub(hub: SubagentHub): void {
  _hub = hub;
}
