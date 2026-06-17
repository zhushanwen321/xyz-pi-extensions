// src/tui/subagents-view-render.ts
//
// /subagents list 视图的纯渲染层（无 runtime 依赖，可独立测试）。
//
// 从 subagents-view.ts 拆出：把所有「输入 data + theme → 输出 string[]」的纯函数
// 集中于此，让 subagents-view.ts 只剩 overlay 工厂（createSubagentsView + getAllRecords，
// 依赖 SubagentRuntime/ExtensionContext）。这样两文件都 < 500 行（githook 建议值）。
//
// 类型（SubagentRecord / ViewState / DetailKeyContext）定义在此处并由
// subagents-view.ts re-export，避免 view.ts ↔ render 双向依赖。

import { visibleWidth } from "@earendil-works/pi-tui";

import type { AgentEventLogEntry, AgentResult, BackgroundStatus } from "../types.ts";
import { foldEventLog, formatEventLogLine, formatTokens, padVisible, type ThemeLike,truncVisible } from "./format.ts";

// ============================================================
// Types
// ============================================================

export interface SubagentRecord {
  readonly id: string;
  readonly agent: string;
  status: BackgroundStatus["status"];
  eventLog: AgentEventLogEntry[];
  turns?: number;
  totalTokens?: number;
  startedAt: number;
  endedAt?: number;
  result?: AgentResult;
  error?: string;
  /** ADR-024 L2: subagent session 文件名（存在时可回看完整对话） */
  sessionFile?: string;
  /** ADR-024 L1: 执行模式（列表显示用） */
  mode?: "sync" | "background";
  /** model 信息（详情区显示） */
  model?: string;
  /** thinking level（详情区显示） */
  thinkingLevel?: string;
}

export interface ViewState {
  selectedIdx: number;
  scrollOffset: number;      // 右列 eventLog 滚动
  filterText: string;        // filter 输入内容（默认可直接输入，无需进入 filter 模式）
  detailMode: boolean;       // Enter 进入详情全屏（右列占满），Esc 返回分屏
  disposed: boolean;
  /** P3#5: sync agent 无法在详情页真正取消时，置 true 显示「请在对话流按 Esc」提示。
   *  进入/切换详情时重置为 false。background agent 按 x 真正取消，不设此标记。 */
  syncCancelHint: boolean;
}

export interface DetailKeyContext {
  /** 详情视口可显示的行数（= 详情内容区高度）。用于 PgUp/PgDn 步长 + End 跳底。 */
  viewportHeight?: number;
  /** 详情内容总行数（= 展开后的 eventLog + result 行数）。用于 End 精确跳底。 */
  contentLines?: number;
}

// ============================================================
// Constants（命名常量，避免 ESLint no-magic-numbers）
// ============================================================

const STATUS_PRIORITY_FALLBACK = 99; // 未知状态排序兜底（排在已知状态之后）

const TIME_FORMAT_LENGTH = 5;        // HH:MM（toTimeString 切前 5 字符）
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PAD_WIDTH = 2;         // "01m09s" 中分钟/秒补零到 2 位

const AGENT_COL_WIDTH = 14;          // 左列 agent 名列宽
const TURNS_COL_WIDTH = 5;           // 左列 turns 列宽
const TOKENS_COL_WIDTH = 8;          // 左列 tokens 列宽

const SPLIT_HEADER_LINES = 2;        // 左列标题占 2 行（Agents(N) + 分隔线）
const SPLIT_HEADER_FOOTER_LINES = 5; // 分屏视图非 body 行数（╭+filter+├┬┤+footer├┴┤+╰+footer）
const MIN_BODY_HEIGHT = 3;
const MIN_TERMINAL_ROWS = 8;

export const SIDEBAR_WIDTH = 38;      // 左列宽（含 ❯ 指针 + 状态图标 + agent + turns + tokens）

const DETAIL_INDENT_WIDTH = 3;       // 全屏详情续行缩进：图标(1) + 空格(1) + 对齐空格(1)
const DETAIL_MIN_WRAP_WIDTH = 10;
const DETAIL_FOOTER_LINES = 2;       // 全屏详情底部（├ + footer text + ╰ 相关）

const BORDER_WIDTH = 2;              // ╭...╮ 边框（左 │ + 右 │）占的可见列
const COL_SEPARATOR_WIDTH = 1;       // 左右列之间的 │ 分隔符
const MIN_MAIN_WIDTH = 10;           // 右列最小宽度（防止极窄终端 mainWidth 塌成 0）
const TEXT_INDENT = 2;              // 缩进空格数（"  " + 截断/wrap 文本）

// ============================================================
// ANSI-aware visible-width helpers
// ============================================================
// P1#2: padVisible / truncVisible 已提升到 format.ts 作为宽度工具唯一真源。
// 此处保留 wrapVisible（换行逻辑，截断工具之外的独立职责）。

/** 把文本按可见宽度自动换行。用 visibleWidth 测量（ANSI-safe），按 grapheme 切分。
 *  超长单词（单个 word > maxWidth）强制截断。返回多行字符串数组。 */
function wrapVisible(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const vw = visibleWidth(text);
  if (vw <= maxWidth) return [text];

  // 简单贪心换行：按 visibleWidth 逐字符累积，超 maxWidth 断行。
  // ANSI 转义序列不计宽度（visibleWidth 会剥离），但需要保留在输出中。
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  // 用 segmenter 按 grapheme 切，避免 emoji/宽字符被劈成两半
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { segment } of segmenter.segment(text)) {
    const segWidth = visibleWidth(segment);
    if (currentWidth + segWidth > maxWidth && currentWidth > 0) {
      lines.push(current);
      current = segment;
      currentWidth = segWidth;
    } else {
      current += segment;
      currentWidth += segWidth;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [text];
}

// ============================================================
// Status / time format helpers
// ============================================================

function statusIcon(status: BackgroundStatus["status"], theme: ThemeLike): string {
  switch (status) {
    case "done": return theme.fg("success", "✓");
    case "running": return theme.fg("warning", "⟳");
    case "failed": return theme.fg("error", "✗");
    case "cancelled": return theme.fg("muted", "■");
  }
}

function statusLabel(status: BackgroundStatus["status"], theme: ThemeLike): string {
  switch (status) {
    case "done": return theme.fg("success", "done");
    case "running": return theme.fg("warning", "running");
    case "failed": return theme.fg("error", "failed");
    case "cancelled": return theme.fg("muted", "cancelled");
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toTimeString().slice(0, TIME_FORMAT_LENGTH);
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / MS_PER_SECOND);
  if (s < SECONDS_PER_MINUTE) return `${s}s`;
  return `${Math.floor(s / SECONDS_PER_MINUTE)}m${String(s % SECONDS_PER_MINUTE).padStart(MINUTES_PAD_WIDTH, "0")}s`;
}

/** 格式化单条 record 为左列行（固定列宽 + padVisible 对齐）。 */
export function formatRecordRow(record: SubagentRecord, theme: ThemeLike, selected: boolean): string {
  const pointer = selected ? "❯ " : "  ";
  const icon = statusIcon(record.status, theme);
  const mode = record.mode === "background" ? "bg" : "  ";
  // 列宽：agent 14 + turns 5 + tokens 8 = 27，加 icon(1) + mode(2) + 分隔符
  const agent = padVisible(truncVisible(record.agent, AGENT_COL_WIDTH), AGENT_COL_WIDTH);
  const turns = padVisible(`${record.turns ?? 0}t`, TURNS_COL_WIDTH);
  const tokens = padVisible(record.totalTokens ? formatTokens(record.totalTokens) : "-", TOKENS_COL_WIDTH);
  const line = `${pointer}${icon} ${mode} ${agent} ${turns} ${tokens}`;
  return selected ? theme.bold(line) : line;
}

// ============================================================
// Filter（纯函数）
// ============================================================

/** 按 filterText 过滤 records（匹配 agent 名或 id，大小写不敏感）。 */
export function applyFilter(records: SubagentRecord[], filterText: string): SubagentRecord[] {
  const q = filterText.trim().toLowerCase();
  if (!q) return records;
  return records.filter((r) =>
    r.agent.toLowerCase().includes(q) || r.id.toLowerCase().includes(q),
  );
}

// ============================================================
// Split-pane render (仿 WorkflowsView mergeBody)
// ============================================================

/** 把左列和右列按行拼接，左列 padVisible 到 SIDEBAR_WIDTH，中间用 │ 分隔。 */
function mergeBody(leftLines: string[], rightLines: string[], mainWidth: number): string[] {
  const bodyHeight = Math.max(leftLines.length, rightLines.length);
  const result: string[] = [];
  const emptyLeft = " ".repeat(SIDEBAR_WIDTH);
  for (let i = 0; i < bodyHeight; i++) {
    const left = padVisible(leftLines[i] ?? "", SIDEBAR_WIDTH);
    const right = padVisible(rightLines[i] ?? "", mainWidth);
    result.push(left + "│" + right);
  }
  return result.length > 0 ? result : [emptyLeft + "│" + " ".repeat(mainWidth)];
}

/** 渲染左列：agent 列表。 */
function renderLeftColumn(
  records: SubagentRecord[],
  theme: ThemeLike,
  state: ViewState,
  bodyHeight: number,
): string[] {
  const lines: string[] = [];
  const filtered = applyFilter(records, state.filterText);
  lines.push(theme.fg("muted", `Agents (${filtered.length}/${records.length})`));
  lines.push("─".repeat(SIDEBAR_WIDTH));

  // 视口滚动：当选中行超出可见区时滚动
  const visibleRows = Math.max(1, bodyHeight - SPLIT_HEADER_LINES);
  let startIdx = 0;
  if (state.selectedIdx >= visibleRows) {
    startIdx = state.selectedIdx - visibleRows + 1;
  }
  const endIdx = Math.min(filtered.length, startIdx + visibleRows);

  for (let i = startIdx; i < endIdx; i++) {
    lines.push(formatRecordRow(filtered[i]!, theme, i === state.selectedIdx));
  }

  // 空状态
  if (filtered.length === 0) {
    lines.push(theme.fg("dim", "  (no matching agents)"));
  }

  return lines;
}

/** 渲染右列：选中 record 的详情（分屏折叠视图——每条 eventLog 单行截断）。 */
function renderRightColumn(
  record: SubagentRecord | null,
  theme: ThemeLike,
  mainWidth: number,
  _state: ViewState,
  _bodyHeight: number,
): string[] {
  const lines: string[] = [];
  if (!record) {
    lines.push(theme.fg("dim", "Select an agent to view details"));
    return lines;
  }

  lines.push(theme.fg("muted", "Detail"));
  lines.push("─".repeat(mainWidth));

  // 状态行
  const elapsed = record.endedAt
    ? formatDuration(record.endedAt - record.startedAt)
    : formatDuration(Date.now() - record.startedAt);
  lines.push(`${statusIcon(record.status, theme)} ${statusLabel(record.status, theme)} · ${record.agent}`);
  // model + thinking level（借鉴 subagent-render 的 meta 括号分组）
  const metaParts: string[] = [];
  if (record.model) metaParts.push(record.model);
  if (record.thinkingLevel) metaParts.push(`thinking ${record.thinkingLevel}`);
  if (metaParts.length > 0) {
    lines.push(theme.fg("dim", `(${metaParts.join(" · ")})`));
  }

  // stats 行
  const turns = record.turns ?? 0;
  const tokens = record.totalTokens ? formatTokens(record.totalTokens) : "0";
  const mode = record.mode === "background" ? "background" : "sync";
  lines.push(theme.fg("dim", `${turns} turns · ${tokens} · ${elapsed} · ${mode} · started ${formatTime(record.startedAt)}`));
  lines.push("");

  // Event log（折叠：每条单行截断到列宽，不换行）
  // foldEventLog：连续同类 text_output/thinking 分片 → 1 条首行代表行，
  // 与对话流压缩视图保持一致（否则一段长输出切成 N 个半句碎片，详情列全是重复前缀）。
  const filteredLog = foldEventLog((record.eventLog ?? []).filter((e) => e.type !== "turn_end"));
  if (filteredLog.length === 0) {
    lines.push(theme.fg("dim", "  (no events)"));
  } else {
    // 缩进 1 空格 + 图标行，截断到 mainWidth（图标由 formatEventLogLine 嵌入）
    for (const entry of filteredLog) {
      const raw = formatEventLogLine(entry, theme);
      lines.push(" " + truncVisible(raw, mainWidth - 1));
    }
  }

  // Result / Error（单行截断）
  if (record.result?.text || record.error) {
    lines.push("");
    lines.push(theme.fg("muted", record.error ? "Error:" : "Result:"));
    const text = record.error ?? record.result?.text ?? "";
    const firstLine = text.split("\n")[0] ?? "";
    lines.push(theme.fg("dim", "  " + truncVisible(firstLine, mainWidth - TEXT_INDENT)));
  }

  return lines;
}

// ============================================================
// Full view render
// ============================================================

export function renderView(
  records: SubagentRecord[],
  theme: ThemeLike,
  width: number,
  state: ViewState,
  termRows: number,
): string[] {
  if (termRows < MIN_TERMINAL_ROWS) {
    return [`Terminal too small (need ≥${MIN_TERMINAL_ROWS} rows)`];
  }

  // detailMode：渲染全屏详情视图（右列占满，展开换行 + 完整翻屏）
  if (state.detailMode) {
    const filtered = applyFilter(records, state.filterText);
    const selectedRecord = filtered[state.selectedIdx] ?? filtered[0] ?? null;
    return renderDetailView(selectedRecord, theme, width, state, termRows);
  }

  const contentWidth = width - BORDER_WIDTH; // ╭...╮ 边框
  const mainWidth = Math.max(MIN_MAIN_WIDTH, contentWidth - SIDEBAR_WIDTH - COL_SEPARATOR_WIDTH); // -1 for │

  const lines: string[] = [];

  // ── Header ──
  lines.push("╭" + "─".repeat(contentWidth) + "╮");
  // filter 默认可直接输入：显示当前 filterText + 光标 _
  const filterDisplay = theme.fg("dim", `filter: `) + theme.bold(`${state.filterText}_`);
  lines.push("│" + padVisible(filterDisplay, contentWidth) + "│");
  lines.push("├" + "─".repeat(SIDEBAR_WIDTH) + "┬" + "─".repeat(mainWidth) + "┤");

  // ── Body (split pane) ──
  const bodyHeight = Math.max(MIN_BODY_HEIGHT, termRows - SPLIT_HEADER_FOOTER_LINES);

  const filtered = applyFilter(records, state.filterText);
  const selectedRecord = filtered[state.selectedIdx] ?? filtered[0] ?? null;

  const leftLines = renderLeftColumn(records, theme, state, bodyHeight);
  const rightLines = renderRightColumn(selectedRecord, theme, mainWidth, state, bodyHeight);
  const bodyLines = mergeBody(leftLines, rightLines, mainWidth);

  // pad body to bodyHeight
  const emptyBodyLine = " ".repeat(SIDEBAR_WIDTH) + "│" + " ".repeat(mainWidth);
  while (bodyLines.length < bodyHeight) bodyLines.push(emptyBodyLine);

  for (const bodyLine of bodyLines) {
    lines.push("│" + padVisible(bodyLine, contentWidth) + "│");
  }

  // ── Footer ──
  lines.push("├" + "─".repeat(SIDEBAR_WIDTH) + "┴" + "─".repeat(mainWidth) + "┤");
  const footer = "↑↓ 导航 · Enter 详情 · x stop · Esc 退出";
  lines.push("│" + padVisible(theme.fg("muted", footer), contentWidth) + "│");
  lines.push("╰" + "─".repeat(contentWidth) + "╯");

  return lines;
}

/**
 * 详情全屏视图（detailMode）：右列占满 overlay，展开所有 eventLog。
 * 长内容换行 + 续行缩进对齐到图标后；事件间空行分隔。
 * 支持 ↑↓ 行级 / PgUp PgDn 大跨度 / Home End 跳顶底（见 processKey）。
 */
function renderDetailView(
  record: SubagentRecord | null,
  theme: ThemeLike,
  width: number,
  state: ViewState,
  termRows: number,
): string[] {
  const contentWidth = width - BORDER_WIDTH; // ╭...╮ 边框
  const wrapWidth = Math.max(DETAIL_MIN_WRAP_WIDTH, contentWidth - DETAIL_INDENT_WIDTH);

  const lines: string[] = [];

  if (!record) {
    lines.push("╭" + "─".repeat(contentWidth) + "╮");
    lines.push("│" + padVisible(theme.fg("dim", "No agent selected"), contentWidth) + "│");
    lines.push("╰" + "─".repeat(contentWidth) + "╯");
    return lines;
  }

  // ── Header（agent 名）──
  const title = record.agent;
  const titleLine = `─ ${title} `;
  const titleFill = "─".repeat(Math.max(0, contentWidth - visibleWidth(titleLine)));
  lines.push("╭" + titleLine + titleFill + "╮");

  // ── 内容行（全部生成后整体滚动）──
  const content: string[] = [];

  // P3#5: sync agent 无法在详情页真正取消时，顶部显示提示（用户按 x 后 state.syncCancelHint=true）。
  // background agent 按 x 真正取消，不设此标记，无提示行。
  if (state.syncCancelHint) {
    content.push(theme.fg("warning", "sync agent 无法在此取消，请在对话流按 Esc 中止"));
    content.push("");
  }

  // 状态 + stats 行
  const elapsed = record.endedAt
    ? formatDuration(record.endedAt - record.startedAt)
    : formatDuration(Date.now() - record.startedAt);
  const turns = record.turns ?? 0;
  const tokens = record.totalTokens ? formatTokens(record.totalTokens) : "0";
  const mode = record.mode === "background" ? "background" : "sync";
  content.push(`${statusIcon(record.status, theme)} ${statusLabel(record.status, theme)} · ${turns} turns · ${tokens} · ${elapsed} · ${mode} · started ${formatTime(record.startedAt)}`);
  // model + thinking level 括号分组
  const metaParts: string[] = [];
  if (record.model) metaParts.push(record.model);
  if (record.thinkingLevel) metaParts.push(`thinking ${record.thinkingLevel}`);
  if (metaParts.length > 0) {
    content.push(theme.fg("dim", `(${metaParts.join(" · ")})`));
  }
  content.push("");

  // Event log（展开：换行 + 续行缩进，事件间空行）——不折叠，全屏看完整内容
  for (const entry of record.eventLog ?? []) {
    if (entry.type === "turn_end") {
      content.push(theme.fg("dim", `── turn ──`));
      continue;
    }
    const raw = formatEventLogLine(entry, theme);
    const wrapped = wrapVisible(raw, wrapWidth);
    content.push(wrapped[0]!);
    for (let i = 1; i < wrapped.length; i++) {
      content.push(" ".repeat(DETAIL_INDENT_WIDTH) + wrapped[i]);
    }
    content.push(""); // 事件间空行
  }

  // Result / Error（展开换行 + 缩进）
  if (record.result?.text || record.error) {
    content.push(theme.fg("muted", record.error ? "Error:" : "Result:"));
    const text = record.error ?? record.result?.text ?? "";
    for (const l of text.split("\n")) {
      for (const wl of wrapVisible(l, wrapWidth - TEXT_INDENT)) {
        content.push(theme.fg("dim", "  " + wl));
      }
    }
  }

  // ── 视口滚动（scrollOffset）──
  // 可用高度 = termRows - header(1) - footer(2: ├ + footer text + ╰)
  const viewportHeight = Math.max(1, termRows - 1 - DETAIL_FOOTER_LINES);
  const maxOffset = Math.max(0, content.length - viewportHeight);
  const startIdx = Math.max(0, Math.min(state.scrollOffset, maxOffset));
  // 回写收敛后的 offset：End 设 MAX_SAFE_INTEGER、PgDn 越界时，下次渲染状态即归位。
  state.scrollOffset = startIdx;
  const visible = content.slice(startIdx, startIdx + viewportHeight);

  for (const line of visible) {
    lines.push("│" + padVisible(line, contentWidth) + "│");
  }
  // pad to viewportHeight
  while (lines.length < 1 + viewportHeight) {
    lines.push("│" + " ".repeat(contentWidth) + "│");
  }

  // ── Footer ──
  lines.push("├" + "─".repeat(contentWidth) + "┤");
  const scrollInfo = content.length > viewportHeight ? ` · ${startIdx + 1}-${Math.min(startIdx + viewportHeight, content.length)}/${content.length}` : "";
  // P3#5: running 时 footer 显示 x stop（仅 detailMode 可用）；非 running 隐藏避免误导。
  const stopHint = record.status === "running" ? " · x stop" : "";
  const footer = `↑↓ / PgUp PgDn / Home End 滚动${scrollInfo}${stopHint} · Esc 返回`;
  lines.push("│" + padVisible(theme.fg("muted", footer), contentWidth) + "│");
  lines.push("╰" + "─".repeat(contentWidth) + "╯");

  return lines;
}

// 导出 STATUS_PRIORITY_FALLBACK 供 subagents-view.ts 的 sortRecords 使用
export { STATUS_PRIORITY_FALLBACK };
