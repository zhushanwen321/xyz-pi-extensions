/**
 * Workflow Fullscreen TUI View — Single-level, agent-centric.
 *
 * Left sidebar: phase headers (non-selectable) + agent list (selectable)
 * Right panel: selected agent execution detail
 *
 * Keys: ↑↓ navigate agents · ⏎ expand prompt · esc back · s save
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, Key } from "@mariozechner/pi-tui";

import type { WorkflowOrchestrator } from "../orchestrator.js";
import type { WorkflowInstance } from "../state.js";

import {
  type PhaseGroup,
  type ThemeLike,
  buildPhaseGroups,
  ELLIPSIS,
  formatActivityLine,
  formatElapsed,
  formatTokenStat,
  isTerminalStatus,
  OUTPUT_TRUNCATE_BYTES,
  padVisible,
  PROMPT_FOLD_LINES,
  SIDEBAR_WIDTH,
  statusDotStr,
  visibleLen,
} from "./format.js";

const MAX_TOOL_CALLS_DISPLAY = 3;

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

    // Find first selectable agent entry
    const initPhases = buildPhaseGroups(instance.trace);
    const initEntries = buildSidebar(initPhases);
    const firstAgent = initEntries.findIndex((e) => e.type === "agent");

    const state = {
      selectedIdx: firstAgent >= 0 ? firstAgent : 0,
      promptExpanded: false,
      disposed: false,
    };
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
      invalidate(): void { cache.width = undefined; cache.lines = undefined; },
      render(width: number): string[] {
        if (cache.lines && cache.width === width) return cache.lines;
        const inst = orchestrator.getInstance(runId);
        const raw = inst ? renderView(inst, theme, width, state) : ["(workflow not found)"];
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
        if (processKey(data, orchestrator, runId, state, ctx, wrappedDone)) {
          cache.width = undefined;
          cache.lines = undefined;
          requestRender();
        }
      },
    };

    return component;
  }, {
    overlay: true,
    overlayOptions: { anchor: "center" as const, width: "100%", maxHeight: "100%", margin: 0 },
  });
}

// ── Build sidebar entries: phase headers + agent nodes ────────

interface SidebarEntry {
  type: "phase" | "agent";
  phaseGroup?: PhaseGroup;
  node?: import("../state.js").ExecutionTraceNode;
}

function buildSidebar(phases: PhaseGroup[]): SidebarEntry[] {
  const entries: SidebarEntry[] = [];
  for (const pg of phases) {
    // Only add phase header when name is non-empty (skip fallback)
    if (pg.name) {
      entries.push({ type: "phase", phaseGroup: pg });
    }
    for (const node of pg.nodes) {
      entries.push({ type: "agent", node });
    }
  }
  return entries;
}

/** Find next agent entry index in direction (+1 or -1). */
function findNextAgent(entries: SidebarEntry[], from: number, dir: number): number {
  let i = from + dir;
  while (i >= 0 && i < entries.length) {
    if (entries[i].type === "agent") return i;
    i += dir;
  }
  return from;
}

// ── Keyboard ──────────────────────────────────────────────────

function processKey(
  data: string,
  orchestrator: WorkflowOrchestrator,
  runId: string,
  state: { selectedIdx: number; promptExpanded: boolean; disposed: boolean },
  ctx: ExtensionContext,
  done: () => void,
): boolean {
  const instance = orchestrator.getInstance(runId);
  if (!instance) return false;

  if (matchesKey(data, Key.escape)) { done(); return false; }

  if (matchesKey(data, Key.up)) {
    const phases = buildPhaseGroups(instance.trace);
    const entries = buildSidebar(phases);
    const next = findNextAgent(entries, state.selectedIdx, -1);
    if (next !== state.selectedIdx) { state.selectedIdx = next; return true; }
    return false;
  }

  if (matchesKey(data, Key.down)) {
    const phases = buildPhaseGroups(instance.trace);
    const entries = buildSidebar(phases);
    const next = findNextAgent(entries, state.selectedIdx, 1);
    if (next !== state.selectedIdx) { state.selectedIdx = next; return true; }
    return false;
  }

  if (data === "\r" || data === "\n" || data === "I") {
    state.promptExpanded = !state.promptExpanded;
    return true;
  }

  if (data === "s") {
    saveTraceToFile(instance, ctx);
    return false;
  }

  return false;
}

// ── Save trace ────────────────────────────────────────────────

function saveTraceToFile(instance: WorkflowInstance, ctx: ExtensionContext): void {
  const dir = path.join(os.homedir(), ".pi", "agent", "workflow-traces");
  const filePath = path.join(dir, `${instance.runId}.md`);
  const lines: string[] = [];
  lines.push(`# Workflow Trace: ${instance.name} (${instance.runId})`, "");
  lines.push(`Status: ${instance.status} | Started: ${instance.startedAt ?? "-"} | Duration: ${formatElapsed(instance.startedAt)}`);
  lines.push(`Budget: ${instance.budget.usedTokens}/${instance.budget.maxTokens ?? "unlimited"} tokens, $${instance.budget.usedCost.toFixed(4)}`, "");
  const phases = buildPhaseGroups(instance.trace);
  for (const pg of phases) {
    lines.push(`## Phase: ${pg.name}`, "");
    for (const node of pg.nodes) {
      lines.push(`### [#${node.stepIndex}] ${node.agent} — ${node.status}`);
      lines.push(`- Model: ${node.model}`);
      const dur = formatElapsed(node.startedAt, node.completedAt ? new Date(node.completedAt).getTime() : Date.now());
      lines.push(`- Duration: ${dur}`, "");
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

// ── Render ────────────────────────────────────────────────────

function renderView(
  instance: WorkflowInstance,
  theme: ThemeLike,
  width: number,
  state: { selectedIdx: number; promptExpanded: boolean },
): string[] {
  const lines: string[] = [];
  const phases = buildPhaseGroups(instance.trace);
  const entries = buildSidebar(phases);

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

  // ── Body: sidebar + detail ──
  const selectedNode = entries[state.selectedIdx]?.node;
  const leftLines: string[] = [];
  const rightLines: string[] = [];
  const mainWidth = width - SIDEBAR_WIDTH - 1;

  // Left sidebar
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === "phase") {
      const pg = entry.phaseGroup!;
      const dot = statusDotStr(pg.doneCount === pg.nodes.length ? "completed" : "running", theme);
      leftLines.push(`  ${dot} ${pg.name} ${pg.doneCount}/${pg.nodes.length}`);
    } else {
      const isSelected = i === state.selectedIdx;
      const pointer = isSelected ? "❯ " : "  ";
      const dot = statusDotStr(entry.node!.status, theme);
      const label = entry.node!.agent;
      leftLines.push(`${pointer}${dot} ${label}`);
    }
  }

  // Right panel: selected agent detail
  if (selectedNode) {
    rightLines.push(`${statusDotStr(selectedNode.status, theme)} ${selectedNode.status} · ${selectedNode.model}`);
    rightLines.push(theme.fg("dim", formatTokenStat(selectedNode.result?.usage, selectedNode.result?.toolCalls)));
    rightLines.push("");

    // Prompt
    const taskLines = selectedNode.task.split("\n");
    const lineCount = taskLines.length;
    rightLines.push(theme.fg("muted", `Prompt · ${lineCount} lines · ⏎ ${state.promptExpanded ? "collapse" : "expand"}`));
    if (state.promptExpanded || lineCount <= PROMPT_FOLD_LINES) {
      rightLines.push(...taskLines.map((l) => `  ${l}`));
    } else {
      rightLines.push(...taskLines.slice(0, PROMPT_FOLD_LINES).map((l) => `  ${l}`));
      rightLines.push(theme.fg("dim", `  ${ELLIPSIS} ${lineCount - PROMPT_FOLD_LINES} more lines`));
    }
    rightLines.push("");

    // Activity
    const toolCalls = selectedNode.result?.toolCalls ?? [];
    const totalCount = toolCalls.length;
    if (totalCount > 0) {
      const showCount = Math.min(MAX_TOOL_CALLS_DISPLAY, totalCount);
      const isTruncated = totalCount > MAX_TOOL_CALLS_DISPLAY;
      const label = isTruncated
        ? `Activity · last ${showCount} of ${totalCount} tool calls`
        : `Activity · ${totalCount} tool call${totalCount !== 1 ? "s" : ""}`;
      rightLines.push(theme.fg("muted", label));
      const start = totalCount - showCount;
      for (let i = start; i < totalCount; i++) {
        rightLines.push(`  ${formatActivityLine(toolCalls[i], mainWidth - 2)}`);
      }
    } else {
      rightLines.push(theme.fg("muted", "Activity"));
      rightLines.push(theme.fg("dim", `  ${selectedNode.status === "running" ? "(no tool calls yet)" : "(no activity recorded)"}`));
    }
    rightLines.push("");

    // Outcome
    rightLines.push(theme.fg("muted", "Outcome"));
    if (selectedNode.status === "running") {
      rightLines.push(theme.fg("dim", "  Still running..."));
    } else if (selectedNode.result?.error) {
      rightLines.push(theme.fg("error", `  ${selectedNode.result.error.slice(0, mainWidth - 4)}`));
    } else if (selectedNode.result?.content) {
      let content = selectedNode.result.content;
      if (content.length > OUTPUT_TRUNCATE_BYTES) {
        content = content.slice(0, OUTPUT_TRUNCATE_BYTES) + `\n${ELLIPSIS} (truncated)`;
      }
      rightLines.push(...content.split("\n").slice(0, 20).map((l) => `  ${l}`));
    }
  } else {
    rightLines.push(theme.fg("muted", "Select an agent to view details"));
  }

  // Merge
  const bodyHeight = Math.max(leftLines.length, rightLines.length);
  for (let i = 0; i < bodyHeight; i++) {
    const left = padVisible(leftLines[i] ?? "", SIDEBAR_WIDTH);
    lines.push(left + "│" + (rightLines[i] ?? ""));
  }

  // ── Footer ──
  lines.push("─".repeat(width));
  lines.push(theme.fg("muted", "↑↓ agent · ⏎ prompt · esc back · s save"));

  return lines;
}
