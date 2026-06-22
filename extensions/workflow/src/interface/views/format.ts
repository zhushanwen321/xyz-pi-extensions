/**
 * Workflow View — Pure formatting functions (FR-4)
 *
 * Stateless functions extracted from WorkflowsView for testability.
 * All functions are pure: no Pi runtime, no side effects.
 */

import { truncateToWidth } from "@mariozechner/pi-tui";

import type { ExecutionTraceNode, ToolCallEntry } from "../../engine/models/types.js";
import { MS_PER_SEC, SECS_PER_MIN } from "../../infra/constants.js";

// ── Constants ─────────────────────────────────────────────────

export const SIDEBAR_WIDTH = 24;
export const PROMPT_FOLD_LINES = 3;
export const OUTPUT_TRUNCATE_BYTES = 100_000;
export const ELLIPSIS = "\u2026"; // U+2026

// ── Theme interface (avoids importing Pi runtime) ─────────────

export interface ThemeLike {
  fg(token: string, text: string): string;
  bold(text: string): string;
}

// ── Status helpers ────────────────────────────────────────────

/** status → 语义颜色 token（用于给任意文本染色，不含符号）。 */
export function statusColorToken(status: string): "success" | "warning" | "error" | "muted" {
  switch (status) {
    case "completed": return "success";
    case "running": return "warning";
    case "failed": case "aborted": return "error";
    default: return "muted";
  }
}

export function statusDotStr(status: string, theme: ThemeLike): string {
  return theme.fg(statusColorToken(status), "●");
}

/** Format a status badge with color for the header area. */
export function formatStatusBadge(status: string, theme: ThemeLike): string {
  switch (status) {
    case "running": return theme.fg("warning", "\u25CF running");
    case "paused": return theme.fg("warning", "\u23F8 PAUSED");
    case "completed": return theme.fg("success", "\u2713 completed");
    case "failed": return theme.fg("error", "\u2717 failed");
    case "aborted": return theme.fg("error", "\u2717 aborted");
    case "budget_limited": return theme.fg("error", "\u26A0 budget");
    case "time_limited": return theme.fg("error", "\u26A0 timeout");
    case "state_lost": return theme.fg("muted", "? lost");
    default: return theme.fg("muted", status);
  }
}

// ── Pure formatting functions ─────────────────────────────────

/** Group trace nodes by phase. Nodes without phase go to "(no phase)". */
export function groupByPhase(nodes: ExecutionTraceNode[]): Map<string, ExecutionTraceNode[]> {
  const map = new Map<string, ExecutionTraceNode[]>();
  for (const node of nodes) {
    const phase = node.phase || "(default)";
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
  if (secs < SECS_PER_MIN) return `${secs}s`;
  const mins = Math.floor(secs / SECS_PER_MIN);
  const remSecs = secs % SECS_PER_MIN;
  return `${mins}m${remSecs}s`;
}

/** Format token + tool call statistics. */
export function formatTokenStat(
  usage?: { input: number; output: number },
  toolCalls?: ToolCallEntry[],
  elapsed?: string,
): string {
  const tokens = usage ? usage.input + usage.output : 0;
  const tools = toolCalls?.length ?? 0;
  const base = `${tokens} tok · ${tools} tool calls`;
  return elapsed ? `${base} · ${elapsed}` : base;
}

/**
 * renderResult 的文本兜底：从 result.content[0] 提取纯文本。
 * 多处 tool 的 renderResult 曾各自内联此逻辑，提取后统一调用。
 */
export function renderTextFallback(
  result: { content?: Array<{ type: string; text?: string }> },
): string {
  const first = result.content?.[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

/** Format a single activity line: ToolName(argsPreview). */
export function formatActivityLine(entry: ToolCallEntry, maxWidth: number): string {
  // 语义阈值与开销：低于此宽度只显名称；括号占 2 字符 (name())。
  const MIN_ACTIVITY_WIDTH = 10;
  const PARENS_OVERHEAD = 2;
  if (maxWidth < MIN_ACTIVITY_WIDTH) return entry.name;
  const argsBudget = maxWidth - entry.name.length - PARENS_OVERHEAD;
  if (argsBudget <= 0) return truncateToWidth(entry.name, maxWidth);
  const truncated = entry.input.length > argsBudget
    ? entry.input.slice(0, argsBudget - 1) + ELLIPSIS
    : entry.input;
  return `${entry.name}(${truncated})`;
}

// ── ANSI helpers ──────────────────────────────────────────────

/** Measure visible width of a string (strips ANSI escapes). */
export function visibleLen(s: string): number {
   
  return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "").length;
}

/** Pad an ANSI-escaped string to a target *visible* width. */
export function padVisible(s: string, width: number): string {
  const vl = visibleLen(s);
  if (vl >= width) return s;
  return s + " ".repeat(width - vl);
}

// ── Phase group (filters empty phases) ────────────────────────

export interface PhaseGroup {
  name: string;
  nodes: ExecutionTraceNode[];
  doneCount: number;
}

/** The fallback phase name when node has no explicit phase. */
const NO_PHASE = "(default)";

/** Build phase groups. Nodes without a phase are placed in an unnamed group. */
export function buildPhaseGroups(nodes: ExecutionTraceNode[]): PhaseGroup[] {
  const map = groupByPhase(nodes);
  const result: PhaseGroup[] = [];
  for (const [name, phaseNodes] of map) {
    if (phaseNodes.length > 0) {
      result.push({
        name: name === NO_PHASE ? "" : name,
        nodes: phaseNodes,
        doneCount: phaseNodes.filter((n) => n.status === "completed").length,
      });
    }
  }
  return result;
}

// ── Sidebar phase line formatter ─────────────────────────────

export function formatPhaseLine(
  pg: PhaseGroup,
  idx: number,
  isSelected: boolean,
  theme: ThemeLike,
  maxWidth: number,
): string {
  const pointer = isSelected ? "❯ " : "  ";
  const dot = statusDotStr(pg.doneCount === pg.nodes.length ? "completed" : "running", theme);
  const name = pg.name || "(unnamed)";
  const label = `${idx + 1} ${name} ${pg.doneCount}/${pg.nodes.length}`;
  // pointer(2) + dot(1) + space(1)
  const PHASE_PREFIX_WIDTH = 4;
  const budget = maxWidth - PHASE_PREFIX_WIDTH;
  const truncated = visibleLen(label) > budget
    ? truncateToWidth(label, budget - 1) + ELLIPSIS
    : label;
  return `${pointer}${dot} ${truncated}`;
}

// ── Agent one-liner for overview right panel ──────────────────

const TOKEN_K = 1000;

export function formatAgentOneLiner(node: ExecutionTraceNode, theme: ThemeLike): string {
  const dot = statusDotStr(node.status, theme);
  const elapsed = formatElapsed(
    node.startedAt,
    node.completedAt ? new Date(node.completedAt).getTime() : Date.now(),
  );
  const tok = node.result?.usage;
  const tokStr = tok
    ? `${Math.round((tok.input + tok.output) / TOKEN_K)}k tok`
    : "";
  const tcCount = node.result?.toolCalls?.length ?? 0;
  const parts = [dot, node.agent, node.model];
  if (tokStr) parts.push(`${tokStr} · ${tcCount} tools`);
  parts.push(elapsed);
  return parts.join("    ");
}


