/**
 * Workflow Extension — JSONL Run Store
 *
 * RunStore port 的 Infra 实现。
 *
 * 职责：持久化 WorkflowRun 聚合根到 JSONL 文件 + 跨 session 重水合。
 *
 * 层归属：Infra（D-12）。implements Engine 层的 RunStore port。
 * 依赖 @mariozechner/pi-coding-agent 的 ExtensionAPI/ExtensionContext（Infra 允许 Pi SDK）。
 *
 * 设计：
 * - JsonlRunStore implements RunStore（而非散落的 persist/reconstruct 自由函数）。
 * - **D-5: 不向后兼容**——reconstruct 时检查 snapshotVersion，无版本号或版本不匹配
 * 的 session 返回空数组（spec 决策：旧 run 历史价值低，不尝试兼容迁移）。
 * - rewrite mode（writeFile 覆盖，文件始终是最新单行快照）。
 * - workflow-state-link 指针条目机制保留（pi.appendEntry）。
 *
 * 序列化策略：
 * - WorkflowRun 是带方法的 class 聚合根——序列化只取公共字段快照。
 * - Budget/Trace/AgentCall 都有公共构造器或 fromArray 工厂，反序列化时重建实例。
 * - Snapshot 形态用 SnapshotVersion 守护（D-5：格式识别）。
 *
 * 参考：domain-models.md §Ports（RunStore 定义）、clarification.md D-5。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { AgentCall } from "./models/agent-call.ts";
import { Budget } from "./models/budget.ts";
import type { RunSpec } from "./models/run-spec.ts";
import type { RunState } from "./models/run-state.ts";
import { Trace } from "./models/trace.ts";
import type { DoneReason, RunStatus, WorkerLogEntry } from "./models/types.ts";
import type { AgentCallOpts, AgentResult, ExecutionTraceNode } from "./models/types.ts";
import type { WorkflowRunMeta } from "./models/workflow-run.ts";
import { WorkflowRun } from "./models/workflow-run.ts";

// ── Snapshot format (D-5 version guard) ──────────────────────

/**
 * 快照格式版本。D-5：旧 session（无此字段或值不匹配）被 loadAll 忽略。
 *
 * 升级格式时 bump 此常量并在 deserializeRun 中适配——旧文件返回 null（被 loadAll 跳过）。
 */
export const SNAPSHOT_VERSION = "wf-run-v1" as const;

/**
 * 持久化快照形态——WorkflowRun 公共字段的 JSON 可序列化投影。
 *
 * calls 序列化为数组（Map 不能直接 JSON.stringify）；反序列化时重建 Map。
 * budget/trace 在 deserialize 时重建实例（带方法的 class）。
 */
interface RunSnapshot {
  v: typeof SNAPSHOT_VERSION;
  runId: string;
  spec: RunSpec;
  state: {
    status: RunStatus;
    reason?: DoneReason;
    budget: {
      maxTokens?: number;
      maxCost?: number;
      maxTimeMs?: number;
      usedTokens: number;
      usedCost: number;
      totalCallCount: number;
    };
    calls: Array<{
      id: number;
      opts: AgentCallOpts;
      status: "pending" | "running" | "done";
      attempts: number;
      result?: AgentResult;
      sessionId?: string;
      traceNode: ExecutionTraceNode;
    }>;
    trace: ExecutionTraceNode[];
    errorLogs: WorkerLogEntry[];
    error?: string;
    scriptResult?: unknown;
  };
  meta: {
    startedAt: string;
    completedAt?: string;
    pausedAt?: string;
    workerErrorCount?: number;
    scriptErrorCount?: number;
  };
}

// ── Serialization ────────────────────────────────────────────

function serializeRun(run: WorkflowRun): RunSnapshot {
  return {
    v: SNAPSHOT_VERSION,
    runId: run.runId,
    spec: run.spec,
    state: {
      status: run.state.status,
      reason: run.state.reason,
      budget: {
        maxTokens: run.state.budget.maxTokens,
        maxCost: run.state.budget.maxCost,
        maxTimeMs: run.state.budget.maxTimeMs,
        usedTokens: run.state.budget.usedTokens,
        usedCost: run.state.budget.usedCost,
        totalCallCount: run.state.budget.totalCallCount,
      },
      calls: Array.from(run.state.calls.values()).map((c) => {
        // strip live（同 trace 序列化，不持久化运行期对象）
        const { live: _live, ...traceNodeRest } = c.traceNode;
        return {
          id: c.id,
          opts: c.opts,
          status: c.status,
          attempts: c.attempts,
          result: c.result,
          sessionId: c.sessionId,
          traceNode: traceNodeRest,
        };
      }),
      // trace 节点浅拷贝时 strip live 字段——ExecutionRecord 含可变 turns[]/controller，
      // 不适合序列化；pause/resume 后 live 为 undefined（重跑时由 dispatchAgentCall 重建）。
      trace: run.state.trace.toArray().map(({ live: _live, ...rest }) => rest),
      errorLogs: run.state.errorLogs,
      error: run.state.error,
      scriptResult: run.state.scriptResult,
    },
    meta: run.meta,
  };
}

/**
 * 反序列化快照为 WorkflowRun。D-5：版本不匹配返回 null（旧 session）。
 */
function deserializeRun(snapshot: RunSnapshot): WorkflowRun | null {
 // D-5 version guard
  if (snapshot.v !== SNAPSHOT_VERSION) return null;

  const budget = new Budget({
    maxTokens: snapshot.state.budget.maxTokens,
    maxCost: snapshot.state.budget.maxCost,
    maxTimeMs: snapshot.state.budget.maxTimeMs,
    usedTokens: snapshot.state.budget.usedTokens,
    usedCost: snapshot.state.budget.usedCost,
  });
  budget.totalCallCount = snapshot.state.budget.totalCallCount;

  const calls = new Map<number, AgentCall>();
  for (const c of snapshot.state.calls) {
    const call = new AgentCall(c.id, c.opts, c.traceNode);
    call.status = c.status;
    call.attempts = c.attempts;
 // Restore result directly — bypasses markRunning/markDone state-machine guards
 // because we're reconstructing a known-good persisted state, not transitioning.
    if (c.result !== undefined) {
      call.result = c.result;
    }
    if (c.sessionId !== undefined) {
      call.setSessionId(c.sessionId);
    }
    calls.set(c.id, call);
  }

  const trace = Trace.fromArray(snapshot.state.trace);

  const state: RunState = {
    status: snapshot.state.status,
    reason: snapshot.state.reason,
    budget,
    calls,
    trace,
    errorLogs: snapshot.state.errorLogs,
    error: snapshot.state.error,
    scriptResult: snapshot.state.scriptResult,
  };

  const meta: WorkflowRunMeta = {
    startedAt: snapshot.meta.startedAt,
    completedAt: snapshot.meta.completedAt,
    pausedAt: snapshot.meta.pausedAt,
    workerErrorCount: snapshot.meta.workerErrorCount,
    scriptErrorCount: snapshot.meta.scriptErrorCount,
  };

 // WorkflowRun.reconstruct 跳过 I1 校验——持久化的 running 状态没有 worker
 // （进程被杀后 worker 不可能还活着），违反 I1。D-4 kill-9 恢复在 session_start
 // 时把残留 running 转 done,failed，恢复 I1（见 index.ts session_start handler）。
  return WorkflowRun.reconstruct(snapshot.runId, snapshot.spec, state, meta);
}

// ── JsonlRunStore ────────────────────────────────────────────

export interface JsonlRunStoreOptions {
 /** Session directory root (state files live under <sessionDir>/workflow-state/). */
  sessionDir: string;
 /** Pi ExtensionAPI for appendEntry pointer writes (optional for testing). */
  pi?: ExtensionAPI;
 /** Pi ExtensionContext for sessionManager.getEntries (optional for testing). */
  ctx?: ExtensionContext;
}

export class JsonlRunStore {
  private readonly sessionDir: string;
  private readonly pi?: ExtensionAPI;
  private readonly ctx?: ExtensionContext;

  constructor(opts: JsonlRunStoreOptions) {
    this.sessionDir = opts.sessionDir;
    this.pi = opts.pi;
    this.ctx = opts.ctx;
  }

 /** State directory: <sessionDir>/workflow-state/ */
  private get stateDir(): string {
    return path.join(this.sessionDir, "workflow-state");
  }

 /** State file path for a given runId. */
  private filePathFor(runId: string): string {
    return path.join(this.stateDir, `${runId}.jsonl`);
  }

 /**
 * Persist a single run: rewrite mode (overwrite) — file always contains the
 * latest complete snapshot on a single line. Appends a workflow-state-link
 * pointer entry via pi.appendEntry so loadAll can locate files.
 */
  async save(run: WorkflowRun): Promise<void> {
    const filePath = this.filePathFor(run.runId);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const snapshot = serializeRun(run);
    await fs.promises.writeFile(filePath, JSON.stringify(snapshot) + "\n", "utf8");
    if (this.pi) {
      this.pi.appendEntry("workflow-state-link", {
        runId: run.runId,
        path: filePath,
        updatedAt: new Date().toISOString(),
      });
    }
  }

 /**
 * Reconstruct all runs from session JSONL pointer entries.
 *
 * D-5:旧格式（无版本号 / 版本不匹配）返回空——loadAll 跳过这些条目，
 * 不尝试向后兼容旧 session（spec 决策）。
 *
 * 需要 ctx（构造时注入）——无 ctx 时返回空（测试或非 Pi 环境下）。
 */
  async loadAll(): Promise<WorkflowRun[]> {
    if (!this.ctx) return [];
    const runs: WorkflowRun[] = [];
    try {
      const entries = this.ctx.sessionManager.getEntries();
      const pointers = new Map<string, { path: string }>();

      for (const entry of entries) {
        if (entry.type !== "custom") continue;
        if (entry.customType !== "workflow-state-link") continue;
        const data = entry.data as { runId?: string; path?: string } | undefined;
        if (data?.runId && data?.path) {
          pointers.set(data.runId, { path: data.path });
        }
      }

      for (const [, pointer] of pointers) {
        try {
          const content = await fs.promises.readFile(pointer.path, "utf8");
          const lines = content.split("\n").filter((l) => l.trim());
          const lastLine = lines[lines.length - 1];
          if (!lastLine) continue;
          const parsed = JSON.parse(lastLine) as RunSnapshot;
          const run = deserializeRun(parsed);
 // D-5: null = old format / version mismatch — skip silently
          if (run) runs.push(run);
        } catch (err) {
 // Corrupt/unreadable state file — skip (don't crash loadAll).
 // Single bad file must not abort reconstruction of the rest.
          void err;
        }
      }
    } catch (err) {
 // getEntries failed — return what we have (empty).
      void err;
    }
    return runs;
  }
}
