// src/runtime/subagent-service.ts
//
// 执行编排 + 记录 + 通知领域 Service。"跑一次子代理 + 管理执行状态"。
//
// 与 ModelConfigService（配置/模型解析域）正交——本 Service 持有其引用但不暴露给外部。
// executor 逻辑已合并进本文件——它是 SubagentService.execute 的编排逻辑，
// 没有独立状态/生命周期，不需要独立文件。合并后行为方法自然 private。
//
// 上游：subagent-tool（execute/query/cancel）、TUI（onChange/listRunning/collectRecords）。
// session_start 时经 initSession 注入 pi；modelRegistry/entries 归 ModelConfigService.initModel。

import { type ConcurrencyPool,DefaultConcurrencyPool } from "../core/concurrency-pool.ts";
import {
  completeRecord,
  createRecord,
  project,
  snapshot,
  tryTransition,
} from "../core/execution-record.ts";
import type { AgentConfig, ModelInfo } from "../core/model-resolver.ts";
import { getSdk, getSubagentSessionDir, run, type SessionRunnerContext } from "../core/session-runner.ts";
import type { SdkLike, WorktreeHandle } from "../types.ts";
import type {
  AgentEvent,
  AgentResult,
  ExecuteOptions,
  ExecutionHandle,
  ExecutionMode,
  ExecutionRecord,
  RecordSnapshot,
  ResolvedModel,
  SubagentRecord,
  SubagentToolDetails,
} from "../types.ts";
import { DEFAULT_AGENT_NAME } from "../types.ts";
import { removeAliveMarker } from "./execution/alive-store.ts";
import { writeFinalized } from "./execution/finalized-marker.ts";
import type { BgNotifyRecord, NotifierHost } from "./execution/notifier.ts";
import { BgNotifier } from "./execution/notifier.ts";
import type { StatusFilter } from "./execution/record-store.ts";
import { RecordStore } from "./execution/record-store.ts";
import { writeCancelledTombstone } from "./execution/tombstone-store.ts";
import type { ModelConfigService } from "./model-config-service.ts";
import { WorktreeManager } from "./worktree-manager.ts";

/** Pi ExtensionAPI 的最小接口（duck-typed）。 */
interface PiLike {
  appendEntry(customType: string, data?: unknown): void;
  events: { emit(channel: string, data: unknown): void };
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
}

/** Service 构造参数（进程级）。 */
export interface SubagentServiceInit {
  cwd: string;
  /** 配置/模型域 Service（execute 内部调其 resolveModel）。 */
  modelService: ModelConfigService;
  /** 缓存的主 session file 获取函数（fork source 解析用）。 */
  getMainSessionFile?: () => string | undefined;
}

/** session_start 注入参数（session 级）。 */
export interface SubagentServiceSessionInit {
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
 * 执行编排 Service。进程级单例。
 *
 *   session_start:
 *     1. modelService = getModelConfigService() ?? new ModelConfigService({homeDir, agentDir})
 *     2. service = getSubagentService() ?? new SubagentService({cwd, modelService})
 *     3. modelService.initModel({modelRegistry, sessionId, entries})
 *     4. service.initSession({pi, sessionId})
 *
 *   session_shutdown:
 *     service.dispose()
 */
export class SubagentService {
  private readonly pool: ConcurrencyPool;
  private readonly store: RecordStore;
  private readonly notifier: BgNotifier;
  private readonly modelService: ModelConfigService;
  private readonly cwd: string;
  private readonly worktreeManager: WorktreeManager;
  private readonly getMainSessionFile: (() => string | undefined) | undefined;

  private pi: PiLike | null = null;
  private sdk: SdkLike | null = null;
  private _disposed = false;
  private _seq = 0;

  constructor(init: SubagentServiceInit) {
    this.cwd = init.cwd;
    this.modelService = init.modelService;
    this.getMainSessionFile = init.getMainSessionFile;
    this.pool = new DefaultConcurrencyPool(this.modelService.getGlobalConfig().maxConcurrent);
    this.worktreeManager = new WorktreeManager();
    const sessionsDir = getSubagentSessionDir(this.modelService.getAgentDir(), init.cwd);
    this.store = new RecordStore(sessionsDir);
    this.notifier = new BgNotifier(this.piAdapter());
  }

  // ── 生命周期（index.ts 调）──────────────────────────────

  /** session_start 注入 pi + revive（modelRegistry/entries 归 ModelConfigService.initModel）。 */
  initSession(init: SubagentServiceSessionInit): void {
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
   * 代理 modelService.resolveModel——renderCall 在 execute 前调用，但 model 解析是同步的，
   * 让标题行能提前显示 model/thinking，不必等 execute。
   * hub 未就绪时抛（调用方 catch 降级）。
   *
   * 注意：renderCall 无 ctx，拿不到主 agent model。这里仅解析 override/agentConfig 路径，
   * 主 agent model 路径交给 execute（传 ctxModel）。renderCall 时如果用户未显式 override，
   * 本方法会因 ctxModel 缺失走第三层→ 拋错→ 调用方 catch 降级（不显示 model）。
   */
  resolveModel(
    agent: string,
    override?: { model?: string; thinkingLevel?: string },
    ctxModel?: ModelInfo,
  ): ResolvedModel {
    return this.modelService.resolveModel(agent, override, ctxModel);
  }

  /**
   * 统一执行入口。sync/background 共用，mode 由 opts.wait + agentConfig.defaultBackground 判定。
   * 内部完成：mode 判定 → 确认（经回调）→ 模型解析 → 执行 → 收尾。
   *
   * mode 判定规则（内化在 Service，不暴露给 tool 层）：
   *   wait === false → background（用户显式要求异步）
   *   wait === true → sync（用户显式要求同步）
   *   wait === undefined + agentConfig.defaultBackground === true → background
   *   否则 → sync
   *
   * @param opts.ctxModel  主 agent 当前模型（模型解析第三层兼底）。undefined 时仅依赖 override/agentConfig。
   */
  async execute(opts: ExecuteOptions): Promise<ExecutionHandle> {
    this.assertReady();

    // mode 判定（业务规则归 Service，tool 层只传 wait 意图）
    const mode = this.resolveMode(opts);
    const ctx = await this.buildSessionRunnerContext(opts.cwd);

    // ── 1. IDENTITY 解析（确认 → agentConfig → resolveModel）──
    const identity = await this.resolveIdentity(opts);

    // ── 2. RECORD 创建 + 注册 ──
    const record = this.createRecordForMode(identity, opts, mode);

    // ── 2.5 worktree 创建（fork=true 且未提供 handle 时）──
    // record 先创建，worktree 失败时可 finalizeFailed（record 已在 store 中）。
    let worktreeHandle: WorktreeHandle | undefined;
    if (typeof opts.worktree === "object") {
      // 传入的是已创建的 WorktreeHandle
      worktreeHandle = opts.worktree;
    } else if (opts.fork && opts.worktree === true) {
      // worktree=true，创建新 worktree
      try {
        worktreeHandle = this.worktreeManager.create(this.cwd, record.id);
        record.worktreeHandle = worktreeHandle;
      } catch (err) {
        // create 失败→不进入 run，合成 failed result
        const _result = await this.finalizeFailed(record, err);
        return { mode, record: snapshot(record), details: project(record) } as ExecutionHandle;
      }
    } else if (opts.fork && opts.worktree !== false) {
      // fork=true 但 worktree 未指定或 undefined，也创建 worktree
      try {
        worktreeHandle = this.worktreeManager.create(this.cwd, record.id);
        record.worktreeHandle = worktreeHandle;
      } catch (err) {
        // create 失败→不进入 run，合成 failed result
        const _result = await this.finalizeFailed(record, err);
        return { mode, record: snapshot(record), details: project(record) } as ExecutionHandle;
      }
    }

    // ── 3. MODE 分叉：signal/priority（仅此 2 处即时差异）──
    const signal = mode === "background"
      ? record.controller!.signal
      : opts.signal;
    const priority = mode === "background" ? PRIORITY_BACKGROUND : PRIORITY_SYNC;

    // ── 4-7. sync 直接 await；background 包 detached 立即返回 id ──
    if (mode === "sync") {
      await this.runAndFinalize(record, { ...opts, worktree: worktreeHandle }, ctx, identity, signal, priority);
      return { mode: "sync", record: snapshot(record), details: project(record) };
    }

    // background：立即返回 subagentId + sessionFile（窗口期可能 undefined）+ details（status=running）。
    // 步骤 4-6 在 detached promise 里跑。
    // B1：background 不回流 onUpdate——detached 运行对 tool 层不可见，完成由 notify 驱动新 turn。
    // 若转发 onUpdate，liftSync 会把 bg 事件误标成 syncResponse(mode:"sync") → spinner setInterval 泄漏。
    const bgDetails = project(record);
    this.kickOffBackground(record, { ...opts, onUpdate: undefined, worktree: worktreeHandle }, ctx, identity, signal, priority);
    return { mode: "background", subagentId: record.id, sessionFile: record.sessionFile, details: bgDetails };
  }

  /**
   * 按 id 查内存 running record 的只读快照（G3-002 修复）。
   * 不从 session.jsonl 重建（cancel/list 单点查询只关心内存 running record）。
   * 供 tool 层 cancelHandler 翻译 throw 用（id 不存在 / mode / 终态三种错误）。
   * 不存在返回 undefined。
   */
  findRecord(id: string): RecordSnapshot | undefined {
    this.assertReady();
    const record = this.store.getMutable(id);
    return record ? snapshot(record) : undefined;
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

  /** 合并内存(running) + 磁盘(session.jsonl 重建) record（/subagents list + tool list 消费）。 */
  collectRecords(limit: number, statusFilter: StatusFilter = "all"): SubagentRecord[] {
    return this.store.collectRecords(limit, statusFilter);
  }

  // ── 执行内部：mode 判定 + 身份解析 + record 创建 ──────────

  /** mode 业务规则：wait 显式 > agentConfig.defaultBackground > sync 兜底。 */
  private resolveMode(opts: ExecuteOptions): ExecutionMode {
    if (opts.wait === false) return "background";
    if (opts.wait === true) return "sync";
    // wait === undefined：看 agent 的 defaultBackground
    const agentConfig = this.modelService.getAgentConfig(opts.agent);
    if (agentConfig?.defaultBackground === true) return "background";
    return "sync";
  }

  /** 步骤 1：身份解析。agentConfig → resolveModel（三层：override → agentConfig → 主 agent model）。 */
  private async resolveIdentity(opts: ExecuteOptions): Promise<ResolvedIdentity> {
    // 未显式指定 agent 时兜底为 DEFAULT_AGENT_NAME（与 TUI 层 extractAgentName 共用同一常量，
    // 保证 block 标题显示的名与实际加载的 agent.md 一致）。见 types.ts 常量注释。
    const agent = opts.agent ?? DEFAULT_AGENT_NAME;
    const agentConfig = this.modelService.getAgentConfig(agent);

    const resolved = this.modelService.resolveModel(
      agent,
      { model: opts.model, thinkingLevel: opts.thinkingLevel },
      opts.ctxModel,
    );

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

    // 解析 worktree 参数：boolean → WorktreeHandle | undefined
    let worktreeHandle: WorktreeHandle | undefined;
    if (typeof opts.worktree === "object") {
      worktreeHandle = opts.worktree;
    }
    // worktree=true 或 undefined 时不传递 handle，由 run 内部处理

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
        fork: opts.fork,
        worktree: worktreeHandle,
        parentForkDepth: opts.parentForkDepth ?? 0, // 从 opts 读取，默认 0（顶层）
      }, ctx);
    } catch (err) {
      // run() 正常路径不抛错，但创建期异常（createAndConfigureSession 失败）
      // 会逃逸出 run() —— 合成 failed result + 收尾。
      // swallow（不 re-throw）：sync 调用方拿到合成 failed result，background 的
      // .then 正常跑 notify。避免异常逃逸到 tool 层 + record 卡 running。
      result = await this.finalizeFailed(record, err);
      return result;
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
      .catch((err: unknown) => {
        // detached 吞错：runAndFinalize 内部已 finalize record，不外抛
        // 但记录错误以便排查
        if (err instanceof Error) {
          console.debug(`[subagent] background finalize error (record=${record.id}): ${err.message}`);
        }
      });
  }

  /** 取消 background record。CAS 抢锁——抢到则 notify + 写 tombstone。 */
  private cancelBackground(record: ExecutionRecord): boolean {
    record.controller?.abort();
    if (!tryTransition(record, "cancelled")) {
      return false; // detached 已 finalize，cancel 来晚了
    }
    // 抢到锁：completeRecord（用空 result 填 cancelled）+ archive（立即移出内存）+ notify。
    // 写 cancelled tombstone：session.jsonl 被 abort 截断，cancelled 状态靠 sidecar 标记，
    // collectRecords 重建时 override status=cancelled。
    // durationMs 用真实耗时（startedAt → now），避免耗时统计恒为 0 失真。
    const cancelledResult: AgentResult = {
      text: "",
      turns: record.turnCount,
      durationMs: Date.now() - record.startedAt,
      success: false,
      error: "cancelled by user",
      sessionId: record.id,
      toolCalls: [],
    };
    completeRecord(record, cancelledResult, "cancelled");
    // 写 tombstone（best-effort，sessionFile 可能为 undefined——窗口期 cancel）。
    if (record.sessionFile) {
      writeCancelledTombstone(record.sessionFile, {
        id: record.id,
        status: "cancelled",
        agent: record.agent,
        startedAt: record.startedAt,
        endedAt: record.endedAt ?? Date.now(),
      });
    }
    this.store.archive(record);
    // worktree cleanup + removeAliveMarker（cancel 不写 finalized，BC-4 互斥）
    if (record.worktreeHandle) {
      try {
        this.worktreeManager.cleanup(record.worktreeHandle);
      } catch {
        // best-effort
      }
    }
    if (record.sessionFile) {
      try {
        removeAliveMarker(record.sessionFile);
      } catch {
        // best-effort
      }
    }
    this.notifyComplete(record);
    return true;
  }

  /**
   * D-017 时序收尾：collectPatch → completeRecord → archive → writeFinalized + cleanup + removeAliveMarker。
   * B9 兜底：completeRecord/archive 抛错→ finalized/cleanup/aliveMarker 仍执行。
   */
  private async finalizeRecord(
    record: ExecutionRecord,
    result: AgentResult,
    status: "done" | "failed" | "cancelled",
  ): Promise<void> {
    // ── Step 0: collectPatch（best-effort，D-022 patchOk 守卫）──
    let patchOk = true;
    if (record.worktreeHandle) {
      try {
        const patch = this.worktreeManager.collectPatch(record.worktreeHandle);
        patchOk = !patch.failed;
      } catch {
        patchOk = false;
      }
    }

    // ── Step 1: completeRecord（B9: 抛错→3 仍执行）──
    try {
      completeRecord(record, result, status);
    } catch (err) {
      // B9: completeRecord 抛错→Step 3 仍执行
      console.error("[subagents] completeRecord failed, continuing with cleanup:", err);
    }

    // ── Step 2: archive（B9: 抛错→3 仍执行）──
    try {
      this.store.archive(record);
    } catch (err) {
      // B9: archive 抛错→Step 3 仍执行
      console.error("[subagents] archive failed, continuing with cleanup:", err);
    }

    // ── Step 3: finalized + cleanup + aliveMarker（三件各自独立 try/catch）──
    if (record.sessionFile) {
      try {
        writeFinalized(record.sessionFile);
      } catch {
        // best-effort
      }
    }
    if (record.worktreeHandle && patchOk) {
      try {
        this.worktreeManager.cleanup(record.worktreeHandle);
      } catch {
        // best-effort
      }
    }
    if (record.sessionFile) {
      try {
        removeAliveMarker(record.sessionFile);
      } catch {
        // best-effort
      }
    }
  }

  /**
   * run() 创建期异常的收尾（H1 修复）。
   * run() 正常路径不抛错，但 createAndConfigureSession 失败会抛——
   * 本方法合成 failed AgentResult → CAS 抢锁 → finalizeRecord
   * （与正常路径同形：completeRecord + archive）。
   * 返回合成 result 供 runAndFinalize 继续返回（不 re-throw，swallow 策略）。
   */
  private async finalizeFailed(record: ExecutionRecord, err: unknown): Promise<AgentResult> {
    const errMsg = err instanceof Error ? err.message : String(err);
    // durationMs 用真实耗时（startedAt → now），避免失败统计恒为 0 失真。
    const failedResult: AgentResult = {
      text: "",
      turns: record.turnCount,
      durationMs: Date.now() - record.startedAt,
      success: false,
      error: errMsg,
      sessionId: record.id,
      toolCalls: [],
    };
    // CAS 抢锁：抢到（status 仍 running）则完整收尾；没抢到（cancel 已先设 cancelled）跳过。
    if (tryTransition(record, "failed")) {
      await this.finalizeRecord(record, failedResult, "failed");
    }
    return failedResult;
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

  /**
   * 校验 Service 就绪（pi 已注入 + 未 dispose）。
   *
   * dispose 后调用是异常路径：session_shutdown 已清资源，正常情况下紧接着
   * session_start 会 initSession 复活。若走到这里说明 session_start 没跟上
   * （RPC 边界 / reload 异常等），service 卡在 disposed 状态。
   *
   * 旧实现只抛 "hub disposed"——无信息，调用方和 AI 都看不懂，导致反复盲试。
   * 现在给出原因 + 恢复指引（重启会话或 /new）。真实错误文本会经 renderResult
   * 兜底透传到 AI（见 tool-render.ts extractResultError）。
   */
  private assertReady(): void {
    if (this.pi === null) {
      throw new Error("pi not injected (initSession not called?)");
    }
    if (this._disposed) {
      throw new Error(
        "subagents service disposed (session ended). " +
          "This happens after session shutdown when the follow-up session_start did not arrive. " +
          "Recovery: start a new session or run /new to revive the subagents runtime.",
      );
    }
  }

  /** 构造 SessionRunnerContext。sdk lazy 获取 + 缓存。 */
  private async buildSessionRunnerContext(overrideCwd?: string): Promise<SessionRunnerContext> {
    if (this.sdk === null) {
      this.sdk = await getSdk();
    }
    return {
      cwd: overrideCwd ?? this.cwd,
      agentDir: this.modelService.getAgentDir(),
      modelRegistry: this.modelService.getModelRegistry(),
      resolveAgent: (name: string) => this.modelService.getAgentConfig(name),
      skillDirs: this.modelService.getDiscoverySkillDirs(),
      sdk: this.sdk,
      mainCwd: this.cwd,
      // mainSessionFile: fork source 解析用，从 session_start 缓存获取。
      mainSessionFile: this.getMainSessionFile?.() ?? undefined,
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

  /** record → BgNotifyRecord（notifier.notify 入参映射，内部不外露）。 */
  private toNotifyRecord(record: ExecutionRecord): BgNotifyRecord {
    const snap = snapshot(record);
    return {
      id: snap.id,
      status: snap.status as "done" | "failed" | "cancelled",
      agent: snap.agent,
      model: snap.model,
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
// 直接加载，若 jiti 缓存 key 用路径字符串（非 realpath），两份 subagent-service.ts 各持
// 一个 _service，setSubagentService 写 A、getSubagentService 读 B(null)。globalThis 跨所有模块实例共享，彻底消除。
// 详见 docs/standards.md §7.5。
const SERVICE_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.service");

type ServiceSlot = { current: SubagentService | null };

function getServiceSlot(): ServiceSlot {
  // globalThis 无 symbol 索引签名，但运行时支持 symbol 键——用 Reflect 安全读写，
  // 避免双重断言。ServiceSlot 是运行时保证的固定形状（同文件唯一写入点）。
  let slot = Reflect.get(globalThis, SERVICE_SLOT_KEY) as ServiceSlot | undefined;
  if (!slot) {
    slot = { current: null };
    Reflect.set(globalThis, SERVICE_SLOT_KEY, slot);
  }
  return slot;
}

/** 获取进程单例。session_start 前为 null。 */
export function getSubagentService(): SubagentService | null {
  return getServiceSlot().current;
}

/** 设置进程单例（session_start 首次创建时）。 */
export function setSubagentService(service: SubagentService): void {
  getServiceSlot().current = service;
}
