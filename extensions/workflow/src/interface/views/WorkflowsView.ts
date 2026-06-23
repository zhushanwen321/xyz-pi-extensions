/**
 * Workflow Fullscreen TUI View — Three-level navigation（W5-T31 重写 + Bug #4 修复）.
 *
 * Level 0 (Phase):   左 phase list，右 agent overview
 * Level 1 (Agent):   左 agent list，右 agent summary
 * Level 2 (Detail):  完整 agent 执行详情
 *
 * 适配新 WorkflowRun 聚合根（替换旧 WorkflowInstance）+ 移除 restart（D-9）。
 * 旧 view 通过 WorkflowOrchestrator.pause/resume/abort/restart 操作 + events.subscribe
 * 推送更新；新 engine 拆掉 orchestrator 事件层（方向正确，AC-3），view 改用
 * 内部轮询（setInterval TICK_MS）从 run.state.trace 实时读 + requestRender。
 *
 * SDK 集成：ctx.ui.custom factory 返回 Component{render(width), handleInput(data),
 * invalidate()}，第二参数 `{overlay:true, overlayOptions}`（全屏 overlay，对齐 main +
 * subagents 扩展 + docs/pi-tui-development-guide.md §3.2）。按键经
 * matchesKey(data, KeyId) 解析（兼容 xterm/iTerm/kitty 转义序列差异）。
 * escape/ctrl+c 在 keybindings 同映射到 exit。
 *
 * Bug #4 修复（本次）：(a) overlay 参数缺失 → view 不全屏；(b) trace 快照冻结
 * → 运行中不刷新（加轮询 tick）；(c) 's' save 快捷键被 D-9 误删 → 恢复 save 模式；
 * (d) pause/resume/abort 失败静默吞 → 加 notify。
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";

import type { ExecutionTraceNode } from "../../engine/models/types.js";
import type { WorkflowRun } from "../../engine/models/workflow-run.js";
import { saveWorkflow } from "../../infra/workflow-files.js";
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
const NAV_LEVEL_DETAIL = 2;
type NavLevel = 0 | 1 | typeof NAV_LEVEL_DETAIL;
const MIN_BODY_LINES = 3;
const BODY_HEIGHT_NUMERATOR = 2;
const BODY_HEIGHT_DENOMINATOR = 3;
const MAX_TOOL_CALLS_DISPLAY = 3;
/** save overlay 居中计算的除数（÷2 居中）。 */
const OVERLAY_CENTER_DIVISOR = 2;

/** 轮询间隔：engine 无事件推送，view 自轮询 trace 变化（缺陷 #1+#5 修复）。 */
const TICK_MS = 1000;

/** tmp workflow 路径标志（用于判断是否允许 save）。 */
const TMP_PATH_POSIX = "/.tmp/";
const TMP_PATH_WIN = "\\.tmp\\";
/** 可打印 ASCII 字符下限（用于 save overlay 输入过滤）。 */
const PRINTABLE_CHAR_MIN = 32;

// ── Minimal TUI duck-types（避免直接 import TUI/KeybindingsManager 类型 ──
// 共享类型 fallback shared/types/mariozechner/index.d.ts 不导出 TUI 类，
// workspace 跨包 typecheck 会报 "no exported member 'TUI'"。
// 此处用结构化接口替代——只声明 view 实际用到的成员（requestRender + terminal）。

interface TuiLike {
  terminal: { columns: number; rows: number };
  requestRender(): void;
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
  // ── Save mode（Bug #4 恢复，缺陷 #3）──
  saveMode: boolean;
  saveInputValue: string;
  saveMessage: string;
  saveMsgOk: boolean;
}

function createInitialState(): ViewState {
  return {
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
}

/** 判断 run 是否来自临时 workflow（仅 tmp workflow 可 save）。 */
function isTmpRun(run: WorkflowRun): boolean {
  return run.spec.scriptPath.includes(TMP_PATH_POSIX) || run.spec.scriptPath.includes(TMP_PATH_WIN);
}

// ── View factory ──────────────────────────────────────────────

/**
 * 创建 workflow fullscreen view。
 *
 * @param run    WorkflowRun 聚合根（读 state.status/spec/trace/meta）
 * @param theme  ThemeLike（避免直接 import Pi runtime）
 * @param ctx    ExtensionContext（调 ui.custom 渲染 + ui.notify 错误反馈）
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

    function currentPhaseAgents() {
      const live = buildPhaseGroups([...run.state.trace.toArray()]);
      const pg = live[state.phaseIdx];
      return pg ? pg.nodes : [];
    }

    function clampSelections() {
      const live = buildPhaseGroups([...run.state.trace.toArray()]);
      if (state.phaseIdx >= live.length) state.phaseIdx = Math.max(0, live.length - 1);
      const agents = currentPhaseAgents();
      if (state.agentIdx >= agents.length) state.agentIdx = Math.max(0, agents.length - 1);
    }

    // 渲染缓存：与 main 同构。width 变化或交互后 invalidate，避免每帧重算。
    const cache = { width: undefined as number | undefined, lines: undefined as string[] | undefined };
    const requestRender = () => tui.requestRender();

    // ── 轮询 tick（缺陷 #1+#5 修复）：engine 无事件推送，view 自轮询 trace 变化 ──
    // 对齐 subagents list-view 的 setInterval 做法。TICK_MS=1s 对 trace 低频更新够用。
    const tick = setInterval(() => {
      if (state.disposed) return;
      cache.width = undefined;
      cache.lines = undefined;
      requestRender();
    }, TICK_MS);

    const wrappedDone = () => {
      if (state.disposed) return;
      state.disposed = true;
      clearInterval(tick);
      done();
    };

    // ── Key handling（SDK Component.handleInput 模式，对齐 main） ──
    // matchesKey(data, KeyId) 处理终端转义序列差异（xterm/iTerm/kitty），
    // 优于手写 \x1b[A 等原始序列。escape/ctrl+c 在 keybindings 里同映射到 exit。
    function handleInput(data: string): void {
      if (state.disposed) return;

      // ── Save mode 拦截（缺陷 #3 恢复）── save overlay 活跃时，所有键走 save 流程
      if (state.saveMode) {
        handleSaveModeInput(data);
        return;
      }

      // Escape / ctrl+c: level back or exit
      if (matchesKey(data, Key.escape)) {
        if (state.level === 0) {
          wrappedDone();
          return;
        }
        state.level = (state.level - 1) as NavLevel;
        state.promptExpanded = false;
        cache.width = undefined;
        requestRender();
        return;
      }

      // Navigation: up/down
      if (matchesKey(data, Key.up)) {
        if (state.level === 0 && state.phaseIdx > 0) {
          state.phaseIdx--;
          state.agentIdx = 0;
        } else if (state.level === 1 && state.agentIdx > 0) {
          state.agentIdx--;
        } else if (state.level === NAV_LEVEL_DETAIL && state.agentIdx > 0) {
          state.agentIdx--;
          state.promptExpanded = false;
        }
        cache.width = undefined;
        requestRender();
        return;
      }
      if (matchesKey(data, Key.down)) {
        if (state.level === 0) {
          const live = buildPhaseGroups([...run.state.trace.toArray()]);
          if (state.phaseIdx < live.length - 1) {
            state.phaseIdx++;
            state.agentIdx = 0;
          }
        } else if (state.level === 1) {
          const agents = currentPhaseAgents();
          if (state.agentIdx < agents.length - 1) state.agentIdx++;
        } else if (state.level === NAV_LEVEL_DETAIL) {
          const agents = currentPhaseAgents();
          if (state.agentIdx < agents.length - 1) {
            state.agentIdx++;
            state.promptExpanded = false;
          }
        }
        cache.width = undefined;
        requestRender();
        return;
      }

      // Enter: drill down (L0→L1→L2) or toggle prompt (L2)
      if (matchesKey(data, Key.enter)) {
        if (state.level === 0 && currentPhaseAgents().length > 0) {
          state.level = 1;
          state.agentIdx = 0;
        } else if (state.level === 1) {
          state.level = NAV_LEVEL_DETAIL;
          state.promptExpanded = false;
        } else if (state.level === NAV_LEVEL_DETAIL) {
          state.promptExpanded = !state.promptExpanded;
        }
        cache.width = undefined;
        requestRender();
        return;
      }

      // ── Lifecycle shortcuts (no restart per D-9) ──
      if (data === "p") {
        if (run.state.status === "running") {
          void actions.pause(run.runId)
            .then(() => { cache.width = undefined; requestRender(); })
            .catch((err: Error) => ctx.ui.notify(`Pause failed: ${err.message}`, "error"));
        } else if (run.state.status === "paused") {
          void actions.resume(run.runId)
            .then(() => { cache.width = undefined; requestRender(); })
            .catch((err: Error) => ctx.ui.notify(`Resume failed: ${err.message}`, "error"));
        }
        return;
      }
      if (data === "a") {
        if (run.state.status === "running" || run.state.status === "paused") {
          void actions.abort(run.runId)
            .then(() => { cache.width = undefined; requestRender(); })
            .catch((err: Error) => ctx.ui.notify(`Abort failed: ${err.message}`, "error"));
        }
        return;
      }

      // ── Save shortcut（缺陷 #3 恢复）：仅 tmp workflow 可 save ──
      if (data === "s" && isTmpRun(run)) {
        state.saveMode = true;
        state.saveInputValue = run.spec.scriptName;
        state.saveMessage = "";
        state.saveMsgOk = false;
        cache.width = undefined;
        requestRender();
        return;
      }
    }

    /** save overlay 内的按键处理（esc 取消 / enter 保存 / backspace 删除 / 可打印追加）。 */
    function handleSaveModeInput(data: string): void {
      // Escape → 退出 save 模式
      if (matchesKey(data, Key.escape)) {
        state.saveMode = false;
        cache.width = undefined;
        requestRender();
        return;
      }
      // Enter → 保存
      if (data === "\r" || data === "\n") {
        const name = state.saveInputValue.trim();
        if (!name) {
          state.saveMessage = "Please enter a name";
          state.saveMsgOk = false;
          cache.width = undefined;
          requestRender();
          return;
        }
        void saveWorkflow(run.spec.scriptName, name)
          .then((msg) => {
            state.saveMessage = msg;
            state.saveMsgOk = true;
            state.saveMode = false;
            cache.width = undefined;
            requestRender();
          })
          .catch((err: Error) => {
            state.saveMessage = err.message;
            state.saveMsgOk = false;
            cache.width = undefined;
            requestRender();
          });
        return;
      }
      // Backspace → 删除最后一个字符
      if (data === "\x7f" || data === "\b") {
        state.saveMessage = "";
        if (state.saveInputValue.length > 0) {
          state.saveInputValue = state.saveInputValue.slice(0, -1);
        }
        cache.width = undefined;
        requestRender();
        return;
      }
      // 可打印字符 → 追加
      if (data.length === 1 && data.charCodeAt(0) >= PRINTABLE_CHAR_MIN) {
        state.saveMessage = "";
        state.saveInputValue += data;
        cache.width = undefined;
        requestRender();
        return;
      }
      // 屏蔽其他键（↑↓ 等）
    }

    // ── Component（SDK 规范：render(width) → string[] + handleInput + invalidate） ──
    return {
      invalidate(): void {
        cache.width = undefined;
        cache.lines = undefined;
      },
      render(width: number): string[] {
        if (cache.lines && cache.width === width) return cache.lines;
        clampSelections();
        const height = tui.terminal.rows;
        // 缺陷 #1 修复：每次 render 从 run.state.trace 实时读（toArray 返回内部数组引用，
        // 后续 trace.append 会反映到 view），不再用 factory 时的冻结快照。
        const liveGroups = buildPhaseGroups([...run.state.trace.toArray()]);
        const raw = renderLayout(run, state, liveGroups, theme, width, height);
        // Pad to terminal height so the overlay fills the screen (matches main 行为）
        const lines = raw.length < height
          ? [...raw, ...Array.from({ length: height - raw.length }, () => "")]
          : raw;
        cache.width = width;
        cache.lines = lines;
        return lines;
      },
      handleInput,
    };
  }, {
    // 缺陷 #2 修复：overlay 第二参数（对齐 main + subagents + pi-tui guide §3.2）
    overlay: true,
    overlayOptions: { anchor: "center" as const, width: "100%", maxHeight: "100%", margin: 0 },
  });
}

// ── Layout rendering（box-drawing 框架，对齐 main）──────────────
//
// 视觉结构（与 main 一致）：
//   ╭───────────────────────────────────────────────────╮
//   │ name (bold)                  ● status · x/y · Ns │  ← header
//   ├───────────────────────────────────────────────────┤
//   │ Phases            │ title · N agents              │
//   │ ────────────────  │ ──────────────────             │  ← body
//   │ ❯ ● 1 build 0/2   │   ● builder    model  ...     │
//   │   ● 2 deploy 0/1  │   ● tester     model  ...     │
//   │ (pad)             │ (pad)                          │
//   ╰───────────────────────────────────────────────────╯
//     ↑↓ phase · ⏎ enter · p pause · a abort · s save · esc back  ← footer (框外)
//
//   body = sidebar(SIDEBAR_WIDTH) │ main(rest)
//   save overlay 活跃时居中覆盖 body。

function bodyHeight(screenHeight: number): number {
  // header(2: name+desc/blank) + border(1) + body + border(1) + footer(1)
  const HEADER_FOOTER_LINES = 6;
  return Math.max(MIN_BODY_LINES, Math.floor((screenHeight * BODY_HEIGHT_NUMERATOR) / BODY_HEIGHT_DENOMINATOR) - HEADER_FOOTER_LINES);
}

const BUDGET_TOKENS_DIVISOR = 1000;
const BUDGET_COST_DECIMALS = 4;

/** status → 语义色标签（L2 detail 头用）。 */
function statusLabel(status: string, theme: ThemeLike): string {
  switch (status) {
    case "completed": return theme.fg("success", status);
    case "running": return theme.fg("warning", status);
    case "failed": return theme.fg("error", status);
    default: return theme.fg("muted", status);
  }
}

function renderLayout(
  run: WorkflowRun,
  state: ViewState,
  phaseGroups: ReturnType<typeof buildPhaseGroups>,
  theme: ThemeLike,
  screenWidth: number,
  screenHeight: number,
): string[] {
  const lines: string[] = [];
  const contentWidth = screenWidth - BOX_BORDER_CHARS;
  const mainWidth = contentWidth - SIDEBAR_WIDTH - 1; // -1 for the │ divider

  renderHeader(lines, run, theme, contentWidth);

  const phase = phaseGroups[state.phaseIdx] ?? phaseGroups[0];
  const agents = phase?.nodes ?? [];
  const now = Date.now();

  const bodyStart = lines.length;
  if (state.level === 0) {
    renderLevel0(lines, run, phaseGroups, state, theme, mainWidth, now);
  } else if (state.level === 1) {
    renderLevel1(lines, run, phaseGroups, state, theme, mainWidth, now);
  } else {
    renderLevel2(lines, run, agents, state, theme, mainWidth, now);
  }

  // Pad body to min height
  const minBody = bodyHeight(screenHeight);
  const emptyBodyLine = padVisible("", SIDEBAR_WIDTH) + "│" + padVisible("", mainWidth);
  while (lines.length - bodyStart < minBody) {
    lines.push(emptyBodyLine);
  }

  // Wrap body lines with │ borders + sidebar divider
  for (let i = bodyStart; i < lines.length; i++) {
    lines[i] = "│" + padVisible(lines[i], contentWidth) + "│";
  }

  lines.push("╰" + "─".repeat(contentWidth) + "╯");

  // Save overlay（缺陷 #3）：居中覆盖 body
  if (state.saveMode) {
    const overlayLines = renderSaveOverlay(state, theme, screenWidth);
    const overlayStart = Math.max(bodyStart, bodyStart + Math.floor((lines.length - bodyStart - overlayLines.length) / OVERLAY_CENTER_DIVISOR));
    for (let i = 0; i < overlayLines.length && overlayStart + i < lines.length; i++) {
      lines[overlayStart + i] = overlayLines[i];
    }
  }

  // Footer（框外，对齐 main renderFooter）
  renderFooter(lines, run, state, theme);
  return lines;
}

/** Header：╭─╮ + name(bold) + 右侧 status/agents/elapsed/budget。 */
function renderHeader(
  lines: string[],
  run: WorkflowRun,
  theme: ThemeLike,
  contentWidth: number,
): void {
  const traceArr = run.state.trace.toArray();
  const completed = traceArr.filter((n) => n.status === "completed").length;
  const total = traceArr.length;
  const elapsed = formatElapsed(run.meta.startedAt);
  const headerRight = `${formatStatusBadge(run.state.status, theme)} · ${completed}/${total} agents · ${elapsed}`;
  const budget = run.state.budget;
  const budgetStr = `${Math.round(budget.usedTokens / BUDGET_TOKENS_DIVISOR)}k/${budget.maxTokens ? `${Math.round(budget.maxTokens / BUDGET_TOKENS_DIVISOR)}k` : "∞"} tok · $${budget.usedCost.toFixed(BUDGET_COST_DECIMALS)}`;

  const nameLine = theme.bold(run.spec.scriptName);
  const rightPart = theme.fg("muted", `${headerRight} · ${budgetStr}`);

  lines.push("╭" + "─".repeat(contentWidth) + "╮");
  lines.push("│" + padVisible(nameLine, contentWidth) + "│");

  if (run.spec.description) {
    const maxDesc = contentWidth - visibleLen(rightPart) - 1;
    const descText = run.spec.description.length > maxDesc
      ? run.spec.description.slice(0, maxDesc - 1) + ELLIPSIS
      : run.spec.description;
    const descPart = theme.fg("dim", descText);
    const padLen = Math.max(0, contentWidth - visibleLen(descPart) - visibleLen(rightPart));
    lines.push("│" + descPart + " ".repeat(padLen) + rightPart + "│");
  } else {
    lines.push("│" + padVisible(rightPart, contentWidth) + "│");
  }
  lines.push("├" + "─".repeat(contentWidth) + "┤");
}

/** Footer（框外）：nav hint + lifecycle shortcuts + esc/ctrl+c。 */
function renderFooter(
  lines: string[],
  run: WorkflowRun,
  state: ViewState,
  theme: ThemeLike,
): void {
  const navPart = state.level === 0
    ? "↑↓ phase · ⏎ enter"
    : state.level === 1
      ? "↑↓ agent · ⏎ detail"
      : "↑↓ agent · ⏎ prompt";
  const actionParts: string[] = [];
  const status = run.state.status;
  if (status === "running" || status === "paused") {
    actionParts.push("a abort");
    actionParts.push(status === "paused" ? "p resume" : "p pause");
  }
  if (isTmpRun(run)) actionParts.push("s save");
  actionParts.push("esc back");
  const footer = `${navPart} · ${actionParts.join(" · ")}`;
  lines.push("");
  lines.push(theme.fg("muted", footer));
}

/** mergeBody：左侧 sidebar + │ divider + 右侧 main，拼成 body 行。 */
function mergeBody(
  lines: string[],
  leftLines: string[],
  rightLines: string[],
): void {
  const bodyHeightVal = Math.max(leftLines.length, rightLines.length);
  for (let i = 0; i < bodyHeightVal; i++) {
    const left = padVisible(leftLines[i] ?? "", SIDEBAR_WIDTH);
    lines.push(left + "│" + (rightLines[i] ?? ""));
  }
}

// ── Level 0: Phase selection ──────────────────────────────────

function renderLevel0(
  lines: string[],
  run: WorkflowRun,
  phases: ReturnType<typeof buildPhaseGroups>,
  state: ViewState,
  theme: ThemeLike,
  mainWidth: number,
  now: number,
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
      ? `${selectedPhase.name} · ${selectedPhase.nodes.length} agents · ${formatElapsed(run.meta.startedAt, now)}`
      : `${selectedPhase.nodes.length} agents · ${formatElapsed(run.meta.startedAt, now)}`;
    rightLines.push(theme.fg("muted", title));
    rightLines.push("─".repeat(mainWidth));
    for (const node of selectedPhase.nodes) {
      rightLines.push(formatAgentOneLiner(node, theme));
    }
  }

  mergeBody(lines, leftLines, rightLines);
}

// ── Level 1: Agent selection ──────────────────────────────────

function renderLevel1(
  lines: string[],
  _run: WorkflowRun,
  phases: ReturnType<typeof buildPhaseGroups>,
  state: ViewState,
  theme: ThemeLike,
  mainWidth: number,
  now: number,
): void {
  const leftLines: string[] = [];
  const rightLines: string[] = [];

  leftLines.push(theme.fg("muted", "Phases"));
  leftLines.push("─".repeat(SIDEBAR_WIDTH));
  for (let i = 0; i < phases.length; i++) {
    leftLines.push(formatPhaseLine(phases[i], i, i === state.phaseIdx, theme, SIDEBAR_WIDTH));
  }

  const currentPhase = phases[state.phaseIdx];
  const agents = currentPhase?.nodes ?? [];
  if (currentPhase) {
    const title = currentPhase.name
      ? `${currentPhase.name} · ${currentPhase.nodes.length} agents`
      : `${currentPhase.nodes.length} agents`;
    rightLines.push(theme.fg("muted", title));
    rightLines.push("─".repeat(mainWidth));
  }
  for (let i = 0; i < agents.length; i++) {
    const node = agents[i];
    const pointer = i === state.agentIdx ? "❯ " : "  ";
    const dot = statusDotStr(node.status, theme);
    const elapsed = formatElapsed(
      node.startedAt,
      node.completedAt ? new Date(node.completedAt).getTime() : now,
    );
    const tok = node.result?.usage;
    const tokStr = tok ? `${Math.round((tok.input + tok.output) / BUDGET_TOKENS_DIVISOR)}k tok` : "";
    const tcCount = node.result?.toolCalls?.length ?? 0;
    rightLines.push(`${pointer}${dot} ${node.agent}    ${node.model}    ${tokStr} · ${tcCount} tools · ${elapsed}`);
  }

  mergeBody(lines, leftLines, rightLines);
}

// ── Level 2: Execution detail ─────────────────────────────────

function renderWorkerLogSection(
  rightLines: string[],
  run: WorkflowRun,
  mainWidth: number,
  theme: ThemeLike,
): void {
  const logs = run.state.errorLogs;
  if (!logs || logs.length === 0) return;
  const total = logs.length;
  const WORKER_LOG_SHOW = 20;
  const showCount = Math.min(total, WORKER_LOG_SHOW);
  const label = total > showCount
    ? `Worker diagnostics · last ${showCount} of ${total}`
    : `Worker diagnostics · ${total} entr${total !== 1 ? "ies" : "y"}`;
  rightLines.push(theme.fg("warning", label));
  const start = total - showCount;
  for (let i = start; i < total; i++) {
    const entry = logs[i];
    const levelToken = entry.level === "error" ? "error" : entry.level === "warn" ? "warning" : "muted";
    const prefix = `[${entry.level}]`;
    const line = `  ${prefix} ${entry.message}`.slice(0, mainWidth - BOX_BORDER_CHARS);
    rightLines.push(theme.fg(levelToken, line));
  }
  rightLines.push("");
}

function renderPromptSection(
  rightLines: string[],
  node: ExecutionTraceNode,
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
  node: ExecutionTraceNode,
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
      rightLines.push(`  ${formatActivityLine(toolCalls[i], mainWidth - BOX_BORDER_CHARS)}`);
    }
  } else {
    rightLines.push(theme.fg("muted", "Activity"));
    rightLines.push(theme.fg("dim", `  ${node.status === "running" ? "(no tool calls yet)" : "(no activity recorded)"}`));
  }
  rightLines.push("");
}

function renderOutcomeSection(
  rightLines: string[],
  node: ExecutionTraceNode,
  mainWidth: number,
  theme: ThemeLike,
): void {
  rightLines.push(theme.fg("muted", "Outcome"));
  if (node.status === "running") {
    rightLines.push(theme.fg("dim", "  Still running..."));
  } else if (node.result?.error) {
    rightLines.push(theme.fg("error", `  ${node.result.error.slice(0, mainWidth - BOX_BORDER_CHARS)}`));
  } else if (node.result?.content) {
    const raw = node.result.content;
    const OUTCOME_TAIL_LINES = 5;
    if (Buffer.byteLength(raw, "utf8") > OUTPUT_TRUNCATE_BYTES) {
      const truncated = Buffer.from(raw, "utf8").slice(0, OUTPUT_TRUNCATE_BYTES).toString("utf8");
      const allLines = truncated.split("\n");
      const tail = allLines.slice(-OUTCOME_TAIL_LINES);
      rightLines.push(...tail.map((l) => `  ${l.slice(0, mainWidth - BOX_BORDER_CHARS)}`));
      rightLines.push(theme.fg("dim", "  (truncated)"));
    } else {
      const allLines = raw.split("\n");
      const tail = allLines.slice(-OUTCOME_TAIL_LINES);
      rightLines.push(...tail.map((l) => `  ${l.slice(0, mainWidth - BOX_BORDER_CHARS)}`));
    }
  }
}

function renderLevel2(
  lines: string[],
  run: WorkflowRun,
  agents: ExecutionTraceNode[],
  state: ViewState,
  theme: ThemeLike,
  mainWidth: number,
  now: number,
): void {
  const leftLines: string[] = [];
  const rightLines: string[] = [];

  // Left: agents title + agent names
  leftLines.push(theme.fg("muted", "Agents"));
  leftLines.push("─".repeat(SIDEBAR_WIDTH));
  const AGENT_NAME_BUDGET = 4; // pointer(2) + spacing(2)
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    const pointer = i === state.agentIdx ? "❯ " : "  ";
    const maxNameWidth = SIDEBAR_WIDTH - AGENT_NAME_BUDGET;
    const agentName = visibleLen(a.agent) > maxNameWidth
      ? a.agent.slice(0, maxNameWidth - 1) + ELLIPSIS
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
    renderWorkerLogSection(rightLines, run, mainWidth, theme);
    renderPromptSection(rightLines, node, state, theme);
    renderActivitySection(rightLines, node, mainWidth, theme);
    renderOutcomeSection(rightLines, node, mainWidth, theme);
  }

  mergeBody(lines, leftLines, rightLines);
}

// ── Save overlay（缺陷 #3 恢复，从 main 移植简化版）────────────

/**
 * save overlay——名称输入框 + 状态消息。
 * refactor 的 saveWorkflow 仅支持 project scope（workflow-files.ts 统一为 rename），
 * 故去掉 main 的 scope 切换（Tab），只保留名称输入。
 */
function renderSaveOverlay(
  state: ViewState,
  theme: ThemeLike,
  width: number,
): string[] {
  const contentWidth = width - BOX_BORDER_CHARS;
  const lines: string[] = [];

  lines.push("╭" + "─".repeat(contentWidth) + "╮");

  // Title
  lines.push("│" + padVisible(theme.bold(" Save dynamic workflow"), contentWidth) + "│");

  // Destination preview
  const destName = state.saveInputValue || "(name)";
  const destLine = `.pi/workflows/${destName}.js`;
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
