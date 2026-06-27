/**
 * tool-workflow-run.ts — Workflow execution tool (start/discover workflows)
 *
 * Extracted from index.ts. Pure relocation; behavior identical to the
 * previous inline registerWorkflowRunTool.
 *
 * Register via registerWorkflowRunTool(pi, deps).
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static,Type } from "typebox";

import { type WorkflowCommandsState } from "./commands.js";
import {
  INPUT_WORD_MIN_LENGTH,
  RUNID_SHORT_LENGTH,
  type WorkflowToolDeps,
} from "./shared.js";

// ── Parameter schema ──────────────────────────────────────────

const WorkflowRunParams = Type.Object({
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

export interface WorkflowRunDetails {
  action: "run"; runId: string; status: string; name: string;
  confirmSkipped?: boolean;
}

export interface WorkflowRunToolDeps extends WorkflowToolDeps {
  cmdState: WorkflowCommandsState;
  /** Per-session approved workflow names (tmp workflows never enter here). */
  sessionApprovals: Set<string>;
}

// ── Tool registration ─────────────────────────────────────────

 
export function registerWorkflowRunTool(pi: ExtensionAPI, deps: WorkflowRunToolDeps): void {
  const { orchestrators, cmdState, sessionApprovals, lsRef, guard } = deps;

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
    parameters: WorkflowRunParams,

     
    async execute(_toolCallId: string, params: Static<typeof WorkflowRunParams>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<{ content: Array<{ type: "text"; text: string }>; details: WorkflowRunDetails | undefined; isError?: boolean }> {
      // P1-6: Reentry guard for the run tool (lifecycle operations share state)
      if (guard.isProcessing) {
        return {
          content: [{ type: "text" as const, text: "Another workflow operation is in progress; please wait for it to complete before issuing another command." }],
          details: undefined,
          isError: true,
        };
      }
      guard.isProcessing = true;
      try {
      const sessionId = ctx.sessionManager.getSessionId();
      lsRef.lastSessionId = sessionId;
      const orch = orchestrators.get(sessionId);
      if (!orch) return { content: [{ type: "text", text: "Workflow orchestrator not initialized" }], details: undefined, isError: true };

      const name = params.name;
      const mode = params.mode ?? "auto";
      const args = params.args ?? {};
      const tokens = params.tokens;
      const time = params.time;

      const { loadWorkflows } = await import("../infra/config-loader.js");
      let allWorkflows: Awaited<ReturnType<typeof loadWorkflows>>;
      try { allWorkflows = await loadWorkflows(); } catch { allWorkflows = []; }
      const available = allWorkflows.filter((wf) => wf.available);

      const exactMatch = available.find((wf) => wf.name === name);
      if (exactMatch) {
        if (mode === "force") {
          const runId = await orch.run(name, args, tokens, time, signal);
          cmdState.lastRunId = runId;
          return { content: [{ type: "text" as const, text: `Started workflow '${name}' (${runId}) [force mode]. Running in background — do NOT poll status.` }], details: { action: "run", runId, status: "running", name, confirmSkipped: true as const } satisfies WorkflowRunDetails };
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
        return { content: [{ type: "text" as const, text: `Started workflow '${exactMatch.name}' (${runId}). Running in background — do NOT poll status.` }], details: { action: "run", runId, status: "running", name: exactMatch.name } satisfies WorkflowRunDetails };
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
          return { content: [{ type: "text" as const, text: `Started workflow '${best.name}' (${runId}) [force mode, fuzzy match]. Running in background — do NOT poll status.` }], details: { action: "run", runId, status: "running", name: best.name, confirmSkipped: true as const } satisfies WorkflowRunDetails };
        }
        pi.sendUserMessage(`No exact match for '${name}', but found ${candidates.length} related workflow(s):\n${candidateList}\n\nAsk the user which one to use, or if they want to create a new workflow. If they choose one, use workflow-run with the exact name and mode 'force'.`, { deliverAs: "steer" });
        return { content: [{ type: "text" as const, text: `Found ${candidates.length} fuzzy match(es) for '${name}'. Awaiting user choice.` }], details: { action: "run", runId: "", status: "pending", name } satisfies WorkflowRunDetails };
      }

      const fullList = available.length > 0 ? available.map((wf) => `  - ${wf.name}: ${wf.description || "(no description)"}`).join("\n") : "  (none)";
      if (mode === "force") {
        return { content: [{ type: "text" as const, text: `No matching workflow for '${name}'. Available:\n${fullList}\n\nRe-run with mode='auto' for interactive selection, or use workflow-generate to create a new workflow.` }], details: undefined, isError: true };
      }
      pi.sendUserMessage(
        `No workflow matches '${name}'. Available workflows:\n${fullList}\n\nSuggestions:\n1. If one of the above looks suitable, use workflow-run with its exact name.\n2. If none fits, use workflow-generate to create a new temporary workflow.\n3. Before executing a generated workflow, ALWAYS show the script path and wait for user confirmation.`,
        { deliverAs: "steer" });
      return { content: [{ type: "text" as const, text: `No match for '${name}'. Suggestions sent to conversation.` }], details: { action: "run", runId: "", status: "pending", name } satisfies WorkflowRunDetails };
      } finally {
        // P1-6: Always release the reentry guard
        guard.isProcessing = false;
      }
    },

    renderCall(args: Record<string, unknown>, theme: Theme, _context?: unknown) {
      const name = args.name as string;
      return new Text(theme.fg("toolTitle", theme.bold("workflow-run ")) + theme.fg("accent", name), 0, 0);
    },

    renderResult(result: { content: Array<{ type: "text" | "image"; text?: string }>; details?: WorkflowRunDetails }, _options: unknown, theme: Theme, _context?: unknown) {
      const details = result.details as WorkflowRunDetails | undefined;
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
