// src/tui/bg-notify-render.ts
//
// background 完成通知的对话流渲染器。
// pi.registerMessageRenderer("subagent-bg-notify", ...) 注册。
//
// 关键设计（对照 Pi 引擎源码 interactive-mode.ts:3069-3076 + custom-message.ts）：
//   - Pi 的 `display` 字段是「渲染门控」。notifier.ts 已设 display:false，
//     通知只 triggerTurn（唤醒父 agent 下一轮），**不渲染视觉 block**——避免与
//     tool result block 重复（commit 4ecc9f5a1 修复的双 block bug）。
//   - display:false 时 Pi **完全不调用** renderer（连 CustomMessageComponent 都不创建），
//     所以本 renderer 在正常路径下永不执行。
//   - 但 messageRenderer 注册表的类型契约要求 renderer 存在，且签名正确
//     （返回 Component | undefined）。这里做防御性实现：
//       1. 若被显式 display:true 调用，从 details 提取 BgNotifyRecord
//       2. 按 status 选图标 + 颜色，渲染一个紧凑完成块（与 sync tool block 同风格）
//       3. details 缺失/结构异常 → 返回 undefined（走 Pi 默认 customMessageBg 渲染）

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
 *   display:false（默认路径）→ 永不调用，return undefined 兜底
 *   display:true（显式调用）→ 渲染紧凑完成块；details 异常 → undefined 走 Pi 默认渲染
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

  // 完成块正文：done → result 首行；failed → error 首行；cancelled → 固定文案
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

  // 裸 Text(paddingX=0 paddingY=0)——背景色由 Pi 的 CustomMessageComponent 容器施加
  return new Text(`${head} — ${t.fg("dim", truncLine(body, BODY_MAX_WIDTH))}`, 0, 0);
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
