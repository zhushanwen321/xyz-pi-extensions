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

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionMode } from "@mariozechner/pi-coding-agent";

import type { AgentResult as WorkflowAgentResult } from "../orchestration/models/types.ts";
// D-A10: workflow 侧 AgentResult 映射（executeAndAwait 出口）
import { mapToWorkflowAgentResult } from "./agent-result-mapper.ts";
import { removeAliveMarker } from "./alive-store.ts";
import { bestEffort } from "./best-effort.ts";
import { type ConcurrencyPool,DefaultConcurrencyPool } from "./concurrency-pool.ts";
import type { DialogGlobalQueue, UiRequestHandler } from "./dialog-queue.ts";
import {
  completeRecord,
  createRecord,
  project,
  snapshot,
  tryTransition,
} from "./execution-record.ts";
import { writeFinalized } from "./finalized-marker.ts";
import type { ModelConfigService } from "./model-config-service.ts";
import type { AgentConfig, ModelInfo, ResolvedModel } from "./model-resolver.ts";
import type { BgNotifyRecord, NotifierHost } from "./notifier.ts";
import { BgNotifier } from "./notifier.ts";
import { getSubagentSessionDir } from "./path-encoding.ts";
import type { StatusFilter } from "./record-store.ts";
import { RecordStore } from "./record-store.ts";
import { MAX_FORK_DEPTH } from "./session-context-resolver.ts";
import { killAllSpawnedChildren, runSpawn, type SessionRunnerContext } from "./session-runner.ts";
import type { StreamSink } from "./stream-sink.ts";
import { SubagentStream } from "./stream-sink.ts";
import { writeCancelledTombstone } from "./tombstone-store.ts";
import type { WorktreeHandle } from "./types.ts";
import { UiRequestObservability } from "./ui-request-observability.ts";
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
} from "./types.ts";
import { ForkDepthExceededError } from "./types.ts";
import { DEFAULT_AGENT_NAME } from "./types.ts";
import { ManifestStore } from "./manifest-store.ts";
import { WorktreeManager } from "./worktree-manager.ts";

/** Pi ExtensionAPI 的最小接口（duck-typed）。
 *  subagent-service 直接调 pi.sendMessage 发 background 完成通知（BgNotifier 滑动窗口合并），
 *  不委托 pending-notifications EventBus 中继——后者只管 registry 不参与通知发送。 */
interface PiLike {
  appendEntry(customType: string, data?: unknown): void;
  events: { emit(channel: string, data: unknown): void };
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
}

/** UI streaming sink 的最小接口（ctx.ui.setWidget 的 duck-typed 子集）。
 *  session_start 时从 ctx.ui 注入，background 执行期间用于把合并后的 text_delta
 *  通过 setWidget 通道转发到 RPC stdout（不经 sendMessage 的持久化路径）。 */
export type { StreamSink } from "./stream-sink.ts";

/** pending-notifications 注册/注销 helper（避免重复代码）。 */
function emitPendingRegister(pi: PiLike | null, id: string, name?: string): void {
  pi?.events.emit("pending:register", {
    id,
    type: "subagent",
    name: name ?? id,
  });
}

function emitPendingUnregister(
  pi: PiLike | null,
  id: string,
  reason: string,
): void {
  pi?.events.emit("pending:unregister", {
    id,
    reason,
  });
}

/** Service 构造参数（进程级）。 */
export interface SubagentServiceInit {
  cwd: string;
  /** 配置/模型域 Service（execute 内部调其 resolveModel）。 */
  modelService: ModelConfigService;
  /** 缓存的主 session file 获取函数（fork source 解析用）。 */
  getMainSessionFile?: () => string | undefined;
  /** W2: UI 请求处理回调（ask_user 扩展）。
   *  签名见 dialog-queue.ts UiRequestHandler：接收 UiRequest，返回 UiResponse。 */
  uiRequestHandler?: UiRequestHandler;
}

/** session_start 注入参数（session 级）。 */
export interface SubagentServiceSessionInit {
  pi: PiLike;
  sessionId: string;
  /** UI streaming sink（ctx.ui.setWidget），用于 background text_delta 转发。 */
  streamSink?: StreamSink;
  /** 主进程运行模式（W4 守卫：headless 不注入 ask_user RPC 提示词）。
   *  initSession 读取后存入 this.sessionMode，buildSessionRunnerContext 透传给 session-runner。 */
  mode?: ExtensionMode;
  /** UI 请求 handler（session 级覆盖进程级）。
   *  initSession 读取后覆盖 this.uiRequestHandler（setUiRequestHandler 的 session 级等价入口）。 */
  uiRequestHandler?: UiRequestHandler;
  /** L2 跨子进程全局 dialog 串行队列（进程单例）。透传给 session-runner，
   *  child close 时调 rejectChildDialogs 清理 pending（SR-4 防全局死锁）。 */
  dialogQueue?: DialogGlobalQueue;
}

/** background 优先级（保留 priority 排序机制，单一值）。 */
const PRIORITY_BACKGROUND = 1000;

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
  private readonly modelService: ModelConfigService;
  private readonly cwd: string;
  private readonly worktreeManager: WorktreeManager;
  private readonly getMainSessionFile: (() => string | undefined) | undefined;
  /** UI 请求 handler（进程级，可被 setUiRequestHandler / initSession 覆盖）。 */
  private uiRequestHandler: SubagentServiceInit["uiRequestHandler"];
  /** L2 dialog 串行队列（进程级）。SR-4：child close 时 session-runner 调 rejectChildDialogs 清理。 */
  private dialogQueue: DialogGlobalQueue | undefined;
  /** UI 请求可观测性（sessionMode + handler 缺失告警去重，提取自本类降低行数）。 */
  private readonly uiObservability = new UiRequestObservability();
  private pi: PiLike | null = null;
  /** 当前 Pi session ID（session 隔离过滤用）。initSession 时注入。 */
  private sessionId: string | null = null;
  /** UI streaming sink（ctx.ui.setWidget）。workflow 域经 getStreamSink() 取用。 */
  private streamSink: StreamSink | null = null;
  getStreamSink(): StreamSink | null { return this.streamSink; }
  private _disposed = false;
  private _seq = 0;
  /** background 完成通知器（滑动窗口合并 + 去重）。session_start revive，shutdown dispose。 */
  private readonly notifier: BgNotifier;
  /** [MF#4][MF#2] fork 深度按 async 调用链传递（AsyncLocalStorage），替代共享可变计数器。
   *  主 session=0；fork 进入子 session 期间推进为子深度，供嵌套 fork 经 ALS 读到自身深度作为
   *  parentForkDepth。并发 background fork 各自独立调用链，不再互相压低深度值。
   *  [MF#2] 旧实现用单实例字段跨执行链共享 → 并发下 A 还原深度后 B 读到被压低值 → 护栏失效。 */
  private readonly forkDepthAls = new AsyncLocalStorage<number>();

  /** subagent 执行上下文按 async 调用链传递（当前正在跑的 record 身份 + 递归深度）。
   *  B run() 期间包此 ALS，B 内创建 C 时 createRecordForMode 读到 B 的 recordId/depth，
   *  据此设 C.parentRecordId=B.id、C.depth=B.depth+1。主 session 链上无 store → 顶层。
   *  与 forkDepthAls 独立：后者只数 fork 链（fork=true 才递增），本 ALS 数所有 subagent 嵌套。 */
  private readonly execCtxAls = new AsyncLocalStorage<{ recordId: string | undefined; depth: number }>();

  private readonly manifestStore: ManifestStore;

  constructor(init: SubagentServiceInit) {
    this.cwd = init.cwd;
    this.modelService = init.modelService;
    this.getMainSessionFile = init.getMainSessionFile;
    this.uiRequestHandler = init.uiRequestHandler;
    this.pool = new DefaultConcurrencyPool(this.modelService.getGlobalConfig().maxConcurrent);
    this.worktreeManager = new WorktreeManager(this.modelService.getAgentDir());
    const sessionsDir = getSubagentSessionDir(this.modelService.getAgentDir(), init.cwd);
    const recordsDir = path.join(this.modelService.getAgentDir(), "records");
    this.manifestStore = new ManifestStore(recordsDir);
    this.store = new RecordStore(sessionsDir);
    this.notifier = new BgNotifier(this.piAdapter());
  }

  // ── 生命周期（index.ts 调）──────────────────────────────

  /** 覆盖 UI 请求 handler（W3: index.ts session_start 时按 mode 注入 handler 后调）。
   *  委托 uiObservability 重置缺失告警去重——新 handler 就位后允许重新 warn。 */
  setUiRequestHandler(handler: UiRequestHandler | undefined): void {
    this.uiRequestHandler = handler;
    this.uiObservability.resetMissingHandlerWarnings();
  }

  /** session-runner handleUiRequest 在 handler 缺失时调用（FR-9 可观测性）。
   *  委托 uiObservability：按 session 去重，同一 session 的多次 UI 请求只 warn 一次。
   *  W2: console.warn 兜底。W3 接入 pi.appendEntry("subagent:ui-request-missing-handler", ...)。 */
  notifyMissingHandler(sessionId: string): void {
    this.uiObservability.notifyMissingHandler(sessionId);
  }

  /** session_start 注入 pi + revive（modelRegistry/entries 归 ModelConfigService.initModel）。 */
  initSession(init: SubagentServiceSessionInit): void {
    this.pi = init.pi;
    this.sessionId = init.sessionId;
    this.streamSink = init.streamSink ?? null;
    // 读取 mode（W4 守卫透传给 session-runner）+ session 级 handler 覆盖。
    this.uiObservability.setMode(init.mode);
    if (init.uiRequestHandler !== undefined) {
      this.uiRequestHandler = init.uiRequestHandler;
      this.uiObservability.resetMissingHandlerWarnings();
    }
    // SR-4：注入 L2 dialog 队列（child close 清理路径）。undefined 时 buildSessionRunnerContext
    // 透传 undefined，session-runner onClose 跳过 L2 清理（仅清 L1，保留旧行为）。
    if (init.dialogQueue !== undefined) {
      this.dialogQueue = init.dialogQueue;
    }
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

  /** session 结束清理（清定时器，丢弃 pending 通知）。幂等。
   *
   * [M-7] dispose 顺序假设：pending:unregister emit 依赖 pending-notifications 扩展的
   * listener 仍然存活。若 pending-notifications 先于本扩展执行 session_shutdown（后注册
   * 先执行的语义下会如此），listener 已注销，unregister 事件被静默丢弃。这是可接受的
   * 退化——进程退出后两侧状态本就不保证一致，下次 session_start 的 crash recovery 会修正。 */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    // [T2 AC-4.3 双重记账一致性] 为每个 running record emit pending:unregister(reason=failed)，
    // 让 pending-notifications 清理 registry entry，避免进程退出后两侧状态不一致。
    // 必须在 abortRunningControllers 之前——此时 record 仍 running，listRunning 能取到。
    for (const record of this.store.listRunning()) {
      emitPendingUnregister(this.pi, record.id, "failed");
    }
    // [R0/C1 孤儿进程修复] 两层兜底 kill 所有 spawned 子进程（sync + background）：
    //   1. abortRunningControllers：background record 的 controller.abort → child.kill（CAS 收尾语义）。
    //   2. killAllSpawnedChildren：遍历 session-runner spawnedChildren Set，对仍存活的发 SIGTERM
    //      （sync record 的 controller 是 undefined，abortRunningControllers 跳过它们，此处补齐）。
    // 必须在 store.dispose 之前（先 kill 再清场）。dispose 同步返回后主进程可能立即 exit，
    // runSpawn 的 finally 清理可能来不及跑——可接受退化（session.jsonl 已由子进程写入）。
    this.store.abortRunningControllers();
    killAllSpawnedChildren();
    for (const s of this.throttleState.values()) {
      if (s.timer !== undefined) clearTimeout(s.timer);
    }
    this.throttleState.clear();
    // flush 待发通知后 dispose（防丢失）
    this.notifier.flushPendingNotifications();
    this.notifier.dispose();
    this.store.dispose();
  }

  // ── 执行（subagent-tool 调）────────────────────────────

  /** background 完成回注（record → BgNotifyRecord 映射 + notifier.notify）。 */
  private notifyComplete(record: ExecutionRecord): void {
    this.notifier.notify(this.toNotifyRecord(record));
  }

  /** notifier 的 NotifierHost 适配器（绑定到 pi.sendMessage + store 查询）。 */
  private piAdapter(): NotifierHost {
    return {
      sendMessage: (message, options) => {
        this.pi?.sendMessage(message, options);
      },
      hasRunningBackground: () => {
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
      patchFile: record.patchFile,
    };
  }

  /**
   * 预解析 model（renderCall 标题行用，同步）。代理 modelService.resolveModel。
   * 仅解析 override/agentConfig 路径；ctxModel 缺失时拋错，调用方 catch 降级。
   */
  resolveModel(
    agent: string,
    override?: { model?: string; thinkingLevel?: string },
    ctxModel?: ModelInfo,
  ): ResolvedModel {
    return this.modelService.resolveModel(agent, override, ctxModel);
  }

  /**
   * 统一执行入口。mode 固定 background（sync 已删除）。
   * 内部完成：模型解析 → 执行 → 收尾。
   *
   * @param opts.ctxModel  主 agent 当前模型（模型解析第三层兼底）。undefined 时仅依赖 override/agentConfig。
   */
  async execute(opts: ExecuteOptions): Promise<ExecutionHandle> {
    this.assertReady();

    // 通用嵌套深度护栏（D-033）：execCtxAls 记录所有 subagent 嵌套层级（fork + 非 fork），
    // 每层 +1。MAX_FORK_DEPTH 同时限 fork 链与通用嵌套——非 fork 递归虽不累积 session 体积，
    // 但耗资源且 LLM 易陷入「委派→再委派」死循环。在所有副作用之前拦截，错误直达调用方。
    // 计数基准：顶层 nestingDepth=0，nestingDepth>MAX 被拒。与 fork 体积护栏（parentForkDepth 检查）
    // 互补：本护栏更严（计所有嵌套），混合链下先生效；两者共享 MAX_FORK_DEPTH 上限不漂移。
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

    // mode 固定 background（sync 模式已删除）
    const mode: ExecutionMode = "background";
    const ctx = this.buildSessionRunnerContext(opts.cwd);

    // ── 1. IDENTITY 解析（确认 → agentConfig → resolveModel）──
    const identity = await this.resolveIdentity(opts);

    // ── 2. RECORD 创建 + 注册 ──
    const record = this.createRecordForMode(identity, opts, mode);
    emitPendingRegister(this.pi, record.id, record.agent);

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
        // create 失败→不进入 run，finalizeFailed 统一收尾（含 emitPendingUnregister failed）
        const _result = await this.finalizeFailed(record, err);
        return this.buildEarlyFailedHandle(record);
      }
    }

    // ── 3. MODE 固定 background：signal/controller、priority 固定 ──
    const signal = record.controller!.signal;
    const priority = PRIORITY_BACKGROUND;

    // ── 4-7. background 包 detached 立即返回 id ──
    // background 不回流 onUpdate（任何嵌套 subagent 的 onUpdate 都须 undefined，防
    // SubagentResultComponent spinner setInterval 堆叠）。detached 运行对 tool 层不可见，
    // 完成由 notify 驱动新 turn。
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

  // ── 编排层专用接口（workflow 消费）──────────────────────

  /**
   * workflow 编排层专用：sync-await 接口，内部走 background 管道但返回 Promise<AgentResult>。
   *
   * 与 execute() 的区别（D-A1）：
   *   1. 返回 workflow AgentResult（content 字段），非 ExecutionHandle
   *   2. 不调 kickOffBackground → 不注入 followUp 完成通知（BC-11，结果直接返回 workflow）
   *   3. T2 删 sync 时 executeAndAwait 不受牵连（独立方法）
   *
   * 共享：runSpawn + ConcurrencyPool + record + pending emit（D-A4）。
   */
  async executeAndAwait(
    opts: ExecuteOptions,
    signal?: AbortSignal,
    onEvent?: (event: AgentEvent) => void,
    stream?: SubagentStream,
  ): Promise<WorkflowAgentResult> {
    this.assertReady();

    // ── BC-12 嵌套护栏：复用 execute() 的 execCtxAls 深度检查 ──
    const parentNesting = this.execCtxAls.getStore();
    const nestingDepth = parentNesting ? parentNesting.depth + 1 : 0;
    if (nestingDepth > MAX_FORK_DEPTH) {
      throw new ForkDepthExceededError(
        `subagent nesting depth ${nestingDepth} > ${MAX_FORK_DEPTH} (max recursion), refusing to spawn deeper`,
      );
    }

    // ── 步骤 1: IDENTITY 解析 ──
    const identity = await this.resolveIdentity(opts);

    // ── 步骤 2: RECORD 创建（mode="background" 进池）──
    const record = this.createRecordForMode(identity, opts, "background");
    emitPendingRegister(this.pi, record.id, record.agent);

    // ── 步骤 3: SessionRunnerContext ──
    const ctx = this.buildSessionRunnerContext(opts.cwd);

    // ── 步骤 4: signal 决议 ──
    const effectiveSignal = signal ?? record.controller?.signal;

    // 步骤 5: runAndFinalize（await，不 detached）。onUpdate=undefined（BC-11），onEvent 独立传，stream 透传。
    const result = await this.runAndFinalize(
      record,
      { ...opts, onUpdate: undefined },
      ctx,
      identity,
      effectiveSignal,
      PRIORITY_BACKGROUND,
      onEvent,
      stream,
    );

    // ── 步骤 6: D-A10 AgentResult 映射 ──
    // [MF-2] 不在此 emit pending:unregister——runAndFinalize 内部已覆盖所有路径：
    //   - CAS 成功（runAndFinalize L629）→ finalizeRecord 末尾 emit（L797）
    //   - CAS 失败（cancel/finalizeFailed/dispose 抢先转终态）→ 那些路径各自已 emit
    //     （cancelBackground L709 / finalizeFailed→finalizeRecord / dispose L240）
    // 旧实现无条件 emit 一次 → CAS 成功分支重复 emit（双注销）。
    return mapToWorkflowAgentResult(result);
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

  /** 合并内存(running) + 磁盘(session.jsonl 重建) record（/subagents list + tool list 消费）。
   *  按 rootSessionId 过滤，只返回当前 session 创建的 record（session 隔离）。 */
  collectRecords(limit: number, statusFilter: StatusFilter = "all"): SubagentRecord[] {
    return this.store.collectRecords(limit, statusFilter, this.sessionId ?? undefined);
  }

  // ── 执行内部：身份解析 + record 创建 ──────────

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

  /** 步骤 2：按 mode 生成 id + controller，创建 record 并注册。
   *  [L-1] ExecutionMode 类型固定 "background"（sync 已删除），id/controller 分支简化。 */
  private createRecordForMode(
    identity: ResolvedIdentity,
    opts: ExecuteOptions,
    mode: ExecutionMode,
  ): ExecutionRecord {
    // FR-1: record id 用全局 UUID，不依赖 transcript/PID
    const id = crypto.randomUUID();
    const controller = new AbortController();

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
      slug: opts.slug,
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
   *  record 已被 finalizeFailed 收尾为 failed、detached promise 从未启动。 */
  private buildEarlyFailedHandle(record: ExecutionRecord): ExecutionHandle {
    const details = project(record);
    return { mode: "background", subagentId: record.id, sessionFile: record.sessionFile, details };
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
    rawOnEvent?: (event: AgentEvent) => void,
    stream?: SubagentStream,
  ): Promise<AgentResult> {
    const pooled = record.mode === "background";
    let acquired = false;
    if (pooled) {
      const effectiveMaxConcurrent = Math.max(1, this.pool.maxConcurrent - record.depth);
      try {
        await this.pool.acquire(priority, effectiveMaxConcurrent, signal);
        acquired = true;
      } catch {
        // S1: 排队中被 abort（signal.aborted）走 cancelled，与已运行被 abort 一致。
        if (signal?.aborted) return this.finalizeAborted(record);
        return this.finalizeFailed(record, new Error("aborted"));
      }
    }
    // onEvent 包装：AgentEvent → onUpdate(project(record)) 回流调用方
    const onEvent = rawOnEvent
      ?? (opts.onUpdate
        ? (event: AgentEvent): void => this.onEventThrottled(record, event, opts.onUpdate!)
        : undefined);

    // 解析 worktree 参数：boolean → WorktreeHandle | undefined（true/undefined 由 run 内部处理）
    let worktreeHandle: WorktreeHandle | undefined;
    if (typeof opts.worktree === "object") {
      worktreeHandle = opts.worktree;
    }
    // [MF#4][MF#2] fork 深度护栏：ALS 传递深度（主 session 链无 store→0，fork 推进 +1）。
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
            schemaEnv: opts.schemaEnv, // D-A6 bridge: workflow 编排层透传 schema 到 childEnv
            maxTurns: opts.maxTurns,
            graceTurns: opts.graceTurns,
            signal,
            onEvent,
            stream, // text_delta streaming（background 路径有值，workflow 路径 undefined）
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
      if (pooled && acquired) this.pool.release();
      // 清除 streaming widget（subagent 终态，幂等）
      stream?.dispose();
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
    // 创建 streaming 生命周期对象——streamSink 为 null（session_start 未注入）时降级为 undefined。
    const stream = this.streamSink
      ? new SubagentStream(record.id, this.streamSink)
      : undefined;

    void this.runAndFinalize(
      record, opts, ctx, identity, signal, priority,
      undefined, stream,
    )
      .then(() => {
        // background 回注：仅当本路径抢到 CAS（status 已转 done/failed）才 notify。
        // cancel 抢先时 status=cancelled，cancelBackground 自己 notify，此处跳过。
        if (record.status !== "cancelled") {
          this.notifyComplete(record);
        }
      })
      .catch((err: unknown) => {
        // detached 吞错：runAndFinalize 内部已 finalize record（含 emitPendingUnregister），不外抛
        // 完成通知由 finalizeRecord 内的 emitPendingUnregister 承担（pending-notifications 消费）。
        // cancel 抢先时 status=cancelled，cancelBackground 自己 emit，此处无需重复。
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
    // collectRecords 重建时 override status=cancelled。durationMs 用真实耗时（startedAt → now）。
    const cancelledResult: AgentResult = { text: "", turns: record.turnCount, durationMs: Date.now() - record.startedAt, success: false, error: "cancelled by user", sessionId: record.id, toolCalls: [] };
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
    // pending-notifications：cancel 注销（只记 registry 状态）
    emitPendingUnregister(this.pi, record.id, "cancelled");
    // cancel 完成通知（与 kickOffBackground.then 对称——cancel 抢先时 .then 跳过 notify）
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
    // ── Step 0: collectPatch（best-effort）──
    // [MF#3] patchFile 写到 worktree 之外（sessionsDir/<branch>.patch），避免被 cleanup 删除；
    //        路径回填 record.patchFile，供调用方（tool result / /subagents list）应用。
    if (record.worktreeHandle) {
      try {
        const sessionsDir = getSubagentSessionDir(
          this.modelService.getAgentDir(),
          record.worktreeHandle.mainCwd,
        );
        fs.mkdirSync(sessionsDir, { recursive: true });
        const patchFile = path.join(sessionsDir, `${record.worktreeHandle.branch}.patch`);
        const patch = this.worktreeManager.collectPatch(record.worktreeHandle, patchFile);
        if (patch.written) record.patchFile = patchFile;
      } catch (pe: unknown) {
        bestEffort(pe, "collectPatch (finalizeRecord Step0)");
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

    // ── Step 2.5: manifest持久化（FR-7: 失败向上抛错，不走 bestEffort）──
    try {
      await this.manifestStore.writeManifest({
        id: record.id,
        rootSessionId: record.rootSessionId ?? "",
        agentName: record.agent,
        status: status === "done" ? "completed" : status,
        createdAt: record.startedAt,
        completedAt: record.endedAt ?? Date.now(),
        sessionFile: record.sessionFile,
        pid: process.pid,
      });
    } catch (err) {
      // FR-7: manifest 写入失败向上抛错
      throw new Error(`manifest 写入失败 (finalizeRecord Step2.5): ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Step 3: finalized + cleanup + aliveMarker（三件各自独立 try/catch）──
    if (record.sessionFile) {
      try {
        // MF-1 fix: cancelled 状态写 tombstone 而非 finalized，防重建丢失 cancelled
        if (status === "cancelled") {
          writeCancelledTombstone(record.sessionFile, {
            id: record.id,
            status: "cancelled",
            agent: record.agent,
            startedAt: record.startedAt,
            endedAt: record.endedAt ?? Date.now(),
          });
        } else {
          writeFinalized(record.sessionFile);
        }
      } catch (err) {
        bestEffort(err, "writeFinalized/tombstone (finalizeRecord Step3)");
      }
    }
    if (record.worktreeHandle) {
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

    // pending-notifications：终态注销（只记 registry 状态，通知由 BgNotifier 发）
    emitPendingUnregister(this.pi, record.id, status);
  }

  /** run() 创建期异常的收尾（H1 修复）：createAndConfigureSession 失败会抛，本方法合成 failed
   *  AgentResult → CAS 抢锁 → finalizeRecord（与正常路径同形）。返回合成 result 供 runAndFinalize
   *  继续返回（不 re-throw，swallow 策略）。 */
  private async finalizeFailed(record: ExecutionRecord, err: unknown): Promise<AgentResult> {
    const errMsg = err instanceof Error ? err.message : String(err);
    // durationMs 用真实耗时（startedAt → now），避免失败统计恒为 0 失真。
    const failedResult: AgentResult = { text: "", turns: record.turnCount, durationMs: Date.now() - record.startedAt, success: false, error: errMsg, sessionId: record.id, toolCalls: [] };
    // CAS 抢锁：抢到（status 仍 running）则完整收尾；没抢到（cancel 已先设 cancelled）跳过。
    if (tryTransition(record, "failed")) {
      await this.finalizeRecord(record, failedResult, "failed");
    }
    return failedResult;
  }

  /** S1: 排队中被 abort 走 cancelled 终态（对齐已运行被 abort 的 cancelBackground）。 */
  private async finalizeAborted(record: ExecutionRecord): Promise<AgentResult> {
    const cancelledResult: AgentResult = { text: "", turns: record.turnCount, durationMs: Date.now() - record.startedAt, success: false, error: "cancelled by user", sessionId: record.id, toolCalls: [] };
    if (tryTransition(record, "cancelled")) {
      await this.finalizeRecord(record, cancelledResult, "cancelled");
    }
    return cancelledResult;
  }

  // onUpdate 节流状态（per-record Map）。每条 record 独立节流，避免嵌套（fork 链：主→A→B）
  // 多条 onUpdate 链争用同一份状态。旧实现用单实例字段——trailing timer 异步导致跨链争用
  // → onUpdate 被吞/延迟 → 主 agent 对话流残影。per-record 化让 A/B 各自独立节流。
  private readonly throttleState = new Map<string, { lastEmitAt: number; timer?: ReturnType<typeof setTimeout> }>();

  /** AgentEvent 节流回流到 onUpdate（streaming delta 不触发 + 时间窗节流）。
   *  名为 Throttled 必须真节流——否则嵌套场景一秒 10+ 事件密集回流 → Pi tool_execution_update
   *  密集重绘 → 流式 tool 组件残影。leading + trailing：首次立即发（响应性），窗口内后续合并
   *  到末尾补发一次（保证终态事件不丢）。节流状态 per-record，trailing timer 不会跨链污染。 */
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
      // ADR-031 废弃 discovery.json 后，skillDirs 为空。子 session 的 --skill
      // 由 agent({skill}) 调用方显式传入（resolveSkillPath → opts.skillPath）。
      skillDirs: [],
      mainCwd: this.cwd,
      // mainSessionFile: fork source 解析用，从 session_start 缓存获取。
      mainSessionFile: this.getMainSessionFile?.() ?? undefined,
      // worktree pid 回调：session-runner first header 时补全注册表 pid。
      onWorktreePid: (branch: string, pid: number) => this.worktreeManager.registerPid(branch, pid),
      uiRequestHandler: this.uiRequestHandler,
      // SR-4：L2 dialog 队列透传——child close 时 session-runner 据此调 rejectChildDialogs
      // 清理 L2 pending dialog，防全局死锁。undefined 时 session-runner 跳过 L2 清理。
      dialogQueue: this.dialogQueue,
      // 主进程运行模式：session-runner W4 守卫据此决定是否注入 ask_user RPC 提示词。
      mode: this.uiObservability.getMode(),
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
