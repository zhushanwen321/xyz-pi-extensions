// src/tui/format.ts
import { visibleWidth } from "@earendil-works/pi-tui";

import type { AgentEventLogEntry, SubagentsGlobalConfig } from "../types.ts";

const THINKING_DESCRIPTIONS: Record<string, string> = {
  off: "不使用推理",
  minimal: "极轻推理",
  low: "轻度推理",
  medium: "平衡推理",
  high: "深度推理，耗时较长",
  xhigh: "最深度推理，耗时最长",
};

export function formatThinkingLevelOption(level: string): string {
  return `${level} — ${THINKING_DESCRIPTIONS[level] ?? level}`;
}

/** FR-4.8.1: 格式化配置摘要（/subagents 不带参数时显示） */
export function formatConfigSummary(config: SubagentsGlobalConfig, yoloMode: boolean): string {
  const lines: string[] = [
    "# Subagents 配置",
    "",
    `YOLO: ${yoloMode ? "ON" : "OFF"}  |  全局并发: ${config.maxConcurrent}`,
    "",
    "## Categories",
  ];
  for (const [name, def] of Object.entries(config.categories)) {
    const thinking = def.thinkingLevel ? ` / ${def.thinkingLevel}` : "";
    lines.push(`- **${name}** (${def.label}): ${def.model}${thinking}`);
  }
  lines.push("", `## Fallback: ${config.fallback.model}`, "");
  lines.push("子命令: `/subagents config` | `/subagents config <category>`");
  return lines.join("\n");
}

// ============================================================
// FR-1.1a / FR-2.1: eventLog 格式化纯函数
// ============================================================

const TOKEN_THOUSAND = 1000;
const TOKEN_MILLION = 1000000;
const BASH_CMD_MAX = 60;

/** Theme 接口（duck-typed，避免依赖 Pi 运行时） */
export interface ThemeLike {
  fg(token: string, text: string): string;
  bold(text: string): string;
}

/**
 * FR-1.1a: 从 tool args 提取可展示 label。
 * 白名单 keys: read/write/edit → path (basename); bash → command; web_* → query/url。
 */
export function extractLabelFromArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return toolName;
  const a = args as Record<string, unknown>;

  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    if (typeof a.path === "string") {
      return `${toolName} ${basename(a.path)}`;
    }
  }
  if (toolName === "bash") {
    if (typeof a.command === "string") {
      // P1#2: 用 truncVisible（grapheme-safe）替代 .slice（UTF-16 切分会劈半 emoji/CJK）。
      // bash 命令含 emoji/CJK 时，.slice(0, n) 可能在代理对或 grapheme cluster 中间断开产生乱码。
      const cmd = visibleWidth(a.command) > BASH_CMD_MAX ? truncVisible(a.command, BASH_CMD_MAX) : a.command;
      return `${toolName} ${cmd}`;
    }
  }
  if (toolName === "web_search") {
    if (typeof a.query === "string") return `${toolName} ${a.query}`;
  }
  if (toolName === "web_fetch") {
    if (typeof a.url === "string") return `${toolName} ${a.url}`;
  }
  return toolName;
}

function basename(p: string): string {
  const m = p.match(/[^/\\]+$/);
  return m ? m[0] : p;
}

/**
 * FR-2.1: 格式化事件日志条目为单行展示。
 * 统一入口：对话流 block（subagent-render）和 widget 视图共用。
 *
 * 图标语义（2026-06-17 变更，替代原统一 `⎿  ` 前缀）：
 *   - `›` tool_start / tool_end（tool_end 尾部追加 ✓/✗）
 *   - `>` text_output
 *   - `·` thinking（图标 + 文本整行 dim）
 *   - `── turn N ──` turn_end（仅 expanded view）
 * 用类型图标代替统一连接符，让 thinking / tool / output 在压缩视图里一眼可辨。
 *
 * 注意：entry.label 可能来自 LLM 的 text_delta/thinking_delta，会包含换行符。
 * 必须先把 \r\n\t 压成空格，否则 Pi TUI 会把一条 eventLog 展开成多行，破坏布局。
 */
export function formatEventLogLine(
  entry: AgentEventLogEntry,
  theme: ThemeLike,
  turnNumber?: number,
): string {
  const label = sanitizeLogLabel(entry.label);
  if (entry.type === "turn_end") {
    return theme.fg("dim", `── turn ${turnNumber ?? "?"}: "${label}" ──`);
  }
  if (entry.type === "tool_start") {
    return `${TOOL_ICON} ${label}`;
  }
  if (entry.type === "tool_end") {
    const icon = entry.status === "failed" ? theme.fg("error", "✗") : theme.fg("success", "✓");
    return `${TOOL_ICON} ${label} ${icon}`;
  }
  if (entry.type === "thinking") {
    // thinking 整行 dim（含 `·` 图标）
    return theme.fg("dim", `${THINKING_ICON} ${label}`);
  }
  // text_output
  return `${OUTPUT_ICON} ${label}`;
}

/** eventLog 行首类型图标常量（见 tui-format.md §4 图标语义表）。
 *  P1#3: export 供 subagent-render.ts 的 formatActivityLine 复用，保证活动行与 eventLog 图标一致。 */
export const TOOL_ICON = "›";
export const OUTPUT_ICON = ">";
export const THINKING_ICON = "·";

/** 把 eventLog label 中的换行/回车/制表符替换为空格，避免 TUI 单行变多行。 */
function sanitizeLogLabel(label: string): string {
  return label.replace(/[\r\n]+/g, " ").replace(/\t/g, "  ");
}

/**
 * 格式化 token 数。统一实现（subagent-render / subagent-tool / widget 共用）。
 * @param n token 数
 * @param withSuffix true → "12.3k token"（widget 视图用）；false → "12.3k"（对话流 block 用）
 */
export function formatTokens(n: number, withSuffix = false): string {
  const suffix = withSuffix ? " token" : "";
  if (n >= TOKEN_MILLION) return `${(n / TOKEN_MILLION).toFixed(1)}M${suffix}`;
  if (n >= TOKEN_THOUSAND) return `${(n / TOKEN_THOUSAND).toFixed(1)}k${suffix}`;
  return `${n}${suffix}`;
}

// ============================================================
// 宽度工具（grapheme-safe，ANSI-safe）—— TUI 宽度计算唯一真源
// ============================================================
//
// P1#2: 从 subagents-view.ts 提升到此处统一导出。
// 所有「按可见宽度截断/padding」的调用点（format / subagents-view / bg-notify-render /
// category-confirm）都应复用这两个函数，避免散落多份实现导致行为漂移。
//
// 为什么不用 pi-tui 的 truncateToWidth：
//   它在省略号前后插游离 \x1b[0m（全局 reset），对自己管理背景色 + 需要 indexOf 列对齐
//   的调用方是灾难（见 TUI 避坑指南 §第二部分.2）。truncVisible 用 Intl.Segmenter
//   grapheme 切分，无游离 ANSI，字面位置 == 可见位置，列对齐不错位。

/** 共享的 grapheme segmenter（模块级复用，不在热路径每次 new）。 */
const _segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * 按可见宽度截断纯文本，超出部分显示 `…`（grapheme-safe，无游离 ANSI）。
 *
 * 适用场景：agent 名 / eventLog label / bash 命令 / 结果预览——这些输入一般无样式
 * 或仅需后续 padVisible 列对齐。按 grapheme cluster 切到 maxWidth-1 + `…`，
 * 保证 indexOf（字面位置）== visibleWidth（可见位置）。
 *
 * 带样式（fg/bg）的行截断请用 subagent-render.ts 的 truncLine（追踪 activeStyles）。
 */
export function truncVisible(s: string, maxWidth: number): string {
  if (visibleWidth(s) <= maxWidth) return s;
  if (maxWidth <= 1) return visibleWidth(s) > 0 ? "…" : s;
  // 取可见宽度 <= maxWidth-1 的前缀 grapheme，再加 `…`
  const target = maxWidth - 1;
  let out = "";
  let w = 0;
  for (const { segment } of _segmenter.segment(s)) {
    const sw = visibleWidth(segment);
    if (w + sw > target) break;
    out += segment;
    w += sw;
  }
  return out + "…";
}

/**
 * 把字符串 pad 到目标可见宽度（右侧补空格）。ANSI-safe：按 visibleWidth 测量，
 * 不会把 ANSI 转义码算进宽度。用于列表/表格的列对齐。
 */
export function padVisible(s: string, width: number): string {
  const vw = visibleWidth(s);
  if (vw >= width) return s;
  return s + " ".repeat(width - vw);
}

