// src/tui/bg-notify-render.ts
//
// background 完成通知的对话流渲染器。
// pi.registerMessageRenderer("subagent-bg-notify", ...) 注册。
//
// notifier.ts 设 display:true + triggerTurn:true：
//   - display:true → Pi 创建 CustomMessageComponent（customMessageBg 背景色块，
//     与 tool block 的 toolSuccessBg 视觉区分），调本 renderer 渲染内容
//   - triggerTurn:true → 唤醒父 agent 下一 turn，让 LLM 看到「X 完成」
//
// 渲染内容（紧凑单行/双行）：
//   ✓ agent — 摘要首行 (id)
//   ✗ agent — Error: 错误首行 (id)
//   ■ agent — cancelled (id)
//
// 注意：不调 theme.bg()——背景色由 Pi 的 CustomMessageComponent 容器施加
// （customMessageBg）。组件只负责前景内容。

import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";

import { statusGlyph, type ThemeLike,truncLine } from "./format.ts";

/** agent 名最大显示宽度。 */
const AGENT_MAX_WIDTH = 40;
/** 完成块正文最大显示宽度。 */
const BODY_MAX_WIDTH = 80;

/**
 * 渲染 background 完成通知。
 *
 * 契约（Pi MessageRenderer，core/extensions/types.ts:1060）：
 *   (message: CustomMessage, options: { expanded }, theme: Theme) => Component | undefined
 *
 *   display:true 时 Pi 调本方法，返回 Component 渲染到 customMessageBg 块。
 *   details 异常 → 返回 undefined 走 Pi 默认渲染（兜底）。
 */
export function renderBgNotifyMessage(
  message: { details?: unknown },
  _options: { expanded: boolean },
  theme: Theme,
): Component | undefined {
  const t = theme as ThemeLike;
  const record = extractBgNotifyRecord(message.details);
  if (!record) return undefined;

  const glyph = statusGlyph(record.status);
  const icon = glyph.icon ?? "•";
  const agent = truncLine(record.agent, AGENT_MAX_WIDTH);
  const head = `${t.fg(glyph.color, icon)} ${t.bold(agent)}`;

  // 完成块正文 + backgroundId
  let body: string;
  switch (record.status) {
    case "done":
      body = record.result ? firstLine(record.result) : "(completed)";
      break;
    case "failed":
      body = `Error: ${record.error ? firstLine(record.error) : "(unknown)"}`;
      break;
    case "cancelled":
      body = "cancelled";
      break;
    default:
      return undefined;
  }

  const idStr = t.fg("dim", ` (${record.id})`);
  return new Text(`${head} — ${t.fg("dim", truncLine(body, BODY_MAX_WIDTH))}${idStr}`, 0, 0);
}

/**
 * 从 message.details 防御性提取 BgNotifyRecord。
 * 结构不全（缺 status / agent）返回 undefined。
 */
function extractBgNotifyRecord(
  details: unknown,
): { id: string; status: "done" | "failed" | "cancelled"; agent: string; result?: string; error?: string } | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const d = details as Record<string, unknown>;
  const status = d.status;
  const agent = d.agent;
  if (
    (status !== "done" && status !== "failed" && status !== "cancelled") ||
    typeof agent !== "string"
  ) {
    return undefined;
  }
  return {
    id: typeof d.id === "string" ? d.id : "",
    status,
    agent,
    result: typeof d.result === "string" ? d.result : undefined,
    error: typeof d.error === "string" ? d.error : undefined,
  };
}

/** 取文本首个非空行（多行压成首行）。 */
function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  return line.replace(/[\r\t]+/g, " ");
}
