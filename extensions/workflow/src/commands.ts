/**
 * Workflow Extension — Commands & Completion Notification
 *
 * Commands:
 *   /workflow run <name> [--args key=val ...] [--tokens N] [--time N]
 *   /workflows              — fullscreen workflow view (three-level navigation)
 *   /workflow list          — list running workflows
 *   /workflow abort <run-id>
 *
 * Completion notification sends a custom message via pi.sendMessage()
 * when a workflow reaches a terminal state, with a _render descriptor
 * for GUI display.
 */

import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { loadWorkflows } from "./infra/config-loader.js";
import { type WorkflowOrchestrator } from "./orchestrator.js";
import { type WorkflowInstance } from "./domain/state.js";
import { createWorkflowsView } from "./views/WorkflowsView.js";

// ── Constants ─────────────────────────────────────────────────

const JSON_INDENT = 2;
const MAX_RESULT_LENGTH = 8000;
const RUNID_SHORT_LENGTH = 12;
const RUNID_SLICE_LENGTH = 16;
const TASK_SHORT_LENGTH = 150;
const CONTENT_TRUNC_LENGTH = 500;
const SPLIT_LIMIT = 2;
const _TASK_PREVIEW_LENGTH = 60;

// ── Types ──────────────────────────────────────────────────────

export interface WorkflowCommandsState {
  /** Last-started run ID, used by shortcuts that need a default target */
  lastRunId: string | null;
}

// ── Completion Notification ────────────────────────────────────

const statusToItemStatus = (
  s: string,
): "pending" | "in_progress" | "completed" | "failed" | "cancelled" => {
  if (s === "completed") return "completed";
  if (s === "failed") return "failed";
  if (s === "running") return "in_progress";
  return "pending";
};

/**
 * Send a completion notification via pi.sendMessage when a workflow
 * reaches a terminal state. Includes a _render descriptor for GUI.
 *
 * The `notifiedRunIds` Set is provided by the caller so that dedup
 * state is scoped to the factory/extension instance, not shared
 * across all callers globally. A default module-level Set is used
 * for backwards compatibility with direct callers (e.g. tests).
 */
const defaultNotifiedRunIds = new Set<string>();

export function sendCompletionNotification(
  api: ExtensionAPI,
  runId: string,
  instance: WorkflowInstance,
  notifiedRunIds: Set<string> = defaultNotifiedRunIds,
): void {
  if (notifiedRunIds.has(runId)) return;
  notifiedRunIds.add(runId);

  // FR-2: Build content with optional scriptResult summary + trace summary
  const parts: string[] = [];
  parts.push(`Workflow '${instance.name}' completed: ${instance.status}`);

  if (instance.scriptResult !== undefined && instance.scriptResult !== null) {
    const serialized = JSON.stringify(instance.scriptResult, null, JSON_INDENT);
    const truncated = serialized.length > MAX_RESULT_LENGTH ? serialized.slice(0, MAX_RESULT_LENGTH) + "\n... (truncated)" : serialized;
    parts.push("");
    parts.push("--- Script Result ---");
    parts.push(truncated);
  }

  parts.push("");
  parts.push("--- Agent Trace ---");
  for (const node of instance.trace) {
    parts.push(`[${node.stepIndex}] ${node.agent}: ${node.status}`);
  }

  const content = parts.join("\n");

  api.sendMessage({
    customType: "workflow-result",
    content,
    display: true,
    details: {
      runId,
      name: instance.name,
      status: instance.status,
      traceLength: instance.trace.length,
      _render: {
        type: "task-list" as const,
        data: {
          title: `Workflow: ${instance.name} (${runId.slice(0, RUNID_SHORT_LENGTH)}...)`,
          items: instance.trace.map((node) => ({
            label: `[${node.stepIndex}] ${node.agent}: ${node.task.slice(0, TASK_SHORT_LENGTH)}`,
            status: statusToItemStatus(node.status),
            detail: node.result?.content?.slice(0, CONTENT_TRUNC_LENGTH),
          })),
          summary: `Status: ${instance.status} | ${instance.trace.length} agent calls`,
        },
      },
    },
  });
}

// ── Argument parsing ───────────────────────────────────────────

interface ParsedRunArgs {
  name: string;
  args: Record<string, unknown>;
  tokens?: number;
  time?: number;
}

function parseRunArgs(tokens: string[]): ParsedRunArgs {
  const name = tokens[0] ?? "";
  const result: ParsedRunArgs = { name, args: {} };

  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "--args") {
      i++;
      while (i < tokens.length && !tokens[i].startsWith("--")) {
        const kv = tokens[i].split("=", SPLIT_LIMIT);
        if (kv.length === SPLIT_LIMIT) {
          result.args[kv[0]] = kv[1];
        }
        i++;
      }
    } else if (token === "--tokens") {
      i++;
      if (i < tokens.length) {
        result.tokens = Number(tokens[i]);
        i++;
      }
    } else if (token === "--time") {
      i++;
      if (i < tokens.length) {
        result.time = Number(tokens[i]);
        i++;
      }
    } else {
      // Unknown token, skip
      i++;
    }
  }

  return result;
}



// ── Command registration ───────────────────────────────────────

/**
 * Register /workflow and /workflows commands.
 * The `orchestrators` map allows command handlers to resolve the
 * correct orchestrator for the current session at runtime.
 */
export function registerWorkflowCommands(
  api: ExtensionAPI,
  orchestrators: Map<string, WorkflowOrchestrator>,
  cmdState: WorkflowCommandsState,
): void {
  // ── /workflow ────────────────────────────────────────────────

  api.registerCommand("workflow", {
    description: [
      "Workflow management.",
      "Subcommands:",
      "  run <name> [--args key=val ...] [--tokens N] [--time N]  Start a workflow",
      "  list              List running instances and available scripts",
      "  abort <run-id>    Abort a running workflow",
      "  save <tmp-name> [--as <name>]  Save a temporary workflow as permanent",
      "  delete <name>     Delete a workflow script",
      "",
      "Shorthand: /workflows opens the interactive panel.",
    ].join("\n"),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length === 0) {
        ctx.ui.notify("Usage: /workflow run|list|abort|save|delete", "warning");
        return;
      }

      const sessionId = ctx.sessionManager.getSessionId();
      const orch = orchestrators.get(sessionId);
      if (!orch) {
        ctx.ui.notify("Workflow system not initialized", "error");
        return;
      }

      const subcommand = parts[0];

      switch (subcommand) {
        // ── run ──
        case "run": {
          const parsed = parseRunArgs(parts.slice(1));
          if (!parsed.name) {
            ctx.ui.notify("Usage: /workflow run <name> [--args ...]", "warning");
            return;
          }

          try {
            const runId = await orch.run(
              parsed.name,
              parsed.args,
              parsed.tokens,
              parsed.time,
            );
            cmdState.lastRunId = runId;
            ctx.ui.notify(
              `Started '${parsed.name}' (${runId.slice(0, RUNID_SLICE_LENGTH)}...)`,
              "info",
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // If workflow not found, pass to AI to handle
            if (msg.includes("not found") || msg.includes("unavailable")) {
              // Load available workflows for suggestions
              let availableList = "";
              try {
                const workflows = await loadWorkflows();
                const available = workflows.filter((wf) => wf.available);
                if (available.length > 0) {
                  availableList = "\n\nAvailable workflow scripts:\n" +
                    available.map((wf) => `  - ${wf.name}: ${wf.description || "(no description)"}`).join("\n");
                } else {
                  availableList = "\n\nNo workflow scripts are currently available.";
                }
              } catch {
                availableList = "";
              }

              api.sendUserMessage(
                `The user tried to run /workflow run '${parsed.name}' but no exact match was found. ` +
                `The original /workflow run input was:\n${args.trim()}${availableList}\n\n` +
                `Use workflow-run with name='${parsed.name}' and mode='auto' — the tool will search by description, ` +
                `list candidates if any match, or suggest creating a new workflow.`
              );
            } else {
              ctx.ui.notify(`Failed: ${msg}`, "error");
            }
          }
          return;
        }

        // ── list ──
        case "list": {
          // Show available workflow scripts with source tags
          let scriptSection = "";
          try {
            const workflows = await loadWorkflows();
            const available = workflows.filter((wf) => wf.available);
            if (available.length > 0) {
              scriptSection = "\nAvailable workflows:\n" +
                available
                  .map((wf) => `  [${wf.source}] ${wf.name} — ${wf.description || "(no description)"}`)
                  .join("\n");
            }
          // eslint-disable-next-line taste/no-silent-catch
          } catch (err) {
            console.warn("Failed to load workflows for list:", err);
          }

          const instances = orch.list();
          if (instances.length === 0 && !scriptSection) {
            ctx.ui.notify("No workflow instances or scripts available", "info");
            return;
          }

          const sections: string[] = [];

          if (instances.length > 0) {
            sections.push("Running:");
            sections.push(...instances.map((inst) => {
              const ts = inst.startedAt
                ? new Date(inst.startedAt).toLocaleTimeString()
                : "-";
              return (
                `  [${inst.status}] ${inst.name} (${inst.runId.slice(0, RUNID_SLICE_LENGTH)}...) ${ts}` +
                (inst.error ? ` error: ${inst.error}` : "")
              );
            }));
          }

          if (scriptSection) {
            sections.push(scriptSection);
          }

          ctx.ui.notify(sections.join("\n"), "info");
          return;
        }

        // ── abort ──
        case "abort": {
          const runId = parts[1];
          if (!runId) {
            ctx.ui.notify("Usage: /workflow abort <run-id>", "warning");
            return;
          }
          try {
            await orch.abort(runId);
            ctx.ui.notify(`Aborted ${runId.slice(0, RUNID_SLICE_LENGTH)}...`, "info");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`Abort failed: ${msg}`, "error");
          }
          return;
        }

        // ── save ──
        case "save": {
          const tmpName = parts[1];
          if (!tmpName) {
            ctx.ui.notify("Usage: /workflow save <tmp-name> [--as <new-name>]", "warning");
            return;
          }

          // Parse --as parameter
          let newName: string | undefined;
          const asIdx = parts.indexOf("--as");
          if (asIdx !== -1 && parts[asIdx + 1]) {
            newName = parts[asIdx + 1];
          }

          try {
            const result = await saveWorkflow(tmpName, newName);
            ctx.ui.notify(result, "info");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`Save failed: ${msg}`, "error");
          }
          return;
        }

        // ── delete ──
        case "delete": {
          const name = parts[1];
          if (!name) {
            ctx.ui.notify("Usage: /workflow delete <name>", "warning");
            return;
          }

          try {
            const isRunning = (n: string) =>
              orch.list().some((i) => i.name === n && i.status === "running");
            const result = deleteWorkflow(name, isRunning);
            ctx.ui.notify(result, "info");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`Delete failed: ${msg}`, "error");
          }
          return;
        }

        default: {
          // Unknown subcommand — check if it could be a workflow name or natural language
          // Collect available workflows and pass to AI for routing
          const userInput = args.trim();
          let workflowList = "";
          try {
            const workflows = await loadWorkflows();
            const available = workflows.filter((wf) => wf.available);
            if (available.length > 0) {
              workflowList = available
                .map((wf) => `  [${wf.source}] ${wf.name} — ${wf.description || "(no description)"}`)
                .join("\n");
            }
          // eslint-disable-next-line taste/no-silent-catch
          } catch (err) {
            console.warn("Failed to load workflows for routing:", err);
          }

          const listSection = workflowList
            ? `\nAvailable workflows:\n${workflowList}`
            : "\nNo available workflows found.";

          api.sendUserMessage(
            `The user typed /workflow with input: "${userInput}"` +
            listSection +
            `\n\nMatch by workflow name and description (do NOT read script files). Then:\n` +
            `1. If a workflow matches, use workflow-run with name='${userInput}' and mode='auto'. The tool will confirm with the user.\n` +
            `2. If no match, use workflow-generate to create a new temporary workflow.\n` +
            `3. Before executing a generated workflow, ALWAYS show the script path and wait for user confirmation.`,
          );
          return;
        }
      }
    },
  });

  // ── /workflows — interactive panel ───────────────────────────

  api.registerCommand("workflows", {
    description: "Open workflow fullscreen view. /workflows [runId] to open specific workflow.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/workflows requires interactive mode", "error");
        return;
      }

      const sessionId = ctx.sessionManager.getSessionId();
      const orch = orchestrators.get(sessionId);
      if (!orch) {
        ctx.ui.notify("Workflow system not initialized", "error");
        return;
      }

      // Direct entry by runId (FR-1.1)
      const directRunId = args.trim();
      if (directRunId) {
        const instance = orch.getInstance(directRunId);
        if (!instance) {
          // Try prefix match
          const all = orch.list();
          const matched = all.filter((s) => s.runId.startsWith(directRunId));
          if (matched.length === 1) {
            await createWorkflowsView(orch, matched[0].runId, ctx.ui.theme, ctx);
            return;
          }
          ctx.ui.notify(`Workflow '${directRunId}' not found`, "error");
          return;
        }
        await createWorkflowsView(orch, directRunId, ctx.ui.theme, ctx);
        return;
      }

      // No runId — list all instances (active first), select or enter directly
      const all = orch.list();

      if (all.length === 0) {
        ctx.ui.notify("No workflows found. Use /workflow <name> to start one.", "info");
        return;
      }

      // Sort: running/paused first, then by startedAt descending
      const statusOrder: Record<string, number> = { running: 0, paused: 1, completed: 2, failed: 3 };
      all.sort((a, b) => {
        const sa = statusOrder[a.status] ?? 9;
        const sb = statusOrder[b.status] ?? 9;
        if (sa !== sb) return sa - sb;
        const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
        const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
        return tb - ta;
      });

      // Single instance — enter directly
      if (all.length === 1) {
        await createWorkflowsView(orch, all[0].runId, ctx.ui.theme, ctx);
        return;
      }

      // Multiple — SelectList
      const entries = all.map(
        (s) => `${s.name} [${s.status}] (${s.runId.slice(0, RUNID_SHORT_LENGTH)}...)`,
      );
      const selected = await ctx.ui.select("Select workflow:", entries);
      if (!selected) return;

      const idx = entries.indexOf(selected);
      if (idx === -1) return;

      await createWorkflowsView(orch, all[idx].runId, ctx.ui.theme, ctx);
    },
  });
}

// ── Shared workflow file operations ──────────────────────────────

const TMP_DIR = resolve(".pi/workflows/.tmp");
const SAVED_DIR = resolve(".pi/workflows");

/**
 * Save a temporary workflow to the saved directory.
 * Moves .pi/workflows/.tmp/{name}.js → .pi/workflows/{newName||name}.js
 */
export async function saveWorkflow(tmpName: string, newName?: string): Promise<string> {
  const workflows = await loadWorkflows();
  const target = workflows.find(
    (wf) => wf.source === "tmp" && wf.name === tmpName,
  );
  if (!target) {
    throw new Error(`Temporary workflow '${tmpName}' not found`);
  }

  const destName = newName ?? tmpName;
  const destPath = resolve(SAVED_DIR, `${destName}.js`);

  // Check destination exists (reject, not auto-rename)
  if (existsSync(destPath)) {
    throw new Error(`'${destName}' already exists in saved workflows. Use --as to save with a different name.`);
  }

  mkdirSync(SAVED_DIR, { recursive: true });

  renameSync(target.path, destPath);
  return `Saved '${tmpName}' → '${destName}' (${destPath})`;
}

/**
 * Delete a workflow script file.
 * Rejects if the workflow is currently running.
 */
export function deleteWorkflow(
  name: string,
  isRunning: (name: string) => boolean,
): string {
  if (isRunning(name)) {
    throw new Error(`Cannot delete '${name}': workflow is currently running. Abort it first.`);
  }

  const candidates = [
    resolve(TMP_DIR, `${name}.js`),
    resolve(SAVED_DIR, `${name}.js`),
  ];

  for (const filePath of candidates) {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      return `Deleted workflow '${name}' (${filePath})`;
    }
  }

  throw new Error(`Workflow file '${name}' not found`);
}
