/**
 * Workflow Extension — Factory（extension 装配点）
 *
 * 用 Infra 实例 + per-session runs Map + Engine free functions 装配 extension。
 * 无 Orchestrator/God Facade（D-12）。
 *
 * 关键设计：
 * - Infra 注入：JsonlRunStore / WorkerHostImpl / SubprocessAgentRunner /
 * WorkflowScriptRegistryImpl（4 个具体类，D-12 不造 interface）
 * - deps: LauncherDeps = { store, workerHost, runner, runs, registry }
 * - session_start：store.loadAll 重建 runs + D-4 kill-9 残留 running→failed
 * - pi.__workflowRun（D-8 签名）：调 runAndWait → {status:'done', reason, ...}
 * - 注册 2 个 tool（workflow-script + workflow）+ /workflows command
 * - session_tree：切分支前 pause 所有 running run
 * - session_shutdown：pause 所有 running + 清理 temp files
 *
 * Proxy 延迟解析：tool 注册一次，但 runs 是 per-session 的。Proxy 包装让 tool execute
 * 时按 lsRef.lastSessionId 取最新 session 的 store/runs。需 `as never` 断言 Proxy 类型。
 *
 * 参考：domain-models.md §D-8（WorkflowRunResult 签名）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { LauncherDeps } from "./engine/launcher.js";
import { runAndWait, type WorkflowRunResult } from "./engine/launcher.js";
import { pauseRun, scheduleTimeBudget } from "./engine/lifecycle.js";
import type { WorkflowRun } from "./engine/models/workflow-run.js";
import { AgentRegistry } from "./infra/agent-discovery.js";
import { cleanupAllTempFiles as cleanupAllFiles } from "./infra/agent-opts-resolver.js";
import { JsonlRunStore } from "./infra/jsonl-run-store.js";
import { SubprocessAgentRunner } from "./infra/subprocess-agent-runner.js";
import { WorkerHostImpl } from "./infra/worker-host.js";
import { WorkflowScriptRegistryImpl } from "./infra/workflow-script-registry-impl.js";
import { registerWorkflowsCommand } from "./interface/commands.js";
import { notifyDone } from "./interface/helpers.js";
import { registerWorkflowTool } from "./interface/tool-workflow.js";
import { registerWorkflowScriptTool } from "./interface/tool-workflow-script.js";

// ── pi.__workflowRun 类型扩展（D-8 新签名） ─────────────────

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

export default function workflowExtension(pi: ExtensionAPI): void {
  const lsRef = { lastSessionId: "" };
 // C-4: notifyDone 去重 Set——同一 runId 只通知一次（跨 done 路径 / 边界防重复）。
  const notifiedRunIds = new Set<string>();
 // P1-6: Reentry guard — shared between workflow + workflow-script tools
  const guard = { isProcessing: false };

 // Infra 实例（per-factory 单例，跨 session 复用）
  const runner = new SubprocessAgentRunner();
  const workerHost = new WorkerHostImpl();
  const registry = new WorkflowScriptRegistryImpl();

 // per-session 状态（session_start 时重建）
  const sessionState = new Map<
    string,
    {
      store: JsonlRunStore;
      runs: Map<string, WorkflowRun>;
      activeTempFiles: Set<string>;
      agentRegistry: AgentRegistry;
      sessionDir: string;
    }
  >();

 // ── Helper: 日志端口（写入 session entry，便于 debug） ───

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
      // 日志写入失败不应阻断主流程（stale context / session replacement 时 listener 仍可触发）
      void err;
    }
  }

 // ── Helper: 解析 sessionDir ───

  function resolveSessionDir(): string {
    const defaultDir = path.join(os.homedir(), ".pi", "agent");
    const sessionSlug = `--${process.cwd().replace(/^\//, "").replace(/\//g, "-")}--`;
    const sessionScopedDir = path.join(os.homedir(), ".pi", "agent", "sessions", sessionSlug);
    return fs.existsSync(sessionScopedDir) ? sessionScopedDir : defaultDir;
  }

 // ── Helper: 构建 LauncherDeps ─────────────────────────────

  function makeDeps(state: {
    store: JsonlRunStore;
    runs: Map<string, WorkflowRun>;
    activeTempFiles: Set<string>;
    agentRegistry: AgentRegistry;
    sessionDir: string;
  }) {
 // C-4: onRunDone callback——run 到达 done 终态时触发 notifyDone，唤醒 parent agent
 // 消费结果（UC-1 主路径）。所有 transition("done", ...) 路径调完 save 后触发。
 // BL-1: agentRegistry/sessionDir/activeTempFiles 透传给 dispatchAgentCall，
 // 让 resolveAgentOpts 能解析 agent({agent,skill,schema}) 的 inline override。
 // D-12 regression fix (round-2 #2)：scheduleTimeBudget 闭包捕获 deps，供
 // error-recovery.rebuildRuntime 在错误重试后重新调度墙钟预算计时器。
 // 箭头函数体延迟访问 deps，构造时不触发 TDZ。
    const deps: LauncherDeps = {
      store: state.store,
      workerHost,
      runner,
      runs: state.runs,
      registry,
      onRunDone: (run: WorkflowRun) => notifyDone(pi, run.runId, run, notifiedRunIds),
      agentRegistry: state.agentRegistry,
      sessionDir: state.sessionDir,
      activeTempFiles: state.activeTempFiles,
      eventBus: pi.events,
      scheduleTimeBudget: (runId: string, budgetTimeMs: number) =>
        scheduleTimeBudget(runId, deps, budgetTimeMs),
      log,
    };
    return deps;
  }

 // ── Helper: 检查脚本是否正在运行（delete guard 用） ────────

  function isScriptRunning(name: string): boolean {
    for (const state of sessionState.values()) {
      for (const run of state.runs.values()) {
        if (run.spec.scriptName === name && run.state.status === "running") return true;
      }
    }
    return false;
  }

 // ── Events ──────────────────────────────────────────────────

  pi.on("session_start", async (_event: Record<string, unknown>, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    lsRef.lastSessionId = sessionId;

 // 构建 per-session store + runs
    const sessionDir = resolveSessionDir();
    const store = new JsonlRunStore({
      sessionDir,
      pi,
      ctx,
    });
    const runs = new Map<string, WorkflowRun>();

 // BL-1: per-session AgentRegistry（扫描 7 个 agent 发现路径一次，非 per-call）。
 // 供 dispatchAgentCall → resolveAgentOpts 解析 agent({agent}) 的 systemPrompt。
    const agentRegistry = new AgentRegistry(process.cwd());
    agentRegistry.discoverAll();

 // D-5: store.loadAll 重水合（旧格式返回空，自动跳过）
    try {
      const loaded = await store.loadAll();
 // D-4: kill-9 残留 running → failed（进程被杀，worker 不可能还活着）
      for (const run of loaded) {
        if (run.state.status === "running") {
          run.state.error = "Process killed (kill-9 or crash recovery)";
          run.transition("done", "failed");
          // 崩溃恢复的 run 无匹配 pending:unregister，补发以避免 goal 持续误报 active
          pi.events.emit("pending:unregister", {
            id: run.runId,
            reason: "failed",
          });
        }
        runs.set(run.runId, run);
      }
    } catch (err) {
 // loadAll 失败不阻断 session_start——旧 session 状态丢失可接受
      void err;
    }

    sessionState.set(sessionId, {
      store,
      runs,
      activeTempFiles: new Set(),
      agentRegistry,
      sessionDir,
    });
  });

  pi.on("session_tree", async (_event: Record<string, unknown>, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    lsRef.lastSessionId = sessionId;

 // 切分支前 pause 所有 running run（隐式契约：分支切换时旧 worker 不再有效）
    const state = sessionState.get(sessionId);
    if (state) {
      for (const run of state.runs.values()) {
        if (run.state.status === "running") {
          try {
            await pauseRun(run.runId, makeDeps(state));
          } catch (err) {
 // pause 失败不阻断分支切换——run 保持 running，下次 session_start 会 D-4 修复
            void err;
          }
        }
      }
    }
  });

  pi.on("session_shutdown", async (_event: Record<string, unknown>, _ctx: ExtensionContext) => {
    const sessionId = lsRef.lastSessionId;
    const state = sessionState.get(sessionId);
    if (state) {
 // pause 所有 running run + 清理 temp files
      const running = Array.from(state.runs.values()).filter((r) => r.state.status === "running");
      await Promise.allSettled(
        running.map((run) => pauseRun(run.runId, makeDeps(state))),
      );
      cleanupAllFiles(state.activeTempFiles);
    }
    sessionState.delete(sessionId);
  });

 // ── pi.__workflowRun（D-8 新签名） ─────────────────────────

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
      makeDeps(state),
      workflowSignal,
      workflowTimeoutMs,
    );
  };

 // ── Tools（2 个，FR-5 收口） ───────────────────────────────

 // 注册时用当前 session 的 deps——tool execute 内部按 lsRef.lastSessionId 查找 runs
 // 简化：tool 持有对 sessionState 的引用（通过闭包），execute 时从 lastSessionId 取 runs
  const getDeps = () => {
    const state = sessionState.get(lsRef.lastSessionId);
    if (!state) throw new Error("Session not initialized");
    return makeDeps(state);
  };

 // workflow tool 需要 LauncherDeps；但 deps 里的 store/runs/onRunDone 是 per-session 的。
 // 用 getter 对象字面量包装——tool execute 时每次属性访问都取最新 session 的 deps。
 // C-4 修复：onRunDone 必须随 store/runs 一起转发，否则交互式 run/abort 路径
 // 会丢失 notifyDone 通知。
 // BL-1: agentRegistry/sessionDir/activeTempFiles 同样需转发，供 dispatchAgentCall
 // 调 resolveAgentOpts 解析 agent/skill/schema inline override。
  const lazyDeps: LauncherDeps = {
    get store() {
      return getDeps().store;
    },
    workerHost,
    runner,
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
    get log() {
      return getDeps().log;
    },
  };

  registerWorkflowTool(pi, lazyDeps, guard);
  registerWorkflowScriptTool(pi, registry, isScriptRunning);

 // ── Commands（仅 /workflows，FR-6） ────────────────────────

  registerWorkflowsCommand(
    pi,
    () => {
      const state = sessionState.get(lsRef.lastSessionId);
      return state?.runs ?? new Map();
    },
    lazyDeps,
  );
}
