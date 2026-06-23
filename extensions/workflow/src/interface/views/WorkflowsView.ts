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
const RIGHT_MARGIN = 2;
const DETAIL_INDENT = 2;
const POINTER_WIDTH = 2;
const NAV_LEVEL_DETAIL = 2;
type NavLevel = 0 | 1 | typeof NAV_LEVEL_DETAIL;
const MIN_BODY_LINES = 3;
const BODY_HEIGHT_NUMERATOR = 2;
const BODY_HEIGHT_DENOMINATOR = 3;
const MAX_TOOL_CALLS_DISPLAY = 3;

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
  const saveHint = isTmpRun(run) ? "s=save" : "";
  const navHint = state.level === 0 ? "↑↓ phases · ⏎ drill in" : state.level === 1 ? "↑↓ agents · ⏎ detail" : "⏎ collapse";
  const footer = [navHint, pauseResumeHint, abortHint, saveHint, "esc=back · ctrl+c=exit"].filter(Boolean).join(" · ");
  lines.push(padVisible(theme.fg("muted", footer), innerWidth));

  // ── Save overlay（缺陷 #3 恢复）：saveMode 活跃时叠加在底部 ──
  if (state.saveMode) {
    lines.push(...renderSaveOverlay(state, theme, innerWidth));
  }

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

function truncateText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleLen(text) <= maxWidth) return text;
  if (maxWidth <= 1) return ELLIPSIS;
  return text.slice(0, maxWidth - 1) + ELLIPSIS;
}
