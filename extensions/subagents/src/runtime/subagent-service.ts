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

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { type ConcurrencyPool,DefaultConcurrencyPool } from "../core/concurrency-pool.ts";
import {
  completeRecord,
  createRecord,
  project,
  snapshot,
  tryTransition,
} from "../core/execution-record.ts";
import type { AgentConfig, ModelInfo, ResolvedModel } from "../core/model-resolver.ts";
import { getSubagentSessionDir } from "../core/path-encoding.ts";
import { MAX_FORK_DEPTH } from "../core/session-context-resolver.ts";
import { runSpawn, type SessionRunnerContext } from "../core/session-runner.ts";
import type { WorktreeHandle } from "../types.ts";
import type {
  AgentEvent,
  AgentResult,
  ExecuteOptions,
  ExecutionHandle,
  ExecutionMode,
  ExecutionRecord,
  RecordSnapshot,
  SubagentRecord,
  SubagentToolDetails,
} from "../types.ts";
import { ForkDepthExceededError } from "../types.ts";
import { DEFAULT_AGENT_NAME } from "../types.ts";
import { bestEffort } from "../utils/best-effort.ts";
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

/** [MF#5] sessionId 短哈希前缀（6 hex）。两个并发 Pi 进程在同一 repo fork 时，seq 各自从 0
 *  自增 → recordId=run-1 / branch=pi-sub-run-1 冲突 → 第二个 git worktree add -b 失败。
 *  加 session 作用域前缀保证跨进程唯一。sessionId 缺失时用 'x' 兌底（空值不进 hash）。 */
const SESSION_TAG_HEX_LEN = 6;
function sessionTag(sessionId: string | null): string {
  if (!sessionId) return "x";
  return createHash("sha1").update(sessionId).digest("hex").slice(0, SESSION_TAG_HEX_LEN);
}

/** 触发 onUpdate 的事件类型（streaming delta 不触发，避免每 token 刷新）。 */
const TRIGGERING_EVENT_TYPES = new Set<AgentEvent["type"]>([
  "tool_start",
  "tool_end",
  "turn_end",
  "message_end",
  "error",
  "compaction",
]);

/**
 * onUpdate 最小发射间隔（ms）。leading + trailing 时间窗节流：窗口内首次事件立即发，
 * 后续合并到窗口末尾补发一次。与 tool-render.ts SPINNER_INTERVAL_MS 对齐——视觉刷新
 * 200ms 一帧，onUpdate 比这更快无感知增益，反而密集打 Pi tool_execution_update
 * （嵌套场景内层一秒可产生 10+ 事件）触发 chatContainer 重绘残影。
 */
const ON_UPDATE_MIN_INTERVAL_MS = 200;

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
  /** 当前 Pi session ID（session 隔离过滤用）。initSession 时注入。 */
  private sessionId: string | null = null;
  private _disposed = false;
  private _seq = 0;
  /** [MF#4][MF#2] fork 深度按 async 调用链传递（AsyncLocalStorage），替代共享可变计数器。
   *  主 session=0；fork 进入子 session 期间推进为子深度，供嵌套 fork 的 execute（子 agent
   *  在 run() 期间再调 subagent tool）经 ALS 读到自身深度作为 parentForkDepth。并发 background
   *  fork 各自独立调用链，不再互相压低深度值 → MAX_FORK_DEPTH 递归护栏不被绕过。
   *  [MF#2] 旧实现用单实例字段 currentForkDepth 跨所有执行链共享：并发 background 下 A 还原
   *  深度后 B 的嵌套 fork 读到被压低的值 → 护栏恒不过限。ALS 是 node 跨 async 边界传递
   *  “请求作用域”状态的标准机制，每条调用链隔离。 */
  private readonly forkDepthAls = new AsyncLocalStorage<number>();

  /** subagent 执行上下文按 async 调用链传递（当前正在跑的 record 身份 + 递归深度）。
   *  B run() 期间包此 ALS，B 内创建 C 时 createRecordForMode 读到 B 的 recordId/depth，
   *  据此设 C.parentRecordId=B.id、C.depth=B.depth+1。主 session 链上无 store → 顶层。
   *  与 forkDepthAls 独立：后者只数 fork 链（fork=true 才递增），本 ALS 数所有 subagent 嵌套。 */
  private readonly execCtxAls = new AsyncLocalStorage<{ recordId: string | undefined; depth: number }>();

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
    this.sessionId = init.sessionId;
    // [SPAWN fork depth 跨进程传递] 子进程被父 spawn 时，父通过 env
    // PI_SUBAGENT_FORK_DEPTH 传入当前 fork 链深度。子进程 session_start 时
    // 读取作为 forkDepthAls 基线，使后续嵌套 spawn fork 能从正确深度递增。
    // 未设置（顶层主 session）→ 基线 0。enterWith 贯穿整个 session 生命周期。
    const envDepth = process.env.PI_SUBAGENT_FORK_DEPTH;
    if (envDepth !== undefined && envDepth !== "") {
      const base = Number.parseInt(envDepth, 10);
      if (!Number.isNaN(base) && base > 0) {
        this.forkDepthAls.enterWith(base);
      }
    }
    // revive（dispose 的逆操作：/resume /fork /new 后复活）
    this._disposed = false;
    this.store.revive();
    this.notifier.revive();
  }

  /** session 结束清理（清定时器，丢弃 pending 通知）。幂等。 */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    // [R0 孤儿进程修复] 进程退出路径：abort 所有 running background controller，
    // 触发 runSpawn 的 signal listener → child.kill("SIGTERM")，防止子进程成孤儿。
    // 必须在 store.dispose 之前（dispose 后 records 仍可访问，但语义上先 kill 再清场）。
    // sync record 无 controller，跳过；background controller.abort 后子进程收到 SIGTERM。
    // 注意：dispose 是同步返回，主进程可能紧接着 process.exit()，runSpawn 的 finally
    // 清理（identity 补写等）可能来不及跑——这是可接受的退化（session.jsonl 已由子进程
    // 写入，缺 identity entry 只影响 list 重建的可观测性，不丢执行数据）。
    this.store.abortRunningControllers();
    for (const s of this.throttleState.values()) {
      if (s.timer !== undefined) clearTimeout(s.timer);
    }
    this.throttleState.clear();
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

    // 通用嵌套深度护栏（D-033）：execCtxAls 记录所有 subagent 嵌套层级（fork + 非 fork），
    // 每层 +1。MAX_FORK_DEPTH 同时限 fork 链与通用嵌套——非 fork 递归虽不累积 session 体积，
    // 但耗资源（每层 createAgentSession + resourceLoader + session 文件）且 LLM 易陷入
    // 「委派子 agent → 子 agent 再委派」死循环（实测无护栏时递归到 L36 全 failed）。
    // 在所有副作用（record/worktree/session）之前拦截，错误直达调用方。
    // fork:true 的体积护栏（resolveSessionContext 的 parentForkDepth 检查）作为第二层保留。
    // 计数基准：顶层 nestingDepth=0；每次嵌套 execute +1。允许 0..MAX_FORK_DEPTH（共 11 层），
    // nestingDepth=MAX+1 被拒。与 fork 护栏（parentForkDepth>=MAX 拒，parent 计数基准）互补：
    // 本护栏更严（计所有嵌套），混合链下先生效；两者共享 MAX_FORK_DEPTH 上限不漂移。
    const parentNesting = this.execCtxAls.getStore();
    const nestingDepth = parentNesting ? parentNesting.depth + 1 : 0;
    if (nestingDepth > MAX_FORK_DEPTH) {
      throw new ForkDepthExceededError(
        `subagent nesting depth ${nestingDepth} > ${MAX_FORK_DEPTH} (max recursion), refusing to spawn deeper`,
      );
    }

    // [MF#7] worktree:true 需要 fork:true——否则下面三个 worktree 分支都不命中，
    // worktreeHandle 恒 undefined → 子 agent 零文件隔离且零报错（静默 no-op）。此处在
    // 任何副作用（record 创建 / worktree 创建）之前 fail-fast，不吞误用。
    if (opts.worktree === true && !opts.fork) {
      throw new Error(
        "worktree:true requires fork:true (worktree isolation only applies to forked sessions). " +
          "Set fork:true together with worktree:true.",
      );
    }

    // mode 判定（业务规则归 Service，tool 层只传 wait 意图）
    const mode = this.resolveMode(opts);
    const ctx = this.buildSessionRunnerContext(opts.cwd);

    // ── 1. IDENTITY 解析（确认 → agentConfig → resolveModel）──
    const identity = await this.resolveIdentity(opts);

    // ── 2. RECORD 创建 + 注册 ──
    const record = this.createRecordForMode(identity, opts, mode);

    // ── 2.5 worktree 创建（仅 worktree===true 或已传入 handle 时）──
    // record 先创建，worktree 失败时可 finalizeFailed（record 已在 store 中）。
    // worktree 必须显式开启：worktree===true 创建新 worktree；worktree===undefined/false 不创建。
    // fork 不隐含 worktree（UC-1 fork 可独立使用，fork 仅继承上下文，在 parent cwd 跑）。
    let worktreeHandle: WorktreeHandle | undefined;
    if (typeof opts.worktree === "object") {
      // 传入的是已创建的 WorktreeHandle
      worktreeHandle = opts.worktree;
    } else if (opts.worktree === true) {
      // worktree===true（显式要求）——创建新 worktree。MF#7 已保证此处 fork 必为 true。
      try {
        worktreeHandle = this.worktreeManager.create(this.cwd, record.id);
        record.worktreeHandle = worktreeHandle;
      } catch (err) {
        // create 失败→不进入 run，合成 failed result
        const _result = await this.finalizeFailed(record, err);
        return this.buildEarlyFailedHandle(record, mode);
      }
    }

    // ── 3. MODE 分叉：signal/priority（仅此 2 处即时差异）──
    const signal = mode === "background"
      ? record.controller!.signal
      : opts.signal;
    const priority = mode === "background" ? PRIORITY_BACKGROUND : PRIORITY_SYNC;

    // ── 4-7. sync 直接 await；background 包 detached 立即返回 id ──
    if (mode === "sync") {
      // [长期方案] 嵌套 sync（subagent 内部再发起 subagent）不回流 onUpdate。
      // 根因：递归 sync 时，内层 subagent 的 SubagentResultComponent 也启动 setInterval 驱动
      // spinner，与外层 block 的 setInterval 在 Pi 嵌套 tool_execution 渲染管线下互相干扰，
      // 导致 statusLine 帧堆叠残影（普通单层 sync 不残影已证 spinner 机制本身无问题）。
      // 解法：嵌套层 onUpdate=undefined → runAndFinalize 的 onEvent=undefined → execute 期间不推
      // partial renderResult → 内层 component 直到完成才创建（done 态）→ maybeToggleSpinner
      // 检测非 running 不启动 setInterval。顶层回归单 setInterval，不堆叠。内层 block 仅显示
      // renderCall 静态标题 + 完成结果（内层进度对顶层用户价值低，Ctrl+O 仍可看实时详情）。
      // nestingDepth 在 execute 入口由 execCtxAls 推导（L2 内调 L3 时 parentNesting 非空 → ≥1）。
      const nestedSyncOnUpdate = nestingDepth > 0 ? undefined : opts.onUpdate;
      await this.runAndFinalize(record, { ...opts, onUpdate: nestedSyncOnUpdate, worktree: worktreeHandle }, ctx, identity, signal, priority);
      return { mode: "sync", record: snapshot(record), details: project(record) };
    }

    // background：立即返回 subagentId + sessionFile（窗口期可能 undefined）+ details（status=running）。
    // 步骤 4-6 在 detached promise 里跑。
    // B1：background 不回流 onUpdate（与 sync 嵌套抑制同理——任何嵌套 subagent 的 onUpdate 都须
    // undefined，防 SubagentResultComponent spinner setInterval 堆叠）。此外 detached 运行对 tool
    // 层不可见，完成由 notify 驱动新 turn；转发 onUpdate 还会被 liftSync 误标 syncResponse(mode:"sync")
    // → spinner setInterval 泄漏。sync 嵌套抑制见上方 nestedSyncOnUpdate。
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

  /** 当前 Pi session ID（TUI/测试用）。initSession 前为 null。 */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /** 订阅 store 变更（widget/list requestRender）。返回取消订阅。 */
  onChange(listener: () => void): () => void {
    return this.store.onChange(listener);
  }

  /** 列出 running record 快照（widget 计数用）。 */
  listRunning(): RecordSnapshot[] {
    return this.store.listRunning();
  }

  /** 合并内存(running) + 磁盘(session.jsonl 重建) record（/subagents list + tool list 消费）。
   *  按 rootSessionId 过滤，只返回当前 session 创建的 record（session 隔离）。 */
  collectRecords(limit: number, statusFilter: StatusFilter = "all"): SubagentRecord[] {
    return this.store.collectRecords(limit, statusFilter, this.sessionId ?? undefined);
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
    const tag = sessionTag(this.sessionId);
    const id = mode === "background"
      ? `bg-${tag}-${seq}-${Date.now()}`
      : `run-${tag}-${seq}`;
    const controller = mode === "background" ? new AbortController() : undefined;

    // 从 async 调用链读父执行上下文：主 session 链上无 store → 顶层 record；
    // B run() 期间包了 execCtxAls，B 内创建 C 时读到 B → C.parentRecordId=B.id, C.depth=B.depth+1。
    // depth 语义：顶层（无父）=0；有父=父 depth+1。靠 recordId 是否存在区分，不用负数魔数。
    const parentCtx = this.execCtxAls.getStore();
    const parentRecordId = parentCtx?.recordId;
    const depth = parentCtx ? parentCtx.depth + 1 : 0;

    const record = createRecord(id, {
      agent: identity.agent,
      model: `${identity.resolved.model.provider}/${identity.resolved.model.id}`,
      thinkingLevel: identity.resolved.thinkingLevel,
      mode,
      task: opts.task,
      startedAt: Date.now(),
      rootSessionId: this.sessionId ?? undefined,
      parentRecordId,
      depth,
      controller,
    });

    this.store.register(record);
    return record;
  }

  /** [MF#R4] worktree 前置失败的 early-return handle。
   *  按 mode 分支返回 ExecutionHandle 的正确判别变体——不能统一返回 sync 形状：
   *  background 时 record 已被 finalizeFailed 收尾为 failed、detached promise 从未启动，
   *  若返回 sync 形状（缺 subagentId/sessionFile），下游 startHandler 读 handle.subagentId
   *  得 undefined → 用户见"已启动"实则已失败且无法 cancel。 */
  private buildEarlyFailedHandle(record: ExecutionRecord, mode: ExecutionMode): ExecutionHandle {
    const details = project(record);
    if (mode === "background") {
      return { mode: "background", subagentId: record.id, sessionFile: record.sessionFile, details };
    }
    return { mode: "sync", record: snapshot(record), details };
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
    // 仅 background 进并发池限流。sync 不进池，原因：
    // ① sync 由主 agent sequential executionMode 天然串行，无需限流；
    // ② sync 嵌套持有槽位会死锁——顶层 + 每层 sync 各占 1 槽，嵌套深度达 maxConcurrent
    //   时子层 acquire 永久排队、父层永等子层、release 永不触发（实测 maxConcurrent=4 → L5 卡死）。
    // sync 嵌套深度由 MAX_FORK_DEPTH (session-context-resolver.ts) 兜底，不靠池限。
    const pooled = record.mode === "background";
    if (pooled) await this.pool.acquire(priority);
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

    // [MF#4][MF#2] fork 深度护栏：深度按 async 调用链传递（ALS），不再用共享实例计数器。
    // parentDepth = 当前调用链的深度（主 session 链上无 store→0）；fork 时推进为 parentDepth+1，
    // 包进 run() 的 ALS 作用域，使子 agent 在 prompt() 期间发起的嵌套 execute 能读到该深度。
    const parentDepth = this.forkDepthAls.getStore() ?? 0;
    const effectiveDepth = opts.fork ? parentDepth + 1 : parentDepth;

    let result: AgentResult;
    try {
      // execCtxAls 包在 forkDepthAls 内层：B run() 期间它的 store={recordId:B.id,depth:B.depth}，
      // B 内创建 C 时 createRecordForMode 读到 B → C 挂到 B 名下。两层 ALS 独立但同生命周期。
      result = await this.forkDepthAls.run(effectiveDepth, () =>
        this.execCtxAls.run(
          { recordId: record.id, depth: record.depth },
          () => runSpawn(record, opts.task, {
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
            parentForkDepth: parentDepth, // [MF#4] 父链深度，不从 opts 读
          }, ctx),
        ),
      );
    } catch (err) {
      // run() 正常路径不抛错，但创建期异常（createAndConfigureSession 失败）
      // 会逃逸出 run() —— 合成 failed result + 收尾。
      // swallow（不 re-throw）：sync 调用方拿到合成 failed result，background 的
      // .then 正常跑 notify。避免异常逃逸到 tool 层 + record 卡 running。
      result = await this.finalizeFailed(record, err);
      return result;
    } finally {
      if (pooled) this.pool.release();
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
      } catch (err) {
        bestEffort(err, "worktree cleanup (cancelBackground)");
      }
    }
    if (record.sessionFile) {
      try {
        removeAliveMarker(record.sessionFile);
      } catch (err) {
        bestEffort(err, "removeAliveMarker (cancelBackground)");
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
    // 终态清节流状态：防 trailing timer 在 record 归档后误发陈旧 onUpdate
    this.clearThrottle(record.id);
    // ── Step 0: collectPatch（best-effort，D-022 patchOk 守卫）──
    // [MF#3] patchFile 写到 worktree 之外（sessionsDir/<branch>.patch），避免被 cleanup 删除；
    //        路径回填 record.patchFile，供调用方（tool result / /subagents list）应用。
    let patchOk = true;
    if (record.worktreeHandle) {
      try {
        const sessionsDir = getSubagentSessionDir(
          this.modelService.getAgentDir(),
          record.worktreeHandle.mainCwd,
        );
        fs.mkdirSync(sessionsDir, { recursive: true });
        const patchFile = path.join(sessionsDir, `${record.worktreeHandle.branch}.patch`);
        const patch = this.worktreeManager.collectPatch(record.worktreeHandle, patchFile);
        patchOk = !patch.failed;
        // 仅 patch 实际写盘（非空 diff 且未失败）才回填，避免指向不存在文件的悬空路径——
        // 否则 notifier/render/sync 路径会向 LLM 输出 `git apply <不存在>`（纯查询任务命中）。
        if (patch.written) record.patchFile = patchFile;
      } catch {
        patchOk = false;
      }
    }

    // ── Step 1: completeRecord（B9: 抛错→3 仍执行）──
    try {
      completeRecord(record, result, status);
    } catch (err) {
      bestEffort(err, "completeRecord (finalizeRecord B9)", "error");
    }

    // ── Step 2: archive（B9: 抛错→3 仍执行）──
    try {
      this.store.archive(record);
    } catch (err) {
      bestEffort(err, "store.archive (finalizeRecord B9)", "error");
    }

    // ── Step 3: finalized + cleanup + aliveMarker（三件各自独立 try/catch）──
    if (record.sessionFile) {
      try {
        writeFinalized(record.sessionFile);
      } catch (err) {
        bestEffort(err, "writeFinalized (finalizeRecord Step3)");
      }
    }
    if (record.worktreeHandle && patchOk) {
      try {
        this.worktreeManager.cleanup(record.worktreeHandle);
      } catch (err) {
        bestEffort(err, "worktree cleanup (finalizeRecord Step3)");
      }
    }
    if (record.sessionFile) {
      try {
        removeAliveMarker(record.sessionFile);
      } catch (err) {
        bestEffort(err, "removeAliveMarker (finalizeRecord Step3)");
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

  // onUpdate 节流状态（per-record Map）。每条 record（每条 onUpdate 回流链）独立节流，
  // 避免嵌套（fork 链：主→A→B）多条 onUpdate 链争用同一份节流状态。
  // [HISTORICAL] 旧实现用单个实例字段，注释假设“fork 嵌套串行，同时只有一条链”——错误：
  // trailing timer 异步，B 设的 trailing 会在 B 完成、A 恢复期间触发，与 A 的同步事件争用
  // onUpdateLastEmitAt/onUpdateTrailingTimer → A 的 onUpdate 被吞/延迟 → 主 agent 对话流
  // A block 状态跳跃更新 → 残影。per-record 化让 A/B 各自独立节流，互不干扰。
  private readonly throttleState = new Map<string, { lastEmitAt: number; timer?: ReturnType<typeof setTimeout> }>();

  /**
   * AgentEvent 节流回流到 onUpdate（streaming delta 不触发 + 时间窗节流）。
   *
   * 名为 Throttled 必须真节流——只过滤事件类型时，每个 tool_start/tool_end/turn_end
   * 都直发 onUpdate，嵌套场景一秒 10+ 事件密集回流 → Pi tool_execution_update 密集重绘
   * → 行数变化的流式 tool 组件在 chatContainer diff 中残影（状态行堆叠）。
   *
   * leading + trailing：首次事件立即发（响应性），窗口内后续合并到末尾补发一次
   * （保证终态事件不丢——sync record 终态后 archive 移出内存，闭包持有的引用仍可 project）。
   *
   * 节流状态 per-record（Map）：每条 record 独立 leading/trailing 窗口。嵌套（fork 链）
   * 时外层 A 与内层 B 各自节流，trailing timer 不会跨链污染。
   */
  private onEventThrottled(
    record: ExecutionRecord,
    event: AgentEvent,
    onUpdate: (details: SubagentToolDetails) => void,
  ): void {
    if (!TRIGGERING_EVENT_TYPES.has(event.type)) return;
    const state = this.throttleState.get(record.id) ?? { lastEmitAt: 0 };
    const now = Date.now();
    if (now - state.lastEmitAt >= ON_UPDATE_MIN_INTERVAL_MS) {
      // leading：窗口外立即发，清掉该 record 残留的 trailing timer（避免补发陈旧状态）
      if (state.timer !== undefined) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      state.lastEmitAt = now;
      this.throttleState.set(record.id, state);
      onUpdate(project(record));
      // 终态清 entry（与 trailing 分支对称）：防 CAS 后到 leading 误发陈旧状态 + Map 无限增长。
      if (record.status !== "running") this.throttleState.delete(record.id);
      return;
    }
    // trailing：窗口末尾补发最新（per-record timer，不与其他 record 的 trailing 争用）。
    if (state.timer === undefined) {
      const wait = ON_UPDATE_MIN_INTERVAL_MS - (now - state.lastEmitAt);
      state.timer = setTimeout(() => {
        state.timer = undefined;
        state.lastEmitAt = Date.now();
        onUpdate(project(record));
        // record 已终态且无 pending trailing → 清 entry 防 Map 无限增长
        if (record.status !== "running") this.throttleState.delete(record.id);
      }, wait);
      this.throttleState.set(record.id, state);
    }
  }

  /** 清指定 record 的节流状态（finalizeRecord 调，防终态后 trailing 误发陈旧状态）。 */
  private clearThrottle(recordId: string): void {
    const state = this.throttleState.get(recordId);
    if (state?.timer !== undefined) clearTimeout(state.timer);
    this.throttleState.delete(recordId);
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

  /** 构造 SessionRunnerContext（spawn 模式：无需 SDK 实例）。 */
  private buildSessionRunnerContext(overrideCwd?: string): SessionRunnerContext {
    return {
      cwd: overrideCwd ?? this.cwd,
      agentDir: this.modelService.getAgentDir(),
      // [M3 恢复] discovery.json 声明的 skill 目录，供子进程 --skill 注入。
      skillDirs: this.modelService.getDiscoverySkillDirs(),
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
      // [MF#1] 透传 patchFile，让 background 完成通知显式回传 patch 路径（否则改动静默丢失）。
      patchFile: record.patchFile,
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
