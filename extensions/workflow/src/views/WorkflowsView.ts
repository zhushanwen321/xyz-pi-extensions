/**
 * Workflow Fullscreen TUI View (FR-1 through FR-8)
 *
 * Uses ctx.ui.custom() with overlay mode to render a fullscreen panel
 * on top of the existing UI. Overlay mode allows stacking confirms
 * (x/p/r keys) and properly covers the terminal screen.
 *
 * The factory receives (tui, theme, keybindings, done) and returns a
 * component object implementing render/handleInput/invalidate.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, Key } from "@mariozechner/pi-tui";

import type { WorkflowOrchestrator } from "../orchestrator.js";
import type { WorkflowInstance } from "../state.js";

import {
  type FlatEntry,
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
    // Cached render output — invalidated on state change or theme change
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
        // Pad to full terminal height so overlay covers entire screen
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

// ── Keyboard handler (returns true if re-render needed) ───────

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

  if (matchesKey(data, Key.escape)) {
    done();
    return false;
  }

  if (matchesKey(data, Key.up)) {
    if (flatEntries.length === 0) return false;
    for (let i = state.selectedIndex - 1; i >= 0; i--) {
      if (flatEntries[i].type === "node") { state.selectedIndex = i; return true; }
    }
    return false;
  }

  if (matchesKey(data, Key.down)) {
    if (flatEntries.length === 0) return false;
    for (let i = state.selectedIndex + 1; i < flatEntries.length; i++) {
      if (flatEntries[i].type === "node") { state.selectedIndex = i; return true; }
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

  const phaseMap = groupByPhase(instance.trace);
  const flatEntries = buildFlatEntries(phaseMap);

  let selectedNode: FlatEntry["node"] = undefined;
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
      selectedNode.result?.usage,
      selectedNode.result?.toolCalls,
    )));
    mainLines.push("");

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

    const toolCalls = selectedNode.result?.toolCalls;
    mainLines.push(theme.fg("muted", "Activity"));
    if (toolCalls && toolCalls.length > 0) {
      for (const tc of toolCalls) mainLines.push(`  ${formatActivityLine(tc, mainWidth - 2)}`);
    } else {
      mainLines.push(theme.fg("dim", `  ${selectedNode.status === "running" ? "(no tool calls yet)" : "(no activity recorded)"}`));
    }
    mainLines.push("");

    mainLines.push(theme.fg("muted", "Outcome"));
    if (selectedNode.status === "running") {
      mainLines.push(theme.fg("dim", "  Still running..."));
    } else if (selectedNode.result?.error) {
      mainLines.push(theme.fg("error", `  ${selectedNode.result.error.slice(0, 200)}`));
    } else if (selectedNode.result?.content) {
      let content = selectedNode.result.content;
      if (content.length > OUTPUT_TRUNCATE_BYTES) {
        content = content.slice(0, OUTPUT_TRUNCATE_BYTES) + `\n${ELLIPSIS} (truncated)`;
      }
      mainLines.push(...content.split("\n").slice(0, 20).map((l) => `  ${l}`));
    }
  } else {
    mainLines.push(theme.fg("muted", "Select an agent node to view details"));
  }

  const bodyHeight = Math.max(sidebarLines.length, mainLines.length);
  for (let i = 0; i < bodyHeight; i++) {
    const left = padVisible(sidebarLines[i] ?? "", SIDEBAR_WIDTH);
    lines.push(left + "│" + (mainLines[i] ?? ""));
  }

  lines.push("─".repeat(width));
  const footer = selectedNode
    ? "↑↓ agent · 👉 prompt · x stop · r restart · p pause · esc back · s save"
    : "↑↓ select · x stop workflow · p pause · esc back · s save";
  lines.push(theme.fg("muted", footer));

  return lines;
}
