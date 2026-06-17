// src/tui/format.ts
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
      const cmd = a.command.length > BASH_CMD_MAX ? a.command.slice(0, BASH_CMD_MAX) : a.command;
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

