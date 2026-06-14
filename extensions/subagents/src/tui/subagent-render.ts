// src/tui/subagent-render.ts
//
// Subagent tool result 的对话流渲染。
// 返回 Component（pi-tui），由 Pi runtime 在对话流中渲染为背景色 block。
//
// 不依赖 AgentWidgetManager（widget 已移除），直接从 details 构建渲染内容。

import type { AgentEventLogEntry } from "../types.ts";

// ============================================================
// Types
// ============================================================

export interface SubagentToolDetails {
  eventLog: AgentEventLogEntry[];
  status: "running" | "done" | "failed" | "cancelled";
  agent: string;
  turns: number;
  totalTokens: number;
  elapsedSeconds: number;
  result?: string;
  error?: string;
  backgroundId?: string;
}

// ============================================================
// Format helpers（与 format.ts 解耦，避免循环依赖）
// ============================================================

const SPINNER = "\u2839"; // ⠹

function statusIcon(status: SubagentToolDetails["status"]): string {
  switch (status) {
    case "running": return SPINNER;
    case "done": return "\u2713"; // ✓
    case "failed": return "\u2717"; // ✗
    case "cancelled": return "\u25A0"; // ■
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

/**
 * 构建 SubagentResultComponent 的渲染行。
 * 返回字符串数组，每行不带背景色（由调用方用 theme.bg() 包裹）。
 */
export function buildRenderLines(details: SubagentToolDetails): string[] {
  const lines: string[] = [];

  // Status line
  const icon = statusIcon(details.status);
  const turns = details.turns;
  const tokens = formatTokens(details.totalTokens);
  const elapsed = `${details.elapsedSeconds}s`;
  lines.push(`${icon} ${details.agent} \u2502 ${turns} turns \u2502 ${tokens} \u2502 ${elapsed}`);
  //                   │                │                │

  // EventLog lines
  let turnNumber = 0;
  for (const entry of details.eventLog ?? []) {
    if (entry.type === "turn_end") turnNumber++;
    const label = entry.label;
    if (entry.type === "tool_start") {
      lines.push(`${label} \u23F3`); // ⏳
    } else if (entry.type === "tool_end") {
      const icon = entry.status === "failed" ? "\u2717" : "\u2713"; // ✗ or ✓
      lines.push(`${label} ${icon}`);
    } else if (entry.type === "turn_end") {
      lines.push(`turn ${turnNumber}: "${label}"`);
    }
  }

  // Result (after completion)
  if (details.status === "done" && details.result) {
    lines.push("");
    lines.push(details.result);
  }
  if (details.status === "failed" && details.error) {
    lines.push("");
    lines.push(`Error: ${details.error}`);
  }

  return lines;
}

// ============================================================
// Component（pi-tui compatible）
// ============================================================

/**
 * Pi-tui Component 实现：渲染 subagent tool result 为背景色 block。
 *
 * render(width) 返回 string[]，每行已应用背景色（padding + bg）。
 * Pi runtime 将这些行显示在对话流中。
 */
export class SubagentResultComponent {
  private _details: SubagentToolDetails;
  private _theme: { bg(color: string, text: string): string };

  constructor(
    details: SubagentToolDetails,
    theme: { bg(color: string, text: string): string },
  ) {
    this._details = details;
    this._theme = theme;
  }

  /** 更新 details（onUpdate 时调用） */
  update(details: SubagentToolDetails): void {
    this._details = details;
    this.invalidate();
  }

  invalidate(): void {
    // 无缓存，无需清理
  }

  render(width: number): string[] {
    const lines = buildRenderLines(this._details);
    const bgFn = this.getBgFn();

    // 应用背景色 + padding + 全宽填充
    const result: string[] = [];
    const paddingX = 1;
    const leftPad = " ".repeat(paddingX);

    for (const line of lines) {
      // Pad content to fit width (subtract padding)
      const contentWidth = Math.max(1, width - paddingX * 2);
      // Strip ANSI to measure visible length
      const visibleLen = stripAnsi(line).length;
      const padNeeded = Math.max(0, contentWidth - visibleLen);
      const padded = leftPad + line + " ".repeat(padNeeded) + " ";

      // Apply background
      if (bgFn) {
        result.push(bgFn(padded));
      } else {
        result.push(padded);
      }
    }

    return result;
  }

  private getBgFn(): ((text: string) => string) | undefined {
    switch (this._details.status) {
      case "running": return (text: string) => this._theme.bg("toolPendingBg", text);
      case "done": return (text: string) => this._theme.bg("toolSuccessBg", text);
      case "failed":
      case "cancelled": return (text: string) => this._theme.bg("toolErrorBg", text);
    }
  }
}

/** Strip ANSI escape sequences for visible length measurement */
function stripAnsi(str: string): string {
   
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// ============================================================
// Factory（供 subagent-tool.ts 调用）
// ============================================================

/**
 * 创建 renderResult 回调。
 * 返回值：Pi ToolDefinition 的 renderResult 字段。
 */
export function createRenderResult(
  theme: { bg(color: string, text: string): string },
) {
  // 用闭包持有最新 Component 实例
  let component: SubagentResultComponent | null = null;

  return {
    /** 获取或创建 Component */
    getComponent(details: SubagentToolDetails): SubagentResultComponent {
      if (!component) {
        component = new SubagentResultComponent(details, theme);
      } else {
        component.update(details);
      }
      return component;
    },
    /** 渲染函数（Pi runtime 调用） */
    render(
      result: { content: Array<{ type: string; text?: string }>; details?: unknown },
      _options: { expanded: boolean; isPartial: boolean },
      theme: { bg(color: string, text: string): string },
    ) {
      const details = result.details as SubagentToolDetails | undefined;
      if (!details) {
        const text = result.content[0];
        // Fallback: 返回 Text-like 对象（有 render 方法）
        return { render: (_w: number) => [text?.type === "text" ? (text.text ?? "") : ""], invalidate() {} };
      }
      if (!component) {
        component = new SubagentResultComponent(details, theme);
      } else {
        component.update(details);
      }
      return component;
    },
  };
}
