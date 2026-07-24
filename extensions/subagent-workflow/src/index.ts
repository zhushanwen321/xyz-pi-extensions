/**
 * subagent-workflow Extension — Factory（extension 装配点）
 *
 * 合并 @zhushanwen/pi-subagents + @zhushanwen/pi-workflow 为统一包。
 * 注册项：3 tool（subagent + workflow + workflow-script）+ 2 command（subagents + workflows）
 * + messageRenderer（subagent-bg-notify）+ pi.__workflowRun + session 事件。
 *
 * 三层架构：
 *   interface/ → 注册胶水（tools/commands/tui）
 *   orchestration/ → workflow engine（launcher/lifecycle/error-recovery）
 *   execution/ → subagents 执行运行时（SubagentService/session-runner/concurrency-pool）
 *
 * 设计基线：D-004（旧包不动）/ ADR-025（进程内执行）/ D-8（pi.__workflowRun 签名）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext, ModelSelectEvent, ResourcesDiscoverEvent, ResourcesDiscoverResult, SessionShutdownEvent, SessionStartEvent, SessionTreeEvent } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

import type { AgentRegistry } from "./execution/agent-registry.ts";
import { bestEffort } from "./execution/best-effort.ts";
// ═══ execution/ 层（subagents 核心 + 运行时） ═══
import { getOrCreateChannelRegistry } from "./execution/channel-registry-access.ts";
import { DialogGlobalQueue } from "./execution/dialog-queue.ts";
import { createUiRequestHandlerForMode } from "./execution/ui-request-handler-factory.ts";
import {
  getModelConfigService,
  ModelConfigService,
  setModelConfigService,
} from "./execution/model-config-service.ts";
import { maybeCleanupExpiredSessionFiles } from "./execution/session-file-gc.ts";
import {
  getSubagentService,
  setSubagentService,
  SubagentService,
} from "./execution/subagent-service.ts";
import { SubprocessAgentRunner } from "./execution/subprocess-agent-runner.ts";
import { WorktreeManager } from "./execution/worktree-manager.ts";
import { renderBgNotifyMessage } from "./interface/bg-notify-render.ts";
import { registerWorkflowsCommand } from "./interface/commands.ts";
import { toGuiCtx } from "./interface/gui-mappers.ts";
import { notifyDone } from "./interface/helpers.ts";
import { registerSubagentTool } from "./interface/subagent-tool.ts";
// ═══ interface/ 层（tools/commands/tui 合并） ═══
import { registerSubagentsCommand } from "./interface/subagents.ts";
import { registerWorkflowTool } from "./interface/tool-workflow.ts";
import { registerWorkflowScriptTool } from "./interface/tool-workflow-script.ts";
import { cleanupAllTempFiles as cleanupAllFiles } from "./orchestration/agent-opts-resolver.ts";
import { JsonlRunStore } from "./orchestration/jsonl-run-store.ts";
// ═══ orchestration/ 层（workflow engine + infra） ═══
import type { LauncherDeps } from "./orchestration/launcher.ts";
import { executeNestedWorkflow, runAndWait, type WorkflowRunResult } from "./orchestration/launcher.ts";
import { pauseRun, scheduleTimeBudget } from "./orchestration/lifecycle.ts";
import type { WorkflowRun } from "./orchestration/models/workflow-run.ts";
import { WorkerHostImpl } from "./orchestration/worker-host.ts";
import { WorkflowScriptRegistryImpl } from "./orchestration/workflow-script-registry-impl.ts";

// ── pi.__workflowRun 类型扩展（D-8 签名） ─────────────────

declare module "@mariozechner/pi-coding-agent" {
  interface ExtensionAPI {
    __workflowRun?: (
      workflowName: string,
      workflowArgs: Record<string, unknown>,
      workflowSignal?: AbortSignal,
      workflowTimeoutMs?: number,
    ) => Promise<WorkflowRunResult>;
  }
}

// ── Factory ──────────────────────────────────────────────────

export default function subagentsWorkflowExtension(pi: ExtensionAPI): void {
  // ════════════════════════════════════════════════════════════
  //  subagents 域：tool + command + messageRenderer
  // ════════════════════════════════════════════════════════════
  registerSubagentTool(pi);
  registerSubagentsCommand(pi);
  pi.registerMessageRenderer("subagent-bg-notify", renderBgNotifyMessage);

  // 模块级缓存：主 session 的 sessionFile（fork source 解析用）。
  let cachedMainSessionFile: string | undefined;
  function getCachedMainSessionFile(): string | undefined {
    return cachedMainSessionFile;
  }

  // resources_discover：不再注入额外 skill 目录（ADR-031 废弃 discovery.json）。
  // pi 核心 auto-discovery 已覆盖 .agents/skills 等标准目录，子 session 的
  // --skill 由 agent({skill}) 调用方显式传入，无需 extension 额外补充。
  pi.on("resources_discover", (_event: ResourcesDiscoverEvent, _ctx: ExtensionContext): ResourcesDiscoverResult => {
    return {};
  });

  // ════════════════════════════════════════════════════════════
  //  workflow 域：tools + command + pi.__workflowRun + state
  // ════════════════════════════════════════════════════════════
  const lsRef = { lastSessionId: "" };
  const notifiedRunIds = new Set<string>();
  const guard = { isProcessing: false };

  // Infra 实例（per-factory 单例，跨 session 复用）
  const workerHost = new WorkerHostImpl();
  const registry = new WorkflowScriptRegistryImpl();

  // SAR 改为 per-session 构造（需要 ctxModel 填底 D-008 + subagentService 委托目标）
  // old: const runner = new SubprocessAgentRunner();
  // new: per-session session_start 时创建，见下方 makeDeps 前的 runner 创建

  // per-session 状态（session_start 时重建）
  const sessionState = new Map<
    string,
    {
      store: JsonlRunStore;
      runs: Map<string, WorkflowRun>;
      activeTempFiles: Set<string>;
      agentRegistry: AgentRegistry;
      sessionDir: string;
      /** D-008 per-session SAR（需要 ctxModel + subagentService） */
      runner: SubprocessAgentRunner;
      /** session 上下文（notifyDone 需要 GuiContext） */
      ctx?: ExtensionContext;
      /** MF-1: store 健康度。session_start 时 store.loadAll 失败则置 false，
       *  workflow 域启动时 fail-fast，避免后续 store.save 再次失败导致 run 状态不落地。
       *  subagent 域不依赖 store，不受此标志影响。 */
      storeHealthy: boolean;
    }
  >();

  function log(
    level: "debug" | "info" | "warn" | "error",
    component: string,
    message: string,
    data?: unknown,
  ): void {
    try {
      pi.appendEntry("workflow:log", {
        timestamp: Date.now(),
        level,
        component,
        message,
        data,
      });
    } catch (err) {
      void err;
    }
  }

  function resolveSessionDir(): string {
    const defaultDir = path.join(os.homedir(), ".pi", "agent");
    const sessionSlug = `--${process.cwd().replace(/^\//, "").replace(/\//g, "-")}--`;
    const sessionScopedDir = path.join(os.homedir(), ".pi", "agent", "sessions", sessionSlug);
    return fs.existsSync(sessionScopedDir) ? sessionScopedDir : defaultDir;
  }

  function makeDeps(
    state: {
      store: JsonlRunStore;
      runs: Map<string, WorkflowRun>;
      activeTempFiles: Set<string>;
      agentRegistry: AgentRegistry;
      sessionDir: string;
      runner: SubprocessAgentRunner;
    },
    sessionCtx?: ExtensionContext,
  ) {
    const deps: LauncherDeps = {
      store: state.store,
      workerHost,
      runner: state.runner,
      runs: state.runs,
      registry,
      onRunDone: (run: WorkflowRun) => notifyDone(pi, run.runId, run, notifiedRunIds, toGuiCtx(sessionCtx)),
      agentRegistry: state.agentRegistry,
      sessionDir: state.sessionDir,
      activeTempFiles: state.activeTempFiles,
      eventBus: pi.events,
      scheduleTimeBudget: (runId: string, budgetTimeMs: number) =>
        scheduleTimeBudget(runId, deps, budgetTimeMs),
      onWorkflowCall: (name: string, args: Record<string, unknown>, parentRun: WorkflowRun) =>
        executeNestedWorkflow(name, args, parentRun, deps),
      streamSink: getSubagentService()?.getStreamSink() ?? undefined,
      log,
    };
    return deps;
  }

  function isScriptRunning(name: string): boolean {
    for (const state of sessionState.values()) {
      for (const run of state.runs.values()) {
        if (run.spec.scriptName === name && run.state.status === "running") return true;
      }
    }
    return false;
  }

  // ════════════════════════════════════════════════════════════
  //  session_start：初始化 subagents + workflow 两域
  // ════════════════════════════════════════════════════════════
  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const cwd = ctx.cwd;
    const agentDir = getAgentDir();
    const sessionId = ctx.sessionManager.getSessionId();
    lsRef.lastSessionId = sessionId;

    // ── subagents 域：双 Service 装配 ──
    const existingService = getSubagentService();
    const existingModelService = getModelConfigService();
    const modelService = existingModelService ?? new ModelConfigService({ agentDir, cwd });
    const service = existingService ?? new SubagentService({ cwd, modelService, getMainSessionFile: getCachedMainSessionFile });

    modelService.initModel({
      modelRegistry: ctx.modelRegistry,
      sessionId: ctx.sessionManager.getSessionId(),
      ctxModel: ctx.model ?? undefined,
    });

    // ── W3: handler 注入链路接通 ──
    // 进程级单例：channel registry + dialog queue 跨 session 复用
    //（与 SubagentService 单例模式一致，globalThis Symbol 持有避免 jiti 多实例分裂）。
    const channelRegistry = getOrCreateChannelRegistry();
    const dialogQueue = getOrCreateDialogQueue();
    const uiRequestHandler = createUiRequestHandlerForMode(ctx, channelRegistry, dialogQueue);
    // SR-3: 无论 new 还是 existing（/resume /fork 复用），session_start 都必须注入 handler
    service.setUiRequestHandler(uiRequestHandler);

    service.initSession({
      pi,
      sessionId: ctx.sessionManager.getSessionId(),
      // 注入 ctx.ui.setWidget 作为 streaming sink（只绑方法，不持有整个 ctx）。
      // background subagent 执行期间，text_delta 经 SubagentStream 合并后由此通道转发。
      // [W1 修复] ctx.mode === 'rpc' 守卫：TUI/json/print 下 streamSink = undefined（无 widget 噪音），
      // rpc mode（GUI/xyz-agent）下保持原行为（ctx.ui.setWidget → sidecar → chatStore）。
      // streamSink API 不变（SubagentStream.onDelta 仍可调，只是 TUI 下 stream 不会被创建）。
      streamSink: ctx.mode === "rpc"
        ? { setWidget: (key, lines) => ctx.ui.setWidget(key, lines) }
        : undefined,
      // [#24] uiRequestHandler 单一注入入口：上方 setUiRequestHandler 已注入（SR-3 语义，
      // new/existing service 均覆盖）。此处不再重复传 initSession.uiRequestHandler，避免
      // 同一 handler 双路径注入造成的语义混淆与“哪一个是 source of truth”歧义。
      // mode 仍需 session 级注入（uiObservability.setMode 依赖它，与 handler 无关）。
      mode: ctx.mode,
      // SR-4：注入 L2 dialog 队列——session-runner child close 时调 rejectChildDialogs
      // 清理该 child 在 L2 的 pending dialog，防全局死锁（C1 修复：清理路径接通）。
      dialogQueue,
      // [竞态修复] 注入 ctx.isIdle：notifier flush 在主 agent busy 时退避，idle 后再
      // sendMessage(triggerTurn)，规避 agent_end→finishRun 窗口里走 steer 分支丢失通知。
      isIdle: () => ctx.isIdle(),
    });

    if (!existingService) {
      setModelConfigService(modelService);
      setSubagentService(service);
    }

    cachedMainSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;

    try {
      maybeCleanupExpiredSessionFiles(agentDir, cwd);
    } catch (err) {
      void err;
      console.warn("[subagents] expired session file cleanup failed:", err);
    }

    // ADR-035 启动恢复：扫描 manifest tmp 残留（崩溃打断的 writeManifest 留下），
    // 每次 session_start 都调（与上方 maybeCleanupExpiredSessionFiles 一致）。
    try {
      const recovered = await service.recoverManifestTmpFiles();
      if (recovered.recovered > 0 || recovered.deleted > 0) {
        console.warn(`[subagents] manifest tmp recovery: ${recovered.recovered} promoted, ${recovered.deleted} deleted`);
      }
    } catch (err) {
      void err;
      console.warn("[subagents] manifest tmp recovery failed:", err);
    }

    try {
      const wtm = new WorktreeManager(agentDir);
      wtm.scan();
    } catch (err) {
      void err;
      console.warn("[subagents] worktree reaper scan failed:", err);
    }

    // ── workflow 域：per-session store + runs ──
    const sessionDir = resolveSessionDir();
    const store = new JsonlRunStore({
      sessionDir,
      pi,
      ctx,
    });
    const runs = new Map<string, WorkflowRun>();

    // F-4/D-003: 复用 modelService 的 AgentRegistry（统一资源发现 + 包内 builtin），
    // 取代旧 orchestration/agent-discovery.ts 的 7 路径自爬。agent 发现走
    // shared/resource-discovery（ADR-031），与 subagents 域共用同一份发现结果。
    const agentRegistry = modelService.getAgentRegistry();

    // MF-1: store 健康度跟踪。loadAll 失败 → storeHealthy=false，workflow 域启动时 fail-fast。
    let storeHealthy = true;
    try {
      const loaded = await store.loadAll();
      for (const run of loaded) {
        if (run.state.status === "running") {
          run.state.error = "Process killed (kill-9 or crash recovery)";
          run.transition("done", "failed");
          pi.events.emit("pending:unregister", {
            id: run.runId,
            reason: "failed",
          });
        }
        runs.set(run.runId, run);
      }
    } catch (err) {
      // QMF-4 fix: store.loadAll 失败是关键路径错误，workflow 域将未初始化
      console.error("[subagent-workflow] store.loadAll failed, workflow domain uninitialized:", err);
      storeHealthy = false;
    }

    // D-008: per-session SAR（需要 ctxModel 填底 + subagentService 委托目标）。
    // old: const runner = new SubprocessAgentRunner()（module-level singleton，无 deps）
    // new: per-session session_start 时创建，通过 sessionState 传给 makeDeps。
    const runner = new SubprocessAgentRunner({
      subagentService: service,
      ctxModel: ctx.model ?? undefined,
    });

    sessionState.set(sessionId, {
      store,
      runs,
      activeTempFiles: new Set(),
      agentRegistry,
      sessionDir,
      runner,
      ctx,
      storeHealthy,
    });
  });

  // ════════════════════════════════════════════════════════════
  //  model_select：用户切换 model 时刷新缓存
  // ════════════════════════════════════════════════════════════
  pi.on("model_select", (event: ModelSelectEvent, ctx: ExtensionContext) => {
    const service = getModelConfigService();
    if (service && typeof service.setCtxModel === "function") {
      service.setCtxModel(event.model);
    }
    // H1: 同步刷新所有 session 的 SAR ctxModel（旧实现只在 session_start 固化）
    const sid = ctx.sessionManager.getSessionId();
    const state = sessionState.get(sid);
    if (state) {
      state.runner.updateCtxModel(event.model);
    }
  });

  // ════════════════════════════════════════════════════════════
  //  session_tree：切分支前 pause 所有 running run
  // ════════════════════════════════════════════════════════════
  pi.on("session_tree", async (_event: SessionTreeEvent, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    lsRef.lastSessionId = sessionId;

    const state = sessionState.get(sessionId);
    if (state) {
      for (const run of state.runs.values()) {
        if (run.state.status === "running") {
          try {
            await pauseRun(run.runId, makeDeps(state, ctx));
          } catch (err) {
            bestEffort(err, "pauseRun (session_tree handler)");
          }
        }
      }
    }
  });

  // ════════════════════════════════════════════════════════════
  //  session_shutdown：dispose subagents + pause workflows + cleanup
  // ════════════════════════════════════════════════════════════
  pi.on("session_shutdown", async (_event: SessionShutdownEvent, _ctx: ExtensionContext) => {
    // ── subagents 域：dispose SubagentService ──
    getSubagentService()?.dispose();

    // ── workflow 域：pause 所有 running run + 清理 temp files ──
    // H-5: 遍历所有 sessionState 条目清理（而不只 lastSessionId——
    // 防御 session 切换但 session_tree 未先触发导致 lastSessionId 指向已删除 session 的情况）。
    for (const [sessionId, state] of sessionState) {
      const running = Array.from(state.runs.values()).filter((r) => r.state.status === "running");
      await Promise.allSettled(
        running.map((run) => pauseRun(run.runId, makeDeps(state, _ctx))),
      );
      cleanupAllFiles(state.activeTempFiles);
      sessionState.delete(sessionId);
    }

    // M2: 清理 dialog queue 运行时状态（queue/current/processing）。
    // [#10] 先 rejectAll() settle 所有 pending dialog Promise（防闭包泄漏：未 settle 的
    // Promise 持有 resolve/reject 闭包及 handler 上下文，session 退出后仍挂在全球队列上），
    // 再 clear() 重置 queue/current/processing（防异常退出后 processing=true 卡死下次 session）。
    // rejectAll() 由 dialog-queue.ts 提供（Group B 新增）；若其内部已 reset 状态，此处 clear() 为幂等兜底。
    // 单 session 假设（M-2，同 lastSessionId）：rejectAll() 清空进程级单例的所有 pending，
    // 依赖 Pi 单进程单 session 串行保证——不会误清其他 session。多 session 并发的迁移策略
    // 见 DialogGlobalQueue 类注释（rejectAllForSession）。
    // channel registry 不清：跨 session 持久是有意设计（ask-user 扩展注册的 channel handler
    // 在 /new /resume /fork 时不丢失注册）。
    const dialogQueue = getOrCreateDialogQueue();
    dialogQueue.rejectAll();
    dialogQueue.clear();
  });

  // ════════════════════════════════════════════════════════════
  //  pi.__workflowRun（D-8 签名）
  // ════════════════════════════════════════════════════════════
  pi.__workflowRun = async (
    workflowName: string,
    workflowArgs: Record<string, unknown>,
    workflowSignal?: AbortSignal,
    workflowTimeoutMs?: number,
  ): Promise<WorkflowRunResult> => {
    // 注意：lastSessionId 是单值假设——Pi 当前保证单 session 串行（一次只一个活跃 session）。
    // 若未来 Pi 支持多 session 并发，此处需改为从 ctx.sessionManager.getSessionId() 显式传入。
    // M-2 已记录此假设。
    const state = sessionState.get(lsRef.lastSessionId);
    if (!state) {
      return {
        status: "done",
        reason: "failed",
        error: "Session not initialized",
        runId: "",
      };
    }
    // MF-1: store 不健康时 fail-fast，避免 store.save 再次失败导致 run 状态不落地。
    if (!state.storeHealthy) {
      return {
        status: "done",
        reason: "failed",
        error: "Workflow store unavailable (loadAll failed in session_start)",
        runId: "",
      };
    }
    return runAndWait(
      workflowName,
      workflowArgs,
      makeDeps(state, state.ctx),
      workflowSignal,
      workflowTimeoutMs,
    );
  };

  // ════════════════════════════════════════════════════════════
  //  Tools（3 个）—— lazy deps 注入
  // ════════════════════════════════════════════════════════════
  const getDeps = () => {
    // 注意：lastSessionId 是单值假设——Pi 当前保证单 session 串行（一次只一个活跃 session）。
    // 若未来 Pi 支持多 session 并发，此处需改为从 ctx.sessionManager.getSessionId() 显式传入。
    // M-2 已记录此假设。
    const state = sessionState.get(lsRef.lastSessionId);
    if (!state) throw new Error("Session not initialized");
    // MF-1: store 不健康时 fail-fast，避免 store.save 再次失败导致 run 状态不落地。
    if (!state.storeHealthy) {
      throw new Error("Workflow store unavailable (loadAll failed in session_start)");
    }
    return makeDeps(state, state.ctx);
  };

  const lazyDeps: LauncherDeps = {
    get store() {
      return getDeps().store;
    },
    workerHost,
    get runner() {
      return getDeps().runner;
    },
    get runs() {
      return getDeps().runs;
    },
    registry,
    get onRunDone() {
      return getDeps().onRunDone;
    },
    get agentRegistry() {
      return getDeps().agentRegistry;
    },
    get sessionDir() {
      return getDeps().sessionDir;
    },
    get activeTempFiles() {
      return getDeps().activeTempFiles;
    },
    get eventBus() {
      return getDeps().eventBus;
    },
    get scheduleTimeBudget() {
      return getDeps().scheduleTimeBudget;
    },
    get onWorkflowCall() {
      return getDeps().onWorkflowCall;
    },
    get log() {
      return getDeps().log;
    },
  };

  registerWorkflowTool(pi, lazyDeps, guard);
  registerWorkflowScriptTool(pi, registry, isScriptRunning);

  // ════════════════════════════════════════════════════════════
  //  Commands（2 个）
  // ════════════════════════════════════════════════════════════
  registerWorkflowsCommand(
    pi,
    () => {
      const state = sessionState.get(lsRef.lastSessionId);
      return state?.runs ?? new Map();
    },
    lazyDeps,
  );
}

// ============================================================
// 进程级单例（channel registry + dialog queue）
// ============================================================

// channel registry 经 channel-registry-access.ts 公开访问（跨扩展 API）。
// dialog queue 仍为本模块私有——无外部消费者。
const DIALOG_QUEUE_KEY = Symbol.for("@zhushanwen/pi-subagents.dialogQueue");

/** 获取或创建进程级 dialog queue 单例。
 *  L2 跨子进程串行队列——所有子进程的 dialog 类请求共享同一队列实例。 */
function getOrCreateDialogQueue(): DialogGlobalQueue {
  let queue = Reflect.get(globalThis, DIALOG_QUEUE_KEY) as DialogGlobalQueue | undefined;
  if (!queue) {
    queue = new DialogGlobalQueue();
    Reflect.set(globalThis, DIALOG_QUEUE_KEY, queue);
  }
  return queue;
}

// ============================================================
// Public cross-extension API（channel handler 注册入口）
// ============================================================
//
// 跨扩展消费者（ask-user 等）通过包根 import 注册 channel handler，
// 让 subagent 子进程的 UI 请求（ask_user 等）透传到主进程渲染。
// 重新导出 channel-registry-access 的公开 API——稳定 surface，
// 内部存储实现演进不影响消费者。

export {
  getOrCreateChannelRegistry,
  type UiChannelRegistry,
  type ChannelHandler,
} from "./execution/channel-registry-access.ts";
