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

import { promises as fsPromises } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

import { type WorkflowInstance } from "../../domain/state.js";
import { isTerminal } from "../../domain/state.js";
import { saveWorkflow } from "../../infra/workflow-files.js";
import type { WorkflowOrchestrator } from "../../orchestrator.js";
import {
  buildPhaseGroups,
  ELLIPSIS,
  formatActivityLine,
  formatAgentOneLiner,
  formatElapsed,
  formatPhaseLine,
  formatStatusBadge,
  formatTokenStat,
  OUTPUT_TRUNCATE_BYTES,
  padVisible,
  type PhaseGroup,
  PROMPT_FOLD_LINES,
  SIDEBAR_WIDTH,
  statusDotStr,
  type ThemeLike,
  visibleLen,
} from "./format.js";

const MAX_TOOL_CALLS_DISPLAY = 3;

function statusLabel(status: string, theme: ThemeLike): string {
  switch (status) {
    case "completed": return theme.fg("success", status);
    case "running": return theme.fg("warning", status);
    case "failed": return theme.fg("error", status);
    default: return theme.fg("muted", status);
  }
}

// ── View state ────────────────────────────────────────────────

interface ViewState {
  level: 0 | 1 | 2;
  phaseIdx: number;
  agentIdx: number;
  promptExpanded: boolean;
  disposed: boolean;
  // Save mode
  saveMode: boolean;
  saveInputValue: string;
  saveMessage: string;    // inline feedback in save overlay
  saveMsgOk: boolean;     // true = success style, false = error style
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

    const initialState: ViewState = {
      level: 0,
      phaseIdx: 0,
      agentIdx: 0,
      promptExpanded: false,
      disposed: false,
      saveMode: false,
      saveInputValue: "",
      saveMessage: "",
      saveMsgOk: false,
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
        const raw = inst ? renderView(inst, theme, width, state, tuiAny.terminal.rows) : ["(workflow not found)"];
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
        if (processKey(data, orchestrator, runId, state, ctx, wrappedDone, cache, requestRender)) {
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

function processGlobalActions(
  data: string,
  orchestrator: WorkflowOrchestrator,
  runId: string,
  instance: WorkflowInstance,
  ctx: ExtensionContext,
  state: ViewState,
  done: () => void,
): boolean | undefined {
  if (data === "x") {
    handleAbort(orchestrator, runId, instance, ctx);
    return false;
  }
  if (data === "p") {
    handlePauseResume(orchestrator, runId, instance, ctx);
    return false;
  }
  if (data === "r") {
    if (isTerminal(instance.status) || instance.status === "paused") {
      handleRestart(orchestrator, runId, instance, ctx, state, done);
    }
    return false;
  }
  if (data === "s") {
    state.saveMode = true;
    state.saveInputValue = instance.name;
    state.saveMessage = "";
    state.saveMsgOk = false;
    return true;
  }
  if (data === "S") {
    saveTraceToFile(instance, ctx);
    return false;
  }
  return undefined;
}

function processNavigation(
  data: string,
  phases: PhaseGroup[],
  state: ViewState,
): boolean {
  if (phases.length === 0) return false;

  // Level 2 (Detail)
  if (state.level === 2) {
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

function processKey(
  data: string,
  orchestrator: WorkflowOrchestrator,
  runId: string,
  state: ViewState,
  ctx: ExtensionContext,
  done: () => void,
  cache: { width: number | undefined; lines: string[] | undefined },
  requestRender: () => void,
): boolean {
  const instance = orchestrator.getInstance(runId);
  if (!instance) return false;
  const phases = buildPhaseGroups(instance.trace);

  // 1. Save mode intercept
  if (state.saveMode) return processSaveModeInput(data, instance, state, ctx, cache, requestRender);

  // 2. Escape: level back or exit
  if (matchesKey(data, Key.escape)) {
    if (state.level === 0) { done(); return false; }
    state.level = (state.level - 1) as 0 | 1 | 2;
    return true;
  }

  // 3. Global actions (x/p/r/s/S)
  const globalResult = processGlobalActions(data, orchestrator, runId, instance, ctx, state, done);
  if (globalResult !== undefined) return globalResult;

  // 4. Navigation
  return processNavigation(data, phases, state);
}

// ── Save mode input handling ──────────────────────────────────

function processSaveModeInput(
  data: string,
  instance: WorkflowInstance,
  state: ViewState,
  ctx: ExtensionContext,
  cache: { width: number | undefined; lines: string[] | undefined },
  requestRender: () => void,
): boolean {
  // Escape → exit save mode
  if (matchesKey(data, Key.escape)) {
    state.saveMode = false;
    return true;
  }
  // Enter → save
  if (data === "\r" || data === "\n") {
    if (!state.saveInputValue.trim()) {
      state.saveMessage = "Please enter a name";
      state.saveMsgOk = false;
      return true;
    }
    void doSaveWorkflow(instance, state, ctx).then((result) => {
      state.saveMessage = result.msg;
      state.saveMsgOk = result.ok;
      if (result.ok) {
        state.saveMode = false;
      }
      cache.width = undefined;
      cache.lines = undefined;
      requestRender();
    });
    return false;
  }
  // Backspace → clear message on edit
  if (data === "\x7f" || data === "\b") {
    state.saveMessage = "";
    if (state.saveInputValue.length > 0) {
      state.saveInputValue = state.saveInputValue.slice(0, -1);
      return true;
    }
    return false;
  }
  // Printable chars → clear message on edit
  if (data.length === 1 && data.charCodeAt(0) >= 32) {
    state.saveMessage = "";
    state.saveInputValue += data;
    return true;
  }
  // Block all other keys (↑↓ etc.) from falling through
  return false;
}

// ── Save trace ────────────────────────────────────────────────

function handlePauseResume(
  orchestrator: WorkflowOrchestrator,
  runId: string,
  instance: WorkflowInstance,
  ctx: ExtensionContext,
): void {
  if (isTerminal(instance.status)) {
    ctx.ui.notify(`Workflow already ${instance.status}`, "warning");
    return;
  }
  const action = instance.status === "running" ? "pause" : "resume";
  void (action === "pause" ? orchestrator.pause(runId) : orchestrator.resume(runId))
    .then(() => ctx.ui.notify(`Workflow ${action}d`, "info"))
    .catch((err: Error) => ctx.ui.notify(`${action} failed: ${err.message}`, "error"));
}

function saveTraceToFile(instance: WorkflowInstance, ctx: ExtensionContext): void {
  const dir = pathJoin(homedir(), ".pi", "agent", "workflow-traces");
  const filePath = pathJoin(dir, `${instance.runId}.md`);
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
  fsPromises.mkdir(dir, { recursive: true })
    .then(() => fsPromises.writeFile(filePath, lines.join("\n"), "utf8"))
    .then(() => ctx.ui.notify(`Trace saved: ${filePath}`, "info"))
    .catch((err: Error) => ctx.ui.notify(`Save failed: ${err.message}`, "error"));
}

function handleAbort(
  orchestrator: WorkflowOrchestrator,
  runId: string,
  instance: WorkflowInstance,
  ctx: ExtensionContext,
): void {
  if (isTerminal(instance.status)) {
    ctx.ui.notify(`Workflow already ${instance.status}`, "warning");
    return;
  }
  void orchestrator.abort(runId)
    .then(() => ctx.ui.notify("Workflow aborted", "info"))
    .catch((err: Error) => ctx.ui.notify(`Abort failed: ${err.message}`, "error"));
}

function handleRestart(
  orchestrator: WorkflowOrchestrator,
  runId: string,
  instance: WorkflowInstance,
  ctx: ExtensionContext,
  state: ViewState,
  done: () => void,
): void {
  // Block renders before async restart to avoid flickering "(workflow not found)"
  state.disposed = true;
  void orchestrator.restart(runId)
    .then((newRunId) => {
      ctx.ui.notify(`Restarted '${instance.name}' (${newRunId.slice(0, 12)}...)`, "info");
      done();
    })
    .catch((err: Error) => {
      ctx.ui.notify(`Restart failed: ${err.message}`, "error");
      state.disposed = false;
    });
}

// ── Save workflow script ──────────────────────────────────────

async function doSaveWorkflow(
  instance: WorkflowInstance,
  state: ViewState,
  _ctx: ExtensionContext,
): Promise<{ ok: boolean; msg: string }> {
  const isTmp = instance.worker.includes("/.tmp/") || instance.worker.includes("\\.tmp\\");
  if (!isTmp) {
    return { ok: false, msg: "Only temporary workflows can be saved." };
  }

  const name = state.saveInputValue.trim();
  if (!name) {
    return { ok: false, msg: "Please enter a name" };
  }

  try {
    // 提取 tmp 名：worker path 形如 .../.pi/workflows/.tmp/{name}.js
    const tmpName = instance.worker.replace(/.*\.tmp\//, "").replace(/.*\.tmp\\/, "").replace(/\.js$/, "");
    const msg = await saveWorkflow(tmpName, name);
    return { ok: true, msg };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, msg: `Save failed: ${msg}` };
  }
}

// ── Render ────────────────────────────────────────────────────

function renderHeader(
  lines: string[],
  instance: WorkflowInstance,
  theme: ThemeLike,
  contentWidth: number,
): void {
  const completed = instance.trace.filter((n) => n.status === "completed").length;
  const total = instance.trace.length;
  const elapsed = formatElapsed(instance.startedAt);
  const headerRight = `${formatStatusBadge(instance.status, theme)} · ${completed}/${total} agents · ${elapsed}`;

  const nameLine = theme.bold(instance.name);
  const rightPart = theme.fg("muted", headerRight);

  lines.push("╭" + "─".repeat(contentWidth) + "╮");
  lines.push("│" + padVisible(nameLine, contentWidth) + "│");

  if (instance.description) {
    const maxDesc = contentWidth - visibleLen(rightPart) - 1;
    const descText = instance.description.length > maxDesc
      ? instance.description.slice(0, maxDesc - 1) + ELLIPSIS
      : instance.description;
    const descPart = theme.fg("dim", descText);
    const padLen = Math.max(0, contentWidth - visibleLen(descPart) - visibleLen(rightPart));
    lines.push("│" + descPart + " ".repeat(padLen) + rightPart + "│");
  } else {
    lines.push("│" + padVisible(rightPart, contentWidth) + "│");
  }
  lines.push("├" + "─".repeat(contentWidth) + "┤");
}

function renderFooter(
  lines: string[],
  instance: WorkflowInstance,
  state: ViewState,
  theme: ThemeLike,
): void {
  const navPart = state.level === 0
    ? "↑↓ phase · ⏎ enter"
    : state.level === 1
      ? "↑↓ agent · ⏎ detail"
      : "↑↓ agent · ⏎ prompt";
  const actionParts: string[] = [];
  const terminal = isTerminal(instance.status);
  if (!terminal) {
    actionParts.push("x stop");
    actionParts.push(instance.status === "paused" ? "p resume" : "p pause");
  }
  if (terminal || instance.status === "paused") {
    actionParts.push("r restart");
  }
  actionParts.push("s save");
  actionParts.push("S trace");
  actionParts.push("esc back");
  const footer = `${navPart} · ${actionParts.join(" · ")}`;
  lines.push("");
  lines.push(theme.fg("muted", footer));
}

function renderView(
  instance: WorkflowInstance,
  theme: ThemeLike,
  width: number,
  state: ViewState,
  termRows: number,
): string[] {
  const lines: string[] = [];
  const now = Date.now();
  const phases = buildPhaseGroups(instance.trace);
  if (phases.length === 0) return ["(no agents)"];

  const contentWidth = width - 2;
  renderHeader(lines, instance, theme, contentWidth);

  const phase = phases[state.phaseIdx] ?? phases[0];
  const agents = phase.nodes;
  const mainWidth = contentWidth - SIDEBAR_WIDTH - 1;

  const bodyStart = lines.length;

  if (state.level === 0) {
    renderLevel0(lines, phases, state, theme, width, mainWidth);
  } else if (state.level === 1) {
    renderLevel1(lines, phases, agents, state, theme, width, mainWidth);
  } else {
    renderLevel2(lines, instance, phase, agents, state, theme, width, mainWidth, now);
  }

  const headerFooterLines = 6;
  const minBodyHeight = Math.max(3, Math.floor(termRows * 2 / 3) - headerFooterLines);
  const emptyBodyLine = padVisible("", SIDEBAR_WIDTH) + "│" + padVisible("", mainWidth);
  while (lines.length - bodyStart < minBodyHeight) {
    lines.push(emptyBodyLine);
  }

  for (let i = bodyStart; i < lines.length; i++) {
    lines[i] = "│" + padVisible(lines[i], contentWidth) + "│";
  }

  lines.push("╰" + "─".repeat(contentWidth) + "╯");

  if (state.saveMode) {
    const overlayLines = renderSaveOverlay(instance, state, theme, width);
    const overlayStart = Math.max(bodyStart, bodyStart + Math.floor((lines.length - bodyStart - overlayLines.length) / 2));
    for (let i = 0; i < overlayLines.length && overlayStart + i < lines.length; i++) {
      lines[overlayStart + i] = overlayLines[i];
    }
  }

  renderFooter(lines, instance, state, theme);
  return lines;
}

// ── Level 0: Phase selection ──────────────────────────────────

function renderLevel0(
  lines: string[],
  phases: PhaseGroup[],
  state: ViewState,
  theme: ThemeLike,
  width: number,
  mainWidth: number,
): void {
  const leftLines: string[] = [];
  const rightLines: string[] = [];

  // Left: sidebar title + phase list
  leftLines.push(theme.fg("muted", "Phases"));
  leftLines.push("─".repeat(SIDEBAR_WIDTH));
  for (let i = 0; i < phases.length; i++) {
    leftLines.push(formatPhaseLine(phases[i], i, i === state.phaseIdx, theme, SIDEBAR_WIDTH));
  }

  // Right: agents in the currently selected phase only
  const selectedPhase = phases[state.phaseIdx] ?? phases[0];
  if (selectedPhase) {
    const title = selectedPhase.name
      ? `${selectedPhase.name} · ${selectedPhase.nodes.length} agents`
      : `${selectedPhase.nodes.length} agents`;
    rightLines.push(theme.fg("muted", title));
    rightLines.push("─".repeat(mainWidth));
    for (const node of selectedPhase.nodes) {
      rightLines.push(`  ${formatAgentOneLiner(node, theme)}`);
    }
  }

  mergeBody(lines, leftLines, rightLines);
}

// ── Level 1: Agent selection ──────────────────────────────────

function renderLevel1(
  lines: string[],
  phases: PhaseGroup[],
  agents: import("../../domain/state.js").ExecutionTraceNode[],
  state: ViewState,
  theme: ThemeLike,
  width: number,
  mainWidth: number,
): void {
  const leftLines: string[] = [];
  const rightLines: string[] = [];

  leftLines.push(theme.fg("muted", "Phases"));
  leftLines.push("─".repeat(SIDEBAR_WIDTH));
  for (let i = 0; i < phases.length; i++) {
    leftLines.push(formatPhaseLine(phases[i], i, i === state.phaseIdx, theme, SIDEBAR_WIDTH));
  }

  // Right: agent list for current phase (agents parameter already scoped to current phase)
  const currentPhase = phases[state.phaseIdx];
  if (currentPhase) {
    const title = currentPhase.name ? `${currentPhase.name} · ${currentPhase.nodes.length} agents` : `${currentPhase.nodes.length} agents`;
    rightLines.push(theme.fg("muted", title));
    rightLines.push("─".repeat(mainWidth));
  }
  for (let i = 0; i < agents.length; i++) {
    const node = agents[i];
    const isSelected = i === state.agentIdx;
    const pointer = isSelected ? "❯ " : "  ";
    rightLines.push(`${pointer}${formatAgentOneLiner(node, theme)}`);
  }

  mergeBody(lines, leftLines, rightLines);
}

// ── Level 2: Execution detail ─────────────────────────────────

function renderWorkerLogSection(
  rightLines: string[],
  instance: WorkflowInstance,
  mainWidth: number,
  theme: ThemeLike,
): void {
  const logs = instance.errorLogs;
  if (!logs || logs.length === 0) return;
  const total = logs.length;
  const showCount = Math.min(total, 20);
  const label = total > showCount
    ? `Worker diagnostics · last ${showCount} of ${total}`
    : `Worker diagnostics · ${total} entr${total !== 1 ? "ies" : "y"}`;
  rightLines.push(theme.fg("warning", label));
  const start = total - showCount;
  for (let i = start; i < total; i++) {
    const entry = logs[i];
    const levelToken = entry.level === "error" ? "error" : entry.level === "warn" ? "warning" : "muted";
    const prefix = `[${entry.level}]`;
    const line = `  ${prefix} ${entry.message}`.slice(0, mainWidth - 2);
    rightLines.push(theme.fg(levelToken, line));
  }
  rightLines.push("");
}

function renderPromptSection(
  rightLines: string[],
  node: import("../../domain/state.js").ExecutionTraceNode,
  mainWidth: number,
  state: ViewState,
  theme: ThemeLike,
): void {
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
}

function renderActivitySection(
  rightLines: string[],
  node: import("../../domain/state.js").ExecutionTraceNode,
  mainWidth: number,
  theme: ThemeLike,
): void {
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
}

function renderOutcomeSection(
  rightLines: string[],
  node: import("../../domain/state.js").ExecutionTraceNode,
  mainWidth: number,
  theme: ThemeLike,
): void {
  rightLines.push(theme.fg("muted", "Outcome"));
  if (node.status === "running") {
    rightLines.push(theme.fg("dim", "  Still running..."));
  } else if (node.result?.error) {
    rightLines.push(theme.fg("error", `  ${node.result.error.slice(0, mainWidth - 4)}`));
  } else if (node.result?.content) {
    const raw = node.result.content;
    if (Buffer.byteLength(raw, "utf8") > OUTPUT_TRUNCATE_BYTES) {
      const truncated = Buffer.from(raw, "utf8").slice(0, OUTPUT_TRUNCATE_BYTES).toString("utf8");
      const allLines = truncated.split("\n");
      const tail = allLines.slice(-5);
      rightLines.push(...tail.map((l) => `  ${l.slice(0, mainWidth - 4)}`));
      rightLines.push(theme.fg("dim", "  (truncated)"));
    } else {
      const allLines = raw.split("\n");
      const tail = allLines.slice(-5);
      rightLines.push(...tail.map((l) => `  ${l.slice(0, mainWidth - 4)}`));
    }
  }
}

function renderLevel2(
  lines: string[],
  instance: WorkflowInstance,
  phase: PhaseGroup,
  agents: import("../../domain/state.js").ExecutionTraceNode[],
  state: ViewState,
  theme: ThemeLike,
  width: number,
  mainWidth: number,
  now: number,
): void {
  const leftLines: string[] = [];
  const rightLines: string[] = [];

  // Left: agents title + agent names
  leftLines.push(theme.fg("muted", "Agents"));
  leftLines.push("─".repeat(SIDEBAR_WIDTH));
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    const isSelected = i === state.agentIdx;
    const pointer = isSelected ? "❯ " : "  ";
    const maxNameWidth = SIDEBAR_WIDTH - 4;
    const agentName = visibleLen(a.agent) > maxNameWidth
      ? truncateToWidth(a.agent, maxNameWidth - 1) + ELLIPSIS
      : a.agent;
    leftLines.push(`${pointer}${agentName}`);
  }

  // Right: full detail
  const node = agents[state.agentIdx];
  if (node) {
    const elapsed = formatElapsed(
      node.startedAt,
      node.completedAt ? new Date(node.completedAt).getTime() : now,
    );
    rightLines.push(theme.fg("muted", "Detail"));
    rightLines.push("─".repeat(mainWidth));
    rightLines.push(`${statusDotStr(node.status, theme)} ${statusLabel(node.status, theme)} · ${node.model}`);
    rightLines.push(theme.fg("dim", formatTokenStat(node.result?.usage, node.result?.toolCalls, elapsed)));
    rightLines.push("");
    renderWorkerLogSection(rightLines, instance, mainWidth, theme);
    renderPromptSection(rightLines, node, mainWidth, state, theme);
    renderActivitySection(rightLines, node, mainWidth, theme);
    renderOutcomeSection(rightLines, node, mainWidth, theme);
  }

  mergeBody(lines, leftLines, rightLines);
}

// ── Helpers ───────────────────────────────────────────────────

function mergeBody(
  lines: string[],
  leftLines: string[],
  rightLines: string[],
): void {
  const bodyHeight = Math.max(leftLines.length, rightLines.length);
  for (let i = 0; i < bodyHeight; i++) {
    const left = padVisible(leftLines[i] ?? "", SIDEBAR_WIDTH);
    lines.push(left + "│" + (rightLines[i] ?? ""));
  }
}

// ── Save overlay render ───────────────────────────────────────

function renderSaveOverlay(
  instance: WorkflowInstance,
  state: ViewState,
  theme: ThemeLike,
  width: number,
): string[] {
  const contentWidth = width - 2;
  const lines: string[] = [];

  lines.push("╭" + "─".repeat(contentWidth) + "╮");

  // Title
  const title = " Save dynamic workflow";
  lines.push("│" + padVisible(theme.bold(title), contentWidth) + "│");

  // Destination (project scope only)
  const destName = state.saveInputValue || instance.name;
  const destLine = `Project scope · .pi/workflows/${destName}.js`;
  lines.push("│" + padVisible(theme.fg("dim", destLine), contentWidth) + "│");

  // Empty line
  lines.push("│" + padVisible("", contentWidth) + "│");

  // Label
  lines.push("│" + padVisible("Save as:", contentWidth) + "│");

  // Input line with cursor block
  const inputLine = `  > ${state.saveInputValue}\u2588`;
  lines.push("│" + padVisible(inputLine, contentWidth) + "│");

  // Empty line
  lines.push("│" + padVisible("", contentWidth) + "│");

  // Inline message (error or success)
  if (state.saveMessage) {
    const msgStyle = state.saveMsgOk ? "success" : "error";
    const msgLine = `  ${state.saveMessage}`;
    lines.push("│" + padVisible(theme.fg(msgStyle, msgLine), contentWidth) + "│");
  } else {
    lines.push("│" + padVisible("", contentWidth) + "│");
  }

  // Hint
  const hint = "Enter to save · Esc to cancel";
  lines.push("│" + padVisible(theme.fg("muted", hint), contentWidth) + "│");

  lines.push("╰" + "─".repeat(contentWidth) + "╯");

  return lines;
}
