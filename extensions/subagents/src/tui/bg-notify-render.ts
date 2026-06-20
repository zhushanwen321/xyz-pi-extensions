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

import { firstLine, statusGlyph, type ThemeLike,truncLine } from "./format.ts";

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
 *
 *   details 两种形态：
 *     - 单条：BgNotifyRecord（status/agent/id/result/error）
 *     - 批量：{ batch: true, items: BgNotifyRecord[] }（notifier 合并窗口内多条完成）
 */
export function renderBgNotifyMessage(
  message: { details?: unknown },
  _options: { expanded: boolean },
  theme: Theme,
): Component | undefined {
  const t = theme as ThemeLike;

  // 批量分支：多条合并，各自渲染一行
  const batch = extractBatch(message.details);
  if (batch) {
    const lines = batch.map((r) => renderRecordLine(r, t));
    return new Text(lines.join("\n"), 0, 0);
  }

  // 单条分支
  const record = extractBgNotifyRecord(message.details);
  if (!record) return undefined;
  return new Text(renderRecordLine(record, t), 0, 0);
}

/** 渲染单条 record 为一行文本（头 + 首行预览 + id）。 */
function renderRecordLine(
  record: { id: string; status: "done" | "failed" | "cancelled"; agent: string; result?: string; error?: string },
  t: ThemeLike,
): string {
  const glyph = statusGlyph(record.status);
  const icon = glyph.icon ?? "•";
  const agent = truncLine(record.agent, AGENT_MAX_WIDTH);
  const head = `${t.fg(glyph.color, icon)} ${t.bold(agent)}`;

  let body: string;
  switch (record.status) {
    case "done":
      body = record.result ? firstLineSanitized(record.result) : "(completed)";
      break;
    case "failed":
      body = `Error: ${record.error ? firstLineSanitized(record.error) : "(unknown)"}`;
      break;
    case "cancelled":
      body = "cancelled";
      break;
    default:
      body = "";
  }

  const idStr = t.fg("dim", ` (${record.id})`);
  return `${head} — ${t.fg("dim", truncLine(body, BODY_MAX_WIDTH))}${idStr}`;
}

/**
 * 从 message.details 防御性提取批量 record。
 * 形态：{ batch: true, items: BgNotifyRecord[] }。结构不全返回 undefined。
 */
function extractBatch(
  details: unknown,
): { id: string; status: "done" | "failed" | "cancelled"; agent: string; result?: string; error?: string }[] | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const d = details as Record<string, unknown>;
  if (d.batch !== true || !Array.isArray(d.items)) return undefined;
  const records: { id: string; status: "done" | "failed" | "cancelled"; agent: string; result?: string; error?: string }[] = [];
  for (const item of d.items) {
    const r = extractBgNotifyRecord(item);
    if (r) records.push(r);
  }
  return records.length > 0 ? records : undefined;
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

// firstLine 取首非空行（共享自 ./format.ts）；本文件额外压 \r\t 防多行展开。
function firstLineSanitized(text: string): string {
  return firstLine(text).replace(/[\r\t]+/g, " ");
}
