/**
 * Workflow View — Pure formatting functions (FR-4)
 *
 * Stateless functions extracted from WorkflowsView for testability.
 * All functions are pure: no Pi runtime, no side effects.
 */

import type { ExecutionTraceNode, ToolCallEntry, WorkflowStatus } from "../state.js";
import { truncateToWidth } from "@mariozechner/pi-tui";

// ── Constants ─────────────────────────────────────────────────

export const SIDEBAR_WIDTH = 24;
export const MS_PER_SEC = 1000;
export const PROMPT_FOLD_LINES = 20;
export const OUTPUT_TRUNCATE_BYTES = 100_000;
export const ELLIPSIS = "\u2026"; // U+2026

// ── Theme interface (avoids importing Pi runtime) ─────────────

export interface ThemeLike {
  fg(token: string, text: string): string;
  bold(text: string): string;
}

// ── Status helpers ────────────────────────────────────────────

export function statusDotStr(status: string, theme: ThemeLike): string {
  switch (status) {
    case "completed": return theme.fg("success", "●");
    case "running": return theme.fg("warning", "●");
    case "failed": return theme.fg("error", "●");
    default: return theme.fg("muted", "●");
  }
}

export function isTerminalStatus(status: WorkflowStatus): boolean {
  return ["completed", "failed", "aborted", "budget_limited", "time_limited", "state_lost"].includes(status);
}

// ── Pure formatting functions ─────────────────────────────────

/** Group trace nodes by phase. Nodes without phase go to "(no phase)". */
export function groupByPhase(nodes: ExecutionTraceNode[]): Map<string, ExecutionTraceNode[]> {
  const map = new Map<string, ExecutionTraceNode[]>();
  for (const node of nodes) {
    const phase = node.phase || "(no phase)";
    let arr = map.get(phase);
    if (!arr) {
      arr = [];
      map.set(phase, arr);
    }
    arr.push(node);
  }
  // Sort within each phase by stepIndex ascending (FR-3.2)
  for (const arr of map.values()) {
    arr.sort((a, b) => a.stepIndex - b.stepIndex);
  }
  return map;
}

/** Format elapsed time string from startedAt. */
export function formatElapsed(startedAt?: string, now: number = Date.now()): string {
  if (!startedAt) return "-";
  const ms = now - new Date(startedAt).getTime();
  if (ms < MS_PER_SEC) return "0s";
  const secs = Math.floor(ms / MS_PER_SEC);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m${remSecs}s`;
}

/** Format token + tool call statistics. */
export function formatTokenStat(
  usage?: { input: number; output: number },
  toolCalls?: ToolCallEntry[],
): string {
  const tokens = usage ? usage.input + usage.output : 0;
  const tools = toolCalls?.length ?? 0;
  return `${tokens} tok · ${tools} tool calls`;
}

/** Format a sidebar node line with status indicator. */
export function formatSidebarNode(
  node: ExecutionTraceNode,
  selected: boolean,
  width: number,
  theme: ThemeLike,
): string {
  const pointer = selected ? "❯ " : "  ";
  const dot = statusDotStr(node.status, theme);
  const label = node.agent;
  const available = width - pointer.length - 2 - 1; // pointer + "● " + space
  const truncated = available > 5 ? truncateToWidth(label, available) : "";
  return pointer + dot + " " + truncated;
}

/** Format a single activity line: ToolName(argsPreview). */
export function formatActivityLine(entry: ToolCallEntry, maxWidth: number): string {
  if (maxWidth < 10) return entry.name;
  const argsBudget = maxWidth - entry.name.length - 2; // name()
  if (argsBudget <= 0) return truncateToWidth(entry.name, maxWidth);
  const truncated = entry.input.length > argsBudget
    ? entry.input.slice(0, argsBudget - 1) + ELLIPSIS
    : entry.input;
  return `${entry.name}(${truncated})`;
}

// ── Sidebar flat list builder ─────────────────────────────────

export interface FlatEntry {
  type: "phase" | "node";
  phase?: string;
  node?: ExecutionTraceNode;
  index: number;
}

export function buildFlatEntries(phaseMap: Map<string, ExecutionTraceNode[]>): FlatEntry[] {
  const entries: FlatEntry[] = [];
  let idx = 0;
  for (const [phase, nodes] of phaseMap) {
    entries.push({ type: "phase", phase, index: idx++ });
    for (const node of nodes) {
      entries.push({ type: "node", node, index: idx++ });
    }
  }
  return entries;
}

// ── ANSI helpers ──────────────────────────────────────────────

/** Measure visible width of a string (strips ANSI escapes). */
export function visibleLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "").length;
}

/** Pad an ANSI-escaped string to a target *visible* width. */
export function padVisible(s: string, width: number): string {
  const vl = visibleLen(s);
  if (vl >= width) return s;
  return s + " ".repeat(width - vl);
}
