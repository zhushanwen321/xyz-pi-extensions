/**
 * Workflow Fullscreen TUI View (FR-1 through FR-8)
 *
 * Replaces the old widget with a single fullscreen view providing
 * real-time phases navigation, structured Activity, and in-view workflow control.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { WorkflowOrchestrator } from "../orchestrator.js";
import type { ExecutionTraceNode, WorkflowInstance, WorkflowStatus } from "../state.js";

import {
  type ThemeLike,
  buildFlatEntries,
  ELLIPSIS,
  formatActivityLine,
  formatElapsed,
  formatSidebarNode,
  formatTokenStat,
  groupByPhase,
  isTerminalStatus,
  OUTPUT_TRUNCATE_BYTES,
  PROMPT_FOLD_LINES,
  SIDEBAR_WIDTH,
  statusDotStr,
  visibleLen,
} from "./format.js";

// ── View Component factory ────────────────────────────────────

export function createWorkflowsView(
  orchestrator: WorkflowOrchestrator,
  runId: string,
  theme: ThemeLike,
  ctx: ExtensionContext,
): Promise<void> {
  return ctx.ui.custom((tui: unknown, _th: unknown, _kb: unknown, done: () => void) => {
    const instance = orchestrator.getInstance(runId);
    if (!instance) { done(); return { invalidate() {}, render() { return []; }, handleInput() {} }; }

    const tuiObj = tui as { addChild?: (c: unknown) => void; setFocus?: (c: unknown) => void; requestRender?: () => void } | null;

    const state = { selectedIndex: 0, promptExpanded: false, disposed: false };

    const requestRender = () => { tuiObj?.requestRender?.(); };

    const view = {
      invalidate() { requestRender(); },
      render(width: number): string[] {
        const inst = orchestrator.getInstance(runId);
        if (!inst) return ["(workflow not found)"];
        return renderView(inst, theme, width, state.selectedIndex, state.promptExpanded);
      },
      handleInput(data: string): void {
        handleKey(data, orchestrator, runId, state, theme, ctx, done, requestRender);
      },
    };

    const unsubscribe = orchestrator.events.subscribe(runId, () => {
      if (!state.disposed) requestRender();
    });

    const wrappedDone = () => {
      if (state.disposed) return;
      state.disposed = true;
      unsubscribe();
      done();
    };

    tuiObj?.addChild?.(view);
    tuiObj?.setFocus?.(view);
    (view as Record<string, unknown>)._done = wrappedDone;

    return view;
  });
}

// ── Keyboard handler ──────────────────────────────────────────

function handleKey(
  data: string,
  orchestrator: WorkflowOrchestrator,
  runId: string,
  state: { selectedIndex: number; promptExpanded: boolean; disposed: boolean },
  theme: ThemeLike,
  ctx: ExtensionContext,
  done: () => void,
  requestRender: () => void,
): void {
  const instance = orchestrator.getInstance(runId);
  if (!instance) return;

  const terminal = isTerminalStatus(instance.status as WorkflowStatus);
  const phaseMap = groupByPhase(instance.trace as ExecutionTraceNode[]);
  const flatEntries = buildFlatEntries(phaseMap);

  switch (data) {
    case "\x1b": case "escape": {
      if (state.disposed) return;
      state.disposed = true;
      done();
      break;
    }
    case "\x1b[A": case "up": {
      if (flatEntries.length === 0) break;
      for (let i = state.selectedIndex - 1; i >= 0; i--) {
        if (flatEntries[i].type === "node") { state.selectedIndex = i; break; }
      }
      requestRender();
      break;
    }
    case "\x1b[B": case "down": {
      if (flatEntries.length === 0) break;
      for (let i = state.selectedIndex + 1; i < flatEntries.length; i++) {
        if (flatEntries[i].type === "node") { state.selectedIndex = i; break; }
      }
      requestRender();
      break;
    }
    case "I": { // shift+i → 👉 toggle prompt expand (FR-4.6)
      state.promptExpanded = !state.promptExpanded;
      requestRender();
      break;
    }
    case "x": { // FR-6.1: abort with confirm
      if (terminal) { ctx.ui.notify(`Workflow already ${instance.status}`, "warning"); break; }
      void ctx.ui.confirm("Stop this workflow?", `${instance.name} (${runId.slice(0, 8)}...)`).then((ok) => {
        if (!ok) return;
        void orchestrator.abort(runId)
          .then(() => ctx.ui.notify("Workflow aborted", "info"))
          .catch((err) => ctx.ui.notify(`Abort failed: ${err instanceof Error ? err.message : String(err)}`, "error"));
      });
      break;
    }
    case "p": { // FR-6.2: pause/resume with confirm
      if (terminal) { ctx.ui.notify(`Workflow already ${instance.status}`, "warning"); break; }
      const action = instance.status === "running" ? "pause" : "resume";
      void ctx.ui.confirm(`${action === "pause" ? "Pause" : "Resume"} this workflow?`, `${instance.name}`).then((ok) => {
        if (!ok) return;
        const op = action === "pause"
          ? orchestrator.pause(runId)
          : orchestrator.resume(runId);
        void op
          .then(() => ctx.ui.notify(`Workflow ${action}d`, "info"))
          .catch((err) => ctx.ui.notify(`${action} failed: ${err instanceof Error ? err.message : String(err)}`, "error"));
      });
      break;
    }
    case "r": { // FR-6.3: restart (node detail view only)
      if (terminal) { ctx.ui.notify(`Workflow already ${instance.status}`, "warning"); break; }
      void ctx.ui.confirm("Restart from scratch?", `This will start a new run of '${instance.name}'`).then((ok) => {
        if (!ok) return;
        void orchestrator.run(instance.name, {}, instance.budget.maxTokens, instance.budget.maxTimeMs)
          .then((newRunId) => ctx.ui.notify(`Restarted → ${newRunId.slice(0, 8)}...`, "info"))
          .catch((err) => ctx.ui.notify(`Restart failed: ${err instanceof Error ? err.message : String(err)}`, "error"));
      });
      break;
    }
    case "s": { // FR-6.7: save trace to file
      saveTraceToFile(instance, ctx);
      break;
    }
  }
}

// ── Save trace to file ────────────────────────────────────────

function saveTraceToFile(instance: WorkflowInstance, ctx: ExtensionContext): void {
  const dir = path.join(os.homedir(), ".pi", "agent", "workflow-traces");
  const filePath = path.join(dir, `${instance.runId}.md`);

  const lines: string[] = [];
  lines.push(`# Workflow Trace: ${instance.name} (${instance.runId})`, "");
  lines.push(`Status: ${instance.status} | Started: ${instance.startedAt ?? "-"} | Duration: ${formatElapsed(instance.startedAt)}`);
  lines.push(`Budget: ${instance.budget.usedTokens}/${instance.budget.maxTokens ?? "unlimited"} tokens, $${instance.budget.usedCost.toFixed(4)}`, "");

  const phaseMap = groupByPhase(instance.trace as ExecutionTraceNode[]);
  for (const [phase, nodes] of phaseMap) {
    lines.push(`## Phase: ${phase}`, "");
    for (const node of nodes) {
      lines.push(`### [#${node.stepIndex}] ${node.agent} — ${node.status}`);
      lines.push(`- Model: ${node.model}`);
      lines.push(`- Duration: ${formatElapsed(node.startedAt, node.completedAt ? new Date(node.completedAt).getTime() : Date.now())}`, "");
      lines.push("**Prompt:**", node.task, "");
      if (node.result?.toolCalls && node.result.toolCalls.length > 0) {
        lines.push("**Activity:**");
        for (const tc of node.result.toolCalls) lines.push(`- ${formatActivityLine(tc, 80)}`);
        lines.push("");
      }
      lines.push("**Outcome:**");
      if (node.status === "running") lines.push("Still running...");
      else if (node.result?.error) lines.push(node.result.error);
      else if (node.result?.content) lines.push(node.result.content.slice(0, 2000));
      lines.push("");
    }
  }

  fs.promises.mkdir(dir, { recursive: true })
    .then(() => fs.promises.writeFile(filePath, lines.join("\n"), "utf8"))
    .then(() => ctx.ui.notify(`Trace saved: ${filePath}`, "info"))
    .catch((err: Error) => ctx.ui.notify(`Save failed: ${err.message}`, "error"));
}

// ── Main render function ──────────────────────────────────────

function renderView(
  instance: WorkflowInstance,
  theme: ThemeLike,
  width: number,
  selectedIndex: number,
  promptExpanded: boolean,
): string[] {
  const lines: string[] = [];

  // ── Header (2 lines + separator) ──
  const completed = instance.trace.filter((n) => n.status === "completed").length;
  const total = instance.trace.length;
  const elapsed = formatElapsed(instance.startedAt);
  const headerRight = `${completed}/${total} agents · ${elapsed}`;

  lines.push(theme.bold(instance.name));
  const descLine = instance.error ? theme.fg("error", instance.error.slice(0, 60)) : "";
  const rightPart = theme.fg("muted", headerRight);
  const padLen = descLine
    ? Math.max(0, width - visibleLen(descLine) - visibleLen(rightPart) - 2)
    : Math.max(0, width - visibleLen(rightPart));
  lines.push(descLine ? descLine + " ".repeat(padLen) + rightPart : " ".repeat(padLen) + rightPart);
  lines.push("─".repeat(width));

  // ── Body (sidebar + main) ──
  const phaseMap = groupByPhase(instance.trace as ExecutionTraceNode[]);
  const flatEntries = buildFlatEntries(phaseMap);

  let selectedNode: ExecutionTraceNode | undefined;
  let selectedPhase: string | undefined;
  for (const entry of flatEntries) {
    if (entry.index === selectedIndex && entry.type === "node" && entry.node) {
      selectedNode = entry.node;
      selectedPhase = entry.node.phase || "(no phase)";
    }
  }

  // Sidebar
  const sidebarLines: string[] = [theme.fg("muted", theme.bold("Phases"))];
  for (const entry of flatEntries) {
    if (entry.type === "phase") {
      const phaseNodes = phaseMap.get(entry.phase!) ?? [];
      const doneCount = phaseNodes.filter((n) => n.status === "completed").length;
      sidebarLines.push(`  ${(flatEntries.indexOf(entry) + 1)} ${entry.phase!.slice(0, 12)} ${doneCount}/${phaseNodes.length}`);
    } else if (entry.node) {
      sidebarLines.push(formatSidebarNode(entry.node, entry.index === selectedIndex, SIDEBAR_WIDTH, theme));
    }
  }

  // Main area
  const mainWidth = width - SIDEBAR_WIDTH - 1;
  const mainLines: string[] = [];

  if (selectedNode) {
    const phaseNodes = phaseMap.get(selectedPhase ?? "(no phase)") ?? [];
    mainLines.push(theme.fg("accent", `${selectedPhase ?? "(no phase)"} · ${phaseNodes.length} agent`), "");
    mainLines.push(theme.bold(selectedNode.agent));
    mainLines.push(`${statusDotStr(selectedNode.status, theme)} ${selectedNode.status} · ${selectedNode.model}`);
    mainLines.push(theme.fg("dim", formatTokenStat(
      selectedNode.result?.usage as { input: number; output: number } | undefined,
      selectedNode.result?.toolCalls,
    )));
    mainLines.push("");

    // Prompt section
    const taskLines = selectedNode.task.split("\n");
    const lineCount = taskLines.length;
    mainLines.push(theme.fg("muted", `Prompt · ${lineCount} lines · 👉 ${promptExpanded ? "collapse" : "expand"}`));
    if (promptExpanded || lineCount <= PROMPT_FOLD_LINES) {
      mainLines.push(...taskLines.map((l) => `  ${l}`));
    } else {
      mainLines.push(...taskLines.slice(0, PROMPT_FOLD_LINES).map((l) => `  ${l}`));
      mainLines.push(theme.fg("dim", `  ${ELLIPSIS} ${lineCount - PROMPT_FOLD_LINES} more lines`));
    }
    mainLines.push("");

    // Activity section
    const toolCalls = selectedNode.result?.toolCalls;
    mainLines.push(theme.fg("muted", "Activity"));
    if (toolCalls && toolCalls.length > 0) {
      for (const tc of toolCalls) mainLines.push(`  ${formatActivityLine(tc, mainWidth - 2)}`);
    } else {
      mainLines.push(theme.fg("dim", `  ${selectedNode.status === "running" ? "(no tool calls yet)" : "(no activity recorded)"}`));
    }
    mainLines.push("");

    // Outcome section
    mainLines.push(theme.fg("muted", "Outcome"));
    if (selectedNode.status === "running") {
      mainLines.push(theme.fg("dim", "  Still running..."));
    } else if (selectedNode.result?.error) {
      mainLines.push(theme.fg("error", `  ${selectedNode.result.error.slice(0, 200)}`));
    } else if (selectedNode.result?.content) {
      let content = selectedNode.result.content;
      if (content.length > OUTPUT_TRUNCATE_BYTES) {
        content = content.slice(0, OUTPUT_TRUNCATE_BYTES) + `\n${ELLIPSIS} (truncated, see full output via result)`;
      }
      mainLines.push(...content.split("\n").slice(0, 20).map((l) => `  ${l}`));
    }
  } else {
    mainLines.push(theme.fg("muted", "Select an agent node to view details"));
  }

  // Combine sidebar + main with │ separator
  const bodyHeight = Math.max(sidebarLines.length, mainLines.length);
  for (let i = 0; i < bodyHeight; i++) {
    const left = (sidebarLines[i] ?? "").padEnd(SIDEBAR_WIDTH).slice(0, SIDEBAR_WIDTH);
    lines.push(left + "│" + (mainLines[i] ?? ""));
  }

  // ── Footer ──
  lines.push("─".repeat(width));
  const footer = selectedNode
    ? "↑↓ agent · 👉 prompt · x stop · r restart · p pause · esc back · s save"
    : "↑↓ select · x stop workflow · p pause · esc back · s save";
  lines.push(theme.fg("muted", footer));

  return lines;
}
