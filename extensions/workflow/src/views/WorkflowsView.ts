/**
 * Workflow Fullscreen TUI View — Two-level navigation model.
 *
 * Overview mode:
 *   Left sidebar = phase list, Right panel = agent list in selected phase
 *   ↑↓ navigate left panel, Tab/→ focus right panel, ↑↓ navigate agents
 *   Enter drills into agent detail
 *
 * Detail mode:
 *   Left sidebar = agent list (was right panel), Right panel = agent execution detail
 *   ↑↓ navigate agents, Escape/← returns to overview
 *
 * Overlay mode renders on top of existing UI. Confirm dialogs stack on overlay.
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
  formatAgentOneLiner,
  formatElapsed,
  formatTokenStat,
  isTerminalStatus,
  OUTPUT_TRUNCATE_BYTES,
  padVisible,
  PROMPT_FOLD_LINES,
  renderBottomBorder,
  renderTopBorder,
  SIDEBAR_WIDTH,
  statusDotStr,
  visibleLen,
} from "./format.js";

/** Max tool calls to display in detail view. */
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

    const state = {
      mode: "overview" as "overview" | "detail",
      focusPanel: "left" as "left" | "right",
      phaseIdx: 0,
      agentIdx: 0,
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
        const raw = inst
          ? renderView(inst, theme, width, state)
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
        const reRender = processKeyInput(data, orchestrator, runId, state, ctx, wrappedDone);
        if (reRender) { cache.width = undefined; cache.lines = undefined; requestRender(); }
      },
    };

    return component;
  }, {
    overlay: true,
    overlayOptions: { anchor: "center" as const, width: "100%", maxHeight: "100%", margin: 0 },
  });
}

// ── Keyboard handler ──────────────────────────────────────────

function processKeyInput(
  data: string,
  orchestrator: WorkflowOrchestrator,
  runId: string,
  state: {
    mode: "overview" | "detail";
    focusPanel: "left" | "right";
    phaseIdx: number;
    agentIdx: number;
    promptExpanded: boolean;
    disposed: boolean;
  },
  ctx: ExtensionContext,
  done: () => void,
): boolean {
  const instance = orchestrator.getInstance(runId);
  if (!instance) return false;
  const phases = buildPhaseGroups(instance.trace);
  if (phases.length === 0) return false;

  if (matchesKey(data, Key.escape)) {
    if (state.mode === "detail") {
      state.mode = "overview";
      state.focusPanel = "right";
      return true;
    }
    done();
    return false;
  }

  // ── Detail mode ──
  if (state.mode === "detail") {
    const agents = phases[state.phaseIdx]?.nodes ?? [];
    if (matchesKey(data, Key.up)) {
      if (state.agentIdx > 0) { state.agentIdx--; return true; }
      return false;
    }
    if (matchesKey(data, Key.down)) {
      if (state.agentIdx < agents.length - 1) { state.agentIdx++; return true; }
      return false;
    }
    if (data === "I") { state.promptExpanded = !state.promptExpanded; return true; }
    return handleActionKeys(data, orchestrator, runId, instance, ctx);
  }

  // ── Overview mode ──
  // Tab / → / ← switch panel focus
  if (data === "\t" || matchesKey(data, Key.right) || matchesKey(data, Key.left)) {
    if (state.focusPanel === "left") {
      const agents = phases[state.phaseIdx]?.nodes ?? [];
      if (agents.length > 0) { state.focusPanel = "right"; return true; }
    } else {
      state.focusPanel = "left";
      return true;
    }
    return false;
  }

  // Enter: drill into agent detail
  if (data === "\r" || data === "\n") {
    if (state.focusPanel === "right") {
      state.mode = "detail";
      return true;
    }
    return false;
  }

  // Navigation
  if (state.focusPanel === "left") {
    if (matchesKey(data, Key.up)) {
      if (state.phaseIdx > 0) {
        state.phaseIdx--;
        state.agentIdx = 0;
        return true;
      }
      return false;
    }
    if (matchesKey(data, Key.down)) {
      if (state.phaseIdx < phases.length - 1) {
        state.phaseIdx++;
        state.agentIdx = 0;
        return true;
      }
      return false;
    }
  } else {
    const agents = phases[state.phaseIdx]?.nodes ?? [];
    if (matchesKey(data, Key.up)) {
      if (state.agentIdx > 0) { state.agentIdx--; return true; }
      return false;
    }
    if (matchesKey(data, Key.down)) {
      if (state.agentIdx < agents.length - 1) { state.agentIdx++; return true; }
      return false;
    }
  }

  if (data === "I") { state.promptExpanded = !state.promptExpanded; return true; }
  return handleActionKeys(data, orchestrator, runId, instance, ctx);
}

function handleActionKeys(
  data: string,
  orchestrator: WorkflowOrchestrator,
  runId: string,
  instance: WorkflowInstance,
  ctx: ExtensionContext,
): boolean {
  const terminal = isTerminalStatus(instance.status);
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
  const phases = buildPhaseGroups(instance.trace);
  for (const pg of phases) {
    lines.push(`## Phase: ${pg.name}`, "");
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

// ── Main render ───────────────────────────────────────────────

function renderView(
  instance: WorkflowInstance,
  theme: ThemeLike,
  width: number,
  state: {
    mode: "overview" | "detail";
    focusPanel: "left" | "right";
    phaseIdx: number;
    agentIdx: number;
    promptExpanded: boolean;
  },
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

  // ── Dispatch to mode-specific renderer ──
  const bodyLines = state.mode === "overview"
    ? renderOverview(phases, state, theme, width)
    : renderDetail(phases, state, theme, width);

  lines.push(...bodyLines);

  // ── Footer ──
  lines.push(renderBottomBorder(SIDEBAR_WIDTH, width));
  const footer = state.mode === "overview"
    ? "↑↓ navigate · Tab switch panel · Enter detail · x stop · p pause · s save · esc back"
    : "↑↓ agent · I expand · x stop · p pause · s save · esc back";
  lines.push(theme.fg("muted", footer));

  return lines;
}

// ── Overview mode ─────────────────────────────────────────────

function renderOverview(
  phases: PhaseGroup[],
  state: { focusPanel: "left" | "right"; phaseIdx: number; agentIdx: number },
  theme: ThemeLike,
  width: number,
): string[] {
  const lines: string[] = [];
  const phase = phases[state.phaseIdx] ?? phases[0];
  const leftTitle = "Phases";
  const rightTitle = `${phase.name} · ${phase.nodes.length} agent${phase.nodes.length !== 1 ? "s" : ""}`;
  lines.push(renderTopBorder(leftTitle, rightTitle, SIDEBAR_WIDTH, width));

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

  // Right: agent list in selected phase
  for (let i = 0; i < phase.nodes.length; i++) {
    const node = phase.nodes[i];
    const isSelected = state.focusPanel === "right" && i === state.agentIdx;
    const pointer = isSelected ? "❯ " : "  ";
    rightLines.push(pointer + formatAgentOneLiner(node, theme));
  }

  // Merge into bordered body
  const bodyHeight = Math.max(leftLines.length, rightLines.length);
  for (let i = 0; i < bodyHeight; i++) {
    const left = padVisible(leftLines[i] ?? "", SIDEBAR_WIDTH - 1);
    lines.push(`│${left}│${rightLines[i] ?? ""}`);
  }

  return lines;
}

// ── Detail mode ───────────────────────────────────────────────

function renderDetail(
  phases: PhaseGroup[],
  state: { phaseIdx: number; agentIdx: number; promptExpanded: boolean },
  theme: ThemeLike,
  width: number,
): string[] {
  const lines: string[] = [];
  const phase = phases[state.phaseIdx] ?? phases[0];
  const agents = phase.nodes;
  const node = agents[state.agentIdx] ?? agents[0];

  const leftTitle = `${phase.name} · ${agents.length} agent${agents.length !== 1 ? "s" : ""}`;
  const rightTitle = node?.agent ?? "unknown";
  lines.push(renderTopBorder(leftTitle, rightTitle, SIDEBAR_WIDTH, width));

  const leftLines: string[] = [];
  const rightLines: string[] = [];

  // Left: agent list
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    const isSelected = i === state.agentIdx;
    const pointer = isSelected ? "❯ " : "  ";
    const dot = statusDotStr(a.status, theme);
    leftLines.push(`${pointer}${dot} ${a.agent}`);
  }

  // Right: agent execution detail
  if (node) {
    const mainWidth = width - SIDEBAR_WIDTH - 2;

    // Status line
    const statusLine = `${statusDotStr(node.status, theme)} ${node.status === "completed" ? "Completed" : node.status} · ${node.model}`;
    rightLines.push(statusLine);
    rightLines.push(theme.fg("dim", formatTokenStat(node.result?.usage, node.result?.toolCalls)));
    rightLines.push("");

    // Prompt section
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

    // Activity section
    const toolCalls = node.result?.toolCalls ?? [];
    const totalCount = toolCalls.length;
    if (totalCount > 0) {
      const showCount = Math.min(MAX_TOOL_CALLS_DISPLAY, totalCount);
      const isTruncated = totalCount > MAX_TOOL_CALLS_DISPLAY;
      const label = isTruncated
        ? `Activity · last ${showCount} of ${totalCount} tool calls`
        : `Activity · ${totalCount} tool call${totalCount !== 1 ? "s" : ""}`;
      rightLines.push(theme.fg("muted", label));
      // Show last N
      const start = totalCount - showCount;
      for (let i = start; i < totalCount; i++) {
        rightLines.push(`  ${formatActivityLine(toolCalls[i], mainWidth - 2)}`);
      }
    } else {
      rightLines.push(theme.fg("muted", "Activity"));
      rightLines.push(theme.fg("dim", `  ${node.status === "running" ? "(no tool calls yet)" : "(no activity recorded)"}`));
    }
    rightLines.push("");

    // Outcome section
    rightLines.push(theme.fg("muted", "Outcome"));
    if (node.status === "running") {
      rightLines.push(theme.fg("dim", "  Still running..."));
    } else if (node.result?.error) {
      rightLines.push(theme.fg("error", `  ${node.result.error.slice(0, mainWidth - 4)}`));
    } else if (node.result?.content) {
      let content = node.result.content;
      if (content.length > OUTPUT_TRUNCATE_BYTES) {
        content = content.slice(0, OUTPUT_TRUNCATE_BYTES) + `\n${ELLIPSIS} (truncated)`;
      }
      rightLines.push(...content.split("\n").slice(0, 20).map((l) => `  ${l}`));
    }
  }

  // Merge into bordered body
  const bodyHeight = Math.max(leftLines.length, rightLines.length);
  for (let i = 0; i < bodyHeight; i++) {
    const left = padVisible(leftLines[i] ?? "", SIDEBAR_WIDTH - 1);
    lines.push(`│${left}│${rightLines[i] ?? ""}`);
  }

  return lines;
}
