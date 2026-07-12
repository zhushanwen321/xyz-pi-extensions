/**
 * Workflow Fullscreen TUI View — Three-level navigation.
 *
 * Level 0 (Phase): 左 phase list，右 agent overview
 * Level 1 (Agent): 左 agent list，右 agent summary
 * Level 2 (Detail): 完整 agent 执行详情
 *
 * 读 WorkflowRun 聚合根；移除 restart（D-9）。新 engine 无 orchestrator 事件层
 * （AC-3），view 改用内部轮询（setInterval TICK_MS）从 run.state.trace 实时读 +
 * requestRender。
 *
 * SDK 集成：ctx.ui.custom factory 返回 Component{render(width), handleInput(data),
 * invalidate}，第二参数 `{overlay:true, overlayOptions}`（全屏 overlay，对齐 main +
 * subagents 扩展 + docs/pi-tui-development-guide.md §3.2）。按键经
 * matchesKey(data, KeyId) 解析（兼容 xterm/iTerm/kitty 转义序列差异）。
 * escape/ctrl+c 在 keybindings 同映射到 exit。
 *
 * 关键实现点：(a) overlay 第二参数必须传，否则 view 不全屏；(b) trace 必须 per-render
 * 重读（run.state.trace.toArray 返回内部数组引用，trace.append 后下次 render 可见），
 * 配 1s tick invalidate + requestRender 保证运行中刷新；(c) 's' save 模式无条件可用
 * （saveWorkflow 内部对非 tmp workflow 返回错误消息）；(d) pause/resume/abort 失败时
 * notify 反馈，不静默吞。
 */

import { promises as fsPromises } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";

import {
  getAllToolCalls,
  projectLiveProgress,
} from "../../execution/execution-record.ts";
import type { ExecutionTraceNode } from "../../orchestration/models/types.ts";
import type { WorkflowRun } from "../../orchestration/models/workflow-run.ts";
import { saveWorkflow } from "../../orchestration/workflow-files.ts";
import {
  BOX_BORDER_CHARS,
  BUDGET_TOKENS_DIVISOR,
  buildPhaseGroups,
  ELLIPSIS,
  formatActivityLine,
  formatAgentOneLiner,
  formatElapsed,
  formatElapsedSeconds,
  formatPhaseLine,
  formatStatusBadge,
  padVisible,
  SIDEBAR_WIDTH,
  statusDotStr,
  TERM_ROWS_FALLBACK,
  type ThemeLike,
  visibleLen,
} from "./format.ts";

// L2 详情内容构建 + 滚动按键（纯函数）抽到 detail-content.ts；此处 re-export 保持
// view 的对外 API 不变（测试仍从 WorkflowsView 导入）。
export {
  buildDetailContent,
  detailContentLength,
  type DetailKeyResult,
  type DetailScrollContext,
  processDetailKey,
} from "./detail-content.ts";
import { buildDetailContent, detailContentLength, type DetailScrollContext,processDetailKey } from "./detail-content.ts";

// ── TUI layout constants ──────────────────────────────────────

const NAV_LEVEL_DETAIL = 2;
type NavLevel = 0 | 1 | typeof NAV_LEVEL_DETAIL;
const MIN_BODY_LINES = 3;
const BODY_HEIGHT_NUMERATOR = 2;
const BODY_HEIGHT_DENOMINATOR = 3;
/** save overlay 居中计算的除数（÷2 居中）。 */
const OVERLAY_CENTER_DIVISOR = 2;

/** 轮询间隔：engine 无事件推送，view 自轮询 trace 变化。
 *  200ms 对齐 subagents spinner 节奏，保证 agent 运行中 live 进度（tool calls/activity）流式可见。 */
const TICK_MS = 200;

/** 可打印 ASCII 字符下限（用于 save overlay 输入过滤）。 */
const PRINTABLE_CHAR_MIN = 32;

// ── 边框着色 helper（统一 borderMuted，避 ANSI 嵌套失色）──────────
// 对齐 subagents list-component.ts 的 b/dash/dashes/titleBorder/plainBorder/walled。
// 所有 ╭╮╰╯├┤┬┴─│ 统一走 borderMuted token，保证边框颜色一致。

/** 着色单个框线字符（borderMuted）。 */
function b(theme: ThemeLike, s: string): string {
  return theme.fg("borderMuted", s);
}
/** 着色单字符填充用的 ─（供 segFillColored 的 fillStyled）。 */
function dash(theme: ThemeLike): string {
  return theme.fg("borderMuted", "─");
}
/** 满宽 ─ 填充串（borderMuted）。n 次单字符着色，ANSI 自然延续。 */
function dashes(theme: ThemeLike, n: number): string {
  return dash(theme).repeat(Math.max(0, n));
}
/** 纯线顶/底框（无标题）：左角 + ─×W + 右角。 */
function plainBorder(theme: ThemeLike, left: string, right: string, contentWidth: number): string {
  return b(theme, left) + dashes(theme, contentWidth) + b(theme, right);
}
/** 内容行墙：│ + 内容(pad 到 contentWidth) + │，墙字符 borderMuted。 */
function walled(theme: ThemeLike, content: string, contentWidth: number): string {
  return `${b(theme, "│")}${padVisible(content, contentWidth)}${b(theme, "│")}`;
}

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
 // ── Save mode ──
  saveMode: boolean;
  saveInputValue: string;
  saveMessage: string;
  saveMsgOk: boolean;
 // ── L0/L1 列表滚动 ──
  /** 左侧 phase list 滚动 offset。 */
  phaseScrollOffset: number;
  /** 右侧 agent list 滚动 offset。 */
  agentScrollOffset: number;
 // ── L2 详情滚动 ──
  /** 右侧 detail 当前滚动 offset（render 路径 clamp 收敛）。 */
  detailScrollOffset: number;
  /** running 态是否自动钉底部（用户 PgUp 后置 false，End/PgDn 到底恢复 true）。 */
  followTail: boolean;
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
    phaseScrollOffset: 0,
    agentScrollOffset: 0,
    detailScrollOffset: 0,
    followTail: true, // 默认钉底（对齐 subagents 进详情即底部对齐）
  };
}

// ── View factory ──────────────────────────────────────────────

/**
 * 创建 workflow fullscreen view。
 *
 * @param run WorkflowRun 聚合根（读 state.status/spec/trace/meta）
 * @param theme ThemeLike（避免直接 import Pi runtime）
 * @param ctx ExtensionContext（调 ui.custom 渲染 + ui.notify 错误反馈）
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

 // 渲染缓存：缓存 key = width×rows，终端 resize 改高度时缓存失效（防行数不匹配终端）
    const cache = { key: undefined as string | undefined, lines: undefined as string[] | undefined };
    const requestRender = () => tui.requestRender();

 // ── 轮询 tick：engine 无事件推送，view 自轮询 trace 变化 ──
 // 每 200ms 重绘，保证 header 动态数据（elapsed/tokens）实时更新。
 // 行数固定后，diff-redraw 引擎能正确逐行对比，不会出现残影。
    const tick = setInterval(() => {
      if (state.disposed) return;
      cache.key = undefined;
      cache.lines = undefined;
      requestRender();
    }, TICK_MS);

    const wrappedDone = () => {
      if (state.disposed) return;
      state.disposed = true;
      clearInterval(tick);
      done();
    };

 // ── L2 详情滚动辅助 ──
    /** 安全读 terminal.rows（duck-type 失败兜底，对齐 subagents termRows）。 */
    function termRows(): number {
      const rows = tui.terminal?.rows;
      return typeof rows === "number" && rows > 0 ? rows : TERM_ROWS_FALLBACK;
    }
    /** L2 右侧 detail viewport 高度（与 renderLayout 的 viewH 同源）。 */
    function detailViewportHeight(): number {
      return Math.max(MIN_BODY_LINES, bodyHeight(termRows()));
    }
    /** 重置 detail 滚动到底部对齐（切 agent / 进 L2 时调用）。 */
    function resetDetailScroll(): void {
      state.detailScrollOffset = Number.MAX_SAFE_INTEGER; // render clamp 收敛到 max
      state.followTail = true;
    }

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
        cache.key = undefined;
        requestRender();
        return;
      }

 // ── L2 详情滚动（PgUp/PgDn/Home/End，对齐 subagents processKey 阶段 2） ──
 // up/down 在 L2 用于切 agent，故滚动键独立于此；未命中则落到下面的 up/down/enter。
      if (state.level === NAV_LEVEL_DETAIL) {
        const node = currentPhaseAgents()[state.agentIdx];
        if (node) {
          const detailCtx: DetailScrollContext = {
            viewportHeight: detailViewportHeight(),
            contentLines: detailContentLength(node, state, run, theme),
            isRunning: node.status === "running",
          };
          const r = processDetailKey(
            data,
            { scrollOffset: state.detailScrollOffset, followTail: state.followTail },
            detailCtx,
          );
          if (r.handled) {
            state.detailScrollOffset = r.scrollOffset;
            state.followTail = r.followTail;
            cache.key = undefined;
            requestRender();
            return;
          }
        }
      }

 // Navigation: up/down
      if (matchesKey(data, Key.up)) {
        if (state.level === 0 && state.phaseIdx > 0) {
          state.phaseIdx--;
          state.agentIdx = 0;
          state.phaseScrollOffset = 0; // 切 phase → 重置滚动
          state.agentScrollOffset = 0; // 切 phase → 重置滚动
        } else if (state.level === 1 && state.agentIdx > 0) {
          state.agentIdx--;
          // agentScrollOffset 由 renderLevel1 自动调整
        } else if (state.level === NAV_LEVEL_DETAIL && state.agentIdx > 0) {
          state.agentIdx--;
          state.promptExpanded = false;
          resetDetailScroll(); // 切 agent → 底部对齐（对齐 subagents 进详情即钉底）
        }
        cache.key = undefined;
        requestRender();
        return;
      }
      if (matchesKey(data, Key.down)) {
        if (state.level === 0) {
          const live = buildPhaseGroups([...run.state.trace.toArray()]);
          if (state.phaseIdx < live.length - 1) {
            state.phaseIdx++;
            state.agentIdx = 0;
            state.phaseScrollOffset = 0; // 切 phase → 重置滚动
            state.agentScrollOffset = 0; // 切 phase → 重置滚动
          }
        } else if (state.level === 1) {
          const agents = currentPhaseAgents();
          if (state.agentIdx < agents.length - 1) state.agentIdx++;
          // agentScrollOffset 由 renderLevel1 自动调整
        } else if (state.level === NAV_LEVEL_DETAIL) {
          const agents = currentPhaseAgents();
          if (state.agentIdx < agents.length - 1) {
            state.agentIdx++;
            state.promptExpanded = false;
            resetDetailScroll(); // 切 agent → 底部对齐
          }
        }
        cache.key = undefined;
        requestRender();
        return;
      }

 // Enter: drill down (L0→L1→L2) or toggle prompt (L2)
      if (matchesKey(data, Key.enter)) {
        if (state.level === 0 && currentPhaseAgents().length > 0) {
          state.level = 1;
          state.agentIdx = 0;
          state.agentScrollOffset = 0; // 进 L1 → 重置滚动
        } else if (state.level === 1) {
          state.level = NAV_LEVEL_DETAIL;
          state.promptExpanded = false;
          resetDetailScroll(); // 进 L2 → 底部对齐
        } else if (state.level === NAV_LEVEL_DETAIL) {
          state.promptExpanded = !state.promptExpanded;
          // 展开/折叠改变内容长度，render 路径 clamp 收敛；保持当前锚点语义
        }
        cache.key = undefined;
        requestRender();
        return;
      }

 // ── Lifecycle shortcuts (no restart per D-9) ──
      if (data === "p") {
        if (run.state.status === "running") {
          void actions.pause(run.runId)
            .then(() => { cache.key = undefined; requestRender(); })
            .catch((err: Error) => ctx.ui.notify(`Pause failed: ${err.message}`, "error"));
        } else if (run.state.status === "paused") {
          void actions.resume(run.runId)
            .then(() => { cache.key = undefined; requestRender(); })
            .catch((err: Error) => ctx.ui.notify(`Resume failed: ${err.message}`, "error"));
        }
        return;
      }
      if (data === "a") {
        if (run.state.status === "running" || run.state.status === "paused") {
          void actions.abort(run.runId)
            .then(() => { cache.key = undefined; requestRender(); })
            .catch((err: Error) => ctx.ui.notify(`Abort failed: ${err.message}`, "error"));
        }
        return;
      }

 // ── Save shortcut（对齐 main：总是进入 save mode，非 tmp 时 saveWorkflow 报错） ──
      if (data === "s") {
        state.saveMode = true;
        state.saveInputValue = run.spec.scriptName;
        state.saveMessage = "";
        state.saveMsgOk = false;
        cache.key = undefined;
        requestRender();
        return;
      }

 // ── Trace export（对齐 main 的 S 键）：导出完整 trace 到 Markdown 文件 ──
      if (data === "S") {
        saveTraceToFile(run, ctx);
        return;
      }
    }

 /** save overlay 内的按键处理（esc 取消 / enter 保存 / backspace 删除 / 可打印追加）。 */
    function handleSaveModeInput(data: string): void {
 // Escape → 退出 save 模式
      if (matchesKey(data, Key.escape)) {
        state.saveMode = false;
        cache.key = undefined;
        requestRender();
        return;
      }
 // Enter → 保存
      if (data === "\r" || data === "\n") {
        const name = state.saveInputValue.trim();
        if (!name) {
          state.saveMessage = "Please enter a name";
          state.saveMsgOk = false;
          cache.key = undefined;
          requestRender();
          return;
        }
        void saveWorkflow(run.spec.scriptName, name)
          .then((msg) => {
            state.saveMessage = msg;
            state.saveMsgOk = true;
            state.saveMode = false;
            cache.key = undefined;
            requestRender();
          })
          .catch((err: Error) => {
            state.saveMessage = err.message;
            state.saveMsgOk = false;
            cache.key = undefined;
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
        cache.key = undefined;
        requestRender();
        return;
      }
 // 可打印字符 → 追加
      if (data.length === 1 && data.charCodeAt(0) >= PRINTABLE_CHAR_MIN) {
        state.saveMessage = "";
        state.saveInputValue += data;
        cache.key = undefined;
        requestRender();
        return;
      }
 // 屏蔽其他键（↑↓ 等）
    }

 // ── Component（SDK 规范：render(width) → string[] + handleInput + invalidate） ──
    return {
      invalidate(): void {
        cache.key = undefined;
        cache.lines = undefined;
      },
      render(width: number): string[] {
        const height = tui.terminal.rows;
        const key = `${width}x${height}`;
        if (cache.lines && cache.key === key) return cache.lines;
        clampSelections();
 // 缺陷 #1 修复：每次 render 从 run.state.trace 实时读（toArray 返回内部数组引用，
 // 后续 trace.append 会反映到 view），不再用 factory 时的冻结快照。
        const liveGroups = buildPhaseGroups([...run.state.trace.toArray()]);
        const raw = renderLayout(run, state, liveGroups, theme, width, height);
 // Pad to terminal height so the overlay fills the screen (matches main 行为）
        const lines = raw.length < height
          ? [...raw, ...Array.from({ length: height - raw.length }, () => "")]
          : raw;
        cache.key = key;
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
// ╭───────────────────────────────────────────────────╮
// │ name (bold) ● status · x/y · Ns │ ← header
// ├───────────────────────────────────────────────────┤
// │ Phases │ title · N agents │
// │ ──────────────── │ ────────────────── │ ← body
// │ ❯ ● 1 build 0/2 │ ● builder model ... │
// │ ● 2 deploy 0/1 │ ● tester model ... │
// │ (pad) │ (pad) │
// ╰───────────────────────────────────────────────────╯
// ↑↓ phase · ⏎ enter · p pause · a abort · s save · esc back ← footer (框外)
//
// body = sidebar(SIDEBAR_WIDTH) │ main(rest)
// save overlay 活跃时居中覆盖 body。

function bodyHeight(screenHeight: number): number {
 // header(2: name+desc/blank) + border(1) + body + border(1) + footer(1)
  const HEADER_FOOTER_LINES = 6;
  return Math.max(MIN_BODY_LINES, Math.floor((screenHeight * BODY_HEIGHT_NUMERATOR) / BODY_HEIGHT_DENOMINATOR) - HEADER_FOOTER_LINES);
}

const BUDGET_COST_DECIMALS = 4;

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

 // 固定 body 高度，确保 renderLayout 始终返回固定行数
  const viewH = Math.max(MIN_BODY_LINES, bodyHeight(screenHeight));

  const bodyStart = lines.length;
  if (state.level === 0) {
    renderLevel0(lines, run, phaseGroups, state, theme, mainWidth, now, viewH);
  } else if (state.level === 1) {
    renderLevel1(lines, run, phaseGroups, state, theme, mainWidth, now, viewH);
  } else {
    // L2 详情走固定高度 viewport（右侧滚动），高度 = minBody（与 L0/L1 最小一致）
    renderLevel2(lines, run, agents, state, theme, mainWidth, now, viewH);
  }

 // Padding 已在各 renderLevel 内部处理，无需额外 padding

 // Wrap body lines with │ borders + sidebar divider（统一 borderMuted）
  for (let i = bodyStart; i < lines.length; i++) {
    lines[i] = walled(theme, lines[i], contentWidth);
  }

  lines.push(plainBorder(theme, "╰", "╯", contentWidth));

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

  const nameLine = run.spec.slug
    ? `${theme.bold(run.spec.scriptName)}${theme.fg("dim", " · ")}${theme.fg("accent", run.spec.slug)}`
    : theme.bold(run.spec.scriptName);
  const rightPart = theme.fg("muted", `${headerRight} · ${budgetStr}`);

  lines.push(plainBorder(theme, "╭", "╮", contentWidth));
  lines.push(walled(theme, nameLine, contentWidth));

  if (run.spec.description) {
    const maxDesc = contentWidth - visibleLen(rightPart) - 1;
    const descText = run.spec.description.length > maxDesc
      ? run.spec.description.slice(0, maxDesc - 1) + ELLIPSIS
      : run.spec.description;
    const descPart = theme.fg("dim", descText);
    const padLen = Math.max(0, contentWidth - visibleLen(descPart) - visibleLen(rightPart));
    lines.push(`${b(theme, "│")}${descPart}${" ".repeat(padLen)}${rightPart}${b(theme, "│")}`);
  } else {
    lines.push(walled(theme, rightPart, contentWidth));
  }
  lines.push(plainBorder(theme, "├", "┤", contentWidth));
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
      : "↑↓ agent · ⏎ prompt · PgUp/PgDn scroll";
  const actionParts: string[] = [];
  const status = run.state.status;
  if (status === "running" || status === "paused") {
    actionParts.push("a abort");
    actionParts.push(status === "paused" ? "p resume" : "p pause");
  }
  actionParts.push("s save");
  actionParts.push("S trace");
  actionParts.push("esc back");
  const footer = `${navPart} · ${actionParts.join(" · ")}`;
  lines.push("");
  lines.push(theme.fg("muted", footer));
}

/** mergeBody：左侧 sidebar + │ divider + 右侧 main，拼成 body 行（divider 着色 borderMuted）。 */
function mergeBody(
  lines: string[],
  leftLines: string[],
  rightLines: string[],
  theme: ThemeLike,
): void {
  const bodyHeightVal = Math.max(leftLines.length, rightLines.length);
  for (let i = 0; i < bodyHeightVal; i++) {
    const left = padVisible(leftLines[i] ?? "", SIDEBAR_WIDTH);
    lines.push(left + b(theme, "│") + (rightLines[i] ?? ""));
  }
}

// 分屏视图固定头部行数（title + separator = 2）。
const SPLIT_HEADER_LINES = 2;

/** 计算滚动视口起始 index，确保选中项可见（居中策略，参考 subagents renderLeftColumn）。
 *  返回 [startIdx, viewportH]：startIdx 是内容区第一个可见项的 index，viewportH 是内容区可显示行数。 */
function computeViewport(
  totalCount: number,
  selectedIdx: number,
  bodyH: number,
): { startIdx: number; viewportH: number } {
  const viewportH = Math.max(0, bodyH - SPLIT_HEADER_LINES);
  if (viewportH <= 0) return { startIdx: 0, viewportH: 0 };
  if (totalCount <= viewportH) return { startIdx: 0, viewportH };
  // 选中项居中，到列表顶/底贴边
  const maxStart = Math.max(0, totalCount - viewportH);
  const center = Math.floor(selectedIdx - viewportH / OVERLAY_CENTER_DIVISOR);
  return { startIdx: Math.max(0, Math.min(center, maxStart)), viewportH };
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
  bodyH: number,
): void {
  const leftLines: string[] = [];
  const rightLines: string[] = [];

 // Left: sidebar title + phase list（固定高度 viewport + 滚动，只构建可见行）
  leftLines.push(theme.fg("muted", "Phases"));
  leftLines.push(dashes(theme, SIDEBAR_WIDTH));
  const { startIdx: phaseStart, viewportH: phaseViewportH } = computeViewport(phases.length, state.phaseIdx, bodyH);
  for (let i = phaseStart; i < phaseStart + phaseViewportH && i < phases.length; i++) {
    leftLines.push(formatPhaseLine(phases[i], i, i === state.phaseIdx, theme, SIDEBAR_WIDTH));
  }
  // 回写滚动偏移（clamp，防止状态脏值）
  state.phaseScrollOffset = phaseStart;
  // padding 到固定高度
  while (leftLines.length < bodyH) leftLines.push("");
  leftLines.length = bodyH;

 // Right: agents in the currently selected phase only（固定高度 viewport + 滚动）
  const selectedPhase = phases[state.phaseIdx] ?? phases[0];
  rightLines.push(theme.fg("muted", selectedPhase
    ? (selectedPhase.name
      ? `${selectedPhase.name} · ${selectedPhase.nodes.length} agents · ${formatElapsed(run.meta.startedAt, now)}`
      : `${selectedPhase.nodes.length} agents · ${formatElapsed(run.meta.startedAt, now)}`)
    : "(no phase)"));
  rightLines.push(dashes(theme, mainWidth));
  if (selectedPhase) {
    const { startIdx: agentStart, viewportH: agentViewportH } = computeViewport(selectedPhase.nodes.length, state.agentIdx, bodyH);
    for (let i = agentStart; i < agentStart + agentViewportH && i < selectedPhase.nodes.length; i++) {
      rightLines.push(formatAgentOneLiner(selectedPhase.nodes[i], theme));
    }
    state.agentScrollOffset = agentStart;
  }
  while (rightLines.length < bodyH) rightLines.push("");
  rightLines.length = bodyH;

  mergeBody(lines, leftLines, rightLines, theme);
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
  bodyH: number,
): void {
  const leftLines: string[] = [];
  const rightLines: string[] = [];

 // Left: sidebar title + phase list（固定高度 viewport + 滚动，只构建可见行）
  leftLines.push(theme.fg("muted", "Phases"));
  leftLines.push(dashes(theme, SIDEBAR_WIDTH));
  const { startIdx: phaseStart, viewportH: phaseViewportH } = computeViewport(phases.length, state.phaseIdx, bodyH);
  for (let i = phaseStart; i < phaseStart + phaseViewportH && i < phases.length; i++) {
    leftLines.push(formatPhaseLine(phases[i], i, i === state.phaseIdx, theme, SIDEBAR_WIDTH));
  }
  state.phaseScrollOffset = phaseStart;
  while (leftLines.length < bodyH) leftLines.push("");
  leftLines.length = bodyH;

 // Right: agent list（固定高度 viewport + 滚动）
  const currentPhase = phases[state.phaseIdx];
  const agents = currentPhase?.nodes ?? [];
  if (currentPhase) {
    rightLines.push(theme.fg("muted", currentPhase.name
      ? `${currentPhase.name} · ${currentPhase.nodes.length} agents`
      : `${currentPhase.nodes.length} agents`));
    rightLines.push(dashes(theme, mainWidth));
  } else {
    rightLines.push(theme.fg("muted", "(no phase)"));
    rightLines.push(dashes(theme, mainWidth));
  }
  const { startIdx: agentStart, viewportH: agentViewportH } = computeViewport(agents.length, state.agentIdx, bodyH);
  for (let i = agentStart; i < agentStart + agentViewportH && i < agents.length; i++) {
    const node = agents[i];
    const pointer = i === state.agentIdx ? "❯ " : "  ";
    const dot = statusDotStr(node.status, theme);
    // Live 路径优先：运行中从 node.live 读实时 token/tool 计数 + elapsed。
    if (node.live) {
      const live = projectLiveProgress(node.live);
      const tokStr = live.totalTokens > 0 ? `${Math.round(live.totalTokens / BUDGET_TOKENS_DIVISOR)}k tok` : "";
      const tcCount = getAllToolCalls(node.live).length;
      const elapsed = formatElapsedSeconds(live.elapsedSeconds);
      rightLines.push(`${pointer}${dot} ${node.agent}    ${node.model}    ${tokStr} · ${tcCount} tools · ${elapsed}`);
    } else {
      const elapsed = formatElapsed(
        node.startedAt,
        node.completedAt ? new Date(node.completedAt).getTime() : now,
      );
      const tok = node.result?.usage;
      const tokStr = tok ? `${Math.round((tok.input + tok.output) / BUDGET_TOKENS_DIVISOR)}k tok` : "";
      const tcCount = node.result?.toolCalls?.length ?? 0;
      rightLines.push(`${pointer}${dot} ${node.agent}    ${node.model}    ${tokStr} · ${tcCount} tools · ${elapsed}`);
    }
  }
  state.agentScrollOffset = agentStart;
  while (rightLines.length < bodyH) rightLines.push("");
  rightLines.length = bodyH;

  mergeBody(lines, leftLines, rightLines, theme);
}

// ── Level 2: Execution detail ─────────────────────────────────
// 详情内容构建 + 滚动按键已抽到 detail-content.ts（纯函数，可单测，且控制本文件行数）。

function renderLevel2(
  lines: string[],
  run: WorkflowRun,
  agents: ExecutionTraceNode[],
  state: ViewState,
  theme: ThemeLike,
  mainWidth: number,
  now: number,
  viewH: number,
): void {
  const leftLines: string[] = [];
  const rightLines: string[] = [];

 // Left: agents title + agent names
  leftLines.push(theme.fg("muted", "Agents"));
  leftLines.push(dashes(theme, SIDEBAR_WIDTH));
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

 // Right: full detail（viewport 截断 + 滚动，对齐 subagents renderRightDetail）
  const node = agents[state.agentIdx];
  if (node) {
    const content = buildDetailContent(node, state, run, theme, mainWidth, now);
    const maxOff = Math.max(0, content.length - viewH);
    // running 且 followTail → 钉底部（最新输出始终可见，用户 PgUp 后停止跟随）
    if (node.status === "running" && state.followTail) {
      state.detailScrollOffset = maxOff;
    }
    // clamp 收敛（切 agent / End 越界后下次 render 归位）
    if (state.detailScrollOffset > maxOff) state.detailScrollOffset = maxOff;
    const start = state.detailScrollOffset;
    const visible = content.slice(start, start + viewH);
    while (visible.length < viewH) visible.push(""); // pad 填满视口
    rightLines.push(...visible);

    // 位置指示（仅内容超一屏时，对齐 subagents detailScrollInfo）
    if (content.length > viewH) {
      const end = Math.min(start + viewH, content.length);
      // 覆盖第一行标题，拼上 (start+1-end/total)
      const titleBase = "Detail";
      const indicator = ` (${start + 1}-${end}/${content.length})`;
      rightLines[0] = theme.fg("muted", titleBase + indicator);
    }
  }

 // body 固定高度 = viewH（左右都 pad/截到 viewH，避免内容撑高溢出）
  const bodyH = viewH;
  const leftPadded: string[] = [];
  for (let i = 0; i < bodyH; i++) leftPadded.push(leftLines[i] ?? "");
  const rightPadded: string[] = [];
  for (let i = 0; i < bodyH; i++) rightPadded.push(rightLines[i] ?? "");
  mergeBody(lines, leftPadded, rightPadded, theme);
}

// ── Trace export（S 键，对齐 main saveTraceToFile）─────────────

/** trace 导出文件每节点 outcome 截断长度。 */
const TRACE_OUTCOME_SLICE = 2000;
/** trace 导出文件 activity 行宽。 */
const TRACE_ACTIVITY_WIDTH = 80;

/**
 * 导出完整 workflow trace 到 Markdown 文件。
 * 路径：~/.pi/agent/workflow-traces/{runId}.md
 * 对齐 main 的 saveTraceToFile（WorkflowsView.ts:365-396）。
 */
function saveTraceToFile(run: WorkflowRun, ctx: ExtensionContext): void {
  const dir = pathJoin(homedir(), ".pi", "agent", "workflow-traces");
  const filePath = pathJoin(dir, `${run.runId}.md`);
  const lines: string[] = [];
  lines.push(`# Workflow Trace: ${run.spec.scriptName} (${run.runId})`, "");
  lines.push(`Status: ${run.state.status} | Started: ${run.meta.startedAt ?? "-"} | Duration: ${formatElapsed(run.meta.startedAt)}`);
  const budget = run.state.budget;
  lines.push(`Budget: ${budget.usedTokens}/${budget.maxTokens ?? "unlimited"} tokens, $${budget.usedCost.toFixed(BUDGET_COST_DECIMALS)}`, "");
  const phases = buildPhaseGroups([...run.state.trace.toArray()]);
  for (const pg of phases) {
    lines.push(`## Phase: ${pg.name || "(unnamed)"}`, "");
    for (const node of pg.nodes) {
      lines.push(`### [#${node.stepIndex}] ${node.agent} — ${node.status}`);
      lines.push(`- Model: ${node.model}`);
      lines.push(`- Duration: ${formatElapsed(node.startedAt, node.completedAt ? new Date(node.completedAt).getTime() : Date.now())}`, "");
      lines.push("**Prompt:**", node.task, "");
      const toolCalls = node.result?.toolCalls ?? [];
      if (toolCalls.length > 0) {
        lines.push("**Activity:**");
        for (const tc of toolCalls) lines.push(`- ${formatActivityLine(tc, TRACE_ACTIVITY_WIDTH)}`);
        lines.push("");
      }
      lines.push("**Outcome:**");
      if (node.status === "running") lines.push("Still running...");
      else if (node.result?.error) lines.push(node.result.error);
      else if (node.result?.content) lines.push(node.result.content.slice(0, TRACE_OUTCOME_SLICE));
      lines.push("");
    }
  }
  fsPromises.mkdir(dir, { recursive: true })
    .then(() => fsPromises.writeFile(filePath, lines.join("\n"), "utf8"))
    .then(() => ctx.ui.notify(`Trace saved: ${filePath}`, "info"))
    .catch((err: Error) => ctx.ui.notify(`Save failed: ${err.message}`, "error"));
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

  lines.push(plainBorder(theme, "╭", "╮", contentWidth));

 // Title
  lines.push(walled(theme, theme.bold(" Save dynamic workflow"), contentWidth));

 // Destination preview
  const destName = state.saveInputValue || "(name)";
  const destLine = `.pi/workflows/${destName}.js`;
  lines.push(walled(theme, theme.fg("dim", destLine), contentWidth));

 // Empty line
  lines.push(walled(theme, "", contentWidth));

 // Label
  lines.push(walled(theme, "Save as:", contentWidth));

 // Input line with cursor block
  const inputLine = `  > ${state.saveInputValue}\u2588`;
  lines.push(walled(theme, inputLine, contentWidth));

 // Empty line
  lines.push(walled(theme, "", contentWidth));

 // Inline message (error or success)
  if (state.saveMessage) {
    const msgStyle = state.saveMsgOk ? "success" : "error";
    const msgLine = `  ${state.saveMessage}`;
    lines.push(walled(theme, theme.fg(msgStyle, msgLine), contentWidth));
  } else {
    lines.push(walled(theme, "", contentWidth));
  }

 // Hint
  const hint = "Enter to save · Esc to cancel";
  lines.push(walled(theme, theme.fg("muted", hint), contentWidth));

  lines.push(plainBorder(theme, "╰", "╯", contentWidth));

  return lines;
}
