// src/tui/format.ts
import type { WidgetAgentState } from "./agent-widget.ts";
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

/** SPINNER 帧序列（与 agent-widget.ts 一致） */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
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
 * turnNumber 是当前 turn 数（可选，turn_end 时传）。
 */
export function formatEventLogLine(
  entry: AgentEventLogEntry,
  theme: ThemeLike,
  turnNumber?: number,
): string {
  if (entry.type === "turn_end") {
    return `├─ turn ${turnNumber ?? "?"}: "${entry.label}"`;
  }
  if (entry.type === "tool_start") {
    return `├─ ${entry.label}  ${theme.fg("warning", "⟳ running")}`;
  }
  // tool_end
  const icon = entry.status === "failed" ? theme.fg("error", "✗") : theme.fg("success", "✓");
  return `├─ ${entry.label}  ${icon}`;
}

/**
 * FR-2.1: inline widget 第 1 行 status summary。
 */
export function formatStatusSummary(
  state: WidgetAgentState,
  spinnerFrame: number,
  _theme: ThemeLike,
): string {
  const spinner = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
  const turns = state.turns ?? 0;
  const tokens = formatTokens(state.totalTokens ?? 0);
  const elapsed = state.elapsedSeconds ?? 0;
  return `${spinner} ${state.agent} │ ${turns} turns │ ${tokens} │ ${elapsed}s`;
}

/** 格式化 token 数（12345 → "12.3k"） */
export function formatTokens(n: number): string {
  if (n >= TOKEN_MILLION) return `${(n / TOKEN_MILLION).toFixed(1)}M token`;
  if (n >= TOKEN_THOUSAND) return `${(n / TOKEN_THOUSAND).toFixed(1)}k token`;
  return `${n} token`;
}
