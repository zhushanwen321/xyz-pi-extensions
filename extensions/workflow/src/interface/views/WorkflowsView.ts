/**
 * Workflow Fullscreen TUI View — Three-level navigation.
 *
 * Level 0 (Phase):
 *   Left = phase list, Right = agent overview in selected phase
 *   ↑↓ navigate phases · Enter drill into agent list · esc exit
 *
 * Level 1 (Agent):
 *   Left = agent list in current phase, Right = selected agent summary
 *   ↑↓ navigate agents · Enter drill into detail · esc back to phase
 *
 * Level 2 (Detail):
 *   Full agent execution detail (prompt, activity, outcome)
 *   ⏎ expand/collapse prompt · esc back to agent list · s save trace
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, Key } from "@mariozechner/pi-tui";

import type { WorkflowOrchestrator } from "../../orchestrator.js";
import type { WorkflowInstance } from "../../domain/state.js";

import {
  type PhaseGroup,
  type ThemeLike,
  buildPhaseGroups,
  ELLIPSIS,
  formatActivityLine,
  formatElapsed,
  formatTokenStat,
  isTerminalStatus,
  padVisible,
  PROMPT_FOLD_LINES,
  SIDEBAR_WIDTH,
  statusDotStr,
  visibleLen,
} from "./format.js";

const MAX_TOOL_CALLS_DISPLAY = 3;

// ── View state ────────────────────────────────────────────────

interface ViewState {
  level: 0 | 1 | 2;
  phaseIdx: number;
  agentIdx: number;
  promptExpanded: boolean;
  disposed: boolean;
}

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

    const phases = buildPhaseGroups(instance.trace);
    // Skip level 0 when only 1 phase — go directly to agent list
    const initialState: ViewState = {
      level: phases.length > 1 ? 0 : 1,
      phaseIdx: 0,
      agentIdx: 0,
      promptExpanded: false,
      disposed: false,
    };
    const state = initialState;

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

// ── Keyboard ──────────────────────────────────────────────────

function processKey(
  data: string,
  orchestrator: WorkflowOrchestrator,
  runId: string,
  state: ViewState,
  ctx: ExtensionContext,
  done: () => void,
): boolean {
  const instance = orchestrator.getInstance(runId);
  if (!instance) return false;
  const phases = buildPhaseGroups(instance.trace);
  if (phases.length === 0) return false;

  // Escape: level back or exit
  if (matchesKey(data, Key.escape)) {
    if (state.level === 0) { done(); return false; }
    state.level = (state.level - 1) as 0 | 1 | 2;
    return true;
  }

  // Level 2 (Detail)
  if (state.level === 2) {
    // ↑↓ navigate agents within current phase
    if (matchesKey(data, Key.up)) {
      if (state.agentIdx > 0) { state.agentIdx--; state.promptExpanded = false; return true; }
      return false;
    }
    if (matchesKey(data, Key.down)) {
      const agents = phases[state.phaseIdx]?.nodes ?? [];
      if (state.agentIdx < agents.length - 1) { state.agentIdx++; state.promptExpanded = false; return true; }
      return false;
    }
    if (data === "\r" || data === "\n" || data === "I") {
      state.promptExpanded = !state.promptExpanded;
      return true;
    }
    if (data === "p") { handlePauseResume(orchestrator, runId, instance, ctx); return false; }
    if (data === "s") { saveTraceToFile(instance, ctx); return false; }
    return false;
  }

  // Level 0 & 1: up/down navigation
  if (matchesKey(data, Key.up)) {
    if (state.level === 0 && state.phaseIdx > 0) {
      state.phaseIdx--;
      state.agentIdx = 0;
      return true;
    }
    if (state.level === 1 && state.agentIdx > 0) {
      state.agentIdx--;
      return true;
    }
    return false;
  }

  if (matchesKey(data, Key.down)) {
    if (state.level === 0 && state.phaseIdx < phases.length - 1) {
      state.phaseIdx++;
      state.agentIdx = 0;
      return true;
    }
    if (state.level === 1) {
      const agents = phases[state.phaseIdx]?.nodes ?? [];
      if (state.agentIdx < agents.length - 1) { state.agentIdx++; return true; }
    }
    return false;
  }

  // Enter: drill down
  if (data === "\r" || data === "\n") {
    if (state.level === 0) {
      const agents = phases[state.phaseIdx]?.nodes ?? [];
      if (agents.length > 0) { state.level = 1; state.agentIdx = 0; return true; }
    } else if (state.level === 1) {
      state.level = 2;
      state.promptExpanded = false;
      return true;
    }
    return false;
  }

  return false;
}

// ── Save trace ────────────────────────────────────────────────

function handlePauseResume(
  orchestrator: WorkflowOrchestrator,
  runId: string,
  instance: WorkflowInstance,
  ctx: ExtensionContext,
): void {
  if (isTerminalStatus(instance.status)) {
    ctx.ui.notify(`Workflow already ${instance.status}`, "warning");
    return;
  }
  const action = instance.status === "running" ? "pause" : "resume";
  void (action === "pause" ? orchestrator.pause(runId) : orchestrator.resume(runId))
    .then(() => ctx.ui.notify(`Workflow ${action}d`, "info"))
    .catch((err: Error) => ctx.ui.notify(`${action} failed: ${err.message}`, "error"));
}

function saveTraceToFile(instance: WorkflowInstance, ctx: ExtensionContext): void {
  const dir = path.join(os.homedir(), ".pi", "agent", "workflow-traces");
  const filePath = path.join(dir, `${instance.runId}.md`);
  const lines: string[] = [];
  lines.push(`# Workflow Trace: ${instance.name} (${instance.runId})`, "");
  lines.push(`Status: ${instance.status} | Started: ${instance.startedAt ?? "-"} | Duration: ${formatElapsed(instance.startedAt)}`);
  lines.push(`Budget: ${instance.budget.usedTokens}/${instance.budget.maxTokens ?? "unlimited"} tokens, $${instance.budget.usedCost.toFixed(4)}`, "");
  const phases = buildPhaseGroups(instance.trace);
  for (const pg of phases) {
    lines.push(`## Phase: ${pg.name || "(unnamed)"}`, "");
    for (const node of pg.nodes) {
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

// ── Render ────────────────────────────────────────────────────

function renderView(
  instance: WorkflowInstance,
  theme: ThemeLike,
  width: number,
  state: ViewState,
): string[] {
  const lines: string[] = [];
  const phases = buildPhaseGroups(instance.trace);
  if (phases.length === 0) return ["(no agents)"];

  // ── Header ──
  const completed = instance.trace.filter((n) => n.status === "completed").length;
  const total = instance.trace.length;
  const elapsed = formatElapsed(instance.startedAt);
  const statusTag = isTerminalStatus(instance.status) ? " · done" : "";
  const headerRight = `${completed}/${total} agents · ${elapsed}${statusTag}`;

  const nameLine = theme.bold(instance.name);
  const rightPart = theme.fg("muted", headerRight);
  lines.push(nameLine);

  // FR-2.2: line 2 = description + stats (right-aligned)
  // When no description, just show stats
  if (instance.description) {
    const maxDesc = width - visibleLen(rightPart) - 2;
    const descText = instance.description.length > maxDesc
      ? instance.description.slice(0, maxDesc - 1) + ELLIPSIS
      : instance.description;
    const descPart = theme.fg("dim", descText);
    const padLen = Math.max(0, width - visibleLen(descPart) - visibleLen(rightPart) - 1);
    lines.push(descPart + " ".repeat(padLen) + rightPart);
  } else {
    lines.push(rightPart);
  }
  lines.push("─".repeat(width));

  // ── Body ──
  const phase = phases[state.phaseIdx] ?? phases[0];
  const agents = phase.nodes;
  const mainWidth = width - SIDEBAR_WIDTH - 1;

  if (state.level === 0) {
    renderLevel0(lines, phases, state, theme, width, mainWidth);
  } else if (state.level === 1) {
    renderLevel1(lines, phases, agents, state, theme, width, mainWidth);
  } else {
    renderLevel2(lines, phase, agents, state, theme, width, mainWidth);
  }

  // ── Footer ──
  lines.push("─".repeat(width));
  const footer = state.level === 0
    ? "↑↓ phase · ⏎ enter · esc back"
    : state.level === 1
      ? "↑↓ agent · ⏎ detail · esc back"
      : "↑↓ agent · ⏎ prompt · p pause · s save · esc back";
  lines.push(theme.fg("muted", footer));

  return lines;
}

// ── Level 0: Phase selection ──────────────────────────────────

function renderLevel0(
  lines: string[],
  phases: PhaseGroup[],
  state: ViewState,
  theme: ThemeLike,
  width: number,
  _mainWidth: number,
): void {
  const leftLines: string[] = [];
  const rightLines: string[] = [];

  // Left: phase list
  for (let i = 0; i < phases.length; i++) {
    const pg = phases[i];
    const isSelected = i === state.phaseIdx;
    const pointer = isSelected ? "❯ " : "  ";
    const dot = statusDotStr(pg.doneCount === pg.nodes.length ? "completed" : "running", theme);
    leftLines.push(`${pointer}${dot} ${pg.name} ${pg.doneCount}/${pg.nodes.length}`);
  }

  // Right: context title + all agents across all phases
  const phase = phases[state.phaseIdx];
  if (phase) {
    const title = phase.name ? `${phase.name} · ${phase.nodes.length} agents` : `${phase.nodes.length} agents`;
    rightLines.push(theme.fg("muted", title));
  }
  for (const pg of phases) {
    for (const node of pg.nodes) {
      const dot = statusDotStr(node.status, theme);
      const elapsed = formatElapsed(
        node.startedAt,
        node.completedAt ? new Date(node.completedAt).getTime() : Date.now(),
      );
      const tok = node.result?.usage;
      const tokStr = tok ? `${Math.round((tok.input + tok.output) / 1000)}k tok` : "";
      const tcCount = node.result?.toolCalls?.length ?? 0;
      rightLines.push(`  ${dot} ${node.agent}    ${node.model}    ${tokStr} · ${tcCount} tools · ${elapsed}`);
    }
  }

  mergeBody(lines, leftLines, rightLines, width);
}

// ── Level 1: Agent selection ──────────────────────────────────

function renderLevel1(
  lines: string[],
  phases: PhaseGroup[],
  agents: import("../../domain/state.js").ExecutionTraceNode[],
  state: ViewState,
  theme: ThemeLike,
  width: number,
  _mainWidth: number,
): void {
  const leftLines: string[] = [];
  const rightLines: string[] = [];

  // Left: phase list (same as level 0, for context)
  for (let i = 0; i < phases.length; i++) {
    const pg = phases[i];
    const isSelected = i === state.phaseIdx;
    const pointer = isSelected ? "❯ " : "  ";
    const dot = statusDotStr(pg.doneCount === pg.nodes.length ? "completed" : "running", theme);
    leftLines.push(`${pointer}${dot} ${pg.name} ${pg.doneCount}/${pg.nodes.length}`);
  }

  // Right: context title + agent list for current phase
  const currentPhase = phases[state.phaseIdx];
  if (currentPhase) {
    const title = currentPhase.name ? `${currentPhase.name} · ${currentPhase.nodes.length} agents` : `${currentPhase.nodes.length} agents`;
    rightLines.push(theme.fg("muted", title));
  }
  for (let i = 0; i < agents.length; i++) {
    const node = agents[i];
    const isSelected = i === state.agentIdx;
    const pointer = isSelected ? "❯ " : "  ";
    const dot = statusDotStr(node.status, theme);
    const elapsed = formatElapsed(
      node.startedAt,
      node.completedAt ? new Date(node.completedAt).getTime() : Date.now(),
    );
    const tok = node.result?.usage;
    const tokStr = tok ? `${Math.round((tok.input + tok.output) / 1000)}k tok` : "";
    const tcCount = node.result?.toolCalls?.length ?? 0;
    rightLines.push(`${pointer}${dot} ${node.agent}    ${node.model}    ${tokStr} · ${tcCount} tools · ${elapsed}`);
  }

  mergeBody(lines, leftLines, rightLines, width);
}

// ── Level 2: Execution detail ─────────────────────────────────

function renderLevel2(
  lines: string[],
  phase: PhaseGroup,
  agents: import("../../domain/state.js").ExecutionTraceNode[],
  state: ViewState,
  theme: ThemeLike,
  width: number,
  mainWidth: number,
): void {
  const leftLines: string[] = [];
  const rightLines: string[] = [];

  // Left: agent list with full info (model + tok + tools + time)
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    const isSelected = i === state.agentIdx;
    const pointer = isSelected ? "❯ " : "  ";
    const dot = statusDotStr(a.status, theme);
    const elapsed = formatElapsed(
      a.startedAt,
      a.completedAt ? new Date(a.completedAt).getTime() : Date.now(),
    );
    const tok = a.result?.usage;
    const tokStr = tok ? `${Math.round((tok.input + tok.output) / 1000)}k` : "";
    const tcCount = a.result?.toolCalls?.length ?? 0;
    const parts = [`${pointer}${dot} ${a.agent}`];
    if (tokStr) parts.push(`${tokStr} · ${tcCount}t`);
    parts.push(elapsed);
    leftLines.push(parts.join(" "));
  }

  // Right: full detail
  const node = agents[state.agentIdx];
  if (node) {
    // FR-4.1: 2 lines — status + model, then stats + elapsed
    const elapsed = formatElapsed(
      node.startedAt,
      node.completedAt ? new Date(node.completedAt).getTime() : Date.now(),
    );
    rightLines.push(`${statusDotStr(node.status, theme)} ${node.status} · ${node.model}`);
    rightLines.push(theme.fg("dim", formatTokenStat(node.result?.usage, node.result?.toolCalls, elapsed)));
    rightLines.push("");

    // Prompt
    const taskLines = node.task.split("\n");
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
    const toolCalls = node.result?.toolCalls ?? [];
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
      rightLines.push(theme.fg("dim", `  ${node.status === "running" ? "(no tool calls yet)" : "(no activity recorded)"}`));
    }
    rightLines.push("");

    // Outcome: show last meaningful text output
    rightLines.push(theme.fg("muted", "Outcome"));
    if (node.status === "running") {
      rightLines.push(theme.fg("dim", "  Still running..."));
    } else if (node.result?.error) {
      rightLines.push(theme.fg("error", `  ${node.result.error.slice(0, mainWidth - 4)}`));
    } else if (node.result?.content) {
      const allLines = node.result.content.split("\n");
      // Show last 5 lines of output
      const tail = allLines.slice(-5);
      rightLines.push(...tail.map((l) => `  ${l.slice(0, mainWidth - 4)}`));
    }
  }

  mergeBody(lines, leftLines, rightLines, width);
}

// ── Helpers ───────────────────────────────────────────────────

function mergeBody(
  lines: string[],
  leftLines: string[],
  rightLines: string[],
  _width: number,
): void {
  const bodyHeight = Math.max(leftLines.length, rightLines.length);
  for (let i = 0; i < bodyHeight; i++) {
    const left = padVisible(leftLines[i] ?? "", SIDEBAR_WIDTH);
    lines.push(left + "│" + (rightLines[i] ?? ""));
  }
}
