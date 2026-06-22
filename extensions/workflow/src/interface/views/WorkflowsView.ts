/**
 * Workflow Fullscreen TUI View — Three-level navigation（W5-T31 重写）.
 *
 * Level 0 (Phase):   左 phase list，右 agent overview
 * Level 1 (Agent):   左 agent list，右 agent summary
 * Level 2 (Detail):  完整 agent 执行详情
 *
 * 适配新 WorkflowRun 聚合根（替换旧 WorkflowInstance）+ 移除 restart（D-9）。
 * 旧 view 通过 WorkflowOrchestrator.pause/resume/abort/restart 操作；
 * 新 view 直接读 WorkflowRun.state + 传 lifecycle 操作 callback。
 *
 * 注：T27 commands.ts 当前 /workflows 用文本输出（view 未注册）。
 * 本 view 为 T31 重建——结构正确、typecheck 通过、基础测试覆盖。
 * 未来 commands.ts 切回 createWorkflowsView 时即激活。
 */

/* eslint-disable taste/no-silent-catch */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import type { WorkflowRun } from "../../engine/models/workflow-run.js";
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
  PROMPT_FOLD_LINES,
  SIDEBAR_WIDTH,
  statusDotStr,
  type ThemeLike,
  visibleLen,
} from "./format.js";

// ── TUI layout constants ──────────────────────────────────────

const BOX_BORDER_CHARS = 2;
const RIGHT_MARGIN = 2;
const DETAIL_INDENT = 2;
const POINTER_WIDTH = 2;
const NAV_LEVEL_DETAIL = 2;
type NavLevel = 0 | 1 | typeof NAV_LEVEL_DETAIL;
const MIN_BODY_LINES = 3;
const BODY_HEIGHT_NUMERATOR = 2;
const BODY_HEIGHT_DENOMINATOR = 3;
const MAX_TOOL_CALLS_DISPLAY = 3;

// ── Minimal TUI duck-types（避免直接 import TUI/KeybindingsManager 类型 ──
// 共享类型 fallback shared/types/mariozechner/index.d.ts 不导出 TUI 类，
// workspace 跨包 typecheck 会报 "no exported member 'TUI'"。
// 此处用结构化接口替代——只声明 view 实际用到的成员。

interface TuiLike {
  terminal: { columns: number; rows: number };
  requestRender(): void;
  on(key: string, cb: () => void): void;
}

// ── View actions ──────────────────────────────────────────────

/**
 * view 可触发的 lifecycle 操作（由调用方注入，避免 view 直接依赖 Engine 函数）。
 * 每个 action 接收 runId；调用方绑到 pauseRun/resumeRun/abortRun。
 */
export interface ViewActions {
  pause: (runId: string) => Promise<void>;
  resume: (runId: string) => Promise<void>;
  abort: (runId: string) => Promise<void>;
}

// ── View state ────────────────────────────────────────────────

interface ViewState {
  level: NavLevel;
  phaseIdx: number;
  agentIdx: number;
  promptExpanded: boolean;
  disposed: boolean;
}

function createInitialState(): ViewState {
  return {
    level: 0,
    phaseIdx: 0,
    agentIdx: 0,
    promptExpanded: false,
    disposed: false,
  };
}

// ── View factory ──────────────────────────────────────────────

/**
 * 创建 workflow fullscreen view。
 *
 * @param run    WorkflowRun 聚合根（读 state.status/spec/trace/meta）
 * @param theme  ThemeLike（避免直接 import Pi runtime）
 * @param ctx    ExtensionContext（调 ui.custom 渲染）
 * @param actions lifecycle 操作（pause/resume/abort），由调用方注入
 */
export function createWorkflowsView(
  run: WorkflowRun,
  theme: ThemeLike,
  ctx: ExtensionContext,
  actions: ViewActions,
): Promise<void> {
  return ctx.ui.custom<void>((_tui: unknown, _t: unknown, _kb: unknown, done: (result: void) => void) => {
    const state = createInitialState();
    const tui = _tui as TuiLike;

    // trace.toArray() 返回 readonly；buildPhaseGroups 需 mutable，拷一份
    const traceNodes = [...run.state.trace.toArray()];
    const phaseGroups = buildPhaseGroups(traceNodes);

    function currentPhaseAgents() {
      const pg = phaseGroups[state.phaseIdx];
      return pg ? pg.nodes : [];
    }

    function clampSelections() {
      if (state.phaseIdx >= phaseGroups.length) state.phaseIdx = Math.max(0, phaseGroups.length - 1);
      const agents = currentPhaseAgents();
      if (state.agentIdx >= agents.length) state.agentIdx = Math.max(0, agents.length - 1);
    }

    // 当前显示的 Text 行（每次 renderView 更新）
    const host = new Text("", 0, 0);

    function renderView() {
      clampSelections();
      const width = tui.terminal.columns;
      const height = tui.terminal.rows;
      const lines = renderLayout(run, state, phaseGroups, theme, width, height);
      // Text 组件以换行拼接，TUI 渲染时按行展开
      host.setText(lines.join("\n"));
      tui.requestRender();
    }

    // ── Key bindings via tui event interface ──
    // TuiLike.on 已声明；tui 直接用（无需 duck-type 转换）。

    tui.on("ctrl+c", () => {
      state.disposed = true;
      done();
    });

    tui.on("escape", () => {
      if (state.level === 0) {
        state.disposed = true;
        done();
      } else {
        state.level = (state.level - 1) as NavLevel;
        state.promptExpanded = false;
        renderView();
      }
    });

    tui.on("up", () => {
      if (state.level === 0 && state.phaseIdx > 0) state.phaseIdx--;
      else if (state.level === 1 && state.agentIdx > 0) state.agentIdx--;
      renderView();
    });

    tui.on("down", () => {
      if (state.level === 0 && state.phaseIdx < phaseGroups.length - 1) state.phaseIdx++;
      else if (state.level === 1 && state.agentIdx < currentPhaseAgents().length - 1) state.agentIdx++;
      renderView();
    });

    tui.on("enter", () => {
      if (state.level === 0 && phaseGroups.length > 0) {
        state.level = 1;
        state.agentIdx = 0;
      } else if (state.level === 1) {
        state.level = NAV_LEVEL_DETAIL;
      }
      renderView();
    });

    // ── Lifecycle shortcuts (no restart per D-9) ──
    tui.on("p", async () => {
      if (run.state.status === "running") {
        try { await actions.pause(run.runId); } catch { /* pause 失败忽略，view 不阻断 */ }
        renderView();
      } else if (run.state.status === "paused") {
        try { await actions.resume(run.runId); } catch { /* resume 失败忽略 */ }
        renderView();
      }
    });

    tui.on("a", async () => {
      if (run.state.status === "running" || run.state.status === "paused") {
        try { await actions.abort(run.runId); } catch { /* abort 失败忽略 */ }
        renderView();
      }
    });

    renderView();
    return host;
  });
}

// ── Layout rendering ──────────────────────────────────────────

function bodyHeight(screenHeight: number): number {
  return Math.max(MIN_BODY_LINES, Math.floor((screenHeight * BODY_HEIGHT_NUMERATOR) / BODY_HEIGHT_DENOMINATOR));
}

const RUNID_HEADER_SHORT = 8;

function renderLayout(
  run: WorkflowRun,
  state: ViewState,
  phaseGroups: ReturnType<typeof buildPhaseGroups>,
  theme: ThemeLike,
  screenWidth: number,
  screenHeight: number,
): string[] {
  const lines: string[] = [];
  const innerWidth = screenWidth - BOX_BORDER_CHARS;

  // ── Header ──
  const reasonSuffix = run.state.reason && run.state.reason !== "completed" ? ` (${run.state.reason})` : "";
  const header = `${formatStatusBadge(run.state.status, theme)} ${run.spec.scriptName} — ${run.runId.slice(0, RUNID_HEADER_SHORT)}${reasonSuffix}`;
  lines.push(padVisible(header, innerWidth));
  lines.push("─".repeat(innerWidth));

  // ── Body depends on nav level ──
  const bh = bodyHeight(screenHeight);
  if (state.level === 0) {
    lines.push(...renderPhaseLevel(run, state, phaseGroups, theme, innerWidth, bh));
  } else if (state.level === 1) {
    lines.push(...renderAgentLevel(state, phaseGroups, theme, innerWidth, bh));
  } else {
    lines.push(...renderDetailLevel(run, state, phaseGroups, theme, innerWidth, bh));
  }

  // ── Footer (keymap, no restart) ──
  lines.push("─".repeat(innerWidth));
  const status = run.state.status;
  const pauseResumeHint = status === "running" ? "p=pause" : status === "paused" ? "p=resume" : "";
  const abortHint = status === "running" || status === "paused" ? "a=abort" : "";
  const navHint = state.level === 0 ? "↑↓ phases · ⏎ drill in" : state.level === 1 ? "↑↓ agents · ⏎ detail" : "⏎ collapse";
  const footer = [navHint, pauseResumeHint, abortHint, "esc=back · ctrl+c=exit"].filter(Boolean).join(" · ");
  lines.push(padVisible(theme.fg("muted", footer), innerWidth));

  return lines;
}

function renderPhaseLevel(
  run: WorkflowRun,
  state: ViewState,
  phaseGroups: ReturnType<typeof buildPhaseGroups>,
  theme: ThemeLike,
  width: number,
  height: number,
): string[] {
  const leftWidth = SIDEBAR_WIDTH;
  const rightWidth = width - leftWidth;
  const lines: string[] = [];

  if (phaseGroups.length === 0) {
    lines.push(theme.fg("muted", "No phases yet. Workflow may still be starting..."));
    while (lines.length < height) lines.push("");
    return lines;
  }

  // Left: phase list
  const leftLines: string[] = [];
  for (let i = 0; i < phaseGroups.length; i++) {
    leftLines.push(formatPhaseLine(phaseGroups[i], i, i === state.phaseIdx, theme, leftWidth));
  }

  // Right: selected phase agents overview
  const pg = phaseGroups[state.phaseIdx];
  const rightLines: string[] = [];
  if (pg) {
    rightLines.push(theme.bold(pg.name || "(unnamed phase)"));
    rightLines.push(theme.fg("muted", `${pg.doneCount}/${pg.nodes.length} completed · ${formatElapsed(run.meta.startedAt)}`));
    rightLines.push("");
    for (const node of pg.nodes) {
      rightLines.push(formatAgentOneLiner(node, theme));
    }
  }

  // Merge columns
  const rowCount = Math.max(leftLines.length, rightLines.length, height);
  for (let i = 0; i < rowCount; i++) {
    const left = leftLines[i] ?? "";
    const right = rightLines[i] ?? "";
    const leftPadded = padVisible(left, leftWidth);
    const rightTrunc = visibleLen(right) > rightWidth ? right.slice(0, rightWidth - 1) + ELLIPSIS : right;
    lines.push(`${leftPadded}${rightTrunc}`);
  }

  return lines;
}

function renderAgentLevel(
  state: ViewState,
  phaseGroups: ReturnType<typeof buildPhaseGroups>,
  theme: ThemeLike,
  width: number,
  height: number,
): string[] {
  const leftWidth = SIDEBAR_WIDTH;
  const rightWidth = width - leftWidth;
  const lines: string[] = [];

  const pg = phaseGroups[state.phaseIdx];
  if (!pg || pg.nodes.length === 0) {
    lines.push(theme.fg("muted", "No agents in this phase."));
    while (lines.length < height) lines.push("");
    return lines;
  }

  // Left: agent list
  const leftLines: string[] = [];
  for (let i = 0; i < pg.nodes.length; i++) {
    const node = pg.nodes[i];
    const pointer = i === state.agentIdx ? "❯ " : "  ";
    const dot = statusDotStr(node.status, theme);
    const label = truncateText(`${node.agent}`, leftWidth - POINTER_WIDTH - 1);
    leftLines.push(`${pointer}${dot} ${label}`);
  }

  // Right: selected agent summary
  const node = pg.nodes[state.agentIdx];
  const rightLines: string[] = [];
  if (node) {
    rightLines.push(theme.bold(node.agent));
    rightLines.push(theme.fg("muted", node.model));
    rightLines.push("");
    rightLines.push(`Task: ${truncateText(node.task, rightWidth - "Task: ".length)}`);
    rightLines.push(`Status: ${node.status}`);
    if (node.result) {
      const usage = node.result.usage;
      if (usage) {
        rightLines.push(formatTokenStat(usage, node.result.toolCalls, formatElapsed(node.startedAt, node.completedAt ? new Date(node.completedAt).getTime() : Date.now())));
      }
      const tc = node.result.toolCalls ?? [];
      if (tc.length > 0) {
        rightLines.push("");
        rightLines.push(theme.bold("Activity:"));
        for (const call of tc.slice(0, MAX_TOOL_CALLS_DISPLAY)) {
          rightLines.push(`  ${formatActivityLine(call, rightWidth - DETAIL_INDENT)}`);
        }
        if (tc.length > MAX_TOOL_CALLS_DISPLAY) {
          rightLines.push(theme.fg("muted", `  … +${tc.length - MAX_TOOL_CALLS_DISPLAY} more`));
        }
      }
    }
  }

  const rowCount = Math.max(leftLines.length, rightLines.length, height);
  for (let i = 0; i < rowCount; i++) {
    const left = leftLines[i] ?? "";
    const right = rightLines[i] ?? "";
    const leftPadded = padVisible(left, leftWidth);
    const rightTrunc = visibleLen(right) > rightWidth ? right.slice(0, rightWidth - 1) + ELLIPSIS : right;
    lines.push(`${leftPadded}${rightTrunc}`);
  }

  return lines;
}

function renderDetailLevel(
  run: WorkflowRun,
  state: ViewState,
  phaseGroups: ReturnType<typeof buildPhaseGroups>,
  theme: ThemeLike,
  width: number,
  height: number,
): string[] {
  const lines: string[] = [];
  const pg = phaseGroups[state.phaseIdx];
  const node = pg?.nodes[state.agentIdx];
  if (!node) {
    lines.push(theme.fg("muted", "No agent selected."));
    while (lines.length < height) lines.push("");
    return lines;
  }

  void run; // run available for future error display
  const indent = " ".repeat(DETAIL_INDENT);
  const bodyWidth = width - DETAIL_INDENT - RIGHT_MARGIN;

  lines.push(theme.bold(`Agent: ${node.agent}`));
  lines.push(theme.fg("muted", `Model: ${node.model} · Status: ${node.status}`));
  lines.push("");

  // Prompt
  lines.push(theme.bold("Prompt:"));
  const promptLines = node.task.split("\n");
  const visiblePromptLines = state.promptExpanded ? promptLines : promptLines.slice(0, PROMPT_FOLD_LINES);
  for (const pl of visiblePromptLines) {
    lines.push(`${indent}${truncateText(pl, bodyWidth)}`);
  }
  if (promptLines.length > PROMPT_FOLD_LINES && !state.promptExpanded) {
    lines.push(theme.fg("muted", `${indent}… +${promptLines.length - PROMPT_FOLD_LINES} more lines (⏎ expand)`));
  }
  lines.push("");

  // Outcome
  if (node.result?.content) {
    lines.push(theme.bold("Outcome:"));
    const content = node.result.content;
    const contentLines = content.slice(0, OUTPUT_TRUNCATE_BYTES).split("\n");
    for (const cl of contentLines) {
      lines.push(`${indent}${truncateText(cl, bodyWidth)}`);
    }
  } else if (node.error) {
    lines.push(theme.bold(theme.fg("error", "Error:")));
    lines.push(`${indent}${truncateText(node.error, bodyWidth)}`);
  }

  while (lines.length < height) lines.push("");
  return lines;
}

function truncateText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleLen(text) <= maxWidth) return text;
  if (maxWidth <= 1) return ELLIPSIS;
  return text.slice(0, maxWidth - 1) + ELLIPSIS;
}
