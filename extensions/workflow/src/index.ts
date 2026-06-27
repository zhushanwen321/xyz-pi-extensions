/**
 * Workflow Extension — Factory Skeleton
 *
 * Events registered:
 *   session_start  — reconstruct state from Session JSONL, create per-session orchestrator
 *   session_tree   — rehydrate on branch switch, drop stale running state
 *   session_shutdown — clean up session-scoped state
 *   tool_call      — inject workflow-script-format SKILL on workflow-generate
 *
 * Tools registered (logic lives in src/interface/):
 *   workflow          — pause/resume/abort/status   (interface/tool-workflow.ts)
 *   workflow-run      — start/discover workflows     (interface/tool-workflow-run.ts)
 *   workflow-generate — generate tmp script          (interface/tool-generate.ts)
 *   workflow-lint     — static script check          (interface/tool-lint.ts)
 *
 * This file is pure glue: state ownership + event wiring + delegating
 * register* calls. No tool execute/render logic lives here.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { transitionStatus } from "./domain/state.js";
import {
  registerWorkflowCommands,
  sendCompletionNotification,
  type WorkflowCommandsState,
} from "./interface/commands.js";
import { registerGenerateTool } from "./interface/tool-generate.js";
import { registerWorkflowLintTool } from "./interface/tool-lint.js";
import { registerWorkflowTool } from "./interface/tool-workflow.js";
import { registerWorkflowRunTool } from "./interface/tool-workflow-run.js";
import { WorkflowOrchestrator } from "./orchestrator.js";

export default function workflowExtension(pi: ExtensionAPI) {
  const lsRef = { lastSessionId: "" };
  const orchestrators = new Map<string, WorkflowOrchestrator>();
  const cmdState: WorkflowCommandsState = { lastRunId: null };
  const sessionApprovals = new Set<string>();
  // P1-3: Per-factory dedup Set for completion notifications (was module-level in commands.ts)
  const notifiedRunIds = new Set<string>();
  // P1-6: Reentry guard — shared object so both workflow and workflow-run tools see the same flag
  const guard = { isProcessing: false };

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
    await orch.reconstructAndRestore();

    // Live progress: event-driven updates handled by WorkflowsView subscription
    orch.onTraceUpdate = undefined;
    orch.onCompletion = (runId) => {
      const instance = orch.getInstance(runId);
      if (instance) sendCompletionNotification(pi, runId, instance, notifiedRunIds);
    };
  });

  pi.on("session_tree", async (_event: Record<string, unknown>, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    lsRef.lastSessionId = sessionId;
    // 切分支前清理旧 orchestrator 的在途 temp 文件（--append-system-prompt / schema 注入文件）。
    // 不清则 mid-run 切分支会泄漏到磁盘（旧 run 被抛弃不会再走 pause/abort 的清理路径）。
    const previousOrch = orchestrators.get(sessionId);
    if (previousOrch) {
      previousOrch.cleanupAllTempFiles();
    }
    const orch = new WorkflowOrchestrator(pi, ctx);
    orchestrators.set(sessionId, orch);
    await orch.reconstructAndRestore();
    // P1-7: Drop pending state from old branches — running workers no longer exist
    for (const summary of orch.list()) {
      if (summary.status === "running") {
        const inst = orch.getInstance(summary.runId);
        if (!inst) continue;
        inst.pausedAt = new Date().toISOString();
        try {
          transitionStatus(inst, "paused");
        // eslint-disable-next-line taste/no-silent-catch
        } catch {
          // State machine refused — leave as-is
        }
      }
    }
    orch.onTraceUpdate = undefined;
    orch.onCompletion = (runId) => {
      const instance = orch.getInstance(runId);
      if (instance) sendCompletionNotification(pi, runId, instance, notifiedRunIds);
    };
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

  // ── Tools ───────────────────────────────────────────────────

  const sharedDeps = { orchestrators, lsRef, guard };
  registerWorkflowTool(pi, sharedDeps);
  registerWorkflowRunTool(pi, { ...sharedDeps, cmdState, sessionApprovals });
  registerGenerateTool(pi);
  registerWorkflowLintTool(pi);

  // ── Commands ────────────────────────────────────────────────

  registerWorkflowCommands(pi, orchestrators, cmdState);

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
