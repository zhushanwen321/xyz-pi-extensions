// src/tui/format.ts
//
// 纯格式化函数。零 Pi 依赖、零 runtime 依赖，可单测。
//
// 分隔符语义体系（tui-format.md §1，impeccable 审查裁定）：
//   `·` 同级并列字段/thinking 图标；`()` 元数据分组；`›` 工具；`>` 输出；`·` thinking。
//   禁用 `│` 做 stats 分隔、`├─`/`└─` 做 eventLog 前缀。
//
// 截断（tui-format.md §5）：truncLine 是 ANSI 安全的——追踪 active SGR，省略号前重应用，
// 否则背景色在省略号处断裂（contentBox 的 applyBg 被 `\x1b[0m` 抹掉）。
// 移植自 pi-subagents render.ts:44-89。

import { visibleWidth } from "@earendil-works/pi-tui";

import type { AgentEventLogEntry, ExecutionStatus } from "../types.ts";

/**
 * ThemeLike：TUI 语义 token 着色接口（duck-typed，兼容 Pi Theme）。
 *
 * 注意：Pi Theme **没有 `dim` 方法**——"dim" 是颜色 token，走 `fg("dim", text)`。
 * 故本接口只声明 fg/bg/bold，dim 文本一律 `fg("dim", ...)`。
 */
export interface ThemeLike {
  bg(color: string, text: string): string;
  fg(color: string, text: string): string;
  bold(text: string): string;
}

// ============================================================
// 模块级常量（复用，勿在热路径 new）
// ============================================================

/** spinner 帧序列（Braille），seed-frame 驱动，不用 setInterval。 */
const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** grapheme 切分器（Unicode/emoji 安全）。模块级共享，勿热路径 new。 */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** eventLog label 的最大可见宽度（压缩区每条上限，超出截断）。 */
const EVENT_LINE_MAX_WIDTH = 50;

// formatTokens 阈值（三段式，与 demo 一致）
/** < 此值显示原值。 */
const TOKEN_PLAIN_MAX = 1000;
/** < 此值显示 "N.Nk"；≥ 此值显示 "Nk"（四舍五入）。 */
const TOKEN_DECIMAL_K_MAX = 10000;

// formatElapsedSeconds 阈值
const SECS_PER_MINUTE = 60;
const SECS_PER_HOUR = 3600;

// ============================================================
// Token / 时长格式化
// ============================================================

/**
 * 格式化 token 数（三段式，与 demo 一致）。
 *
 *   < 1000  → 原值（"820"）
 *   < 10000 → "N.Nk"（8200 → "8.2k"）
 *   ≥ 10000 → "Nk" 四舍五入（23000 → "23k"）
 */
export function formatTokens(n: number): string {
  if (n < TOKEN_PLAIN_MAX) return String(n);
  if (n < TOKEN_DECIMAL_K_MAX) return `${(n / TOKEN_PLAIN_MAX).toFixed(1)}k`;
  return `${Math.round(n / TOKEN_PLAIN_MAX)}k`;
}

/**
 * 格式化整数秒时长（对话流 block + list overlay 共用）。
 * 数据源 details.elapsedSeconds 已是 Math.floor 过的整数秒。
 *
 *   < 60   → "Xs"（12 → "12s"）
 *   < 3600 → "Xm Ys"（72 → "1m12s"）
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

// ============================================================
// 状态图标
// ============================================================

/**
 * status → 图标 + 颜色 token。
 *
 *   running → { icon: undefined, color: "accent" }
 *     icon 留空是因为 running 的 spinner 需 seed 驱动，
 *     调用方用 detailsSeed(details) 算 seed 后调 spinnerGlyph(seed)。
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
      // 防御：运行时 status 可能是意外值（SDK 投影异常/未来新增状态），兜底为 running 语义
      return { icon: undefined, color: "accent" };
  }
}

/**
 * 生成 spinner 字形（seed 驱动，非定时器）。
 *
 * 每次 onUpdate（真实事件）→ seed 单调增长 → 换帧；
 * 静默期 seed 不变 → 冻结 → 换取滚动体验（修复 viewport 锚定 bug）。
 */
export function spinnerGlyph(seed: number): string {
  // 防御：seed 可能是 NaN（details 字段缺失时），回退首帧
  if (!Number.isFinite(seed)) return RUNNING_FRAMES[0]!;
  return RUNNING_FRAMES[Math.abs(seed) % RUNNING_FRAMES.length]!;
}

// ============================================================
// eventLog 单行格式化
// ============================================================

/**
 * 压平 label 到单行（防 LLM 输出的 \r\n/\t 把单行展开成多行，破坏布局）。
 * 两层防御之一（另一层在 tool-render 的 buildRenderLines）。
 */
export function sanitizeLabel(label: string): string {
  return label.replace(/[\r\n]+/g, " ").replace(/\t/g, "  ");
}

/**
 * 格式化单条 eventLog 条目（带类型图标 + 着色，不含 `⎿` 前缀——前缀由调用方加）。
 *
 * 图标语义（tui-conversation.md §7，替代原统一 `├─` 前缀）：
 *   `›` tool_start/tool_end（尾部追加 ✓/✗）
 *   `>`  text_output
 *   `·`  thinking（整行 dim，含图标）
 *   `──` turn_end（仅 expanded）
 *
 * label 经 sanitizeLabel 压成单行，再 truncLine 截到 EVENT_LINE_MAX_WIDTH。
 */
export function formatEventLine(entry: AgentEventLogEntry, theme: ThemeLike): string {
  const label = truncLine(sanitizeLabel(entry.label), EVENT_LINE_MAX_WIDTH);

  switch (entry.type) {
    case "tool_start":
      // 工具开始：图标 + label，无尾部标记
      return `› ${label}`;

    case "tool_end": {
      // 工具结束：尾部 ✓（success）/ ✗（error）
      const mark = entry.status === "failed"
        ? ` ${theme.fg("error", "✗")}`
        : ` ${theme.fg("success", "✓")}`;
      return `› ${label}${mark}`;
    }

    case "text_output":
      // agent 输出文本片段
      return `> ${label}`;

    case "thinking":
      // 推理片段：整行 dim（含 `·` 图标）
      return theme.fg("dim", `· ${label}`);

    case "turn_end":
      // turn 分隔（仅 expanded view 显示）
      return theme.fg("dim", "── turn ──");

    case "error":
      // 错误条目：图标 + label + ✗
      return `› ${label} ${theme.fg("error", "✗")}`;

    default:
      return label;
  }
}

// ============================================================
// ANSI 安全截断
// ============================================================

/**
 * 截断文本到 maxWidth 可见宽度（带省略号 `…`，ANSI 安全）。
 *
 * 问题：pi-tui 的 truncateToWidth 在省略号前插 `\x1b[0m`（全局 reset），
 * 导致 contentBox 施加的背景色在省略号处断裂。
 *
 * 解决：遍历追踪 active SGR styles，遇 `\x1b[0m` 清空、遇其他 `\x1b[..m` push，
 * 截断时 `result + activeStyles.join("") + "…"`——重应用 active 样式，背景不断裂。
 * 用 Intl.Segmenter grapheme 切分，正确处理 emoji/CJK/组合字符。
 *
 * 移植自 pi-subagents render.ts:44-89。
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

    // 找到下一段纯文本（非 ANSI）的边界
    let end = i;
    while (end < text.length && !text.slice(end).match(/^\x1b\[[0-9;]*m/)) {
      end++;
    }

    // 按 grapheme 迭代这段文本，累加到 targetWidth
    const textPortion = text.slice(i, end);
    for (const seg of segmenter.segment(textPortion)) {
      const grapheme = seg.segment;
      const graphemeWidth = visibleWidth(grapheme);

      if (currentWidth + graphemeWidth > targetWidth) {
        // 截断：重应用 active 样式 + 省略号
        return result + activeStyles.join("") + "…";
      }

      result += grapheme;
      currentWidth += graphemeWidth;
    }
    i = end;
  }

  // 理论上 visibleWidth 检查已提前返回，此行兜底
  return result + activeStyles.join("") + "…";
}
