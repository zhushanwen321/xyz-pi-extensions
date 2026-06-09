/**
 * Workflow Extension — Factory Skeleton
 *
 * Events registered:
 *   session_start  — reconstruct state from Session JSONL
 *   session_tree   — rehydrate on branch switch
 *   session_shutdown — clean up session-scoped state
 *
 * Tool: "workflow"
 *   Actions: pause, resume, abort, status
 *   Enforces state machine rules (terminal states are irreversible)
 */

import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static,Type } from "typebox";

import {
  registerWorkflowCommands,
  sendCompletionNotification,
  type WorkflowCommandsState,
} from "./commands.js";
import { type WorkflowInstanceSummary,WorkflowOrchestrator } from "./orchestrator.js";
import {
  createInstance,
  deserializeInstance,
  isTerminal,
  transitionStatus,
  type WorkflowInstance,
  type WorkflowStatus,
} from "./state.js";
import { registerGenerateTool } from "./tool-generate.js";
import { registerWorkflowShortcuts, renderWorkflowList } from "./widget.js";

// ── Parameter schema ──────────────────────────────────────────

const WorkflowAction = StringEnum(
  ["pause", "resume", "abort", "status"] as const,
  { description: "Workflow action to execute" },
);

const WorkflowParams = Type.Object({
  action: WorkflowAction,
  runId: Type.Optional(Type.String({ description: "Workflow run ID (required for pause/resume/abort)" })),
  error: Type.Optional(Type.String({ description: "Error/reason message (optional, used with abort)" })),
});

// ── Details type for TUI / _render ────────────────────────────

interface InstanceSummary {
  runId: string;
  name: string;
  status: WorkflowStatus;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

interface WorkflowDetails {
  action: string;
  instances: InstanceSummary[];
  agents?: Array<{ name: string; source: string; model?: string }>;
  _render?: {
    type: "summary-table";
    data: {
      title: string;
      columns: Array<{ key: string; label: string; width?: number; valueType?: "text" | "status" | "duration" | "number" }>;
      rows: Record<string, unknown>[];
    };
    summary?: string;
  };
}

// ── Constants ─────────────────────────────────────────────────

const MS_PER_SEC = 1000;
const RUNID_SLICE_LENGTH = 20;
const RUNID_SHORT_LENGTH = 16;
const INPUT_WORD_MIN_LENGTH = 2;

// ── Helper: _render descriptor builder ────────────────────────

function buildRender(
  summaries: WorkflowInstanceSummary[],
): WorkflowDetails["_render"] {
  const items = summaries;
  const active = items.filter(
    (i) => i.status === "running" || i.status === "paused",
  ).length;
  const finished = items.filter((i) => isTerminal(i.status)).length;
  return {
    type: "summary-table",
    summary: `${items.length} workflows: ${active} active, ${finished} finished`,
    data: {
      title: "Workflows",
      columns: [
        { key: "name", label: "Name", valueType: "text" },
        { key: "status", label: "Status", valueType: "status" },
        { key: "worker", label: "Worker", valueType: "text" },
        { key: "duration", label: "Duration", valueType: "duration" },
      ],
      rows: items.map((inst) => {
        const duration =
          inst.startedAt && inst.completedAt
            ? `${((new Date(inst.completedAt).getTime() - new Date(inst.startedAt).getTime()) / MS_PER_SEC).toFixed(0)}s`
            : inst.startedAt
              ? `${((Date.now() - new Date(inst.startedAt).getTime()) / MS_PER_SEC).toFixed(0)}s (running)`
              : "-";
        return { name: inst.name, status: inst.status, worker: inst.worker, duration };
      }),
    },
  };
}

function toInstanceSummary(summary: WorkflowInstanceSummary): InstanceSummary {
  return {
    runId: summary.runId,
    name: summary.name,
    status: summary.status,
    startedAt: summary.startedAt,
    completedAt: summary.completedAt,
    error: summary.error,
  };
}

export default function workflowExtension(pi: ExtensionAPI) { // eslint-disable-line max-lines-per-function
  const lsRef = { lastSessionId: "" };
  const orchestrators = new Map<string, WorkflowOrchestrator>();
  const cmdState: WorkflowCommandsState = { lastRunId: null };
  const sessionApprovals = new Set<string>();
  // P1-3: Per-factory dedup Set for completion notifications (was module-level in commands.ts)
  const notifiedRunIds = new Set<string>();
  // P1-6: Reentry guard — shared object so both workflow and workflow-run tools see the same flag
  const guard = { isProcessing: false };

  async function reconstructState(ctx: ExtensionContext): Promise<Map<string, WorkflowInstance>> {
    const instances = new Map<string, WorkflowInstance>();
    try {
      const entries = ctx.sessionManager.getEntries();
      const pointers = new Map<string, { path: string }>();
      for (const entry of entries) {
        if (entry.type !== "custom") continue;
        const custom = entry as unknown as { customType?: string; data?: unknown };
        if (custom.customType !== "workflow-state-link") continue;
        const data = custom.data as { runId?: string; path?: string } | undefined;
        if (data?.runId && data?.path) {
          pointers.set(data.runId, { path: data.path });
        }
      }
      // Load each pointer's JSONL file
      for (const [runId, pointer] of pointers) {
        try {
          const content = await fs.promises.readFile(pointer.path, "utf8");
          const lines = content.split("\n").filter((l) => l.trim());
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line) as Parameters<typeof deserializeInstance>[0];
              const instance = deserializeInstance(parsed);
              instances.set(instance.runId, instance);
            // eslint-disable-next-line taste/no-silent-catch
            } catch {
              // Skip malformed lines
            }
          }
        } catch {
          ctx.ui.notify(`WARN: missing or corrupt state for ${runId}`, "warning");
          // Create a state_lost placeholder so the user can see the run existed
          // but its external state file is unreadable (FR-1.6)
          instances.set(runId, createInstance({
            runId,
            name: `(state lost) ${runId}`,
            worker: "(unknown)",
            status: "state_lost",
          }));
        }
      }
    // eslint-disable-next-line taste/no-silent-catch
    } catch {
      // If getEntries fails, return empty map
    }
    return instances;
  }

  // ── Events ──────────────────────────────────────────────────

  pi.on("session_start", async (_event: Record<string, unknown>, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    lsRef.lastSessionId = sessionId;

    // Rehydrate session approvals from persisted entries
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.customType === "workflow-approval-memory") {
        const data = entry.data as { workflowName: string } | undefined;
        if (data?.workflowName) sessionApprovals.add(data.workflowName);
      }
    }

    // Create orchestrator (sole instance holder)
    const orch = new WorkflowOrchestrator(pi, ctx);
    orchestrators.set(sessionId, orch);

    // Restore reconstructed state into orchestrator
    const instances = await reconstructState(ctx);
    orch.restoreInstances(instances);

    // Log discovered agents with source breakdown
    const agentCount = orch.getAgentCount();
    if (agentCount > 0) {
      const agents = orch.getAgents();
      const bySource = agents.reduce<Record<string, number>>((acc, a) => {
        acc[a.source] = (acc[a.source] || 0) + 1;
        return acc;
      }, {});
      const breakdown = Object.entries(bySource).map(([s, c]) => `${c} ${s}`).join(", ");
      pi.notify(`Workflow: discovered ${agentCount} agents (${breakdown})`);
    }

    // Live progress: refresh widget on every trace node change
    orch.onTraceUpdate = (_runId) => {
      if (ctx.hasUI) ctx.ui.setWidget("workflow", renderWorkflowList(orch.list(), ctx.ui.theme));
    };
    orch.onCompletion = (runId) => {
      const instance = orch.getInstance(runId);
      if (instance) sendCompletionNotification(pi, runId, instance, notifiedRunIds);
    };
    if (ctx.hasUI) ctx.ui.setWidget("workflow", renderWorkflowList(orch.list(), ctx.ui.theme));

    // Expose pi.__workflowRun for cross-extension programmatic access
    // (same pattern as goal extension's pi.__goalInit)
    const api = pi as unknown as Record<string, unknown>;
    api.__workflowRun = async (
      workflowName: string,
      workflowArgs: Record<string, unknown>,
      workflowSignal?: AbortSignal,
      workflowTimeoutMs?: number,
    ) => orch.runAndWait(workflowName, workflowArgs, workflowSignal, workflowTimeoutMs);
  });

  pi.on("session_tree", async (_event: Record<string, unknown>, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    lsRef.lastSessionId = sessionId;
    // Dispose the previous branch's orchestrator (cleanup in-flight agent temp files).
    // Without this, switching branches mid-run leaks temp files.
    const previousOrch = orchestrators.get(sessionId);
    if (previousOrch) {
      previousOrch.cleanupAllTempFiles();
    }
    const orch = new WorkflowOrchestrator(pi, ctx);
    orchestrators.set(sessionId, orch);
    const instances = await reconstructState(ctx);
    // P1-7: Drop pending state from old branches — running workers no longer exist
    for (const inst of instances.values()) {
      if (inst.status === "running") {
        inst.pausedAt = new Date().toISOString();
        try {
          transitionStatus(inst, "paused");
        // eslint-disable-next-line taste/no-silent-catch
        } catch {
          // State machine refused — leave as-is
        }
      }
    }
    orch.restoreInstances(instances);
    orch.onTraceUpdate = (_runId) => {
      if (ctx.hasUI) ctx.ui.setWidget("workflow", renderWorkflowList(orch.list(), ctx.ui.theme));
    };
    orch.onCompletion = (runId) => {
      const instance = orch.getInstance(runId);
      if (instance) sendCompletionNotification(pi, runId, instance, notifiedRunIds);
    };
    if (ctx.hasUI) ctx.ui.setWidget("workflow", renderWorkflowList(orch.list(), ctx.ui.theme));
  });

  pi.on("session_shutdown", async () => {
    // Note: Pi's session_shutdown event does not pass ctx, so we use lastSessionId via shared ref
    const sessionId = lsRef.lastSessionId;
    // Pause running orchestrators before cleanup
    const orch = orchestrators.get(sessionId);
    if (orch) {
      const running = orch.list().filter((s) => s.status === "running");
      await Promise.allSettled(running.map((inst) => orch.pause(inst.runId)));
    }
    orchestrators.delete(sessionId);
  });

  // ── Tool: workflow ──────────────────────────────────────────

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description:
      "Control running workflow instances: pause, resume, abort, or check status.\n" +
      "\n" +
      "For STARTING a new workflow, use \`workflow-run\` instead.\n" +
      "This tool ONLY controls already-running workflows.\n" +
      "\n" +
      "Actions:\n" +
      "  status   — List all workflow instances in current session\n" +
      "  pause    — Pause a running workflow (preserves progress, terminates Worker)\n" +
      "  resume   — Resume a paused workflow (replays callCache, skips completed agents)\n" +
      "  abort    — Abort a running workflow (irreversible)\n",
    promptSnippet:
      "Check workflow status, or pause/resume/abort a running workflow",
    promptGuidelines: [
      "Use workflow tool for lifecycle control: pause, resume, abort.",
      "To START a new workflow, use workflow-run tool instead",
      "Only check status (action: status) when the user explicitly asks. Never poll in a loop.",
      "Workflows can be paused and resumed across sessions",
    ],
    parameters: WorkflowParams,

    async execute(_toolCallId: string, params: Static<typeof WorkflowParams>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      // P1-2: Honor abort signal up-front
      if (signal?.aborted) {
        return {
          content: [{ type: "text" as const, text: "Operation aborted before start" }],
          isError: true,
        };
      }
      // P1-6: Reentry guard — prevent concurrent tool calls from clobbering orchestrator state
      if (guard.isProcessing) {
        return {
          content: [{ type: "text" as const, text: "Another workflow operation is in progress; please wait for it to complete before issuing another command." }],
          isError: true,
        };
      }
      guard.isProcessing = true;
      try {
      const sessionId = ctx.sessionManager.getSessionId();
      lsRef.lastSessionId = sessionId;
      const orch = orchestrators.get(sessionId);
      if (!orch) {
        return {
          content: [{ type: "text", text: "Workflow orchestrator not initialized" }],
          isError: true,
        };
      }
      const action = params.action as string;

      switch (action) {
        // ── Control (pause / resume / abort) ──
        case "pause":
        case "resume":
        case "abort": {
          const runId = params.runId as string | undefined;
          if (!runId) {
            return {
              content: [{ type: "text" as const, text: "Error: 'runId' is required for this action" }],
              details: { action, instances: orch.list().map(toInstanceSummary) } satisfies WorkflowDetails,
              isError: true,
            };
          }

          const instance = orch.getInstance(runId);
          if (!instance) {
            return {
              content: [{ type: "text" as const, text: `Error: workflow '${runId}' not found` }],
              details: { action, instances: orch.list().map(toInstanceSummary) } satisfies WorkflowDetails,
              isError: true,
            };
          }

          const actionToTarget: Record<string, WorkflowStatus> = {
            pause: "paused",
            resume: "running",
            abort: "aborted",
          };
          const targetStatus = actionToTarget[action];

          // Delegate to orchestrator (handles Worker lifecycle)
          if (action === "abort" && (params.error as string | undefined)) {
            instance.error = params.error as string;
          }
          const oldStatus = instance.status;
          try {
            if (action === "pause") await orch.pause(runId);
            else if (action === "resume") await orch.resume(runId);
            else await orch.abort(runId);

            const summaries = orch.list();
            return {
              content: [{
                type: "text" as const,
                text: `Workflow '${instance.name}' (${runId}): ${oldStatus} → ${instance.status}`,
              }],
              details: {
                action,
                instances: summaries.map(toInstanceSummary),
                _render: buildRender(summaries),
              } satisfies WorkflowDetails,
            };
          // eslint-disable-next-line taste/no-silent-catch
          } catch {
            // Orchestrator method failed — fall through to idempotent check or direct state machine
          }

          // Idempotent: if the workflow is already in the target state (or a terminal state for abort),
          // return success instead of attempting an invalid state transition.
          // Re-persist to recover from partial orchestrator success (status mutated but persistState threw).
          if (
            instance.status === targetStatus ||
            (action === "abort" && isTerminal(instance.status))
          ) {
            try { await orch.persistState(); } catch { /* best effort */ }
            const summaries = orch.list();
            return {
              content: [{
                type: "text" as const,
                text: `Workflow '${instance.name}' (${runId}): already ${instance.status}`,
              }],
              details: {
                action,
                instances: summaries.map(toInstanceSummary),
                _render: buildRender(summaries),
              } satisfies WorkflowDetails,
            };
          }

          // Last resort: direct state machine transition (e.g. orchestrator in inconsistent state)
          try {
            const oldStatus = instance.status;
            transitionStatus(instance, targetStatus);

            if (targetStatus === "running" && oldStatus === "paused") {
              instance.pausedAt = undefined;
            } else if (targetStatus === "paused") {
              instance.pausedAt = new Date().toISOString();
            } else if (isTerminal(targetStatus)) {
              instance.completedAt = new Date().toISOString();
              if (action === "abort") {
                instance.error = (params.error as string | undefined) ?? instance.error;
              }
            }

            await orch.persistState();

            const summaries = orch.list();
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Workflow '${instance.name}' (${runId}): ${oldStatus} → ${targetStatus}`,
                },
              ],
              details: {
                action,
                instances: summaries.map(toInstanceSummary),
                _render: buildRender(summaries),
              } satisfies WorkflowDetails,
            };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return {
              content: [{ type: "text" as const, text: `Error: ${msg}` }],
              details: { action, instances: orch.list().map(toInstanceSummary) } satisfies WorkflowDetails,
              isError: true,
            };
          }
        }

        // ── Status ──
        case "status": {
          const summaries = orch.list();
          if (summaries.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No workflows in current session." }],
              details: { action: "status", instances: [], agents: orch.getAgents(), _render: buildRender(summaries) } satisfies WorkflowDetails,
            };
          }

          const text = summaries
            .map((s) => {
              const duration =
                s.startedAt
                  ? ` (${((Date.now() - new Date(s.startedAt).getTime()) / MS_PER_SEC).toFixed(0)}s)`
                  : "";
              return `[${s.status}] ${s.name} (${s.runId.slice(0, RUNID_SLICE_LENGTH)})${duration}` +
                (s.error ? ` error: ${s.error}` : "");
            })
            .join("\n");

          return {
            content: [{ type: "text" as const, text }],
            details: {
              action: "status",
              instances: summaries.map(toInstanceSummary),
              agents: orch.getAgents(),
              _render: buildRender(summaries),
            } satisfies WorkflowDetails,
          };
        }

        default: {
          return {
            content: [{ type: "text" as const, text: `Unknown action: ${action}` }],
            details: { action, instances: orch.list().map(toInstanceSummary) } satisfies WorkflowDetails,
            isError: true,
          };
        }
      }
      } finally {
        // P1-6: Always release the reentry guard
        guard.isProcessing = false;
      }
    },

    renderCall(args: Record<string, unknown>, theme: Theme, _context?: unknown) {
      const action = args.action as string;
      let text =
        theme.fg("toolTitle", theme.bold("workflow ")) +
        theme.fg("muted", action);
      if (args.name) text += ` ${theme.fg("accent", args.name as string)}`;
      if (args.runId) text += ` ${theme.fg("dim", (args.runId as string).slice(0, RUNID_SLICE_LENGTH))}`;
      if (args.error) text += ` ${theme.fg("error", "error")}`;
      return new Text(text, 0, 0);
    },

    renderResult(result: Record<string, unknown>, _options: unknown, theme: Theme, _context?: unknown) {
      const details = result.details as WorkflowDetails | undefined;
      if (!details) {
        const content = result.content as Array<{ type: string; text: string }> | undefined;
        const text = content?.[0];
        return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
      }

      if (details.action === "status" && details.instances.length > 0) {
        const lines = details.instances
          .map((inst) => {
            const color: "success" | "warning" | "error" | "muted" =
              inst.status === "completed" ? "success"
              : inst.status === "running" ? "warning"
              : inst.status === "failed" || inst.status === "aborted" ? "error"
              : "muted";
            return `${theme.fg(color, `[${inst.status}]`)} ${theme.fg("accent", inst.name)} ${theme.fg("dim", inst.runId.slice(0, RUNID_SHORT_LENGTH))}${inst.error ? ` ${theme.fg("error", inst.error)}` : ""}`;
          })
          .join("\n");
        return new Text(lines, 0, 0);
      }

      const content = result.content as Array<{ type: string; text: string }> | undefined;
      const text = content?.[0];
      return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
    },
  });

  // ── Tool: workflow-run ──────────────────────────────────────

  registerWorkflowRunTool(pi, orchestrators, cmdState, sessionApprovals, lsRef, guard);

  // ── Commands & Shortcuts ───────────────────────────────────

  registerWorkflowCommands(pi, orchestrators, cmdState);
  registerGenerateTool(pi);
  registerWorkflowLintTool(pi);
  registerWorkflowShortcuts(pi, orchestrators, cmdState);

  // ── Auto-inject script format spec on workflow-generate calls ──────
  // When AI calls workflow-generate, inject the full format reference as
  // a steering message so it's available in the next LLM call for corrections.
  const skillPath = resolve(import.meta.dirname!, "skills/workflow-script-format/SKILL.md");
  let cachedFormatSpec: string | undefined;

  pi.on("tool_call", async (event: Record<string, unknown>) => {
    if (event.toolName !== "workflow-generate") return;

    if (!cachedFormatSpec) {
      try {
        const raw = readFileSync(skillPath, "utf-8");
        // Strip YAML frontmatter (---...---)
        const body = raw.replace(/^---[\s\S]*?---\n*/, "");
        cachedFormatSpec = body.trim();
      } catch {
        return; // SKILL.md not found — skip injection
      }
    }

    pi.sendUserMessage(
      `[Workflow Script Format Reference — MANDATORY]\n${cachedFormatSpec}`,
      { deliverAs: "steer" },
    );
  });

}

// ── Extracted: workflow-run tool registration ────────────────

const _WorkflowRunParams = Type.Object({
  name: Type.String({ description: "Exact workflow name or natural language task description" }),
  mode: Type.Optional(StringEnum(["auto", "force"] as const, {
    description: "'auto' (default): search existing workflows, confirm with user. 'force': skip confirmation, AI decides",
  })),
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
    description: "Arguments passed to workflow as key-value pairs",
  })),
  tokens: Type.Optional(Type.Number({ description: "Maximum token budget" })),
  time: Type.Optional(Type.Number({ description: "Maximum time budget in milliseconds" })),
});

interface _WorkflowRunDetails {
  action: "run"; runId: string; status: string; name: string;
  confirmSkipped?: boolean;
  _render?: { type: "task-list"; data: { title: string; items: Array<{ label: string; status: "pending" | "in_progress" | "completed" | "failed" | "cancelled"; detail?: string }> } };
}

interface _LastSessionRef { lastSessionId: string }
interface _ReentryGuardRef { isProcessing: boolean }

function registerWorkflowRunTool(
  pi: ExtensionAPI,
  orchestrators: Map<string, WorkflowOrchestrator>,
  cmdState: WorkflowCommandsState,
  sessionApprovals: Set<string>,
  lsRef: _LastSessionRef,
  reentryRef: _ReentryGuardRef,
): void {
  pi.registerTool({
    name: "workflow-run",
    label: "Workflow Run",
    description:
      "Execute a project workflow. When user says \"workflow\", \"执行X的workflow\", or \"run X\", " +
      "use this tool BEFORE reading skill files. Pass natural language as 'name' (e.g. user says " +
      "\"PR的workflow\" → name='PR的workflow'). Auto mode discovers matches by name + description, " +
      "then confirms with user. mode='force' skips confirmation (only when user explicitly demands it). " +
      "NOT for single-step bash tasks.",
    promptSnippet: "Execute a workflow by name or description",
    promptGuidelines: [
      "PRIORITY: When user says 'workflow', '执行workflow', 'run workflow', try workflow-run FIRST. Do NOT read workflow-related skill files or documentation — the tool handles discovery.",
      "Pass user's natural language directly as 'name'. Auto mode searches by exact name AND description keywords. No need to manually find the workflow script first.",
      "Default to auto mode. Only use force when user explicitly demands to skip confirmation.",
      "If no workflow matches, the tool returns suggestions — follow its guidance. Use workflow-generate only when creating a brand new workflow from scratch.",
      "NOT for single-step tasks (use bash). NOT for reading workflow documentation (use read).",
      "Do NOT poll workflow status after starting. Workflows run in background — results appear automatically when done. Only use workflow { action: status } when the user explicitly asks about progress.",
    ],
    parameters: _WorkflowRunParams,

    async execute(_toolCallId: string, params: Static<typeof _WorkflowRunParams>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      // P1-6: Reentry guard for the run tool (lifecycle operations share state)
      if (reentryRef.isProcessing) {
        return {
          content: [{ type: "text" as const, text: "Another workflow operation is in progress; please wait for it to complete before issuing another command." }],
          isError: true,
        };
      }
      reentryRef.isProcessing = true;
      try {
      const sessionId = ctx.sessionManager.getSessionId();
      lsRef.lastSessionId = sessionId;
      const orch = orchestrators.get(sessionId);
      if (!orch) return { content: [{ type: "text", text: "Workflow orchestrator not initialized" }], isError: true };

      const name = params.name;
      const mode = params.mode ?? "auto";
      const args = params.args ?? {};
      const tokens = params.tokens;
      const time = params.time;

      const { loadWorkflows } = await import("./config-loader.js");
      let allWorkflows: Awaited<ReturnType<typeof loadWorkflows>>;
      try { allWorkflows = await loadWorkflows(); } catch { allWorkflows = []; }
      const available = allWorkflows.filter((wf) => wf.available);

      const exactMatch = available.find((wf) => wf.name === name);
      if (exactMatch) {
        if (mode === "force") {
          const runId = await orch.run(name, args, tokens, time, signal);
          cmdState.lastRunId = runId;
          if (ctx.hasUI) ctx.ui.setWidget("workflow", renderWorkflowList(orch.list(), ctx.ui.theme));
          return { content: [{ type: "text" as const, text: `Started workflow '${name}' (${runId}) [force mode]. Running in background — do NOT poll status.` }], details: { action: "run", runId, status: "running", name, confirmSkipped: true as const } satisfies _WorkflowRunDetails };
        }
        if (ctx.hasUI) {
          const isTmp = exactMatch.source === "tmp";
          const shouldConfirm = isTmp || !sessionApprovals.has(exactMatch.name);
          if (shouldConfirm) {
            const ok = await ctx.ui.confirm("Run workflow?",
              `Workflow: ${exactMatch.name}\nDescription: ${exactMatch.description ?? "(none)"}\nSource: [${exactMatch.source}]\nPath: ${exactMatch.path ?? "(none)"}`);
            if (!ok) return { content: [{ type: "text" as const, text: `User declined to run '${exactMatch.name}'.` }], details: { action: "run" as const, runId: "", status: "declined", name: exactMatch.name } };
            if (!isTmp) {
              sessionApprovals.add(exactMatch.name);
              pi.appendEntry("workflow-approval-memory", { workflowName: exactMatch.name, approvedAt: new Date().toISOString() });
            }
          }
        } else {
          pi.sendUserMessage(`Confirm to run '${exactMatch.name}'? (RPC mode — auto-confirm not available, proceed with caution)`, { deliverAs: "steer" });
        }
        const runId = await orch.run(name, args, tokens, time, signal);
        cmdState.lastRunId = runId;
        if (ctx.hasUI) ctx.ui.setWidget("workflow", renderWorkflowList(orch.list(), ctx.ui.theme));
        return { content: [{ type: "text" as const, text: `Started workflow '${exactMatch.name}' (${runId}). Running in background — do NOT poll status.` }], details: { action: "run", runId, status: "running", name: exactMatch.name } satisfies _WorkflowRunDetails };
      }

      const inputLower = name.toLowerCase();
      const inputWords = inputLower.split(/\s+/).filter((w: string) => w.length > INPUT_WORD_MIN_LENGTH);
      const candidates = available.filter((wf) => {
        const text = `${wf.name} ${wf.description}`.toLowerCase();
        return inputWords.some((w: string) => text.includes(w));
      });

      if (candidates.length > 0) {
        const candidateList = candidates.map((wf) => `  - ${wf.name}: ${wf.description || "(no description)"} [${wf.source}]`).join("\n");
        if (mode === "force") {
          const best = candidates[0];
          const runId = await orch.run(best.name, args, tokens, time, signal);
          cmdState.lastRunId = runId;
          if (ctx.hasUI) ctx.ui.setWidget("workflow", renderWorkflowList(orch.list(), ctx.ui.theme));
          return { content: [{ type: "text" as const, text: `Started workflow '${best.name}' (${runId}) [force mode, fuzzy match]. Running in background — do NOT poll status.` }], details: { action: "run", runId, status: "running", name: best.name, confirmSkipped: true as const } satisfies _WorkflowRunDetails };
        }
        pi.sendUserMessage(`No exact match for '${name}', but found ${candidates.length} related workflow(s):\n${candidateList}\n\nAsk the user which one to use, or if they want to create a new workflow. If they choose one, use workflow-run with the exact name and mode 'force'.`, { deliverAs: "steer" });
        return { content: [{ type: "text" as const, text: `Found ${candidates.length} fuzzy match(es) for '${name}'. Awaiting user choice.` }], details: { action: "run", runId: "", status: "pending", name } satisfies _WorkflowRunDetails };
      }

      const fullList = available.length > 0 ? available.map((wf) => `  - ${wf.name}: ${wf.description || "(no description)"}`).join("\n") : "  (none)";
      if (mode === "force") {
        return { content: [{ type: "text" as const, text: `No matching workflow for '${name}'. Available:\n${fullList}\n\nRe-run with mode='auto' for interactive selection, or use workflow-generate to create a new workflow.` }], isError: true };
      }
      pi.sendUserMessage(
        `No workflow matches '${name}'. Available workflows:\n${fullList}\n\nSuggestions:\n1. If one of the above looks suitable, use workflow-run with its exact name.\n2. If none fits, use workflow-generate to create a new temporary workflow.\n3. Before executing a generated workflow, ALWAYS show the script path and wait for user confirmation.`,
        { deliverAs: "steer" });
      return { content: [{ type: "text" as const, text: `No match for '${name}'. Suggestions sent to conversation.` }], details: { action: "run", runId: "", status: "pending", name } satisfies _WorkflowRunDetails };
      } finally {
        // P1-6: Always release the reentry guard
        reentryRef.isProcessing = false;
      }
    },

    renderCall(args: Record<string, unknown>, theme: Theme, _context?: unknown) {
      const name = args.name as string;
      return new Text(theme.fg("toolTitle", theme.bold("workflow-run ")) + theme.fg("accent", name), 0, 0);
    },

    renderResult(result: Record<string, unknown>, _options: unknown, theme: Theme, _context?: unknown) {
      const details = result.details as _WorkflowRunDetails | undefined;
      if (!details) {
        const content = result.content as Array<{ type: string; text: string }> | undefined;
        const text = content?.[0];
        return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
      }
      const statusColor =
        details.status === "completed" ? "success"
        : details.status === "running" ? "warning"
        : details.status === "failed" || details.status === "aborted" ? "error" : "muted";
      const text =
        `${theme.fg(statusColor as "success" | "warning" | "error" | "muted", `[${details.status}]`)}` +
        ` ${theme.fg("accent", details.name)}` +
        ` ${theme.fg("dim", details.runId.slice(0, RUNID_SHORT_LENGTH))}`;
      return new Text(text, 0, 0);
    },
  });
}

function registerWorkflowLintTool(
  pi: ExtensionAPI,
): void {
  pi.registerTool({
    name: "workflow-lint",
    label: "Workflow Lint",
    description:
      "Statically check a workflow script for common API misuse before execution. " +
      "Catches errors like `outputSchema` (should be `schema`), `result.output` (agent returns unwrapped value), " +
      "and fragile file-based state passing between agent calls. " +
      "Use when the user asks to validate/check a workflow script, or before running a generated workflow.",
    promptSnippet: "Lint a workflow script for errors",
    promptGuidelines: [
      "Use when user asks to check/validate a workflow script before execution.",
      "Not for linting TypeScript source files — only for workflow .js scripts.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Workflow script name to lint" }),
    }),

    async execute(_toolCallId: string, params: Static<typeof WorkflowParams>, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: ExtensionContext) {
      const { lintScript } = await import("./script-lint.js");
      const { loadWorkflows } = await import("./config-loader.js");

      let allWorkflows: Awaited<ReturnType<typeof loadWorkflows>>;
      try { allWorkflows = await loadWorkflows(); } catch { allWorkflows = []; }

      const wf = allWorkflows.find((w) => w.name === params.name && w.available);
      if (!wf?.path) {
        return { content: [{ type: "text" as const, text: `Workflow '${params.name}' not found.` }], isError: true };
      }

      const source = fs.readFileSync(wf.path, "utf-8");
      const result = lintScript(source);

      if (result.findings.length === 0) {
        return { content: [{ type: "text" as const, text: `✅ No issues found in '${params.name}'.` }] };
      }

      const lines = result.findings.map((f) => {
        const icon = f.severity === "error" ? "❌" : "⚠️";
        return `${icon} L${f.line}: ${f.message}\n   Suggestion: ${f.suggestion}`;
      });
      return {
        content: [{
          type: "text" as const,
          text: `${result.valid ? "Warnings" : "Errors"} found in '${params.name}':\n\n${lines.join("\n\n")}`,
        }],
        isError: !result.valid,
      };
    },

    renderCall(args: Record<string, unknown>, theme: Theme, _context?: unknown) {
      const name = args.name as string;
      return new Text(theme.fg("toolTitle", theme.bold("workflow-lint ")) + theme.fg("accent", name), 0, 0);
    },

    renderResult(result: Record<string, unknown>, _options: unknown, _theme: Theme, _context?: unknown) {
      const content = result.content as Array<{ type: string; text: string }> | undefined;
      const text = content?.[0];
      return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
    },
  });
}
