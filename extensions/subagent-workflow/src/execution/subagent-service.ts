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

import { type ConcurrencyPool,DefaultConcurrencyPool } from "./concurrency-pool.ts";
import {
  completeRecord,
  createRecord,
  project,
  snapshot,
  tryTransition,
} from "./execution-record.ts";
import type { AgentConfig, ModelInfo, ResolvedModel } from "./model-resolver.ts";
import { getSubagentSessionDir } from "./path-encoding.ts";
import { MAX_FORK_DEPTH } from "./session-context-resolver.ts";
import { killAllSpawnedChildren, runSpawn, type SessionRunnerContext } from "./session-runner.ts";
import type { WorktreeHandle } from "./types.ts";
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
import { bestEffort } from "./best-effort.ts";
import { removeAliveMarker } from "./alive-store.ts";
import { writeFinalized } from "./finalized-marker.ts";
import type { StatusFilter } from "./record-store.ts";
import { RecordStore } from "./record-store.ts";
import { writeCancelledTombstone } from "./tombstone-store.ts";

// D-A10: workflow 侧 AgentResult 映射（executeAndAwait 出口）
import { mapToWorkflowAgentResult } from "./agent-result-mapper.ts";
import type { AgentResult as WorkflowAgentResult } from "../orchestration/models/types.ts";
import type { ModelConfigService } from "./model-config-service.ts";
import { WorktreeManager } from "./worktree-manager.ts";
import { BgNotifier } from "./notifier.ts";
import type { BgNotifyRecord, NotifierHost } from "./notifier.ts";
import type { StreamSink } from "./stream-sink.ts";
import { SubagentStream } from "./stream-sink.ts";

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

/** [PoC] UI streaming sink 的最小接口（ctx.ui.setWidget 的 duck-typed 子集）。
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
}

/** session_start 注入参数（session 级）。 */
export interface SubagentServiceSessionInit {
  pi: PiLike;
  sessionId: string;
  /** [PoC] UI streaming sink（ctx.ui.setWidget），用于 background text_delta 转发。 */
  streamSink?: StreamSink;
}

/** background 优先级（保留 priority 排序机制，单一值）。 */
const PRIORITY_BACKGROUND = 1000;

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
  private readonly modelService: ModelConfigService;
  private readonly cwd: string;
  private readonly worktreeManager: WorktreeManager;
  private readonly getMainSessionFile: (() => string | undefined) | undefined;

  private pi: PiLike | null = null;
  /** 当前 Pi session ID（session 隔离过滤用）。initSession 时注入。 */
  private sessionId: string | null = null;
  /** [PoC] UI streaming sink（ctx.ui.setWidget），background text_delta 转发用。 */
  private streamSink: StreamSink | null = null;
  private _disposed = false;
  private _seq = 0;
  /** background 完成通知器（滑动窗口合并 + 去重）。session_start revive，shutdown dispose。 */
  private readonly notifier: BgNotifier;
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
    this.worktreeManager = new WorktreeManager(this.modelService.getAgentDir());
    const sessionsDir = getSubagentSessionDir(this.modelService.getAgentDir(), init.cwd);
    this.store = new RecordStore(sessionsDir);
    this.notifier = new BgNotifier(this.piAdapter());
  }

  // ── 生命周期（index.ts 调）──────────────────────────────

  /** session_start 注入 pi + revive（modelRegistry/entries 归 ModelConfigService.initModel）。 */
  initSession(init: SubagentServiceSessionInit): void {
    this.pi = init.pi;
    this.sessionId = init.sessionId;
    this.streamSink = init.streamSink ?? null;
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
    // [R0/C1 孤儿进程修复] 进程退出路径：两层兜底 kill 所有 spawned 子进程（sync + background）。
    //   1. store.abortRunningControllers()：background record 的 controller.abort → runSpawn signal
    //      listener → child.kill("SIGTERM")。这是 background 的 CAS 收尾语义路径（不能动）。
    //   2. killAllSpawnedChildren()：遍历 session-runner 的 spawnedChildren Set（sync + background
    //      均注册），对仍存活的发 SIGTERM。sync record 的 controller 是 undefined，abortRunningControllers
    //      跳过它们——此处补齐，防止 sync 子进程成孤儿（主进程崩溃/SIGKILL 之外的退出路径）。
    // 必须在 store.dispose 之前（dispose 后 records 仍可访问，但语义上先 kill 再清场）。
    // 注意：dispose 是同步返回，主进程可能紧接着 process.exit()，runSpawn 的 finally 清理
    //（identity 补写等）可能来不及跑——这是可接受的退化（session.jsonl 已由子进程写入，
    // 缺 identity entry 只影响 list 重建的可观测性，不丢执行数据）。
    //
    // [T2 AC-4.3 双重记账一致性] 进程退出时所有 running record 异常终止（runAndFinalize 的
    // finalizeRecord 不会再跑——detached promise 随进程退出而丢弃）。此处为每个 running record
    // emit pending:unregister(reason=failed)，让 pending-notifications 清理 registry entry，
    // 避免进程退出后两侧（subagent store vs pending registry）状态不一致。
    // 必须在 abortRunningControllers 之前——此时 record 仍 running，listRunning 能取到。
    // 只 emit running 的 record（已终态的由其正常路径 emit 过，不重复）。
    for (const record of this.store.listRunning()) {
      emitPendingUnregister(this.pi, record.id, "failed");
    }
    this.store.abortRunningControllers();
    // [C1] orphan 进程兜底：abortRunningControllers 只能 kill background 子进程（有 controller）。
    // sync 子进程的 controller 是 undefined（见 createRecordForMode），主进程退出时会被遗漏成孤儿。
    // killAllSpawnedChildren 遍历 session-runner 的 spawnedChildren Set（sync + background 均注册），
    // 对仍存活的子进程发 SIGTERM。background 子进程此时已被 controller.abort 路径 kill，
    // 此处对它们的二次 kill 是无害 noop（已 killed/退出）。不 await 子进程退出（dispose 要快）。
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
   * 统一执行入口。mode 固定 background（sync 已删除）。
   * 内部完成：模型解析 → 执行 → 收尾。
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

    // ── 步骤 5: runAndFinalize（await，不 detached）──
    // BC-11：onUpdate 置 undefined（不回流 tool UI 细节），onEvent 独立传（AgentEvent 透传 workflow）
    const result = await this.runAndFinalize(
      record,
      { ...opts, onUpdate: undefined },
      ctx,
      identity,
      effectiveSignal,
      PRIORITY_BACKGROUND,
      onEvent,
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
    const seq = ++this._seq;
    const tag = sessionTag(this.sessionId);
    // mode 类型固定 "background"——保留参数以兼容签名，但 id/controller 无需再分支。
    const id = `bg-${tag}-${seq}-${Date.now()}`;
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
    // 仅 background 进并发池限流，分层配额：每层嵌套 depth 让有效配额 -1（下限 1）。
    // 顶层 depth=0 拿满配额；嵌套越深有效并发越小，防子 agent fan-out 压垮主 agent 的 pool。
    const pooled = record.mode === "background";
    if (pooled) {
      const effectiveMaxConcurrent = Math.max(1, this.pool.maxConcurrent - record.depth);
      await this.pool.acquire(priority, effectiveMaxConcurrent);
    }
    // onEvent 包装：AgentEvent → onUpdate(project(record)) 回流调用方
    const onEvent = rawOnEvent
      ?? (opts.onUpdate
        ? (event: AgentEvent): void => this.onEventThrottled(record, event, opts.onUpdate!)
        : undefined);

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
            schemaEnv: opts.schemaEnv, // D-A6 bridge: workflow 编排层透传 schema 到 childEnv
            maxTurns: opts.maxTurns,
            graceTurns: opts.graceTurns,
            signal,
            onEvent,
            stream, // [PoC] text_delta streaming
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
      // [PoC] 清除 streaming widget（subagent 终态）
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
    // [PoC] 创建 text_delta streaming 生命周期对象——仅在 streamSink 可用时启用
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

    // pending-notifications：终态注销（只记 registry 状态，通知由 BgNotifier 发）
    emitPendingUnregister(this.pi, record.id, status);
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
      // ADR-031 废弃 discovery.json 后，skillDirs 为空。子 session 的 --skill
      // 由 agent({skill}) 调用方显式传入（resolveSkillPath → opts.skillPath）。
      skillDirs: [],
      mainCwd: this.cwd,
      // mainSessionFile: fork source 解析用，从 session_start 缓存获取。
      mainSessionFile: this.getMainSessionFile?.() ?? undefined,
      // worktree pid 回调：session-runner first header 时补全注册表 pid。
      onWorktreePid: (branch: string, pid: number) => this.worktreeManager.registerPid(branch, pid),
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
