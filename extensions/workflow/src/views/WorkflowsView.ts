/**
 * Workflow Fullscreen TUI View (FR-1 through FR-8)
 *
 * Uses ctx.ui.custom() with overlay mode to render a fullscreen panel
 * on top of the existing UI. Overlay mode allows stacking confirms
 * (x/p/r keys) and properly covers the terminal screen.
 *
 * Selection model:
 * - Both phase headers and agent nodes are selectable via ↑↓
 * - Selecting a phase header shows a phase summary on the right
 * - Selecting an agent node shows the agent detail view
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, Key } from "@mariozechner/pi-tui";

import type { WorkflowOrchestrator } from "../orchestrator.js";
import type { WorkflowInstance } from "../state.js";

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
  padVisible,
  PROMPT_FOLD_LINES,
  SIDEBAR_WIDTH,
  statusDotStr,
  visibleLen,
} from "./format.js";

// ── View factory ──────────────────────────────────────────────

export function createWorkflowsView(
  orchestrator: WorkflowOrchestrator,
  runId: string,
  theme: ThemeLike,
  ctx: ExtensionContext,
): Promise<void> {
  return ctx.ui.custom<void>((tui: unknown, _theme: unknown, _kb: unknown, done: () => void) => {
    const instance = orchestrator.getInstance(runId);
    if (!instance) {
      ctx.ui.notify("Workflow not found", "warning");
      done();
      return { render: () => [], invalidate() {}, handleInput() {} };
    }

    const state = { selectedIndex: 0, promptExpanded: false, disposed: false };
    const cache = { width: undefined as number | undefined, lines: undefined as string[] | undefined };
    const tuiAny = tui as { requestRender(): void; terminal: { rows: number } };
    const requestRender = () => tuiAny.requestRender();

    const unsubscribe = orchestrator.events.subscribe(runId, () => {
      if (!state.disposed) requestRender();
    });

    const wrappedDone = () => {
      if (state.disposed) return;
      state.disposed = true;
      unsubscribe();
      done();
    };

    const component = {
      invalidate(): void {
        cache.width = undefined;
        cache.lines = undefined;
      },
      render(width: number): string[] {
        if (cache.lines && cache.width === width) return cache.lines;
        const inst = orchestrator.getInstance(runId);
        const raw = inst
          ? renderView(inst, theme, width, state.selectedIndex, state.promptExpanded)
          : ["(workflow not found)"];
        const termHeight = tuiAny.terminal.rows;
        const lines = raw.length < termHeight
          ? [...raw, ...Array.from({ length: termHeight - raw.length }, () => "")]
          : raw;
        cache.width = width;
        cache.lines = lines;
        return lines;
      },
      handleInput(data: string): void {
        if (state.disposed) return;
        const reRender = processKeyInput(
          data, orchestrator, runId, state, ctx, wrappedDone,
        );
        if (reRender) {
          cache.width = undefined;
          cache.lines = undefined;
          requestRender();
        }
      },
    };

    return component;
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "center" as const,
      width: "100%",
      maxHeight: "100%",
      margin: 0,
    },
  });
}

// ── Keyboard handler ──────────────────────────────────────────

function processKeyInput(
  data: string,
  orchestrator: WorkflowOrchestrator,
  runId: string,
  state: { selectedIndex: number; promptExpanded: boolean; disposed: boolean },
  ctx: ExtensionContext,
  done: () => void,
): boolean {
  const instance = orchestrator.getInstance(runId);
  if (!instance) return false;

  const terminal = isTerminalStatus(instance.status);
  const phaseMap = groupByPhase(instance.trace);
  const flatEntries = buildFlatEntries(phaseMap);

  if (flatEntries.length === 0) return false;

  if (matchesKey(data, Key.escape)) {
    done();
    return false;
  }

  // ↑↓ navigate all entries (phase headers + nodes)
  if (matchesKey(data, Key.up)) {
    if (state.selectedIndex > 0) {
      state.selectedIndex--;
      return true;
    }
    return false;
  }

  if (matchesKey(data, Key.down)) {
    if (state.selectedIndex < flatEntries.length - 1) {
      state.selectedIndex++;
      return true;
    }
    return false;
  }

  if (data === "I") {
    state.promptExpanded = !state.promptExpanded;
    return true;
  }

  // Actions with confirm (overlay mode supports stacking)
  if (data === "x") {
    if (terminal) { ctx.ui.notify(`Workflow already ${instance.status}`, "warning"); return false; }
    void ctx.ui.confirm("Stop this workflow?", `${instance.name} (${runId.slice(0, 8)}...)`).then((ok) => {
      if (!ok) return;
      void orchestrator.abort(runId)
        .then(() => ctx.ui.notify("Workflow aborted", "info"))
        .catch((err: Error) => ctx.ui.notify(`Abort failed: ${err.message}`, "error"));
    });
    return false;
  }

  if (data === "p") {
    if (terminal) { ctx.ui.notify(`Workflow already ${instance.status}`, "warning"); return false; }
    const action = instance.status === "running" ? "pause" : "resume";
    void ctx.ui.confirm(`${action === "pause" ? "Pause" : "Resume"} this workflow?`, `${instance.name}`).then((ok) => {
      if (!ok) return;
      const op = action === "pause" ? orchestrator.pause(runId) : orchestrator.resume(runId);
      void op
        .then(() => ctx.ui.notify(`Workflow ${action}d`, "info"))
        .catch((err: Error) => ctx.ui.notify(`${action} failed: ${err.message}`, "error"));
    });
    return false;
  }

  if (data === "r") {
    if (terminal) { ctx.ui.notify(`Workflow already ${instance.status}`, "warning"); return false; }
    void ctx.ui.confirm("Restart from scratch?", `This will start a new run of '${instance.name}'`).then((ok) => {
      if (!ok) return;
      void orchestrator.run(instance.name, {}, instance.budget.maxTokens, instance.budget.maxTimeMs)
        .then((newRunId) => ctx.ui.notify(`Restarted → ${newRunId.slice(0, 8)}...`, "info"))
        .catch((err: Error) => ctx.ui.notify(`Restart failed: ${err.message}`, "error"));
    });
    return false;
  }

  if (data === "s") {
    saveTraceToFile(instance, ctx);
    return false;
  }

  return false;
}

// ── Save trace to file ────────────────────────────────────────

function saveTraceToFile(instance: WorkflowInstance, ctx: ExtensionContext): void {
  const dir = path.join(os.homedir(), ".pi", "agent", "workflow-traces");
  const filePath = path.join(dir, `${instance.runId}.md`);

  const lines: string[] = [];
  lines.push(`# Workflow Trace: ${instance.name} (${instance.runId})`, "");
  lines.push(`Status: ${instance.status} | Started: ${instance.startedAt ?? "-"} | Duration: ${formatElapsed(instance.startedAt)}`);
  lines.push(`Budget: ${instance.budget.usedTokens}/${instance.budget.maxTokens ?? "unlimited"} tokens, $${instance.budget.usedCost.toFixed(4)}`, "");

  const phaseMap = groupByPhase(instance.trace);
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

  // ── Header ──
  const completed = instance.trace.filter((n) => n.status === "completed").length;
  const total = instance.trace.length;
  const elapsed = formatElapsed(instance.startedAt);
  const statusTag = isTerminalStatus(instance.status) ? " · done" : "";
  const headerRight = `${completed}/${total} agents · ${elapsed}${statusTag}`;

  const nameLine = theme.bold(instance.name);
  const rightPart = theme.fg("muted", headerRight);
  const padLen = Math.max(0, width - visibleLen(nameLine) - visibleLen(rightPart) - 1);
  lines.push(nameLine + " ".repeat(padLen) + rightPart);

  if (instance.description) {
    const maxDesc = width - 2;
    const descText = instance.description.length > maxDesc
      ? instance.description.slice(0, maxDesc - 1) + ELLIPSIS
      : instance.description;
    lines.push(theme.fg("dim", descText));
  } else if (instance.error) {
    lines.push(theme.fg("error", instance.error.slice(0, width - 2)));
  }
  lines.push("─".repeat(width));

  // ── Body: sidebar + main area ──
  const phaseMap = groupByPhase(instance.trace);
  const flatEntries = buildFlatEntries(phaseMap);

  // Resolve selected entry
  const selectedEntry = flatEntries[selectedIndex];

  // Sidebar
  const sidebarLines: string[] = [theme.fg("muted", theme.bold("Phases"))];
  for (const entry of flatEntries) {
    const isSelected = entry.index === selectedIndex;
    const pointer = isSelected ? "❯ " : "  ";
    if (entry.type === "phase") {
      const phaseNodes = phaseMap.get(entry.phase!) ?? [];
      const doneCount = phaseNodes.filter((n) => n.status === "completed").length;
      const label = entry.phase!.slice(0, 12);
      const count = `${doneCount}/${phaseNodes.length}`;
      sidebarLines.push(pointer + label + " " + count);
    } else if (entry.node) {
      // Agent node: show status dot + agent name, with selection highlight
      sidebarLines.push(pointer + formatSidebarNode(entry.node, isSelected, SIDEBAR_WIDTH - 2, theme).trimStart());
    }
  }

  // Main area
  const mainWidth = width - SIDEBAR_WIDTH - 1;
  const mainLines: string[] = [];

  if (selectedEntry?.type === "phase") {
    // Phase selected: show all agents in this phase
    const phaseName = selectedEntry.phase!;
    const nodes = phaseMap.get(phaseName) ?? [];
    mainLines.push(theme.fg("accent", theme.bold(phaseName)), "");
    mainLines.push(theme.fg("muted", `${nodes.length} agent(s) in this phase`), "");

    for (const node of nodes) {
      const dot = statusDotStr(node.status, theme);
      mainLines.push(`  ${dot} ${node.agent} · ${node.model}`);
      mainLines.push(theme.fg("dim", `    ${formatTokenStat(node.result?.usage, node.result?.toolCalls)}`));
    }
  } else if (selectedEntry?.type === "node" && selectedEntry.node) {
    const node = selectedEntry.node;
    const phaseName = node.phase || "(default)";
    const phaseNodes = phaseMap.get(phaseName) ?? [];

    mainLines.push(theme.fg("accent", `${phaseName} · ${phaseNodes.length} agent`), "");
    mainLines.push(theme.bold(node.agent));
    mainLines.push(`${statusDotStr(node.status, theme)} ${node.status} · ${node.model}`);
    mainLines.push(theme.fg("dim", formatTokenStat(
      node.result?.usage,
      node.result?.toolCalls,
    )));
    mainLines.push("");

    // Prompt section
    const taskLines = node.task.split("\n");
    const lineCount = taskLines.length;
    mainLines.push(theme.fg("muted", `Prompt · ${lineCount} lines · I ${promptExpanded ? "collapse" : "expand"}`));
    if (promptExpanded || lineCount <= PROMPT_FOLD_LINES) {
      mainLines.push(...taskLines.map((l) => `  ${l}`));
    } else {
      mainLines.push(...taskLines.slice(0, PROMPT_FOLD_LINES).map((l) => `  ${l}`));
      mainLines.push(theme.fg("dim", `  ${ELLIPSIS} ${lineCount - PROMPT_FOLD_LINES} more lines`));
    }
    mainLines.push("");

    // Activity section
    const toolCalls = node.result?.toolCalls;
    mainLines.push(theme.fg("muted", "Activity"));
    if (toolCalls && toolCalls.length > 0) {
      for (const tc of toolCalls) mainLines.push(`  ${formatActivityLine(tc, mainWidth - 2)}`);
    } else {
      mainLines.push(theme.fg("dim", `  ${node.status === "running" ? "(no tool calls yet)" : "(no activity recorded)"}`));
    }
    mainLines.push("");

    // Outcome section
    mainLines.push(theme.fg("muted", "Outcome"));
    if (node.status === "running") {
      mainLines.push(theme.fg("dim", "  Still running..."));
    } else if (node.result?.error) {
      mainLines.push(theme.fg("error", `  ${node.result.error.slice(0, 200)}`));
    } else if (node.result?.content) {
      let content = node.result.content;
      if (content.length > OUTPUT_TRUNCATE_BYTES) {
        content = content.slice(0, OUTPUT_TRUNCATE_BYTES) + `\n${ELLIPSIS} (truncated)`;
      }
      mainLines.push(...content.split("\n").slice(0, 20).map((l) => `  ${l}`));
    }
  } else {
    mainLines.push(theme.fg("muted", "No items to display"));
  }

  // Combine sidebar + main
  const bodyHeight = Math.max(sidebarLines.length, mainLines.length);
  for (let i = 0; i < bodyHeight; i++) {
    const left = padVisible(sidebarLines[i] ?? "", SIDEBAR_WIDTH);
    lines.push(left + "│" + (mainLines[i] ?? ""));
  }

  // ── Footer ──
  lines.push("─".repeat(width));
  lines.push(theme.fg("muted", "↑↓ navigate · I expand prompt · x stop · r restart · p pause · s save · esc back"));

  return lines;
}
