/**
 * subagents-workflow Extension — Factory（extension 装配点）
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

import type { ExtensionAPI, ExtensionContext, ResourcesDiscoverEvent, ResourcesDiscoverResult, SessionShutdownEvent, SessionStartEvent } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

import type { AgentRegistry } from "./execution/agent-registry.ts";
import { bestEffort } from "./execution/best-effort.ts";
// ═══ execution/ 层（subagents 核心 + 运行时） ═══
import { DiscoveryConfigLoader } from "./execution/discovery-config.ts";
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

  // discovery.json 契约加载器（进程级单例，跨 session 复用 mtime 缓存）。
  const discoveryLoader = new DiscoveryConfigLoader(getAgentDir());

  pi.on("resources_discover", (_event: ResourcesDiscoverEvent, _ctx: ExtensionContext): ResourcesDiscoverResult => {
    const discovery = discoveryLoader.load();
    return { skillPaths: discovery.skillDirs.length > 0 ? [...discovery.skillDirs] : undefined };
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
      onRunDone: (run: WorkflowRun) => notifyDone(pi, run.runId, run, notifiedRunIds, sessionCtx),
      agentRegistry: state.agentRegistry,
      sessionDir: state.sessionDir,
      activeTempFiles: state.activeTempFiles,
      eventBus: pi.events,
      scheduleTimeBudget: (runId: string, budgetTimeMs: number) =>
        scheduleTimeBudget(runId, deps, budgetTimeMs),
      onWorkflowCall: (name: string, args: Record<string, unknown>, parentRun: WorkflowRun) =>
        executeNestedWorkflow(name, args, parentRun, deps),
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
    const modelService = existingModelService ?? new ModelConfigService({ agentDir, discoveryLoader });
    const service = existingService ?? new SubagentService({ cwd, modelService, getMainSessionFile: getCachedMainSessionFile });

    modelService.initModel({
      modelRegistry: ctx.modelRegistry,
      sessionId: ctx.sessionManager.getSessionId(),
      ctxModel: ctx.model ?? undefined,
    });
    service.initSession({
      pi,
      sessionId: ctx.sessionManager.getSessionId(),
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

    // F-4/D-003: 复用 modelService 的 AgentRegistry（discovery.json 契约 + 包内 builtin），
    // 取代旧 orchestration/agent-discovery.ts 的 7 路径自爬。新 AgentRegistry 仅扫 flat
    // 目录（无 nested extensions/*/agents、node_modules 迭代），发现路径由 discovery.json
    // （Pi resources_discover，ADR-028）声明——与 subagents 域共用同一份发现结果。
    const agentRegistry = modelService.getAgentRegistry();

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
      console.error("[subagents-workflow] store.loadAll failed, workflow domain uninitialized:", err);
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
    });
  });

  // ════════════════════════════════════════════════════════════
  //  model_select：用户切换 model 时刷新缓存
  // ════════════════════════════════════════════════════════════
  pi.on("model_select", (event: { model: NonNullable<ExtensionContext["model"]> }, _ctx: ExtensionContext) => {
    const service = getModelConfigService();
    if (service && typeof service.setCtxModel === "function") {
      service.setCtxModel(event.model);
    }
  });

  // ════════════════════════════════════════════════════════════
  //  session_tree：切分支前 pause 所有 running run
  // ════════════════════════════════════════════════════════════
  pi.on("session_tree", async (_event: Record<string, unknown>, ctx: ExtensionContext) => {
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
    const sessionId = lsRef.lastSessionId;
    const state = sessionState.get(sessionId);
    if (state) {
      const running = Array.from(state.runs.values()).filter((r) => r.state.status === "running");
      await Promise.allSettled(
        running.map((run) => pauseRun(run.runId, makeDeps(state, _ctx))),
      );
      cleanupAllFiles(state.activeTempFiles);
    }
    sessionState.delete(sessionId);
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
    const state = sessionState.get(lsRef.lastSessionId);
    if (!state) {
      return {
        status: "done",
        reason: "failed",
        error: "Session not initialized",
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
    const state = sessionState.get(lsRef.lastSessionId);
    if (!state) throw new Error("Session not initialized");
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
