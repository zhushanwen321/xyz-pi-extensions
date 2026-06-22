/**
 * Workflow Extension — Factory（W4-T28，★切换点）
 *
 * 重写 factory：删除 WorkflowOrchestrator，用 Infra 实例 + runs Map + Engine free functions。
 *
 * 这是新旧切换点——完成后旧代码（orchestrator.ts / engine/core.ts / *.legacy.ts /
 * domain/ 等）成死代码，W5 T29 删除。
 *
 * 关键变化：
 *   - Infra 注入：JsonlRunStore / WorkerHostImpl / SubprocessAgentRunner /
 *     WorkflowScriptRegistryImpl（4 个具体类，D-12 不造 interface）
 *   - deps: LauncherDeps = { store, workerHost, runner, runs, registry }
 *   - session_start：重建 approvals + store.loadAll 重建 runs + D-4 kill-9 残留 running→failed
 *   - pi.__workflowRun（D-8 新签名）：调 runAndWait → {status:'done', reason, ...}
 *   - 注册 2 个 tool（T24 workflow-script + T25 workflow）+ /workflows command（T27）
 *   - session_tree：切分支前 pause 所有 running run
 *   - session_shutdown：pause 所有 running + 清理 temp files
 *
 * Proxy 延迟解析：tool 注册一次，但 runs 是 per-session 的。Proxy 包装让 tool execute
 * 时按 lsRef.lastSessionId 取最新 session 的 store/runs。需 `as never` 断言 Proxy 类型。
 *
 * 参考：
 *   - domain-models.md §D-8（WorkflowRunResult 签名）
 *   - 旧 index.ts（事件注册 + tool/command 装配结构）
 */

/* eslint-disable taste/no-unsafe-cast */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { runAndWait, type WorkflowRunResult } from "./engine/launcher.js";
import { pauseRun } from "./engine/lifecycle.js";
import type { WorkflowRun } from "./engine/models/workflow-run.js";
import { cleanupAllTempFiles as cleanupAllFiles } from "./infra/agent-opts-resolver.js";
import { JsonlRunStore } from "./infra/jsonl-run-store.js";
import { SubprocessAgentRunner } from "./infra/subprocess-agent-runner.js";
import { WorkerHostImpl } from "./infra/worker-host.js";
import { WorkflowScriptRegistryImpl } from "./infra/workflow-script-registry-impl.js";
import { registerWorkflowsCommand } from "./interface/commands.js";
import { APPROVAL_MEMORY_TYPE, notifyDone } from "./interface/helpers.js";
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
  const sessionApprovals = new Set<string>();
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
    }
  >();

  // ── Helper: 解析 sessionDir（与旧 orchestrator 同款逻辑） ───

  function resolveSessionDir(): string {
    const defaultDir = path.join(os.homedir(), ".pi", "agent");
    const sessionSlug = `--${process.cwd().replace(/^\//, "").replace(/\//g, "-")}--`;
    const sessionScopedDir = path.join(os.homedir(), ".pi", "agent", "sessions", sessionSlug);
    return fs.existsSync(sessionScopedDir) ? sessionScopedDir : defaultDir;
  }

  // ── Helper: 构建 LauncherDeps ─────────────────────────────

  function makeDeps(store: JsonlRunStore, runs: Map<string, WorkflowRun>) {
    // C-4: onRunDone callback——run 到达 done 终态时触发 notifyDone，唤醒 parent agent
    // 消费结果（UC-1 主路径）。所有 transition("done", ...) 路径调完 save 后触发。
    return {
      store,
      workerHost,
      runner,
      runs,
      registry,
      onRunDone: (run: WorkflowRun) => notifyDone(pi, run.runId, run, notifiedRunIds),
    };
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

    // 重建 sessionApprovals（从持久化 entries）
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.customType === APPROVAL_MEMORY_TYPE) {
        const data = entry.data as { workflowName: string } | undefined;
        if (data?.workflowName) sessionApprovals.add(data.workflowName);
      }
    }

    // 构建 per-session store + runs
    const store = new JsonlRunStore({
      sessionDir: resolveSessionDir(),
      pi,
      ctx,
    });
    const runs = new Map<string, WorkflowRun>();

    // D-5: store.loadAll 重水合（旧格式返回空，自动跳过）
    try {
      const loaded = await store.loadAll();
      // D-4: kill-9 残留 running → failed（进程被杀，worker 不可能还活着）
      for (const run of loaded) {
        if (run.state.status === "running") {
          run.state.error = "Process killed (kill-9 or crash recovery)";
          run.transition("done", "failed");
        }
        runs.set(run.runId, run);
      }
    } catch (err) {
      // loadAll 失败不阻断 session_start——旧 session 状态丢失可接受
      void err;
    }

    sessionState.set(sessionId, { store, runs, activeTempFiles: new Set() });
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
            await pauseRun(run.runId, makeDeps(state.store, state.runs));
          } catch (err) {
            // pause 失败不阻断分支切换——run 保持 running，下次 session_start 会 D-4 修复
            void err;
          }
        }
      }
    }
  });

  pi.on("session_shutdown", async () => {
    const sessionId = lsRef.lastSessionId;
    const state = sessionState.get(sessionId);
    if (state) {
      // pause 所有 running run + 清理 temp files
      const running = Array.from(state.runs.values()).filter((r) => r.state.status === "running");
      await Promise.allSettled(
        running.map((run) => pauseRun(run.runId, makeDeps(state.store, state.runs))),
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
      makeDeps(state.store, state.runs),
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
    return makeDeps(state.store, state.runs);
  };

  // T25 workflow tool 需要 LauncherDeps；但 deps 里的 runs 是 per-session 的。
  // 注册时传一个 lazy getter 包装——tool 调用时取最新 session 的 runs。
  // 简化方案：注册时传当前 session 的 deps（session_start 后），tool 用 lsRef 查找。
  // 由于 registerWorkflowTool 需要 LauncherDeps（含 runs: Map），而 runs 是 per-session 的，
  // 我们传一个 Proxy 或在 tool 内部动态查找。
  // 实际上 T25 tool 已经接收 deps 参数并在 execute 内用——我们传一个稳定的 deps 对象，
  // 其 runs 是一个动态 Map（每次访问取当前 session 的）。
  const lazyDeps = {
    store: new Proxy({} as JsonlRunStore, {
      get(_t, prop) {
        return Reflect.get(getDeps().store as object, prop);
      },
    }),
    workerHost,
    runner,
    runs: new Proxy({} as Map<string, WorkflowRun>, {
      get(_t, prop) {
        return Reflect.get(getDeps().runs as object, prop);
      },
    }),
    registry,
  };

  registerWorkflowTool(pi, lazyDeps as never, sessionApprovals, guard);
  registerWorkflowScriptTool(pi, registry, isScriptRunning);

  // ── Commands（仅 /workflows，FR-6） ────────────────────────

  registerWorkflowsCommand(pi, () => {
    const state = sessionState.get(lsRef.lastSessionId);
    return state?.runs ?? new Map();
  });
}
