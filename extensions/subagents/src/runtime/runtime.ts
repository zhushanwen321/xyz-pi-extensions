// src/runtime/runtime.ts
//
// SubagentRuntime —— 进程单例，组合 Core 所有能力。
// session_start 注入 modelRegistry + pi；session_shutdown dispose。
//
// 职责：
//   - 编排：execute() 委托 executor，record 归 store，完成回注 notifier
//   - 配置：globalConfig + sessionState（首次 category 确认拦截）
//   - 生命周期：注入/复活/dispose，跨 session 复用骨架

import * as path from "node:path";

import { AgentRegistry } from "../core/agent-registry.ts";
import { type ConcurrencyPool } from "../core/concurrency-pool.ts";
import type {
  AgentConfig,
  ModelRegistryLike,
  ResolvedModel,
} from "../core/model-resolver.ts";
import type { ExecuteOptions, ExecutionHandle, QueryResult, SessionModelState, SubagentsGlobalConfig } from "../types.ts";
import { createSessionState, loadGlobalConfig, restoreSessionState } from "./config.ts";
import { execute } from "./executor.ts";
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

/** Runtime 构造参数。 */
export interface RuntimeInit {
  cwd: string;
  homeDir: string;
  agentDir: string;
}

/**
 * 进程单例 Runtime。
 *
 *   ╔══════════════════════════════════════════════════════════════════╗
//   ║  session_start(ctx):                                               ║
//   ║    1. existing = getRuntime() ?? new SubagentRuntime(init)         ║
//   ║    2. rt.injectModelRegistry(ctx.modelRegistry)                    ║
//   ║    3. rt.injectPi(pi)  + rt.setSessionId(ctx.sessionManager.id)    ║
//   ║    4. rt.revive()  （/resume /fork 后复活 dispose 状态）           ║
//   ║    5. rt.restoreFromEntries(ctx.sessionManager.getEntries())       ║
//   ║    6. ctx.hasUI → ctx.ui.setWidget("subagents-progress", ...)      ║
//   ║    7. pruneWorktrees(cwd) + cleanupExpiredSessionFiles             ║
//   ║                                                                    ║
//   ║  session_shutdown:                                                 ║
//   ║    rt.dispose() + cleanupOrphanedWorktreeDirs()                    ║
//   ╚══════════════════════════════════════════════════════════════════╝
 */
export class SubagentRuntime {
  globalConfig: SubagentsGlobalConfig;
  readonly sessionState: SessionModelState;
  readonly pool: ConcurrencyPool;
  readonly agentRegistry: AgentRegistry;
  readonly store: RecordStore;
  readonly notifier: BgNotifier;
  private readonly history: HistoryStore;

  private modelRegistry: ModelRegistryLike | null = null;
  private pi: PiLike | null = null;
  private _disposed = false;
  private _sessionId: string | undefined;

  constructor(init: RuntimeInit) {
    this.globalConfig = loadGlobalConfig(init.homeDir);
    this.sessionState = createSessionState();
    //  初始化 pool（maxConcurrent 来自 globalConfig）、agentRegistry、history、store、notifier
    void path; void restoreSessionState; void execute;
    throw new Error("not implemented");
  }

  // ── 生命周期 ──────────────────────────────────────────────

  /** 注入 modelRegistry（session_start）。null 立即抛错（fail-fast）。 */
  injectModelRegistry(registry: ModelRegistryLike | null): void {
    //  null → throw；否则 this.modelRegistry = registry
    void registry;
    throw new Error("not implemented");
  }

  /** 注入 pi（sendMessage/appendEntry/events）。 */
  injectPi(pi: PiLike): void {
    //  this.pi = pi; notifier 绑定 pi 作为 NotifierHost
    void pi;
    throw new Error("not implemented");
  }

  /** 设置当前 sessionId（history 按 id 过滤）。 */
  setSessionId(id: string): void {
    //  this._sessionId = id
    void id;
    throw new Error("not implemented");
  }

  /** 从 entries 恢复 session 状态（/resume）。 */
  restoreFromEntries(entries: ReadonlyArray<{ type: string; data?: unknown }>): void {
    //  restoreSessionState(entries) → 合并到 this.sessionState
    void entries;
    throw new Error("not implemented");
  }

  /** 重新加载全局配置（跨进程/手动编辑 config.json 后）。 */
  reloadGlobalConfig(): void {
    //  this.globalConfig = loadGlobalConfig(this.homeDir)
    throw new Error("not implemented");
  }

  /** dispose 的逆操作（/resume /fork /new 后复活）。 */
  revive(): void {
    //  this._disposed = false; store.revive(); notifier.revive()
    throw new Error("not implemented");
  }

  /** session 结束清理（清定时器，丢弃 pending 通知）。 */
  dispose(): void {
    //  幂等；_disposed=true; store.dispose(); notifier.dispose()
    throw new Error("not implemented");
  }

  // ── 执行（统一入口，委托 executor）──────────────────────

  /**
   * 统一执行入口。sync/background 共用，mode 在 ExecuteOptions 决定。
   * 委托 executor.execute，内部完成 SessionRunner.run + store.archive + history。
   */
  execute(opts: ExecuteOptions): Promise<ExecutionHandle> {
    //  this.assertReady()
    //  → execute(opts, this, { cwd, agentDir, homeDir })
    void opts;
    throw new Error("not implemented");
  }

  /** poll(backgroundId)：查 record 并投影为 QueryResult。不存在 throw。 */
  query(id: string): QueryResult {
    //  store.snapshot(id) → 不存在 throw；存在则展平为 QueryResult
    void id;
    throw new Error("not implemented");
  }

  /** 取消 background record（_settled 守卫防重复副作用）。sync 无法主动 abort。 */
  cancel(id: string): boolean {
    //  store.getMutable(id) → executor.cancelBackground(record, this)
    void id;
    throw new Error("not implemented");
  }

  // ── Model 解析 ──────────────────────────────────────────

  /** 解析 agent 的 model + thinkingLevel（执行前调，结果传入 SessionRunner）。 */
  resolveModelForAgent(
    agentName?: string,
    paramOverride?: { model?: string; thinkingLevel?: string },
  ): ResolvedModel | undefined {
    //  agentRegistry.discoverAll → resolveModelForAgent(...)
    //  失败 → undefined（调用方决定静默/抛错）
    void agentName; void paramOverride;
    throw new Error("not implemented");
  }

  /** 查询 agent 配置（供 tool 判定 defaultBackground）。 */
  getAgentConfig(name?: string): AgentConfig | undefined {
    //  agentRegistry.discoverAll → get(name)
    void name;
    throw new Error("not implemented");
  }

  /** 校验 agent 名存在（fail-fast，未知 agent 不静默运行为 generic agent）。 */
  assertAgentExists(name?: string): void {
    //  name && agentRegistry.get(name, require=true)
    void name;
    throw new Error("not implemented");
  }

  // ── Store 委托（TUI 只读访问）──────────────────────────

  /** 订阅 store 变更（widget/list requestRender）。返回取消订阅。 */
  onChange(listener: () => void): () => void {
    //  store.onChange(listener)
    void listener;
    throw new Error("not implemented");
  }

  /** 列出 running record 快照（widget 计数用）。 */
  listRunning(): import("../types.ts").RecordSnapshot[] {
    //  store.listRunning()
    throw new Error("not implemented");
  }

  /** 合并四源 record（/subagents list 消费）。 */
  collectRecords(limit: number): import("../types.ts").SubagentRecord[] {
    //  store.collectRecords(limit, this._sessionId)
    void limit;
    throw new Error("not implemented");
  }

  /** 持久化全局配置（config-wizard 调用）。 */
  saveGlobalConfig(): Promise<void> {
    //  saveGlobalConfig(this.homeDir, this.globalConfig)
    throw new Error("not implemented");
  }

  // ── 内部 ────────────────────────────────────────────────

  /** 校验 runtime 就绪（modelRegistry 已注入 + 未 dispose）。 */
  private assertReady(): void {
    //  !this.modelRegistry → throw "modelRegistry not injected"
    //  this._disposed → throw "runtime disposed"
    throw new Error("not implemented");
  }

  /** notifier 访问器（executor 调用）。 */
  getNotifier(): BgNotifier {
    //  return this.notifier
    throw new Error("not implemented");
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
