// src/tui/format.ts
//
// 纯格式化函数.零 Pi 依赖、零 runtime 依赖,可单测.
//
// 分隔符语义体系(tui-format.md §1,impeccable 审查裁定):
//   `·` 同级并列字段/thinking 图标;`()` 元数据分组;`›` 工具;`>` 输出;`·` thinking.
//   禁用 `│` 做 stats 分隔、`├─`/`└─` 做 eventLog 前缀.
//
// 截断(tui-format.md §5):truncLine 是 ANSI 安全的——追踪 active SGR,省略号前重应用,
// 否则背景色在省略号处断裂(contentBox 的 applyBg 被 `\x1b[0m` 抹掉).
// 移植自 pi-subagents render.ts:44-89.

import { visibleWidth } from "@earendil-works/pi-tui";

import type { AgentEventLogEntry, ExecutionStatus } from "../types.ts";
import { DEFAULT_AGENT_NAME } from "../types.ts";

/**
 * ThemeLike:TUI 语义 token 着色接口(duck-typed,兼容 Pi Theme).
 *
 * 注意:Pi Theme **没有 `dim` 方法**——"dim" 是颜色 token,走 `fg("dim", text)`.
 * 故本接口只声明 fg/bg/bold/underline,dim 文本一律 `fg("dim", ...)`.
 */
export interface ThemeLike {
  bg(color: string, text: string): string;
  fg(color: string, text: string): string;
  bold(text: string): string;
  underline(text: string): string;
}

// ============================================================
// 模块级常量(复用,勿在热路径 new)
// ============================================================

/** spinner 帧序列(Braille),seed-frame 驱动,不用 setInterval. */
const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** grapheme 切分器(Unicode/emoji 安全).模块级共享,勿热路径 new. */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// formatTokens 阈值(三段式,与 demo 一致)
/** < 此值显示原值. */
const TOKEN_PLAIN_MAX = 1000;
/** < 此值显示 "N.Nk";≥ 此值显示 "Nk"(四舍五入). */
const TOKEN_DECIMAL_K_MAX = 10000;

// formatElapsedSeconds 阈值
const SECS_PER_MINUTE = 60;
const SECS_PER_HOUR = 3600;

// ============================================================
// Token / 时长格式化
// ============================================================

/**
 * 格式化 token 数(三段式,与 demo 一致).
 *
 *   < 1000  → 原值("820")
 *   < 10000 → "N.Nk"(8200 → "8.2k")
 *   ≥ 10000 → "Nk" 四舍五入(23000 → "23k")
 */
export function formatTokens(n: number): string {
  if (n < TOKEN_PLAIN_MAX) return String(n);
  if (n < TOKEN_DECIMAL_K_MAX) return `${(n / TOKEN_PLAIN_MAX).toFixed(1)}k`;
  return `${Math.round(n / TOKEN_PLAIN_MAX)}k`;
}

/**
 * 格式化整数秒时长(对话流 block + list overlay 共用).
 * 数据源 details.elapsedSeconds 已是 Math.floor 过的整数秒.
 *
 *   < 60   → "Xs"(12 → "12s")
 *   < 3600 → "Xm Ys"(72 → "1m12s")
 *   ≥ 3600 → "Xh Ym"
 */
export function formatElapsedSeconds(seconds: number): string {
  if (seconds < SECS_PER_MINUTE) return `${seconds}s`;
  if (seconds < SECS_PER_HOUR) {
    const m = Math.floor(seconds / SECS_PER_MINUTE);
    const s = seconds % SECS_PER_MINUTE;
    return `${m}m${s}s`;
  }
  const h = Math.floor(seconds / SECS_PER_HOUR);
  const m = Math.floor((seconds % SECS_PER_HOUR) / SECS_PER_MINUTE);
  return `${h}h${m}m`;
}

/**
 * 从完整 record id 提取短编号用于列表展示.
 *
 * id 格式:
 *   - sync:       `run-${seq}`       (如 run-1) → 原样
 *   - background: `bg-${seq}-${ts}`  (如 bg-1-1719500000000) → 去掉时间戳得 bg-1
 *
 * 取前两段(`prefix-seq`)即可覆盖两种格式:sync 原样,background 丢弃冗长时间戳.
 * seq 进程内递增唯一,作为「编号」足够区分;完整 id(含时间戳)在右列预览给出供精确引用.
 */
const SHORT_ID_SEGMENTS = 2;
export function shortId(id: string): string {
  return id.split("-").slice(0, SHORT_ID_SEGMENTS).join("-");
}

/**
 * 把文本 pad 到指定**可见**宽度(grapheme/emoji/CJK 安全).
 *
 * 用 visibleWidth 而非 `.length`——避免 ANSI 转义、emoji、宽字符(CJK 占 2 列)
 * 把列对齐算错(dev guide §2.4 警告的坑).
 *
 *   - 已 ≥ width → 原样返回(调用方负责先 truncLine 截断)
 *   - < width → 末尾补空格到可见宽度对齐
 *
 * 与 truncLine 配对:左/右列对齐时先 `truncLine(s, colWidth)` 再 `padToVisible(s, colWidth)`.
 */
export function padToVisible(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return text;
  return text + " ".repeat(width - w);
}

/**
 * 分段着色版 segFill:title 和 fill 都已着色(含 ANSI),拼接时各自 ANSI 延续.
 *
 * 解决 ANSI 嵌套失色问题:若用 `t.fg("c1", fill(title, "─", n))`,
 * title 内的 `\x1b[0m` 会重置外层 c1,导致 title 之后的 `─` 失去 c1.
 * 本函数改成 `title + fill.repeat(后)`,fill 整段保持着自己的 ANSI,不依赖外层包裹 → 全线着色一致.
 *
 *   segFillColored(t.fg("accent"," Subagents "), t.fg("borderMuted","─"), 20)
 *   → accent(" Subagents ") + borderMuted(─×N),无嵌套
 *
 * 注意:fill 必须是「单字符着色」(如 `t.fg("borderMuted","─")`),visibleWidth=1.
 * 调用方负责 title/fill 着色;本函数不接 theme.标题在前、填充在后.
 */
export function segFillColored(titleStyled: string | undefined, fillStyled: string, width: number): string {
  if (width <= 0) return "";
  const fillW = visibleWidth(fillStyled);
  if (!titleStyled || fillW === 0) {
    // 纯填充线:fillStyled.visibleWidth 应为 1,按 width 次重复
    return fillStyled.repeat(width);
  }
  const tw = visibleWidth(titleStyled);
  if (tw >= width) return truncLine(titleStyled, width);
  const fillCount = width - tw;
  return titleStyled + fillStyled.repeat(fillCount);
}

// ============================================================
// 状态图标
// ============================================================

/**
 * status → 图标 + 颜色 token.
 *
 *   running → { icon: undefined, color: "accent" }
 *     icon 留空是因为 running 的 spinner 需 seed 驱动,
 *     调用方用 detailsSeed(details) 算 seed 后调 spinnerGlyph(seed).
 *   done      → { "✓", "success" }
 *   failed    → { "✗", "error" }
 *   cancelled → { "■", "muted" }
 */
export function statusGlyph(status: ExecutionStatus): { icon: string | undefined; color: string } {
  switch (status) {
    case "running":
      return { icon: undefined, color: "accent" };
    case "done":
      return { icon: "✓", color: "success" };
    case "failed":
      return { icon: "✗", color: "error" };
    case "cancelled":
      return { icon: "■", color: "muted" };
    default:
      // 防御:运行时 status 可能是意外值(SDK 投影异常/未来新增状态),兜底为 running 语义
      return { icon: undefined, color: "accent" };
  }
}

/**
 * 生成 spinner 字形(seed 驱动,非定时器).
 *
 * 每次 onUpdate(真实事件)→ seed 单调增长 → 换帧;
 * 静默期 seed 不变 → 冻结 → 换取滚动体验(修复 viewport 锚定 bug).
 */
export function spinnerGlyph(seed: number): string {
  // 防御:seed 可能是 NaN(details 字段缺失时),回退首帧
  if (!Number.isFinite(seed)) return RUNNING_FRAMES[0]!;
  return RUNNING_FRAMES[Math.abs(seed) % RUNNING_FRAMES.length]!;
}

// ============================================================
// eventLog 单行格式化
// ============================================================

/**
 * 压平 label 到单行(防 LLM 输出的 \r\n/\t 把单行展开成多行,破坏布局).
 * 两层防御之一(另一层在 tool-render 的 buildRenderLines).
 */
export function sanitizeLabel(label: string): string {
  return label.replace(/[\r\n]+/g, " ").replace(/\t/g, "  ");
}

// ============================================================
// 共享文本/参数提取 helper(tool-render / list-view / bg-notify-render / subagent-tool 复用)
// ============================================================

/**
 * 取文本首个非空行(多行压成首行).
 *
 * 仅做"取首行"——不 sanitize.三处调用方的 sanitize 末步不同
 * (tool-render 调 sanitizeLabel、bg-notify-render 压 \r\t、list-view 不处理),
 * 故共享此基础函数,各自按需 wrap.
 *
 *   firstLine("a\nb\nc") → "a"
 *   firstLine("\n\nb") → "b"
 *   firstLine("") → ""
 */
export function firstLine(text?: string): string {
  if (!text) return "";
  return text.split("\n").find((l) => l.trim())?.trim() ?? "";
}

/**
 * 从 renderCall/execute 的 unknown args 安全提取 agent 名.
 * 类型守卫窄化(替代 `as { agent?: string }` 全可选断言).
 * 无 agent 字段或非空字符串时兌底 DEFAULT_AGENT_NAME(与 service 层 resolveIdentity 一致,
 * 保证 block 标题显示的名与实际加载的 agent.md 相符).
 */
export function extractAgentName(args: unknown): string {
  if (typeof args === "object" && args !== null && "agent" in args) {
    const v = (args as { agent: unknown }).agent;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return DEFAULT_AGENT_NAME;
}

/**
 * 格式化单条 eventLog 条目(带类型图标 + 着色,不含 `⎿` 前缀——前缀由调用方加).
 *
 * 标签语义(tui-conversation.md §7):
 *   tool:    tool_start/tool_end(尾部追加 ✓/✗)
 *   ── turn ──  turn_end(仅 expanded)
 *   error:   tool label + ✗
 *
 * text_output / thinking 类型已移除——完整内容收口在 record.turns[]，
 * eventLog 只承载离散语义事件。实时 text/thinking 进度由 currentActivity 行展示。
 *
 * 预处理统一用 sanitizeLabel(换行→空格、tab→2空格).
 * 不做预截断——宽度截断全部交给外层调用点的 `truncLine(formatEventLine(...), width)`.
 */
export function formatEventLine(entry: AgentEventLogEntry, theme: ThemeLike): string {
  const label = sanitizeLabel(entry.label);

  switch (entry.type) {
    case "tool_start":
      return `tool: ${label}`;

    case "tool_end": {
      const mark = entry.status === "failed"
        ? ` ${theme.fg("error", "✗")}`
        : ` ${theme.fg("success", "✓")}`;
      return `tool: ${label}${mark}`;
    }

    case "thinking":
      // thinking 整行 dim（推理流式进度，单源后与 tool 同构进 eventLog）
      return theme.fg("dim", `thinking: ${label}`);

    case "text":
      // text 流式进度（模型最终输出，单源后与 tool 同构进 eventLog）
      return `text: ${label}`;

    case "turn_end":
      // turn 分隔(仅 expanded view 显示)
      return theme.fg("dim", "── turn ──");

    case "error":
      // 错误条目:标签 + label + ✗
      return `tool: ${label} ${theme.fg("error", "✗")}`;

    default:
      return label;
  }
}

/**
 * 把 eventLog 的 tool_start/tool_end 对合并成单行输出(用户期望:每个 tool 只占 1 行,
 * 调用与结果同一行,尾部用 ✓/✗ 标成功/失败)。
 *
 * `getEventLog` 对每个 tool 派生两条独立条目(tool_start + tool_end),逐条 formatEventLine
 * 会导致每个已完成 tool 占 2 行(start 行冗余——其信息被 end 行完全覆盖)。本函数把
 * 相邻的同 label `tool_start`→`tool_end` 配对折叠成 1 行。
 *
 * 配对规则(单遍扫描):
 *   - tool_start + 紧邻同 label tool_end → 合并成 `tool: {label} ✓/✗`(1 行),跳过 start
 *   - tool_start 无紧邻 tool_end(running 态,还没 end)→ 单独 1 行 `tool: {label}`(无尾标)
 *   - 孤儿 tool_end(无对应 start,SDK 滞后/外部注入)→ 单独 1 行 `tool: {label} ✓/✗`
 *   - turn_end / error → 原样 1 行(formatEventLine)
 *
 * 「相邻」配对而非「全局匹配」:tool_start 的 tool_end 总是紧随其后(同一 toolCall 派生),
 * 用相邻判定 O(n) 单遍即可,无需回溯。窗口类调用点(tool-render compact 的 slice(-3))应在
 * slice 之后再调本函数——窗口内若恰好把 start/end 切到窗口两侧,本函数会保守地各输出 1 行
 * (start 行无尾标,end 行有尾标),不会错误合并跨窗口的对。
 *
 * 不含 `⎿` 前缀(由调用方加,与 formatEventLine 一致)。不做宽度截断(交给外层 truncLine)。
 */
export function formatToolEventPairs(
  entries: readonly AgentEventLogEntry[],
  theme: ThemeLike,
): string[] {
  const lines: string[] = [];
  const PAIR_SIZE = 2; // tool_start + tool_end 配对占 2 个 entry
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i]!;
    if (entry.type === "tool_start") {
      const next = entries[i + 1];
      if (next?.type === "tool_end" && next.label === entry.label) {
        // 已完成:合并成 1 行(用 tool_end 的状态),跳过 start 行
        lines.push(formatEventLine(next, theme));
        i += PAIR_SIZE;
        continue;
      }
      // running:只有 start,无 end —— 单独 1 行无尾标
      lines.push(formatEventLine(entry, theme));
      i += 1;
      continue;
    }
    // tool_end(孤儿)/ turn_end / error —— 原样 1 行
    lines.push(formatEventLine(entry, theme));
    i += 1;
  }
  return lines;
}

// ============================================================
// 固定高度滚动窗口(对齐 Pi bash 的行数稳定语义)
// ============================================================

/**
 * 取行数组的尾部 N 行,不足补空行到恒定 height 行(对齐 Pi bash 的行数稳定语义)。
 *
 * 问题:running 态 compact 视图若直接展示「活动行 + eventLog 窗口」两个独立来源,
 * 行数会随事件流涨缩(activity 行时有时无、eventLog 窗口 fold 后 1~3 行波动),
 * 造成「达到最大行数后仍会变换行数」的视觉抖动(用户报告的活动行闪现闪消)。
 *
 * 解决:统一成一个连续的行数组,取尾部固定 height 行,不足用 dim 空行 pad。
 * 行数恒定 = height,与 bash 的 `truncateToVisualLines(_, N, _)` 取尾部 N 行同义
 * (bash 处理文本折行;本函数处理已格式化的行数组,不涉及折行)。
 *
 *   tailFixedLines(["a","b","c","d"], 3) → ["b","c","d"]        (截断:取尾部 3 行)
 *   tailFixedLines(["a"], 3)             → ["a", "", ""]         (不足:pad dim 空行)
 *   tailFixedLines([], 3)                → ["", "", ""]          (空:全 pad)
 *
 * pad 空行加 dim STREAM_PREFIX(`  ⎿ `),与活动行视觉对齐(占用相同的缩进列),
 * 避免 contentBox 背景色在空行处出现「凹陷」错位。
 *
 * 返回的行已含前缀(调用方无需再加 ⎿)。这是与 formatToolEventPairs 的关键区别——
 * 后者返回裸内容行(前缀由调用方加);本函数返回可直接 push 进 lines[] 的完整行,
 * 因为 pad 空行也需要统一的前缀。
 */
export function tailFixedLines(
  contentLines: readonly string[],
  height: number,
  prefix: string,
  theme: ThemeLike,
): string[] {
  if (height <= 0) return [];
  const tail = contentLines.length > height
    ? contentLines.slice(contentLines.length - height)
    : [...contentLines];
  const padded = `${theme.fg("dim", prefix)}`;
  while (tail.length < height) {
    tail.push(padded);
  }
  return tail;
}

// ============================================================
// ANSI 安全截断
// ============================================================

/**
 * 截断文本到 maxWidth 可见宽度(带省略号 `…`,ANSI 安全).
 *
 * 问题:pi-tui 的 truncateToWidth 在省略号前插 `\x1b[0m`(全局 reset),
 * 导致 contentBox 施加的背景色在省略号处断裂.
 *
 * 解决:遍历追踪 active SGR styles,遇 `\x1b[0m` 清空、遇其他 `\x1b[..m` push,
 * 截断时 `result + activeStyles.join("") + "…"`——重应用 active 样式,背景不断裂.
 * 用 Intl.Segmenter grapheme 切分,正确处理 emoji/CJK/组合字符.
 *
 * 移植自 pi-subagents render.ts:44-89.
 */
export function truncLine(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;

  const targetWidth = Math.max(0, maxWidth - 1);
  let result = "";
  let currentWidth = 0;
  let activeStyles: string[] = [];
  let i = 0;

  while (i < text.length) {
    // 捕获 ANSI SGR 序列
    const ansiMatch = text.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (ansiMatch) {
      const code = ansiMatch[0];
      result += code;

      if (code === "\x1b[0m" || code === "\x1b[m") {
        activeStyles = []; // reset → 清空栈
      } else {
        activeStyles.push(code);
      }
      i += code.length;
      continue;
    }

    // 找到下一段纯文本(非 ANSI)的边界
    let end = i;
    while (end < text.length && !text.slice(end).match(/^\x1b\[[0-9;]*m/)) {
      end++;
    }

    // 按 grapheme 迭代这段文本,累加到 targetWidth
    const textPortion = text.slice(i, end);
    for (const seg of segmenter.segment(textPortion)) {
      const grapheme = seg.segment;
      const graphemeWidth = visibleWidth(grapheme);

      if (currentWidth + graphemeWidth > targetWidth) {
        // 截断:重应用 active 样式 + 省略号
        return result + activeStyles.join("") + "…";
      }

      result += grapheme;
      currentWidth += graphemeWidth;
    }
    i = end;
  }

  // 理论上 visibleWidth 检查已提前返回,此行兜底
  return result + activeStyles.join("") + "…";
}
