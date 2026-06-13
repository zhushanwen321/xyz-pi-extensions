// src/tui/format.ts
import type { SubagentsGlobalConfig } from "../types.ts";

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
