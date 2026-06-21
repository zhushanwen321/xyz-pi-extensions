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
//   ✓ agent · model — 摘要首行 (id)
//   ✗ agent · model — Error: 错误首行 (id)
//   ■ agent · model — cancelled (id)
// （model 缺失时省略 · model 段，向后兼容旧 record）
//
// 注意：renderer 自己用 Box(customMessageBg) 施加紫色背景。Pi 的
// CustomMessageComponent 对 customRenderer 返回的组件是「裸 addChild」——
// 只有 renderer 返回 undefined（走 default 渲染）时才套 customMessageBg box。
// 故返回裸 Text 会丢失紫色背景，必须显式 Box 包裹。

import type { Component } from "@earendil-works/pi-tui";
import { Box, Text } from "@earendil-works/pi-tui";
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
 *   display:true 时 Pi 调本方法，返回 Box(customMessageBg) 渲染紫色块。
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
    const lines = batch.map((r) => renderRecordLines(r, t).join("\n"));
    return wrapInBgBox(lines.join("\n"), t);
  }

  // 单条分支
  const record = extractBgNotifyRecord(message.details);
  if (!record) return undefined;
  return wrapInBgBox(renderRecordLines(record, t).join("\n"), t);
}

/**
 * 包进紫色背景 Box（customMessageBg），与 Pi 原生 CustomMessage 视觉一致。
 *
 * 为何 renderer 要自己施加背景：Pi 的 CustomMessageComponent.rebuild() 对
 * customRenderer 返回的组件是「裸 addChild」（component truthy → addChild + return，
 * 跳过 box）。只有 renderer 返回 undefined（走 default 渲染）时才套 customMessageBg
 * box。故返回裸 Text 会丢失紫色背景——这里显式 Box(customMessageBg) 补回。
 *
 * Box(1,1,bgFn)：paddingX/Y=1 留白，bgFn 对每行（含上下 padding 空行）施加背景。
 * 安全性：theme.fg 用 \x1b[39m、bg 用 \x1b[49m、bold 用 chalk \x1b[22m——
 * 均为精确 reset，不互相抹杀，前景着色不会破坏紫色背景。
 */
function wrapInBgBox(content: string, t: ThemeLike): Box {
  const box = new Box(1, 1, (text: string) => t.bg("customMessageBg", text));
  box.addChild(new Text(content, 0, 0));
  return box;
}

/**
 * 渲染单条 record 为多行文本。
 *
 * 格式（两行）：
 *   第 1 行（标题）：✓/✗/■ glyph + agent + 状态描述 + id
 *     - done:      `✓ default — background subagent finished - bg-3-...`
 *     - failed:    `✗ default — background subagent failed - bg-3-...`
 *     - cancelled: `■ default — background subagent cancelled - bg-3-...`
 *   第 2 行（正文）：结果首行 / Error 首行 / cancelled 无第二行
 *
 * 旧格式把结果和 id 挤在一行（`✓ default — 结果首行 (id)`），无法一眼看出
 * 「这是个 background 完成通知」。拆两行后第 1 行明确标识状态 + id，第 2 行
 * 专门展示内容，长内容不被 id 挤压。
 */
function renderRecordLines(
  record: { id: string; status: "done" | "failed" | "cancelled"; agent: string; model?: string; result?: string; error?: string },
  t: ThemeLike,
): string[] {
  const glyph = statusGlyph(record.status);
  const icon = glyph.icon ?? "•";
  const agent = truncLine(record.agent, AGENT_MAX_WIDTH);
  // model 段：agent 后、状态描述前，accent 色。空则省略（向后兼容旧 record）。
  const modelPart = record.model ? ` ${t.fg("dim", "·")} ${t.fg("accent", record.model)}` : "";
  const verb = record.status === "done" ? "finished" : record.status === "failed" ? "failed" : "cancelled";
  const head = `${t.fg(glyph.color, icon)} ${t.bold(agent)}${modelPart}${t.fg("dim", ` — background subagent ${verb} - ${record.id}`)}`;

  switch (record.status) {
    case "done":
      if (!record.result) return [head];
      return [head, t.fg("dim", truncLine(firstLineSanitized(record.result), BODY_MAX_WIDTH))];
    case "failed":
      return [head, t.fg("dim", truncLine(`Error: ${record.error ? firstLineSanitized(record.error) : "(unknown)"}`, BODY_MAX_WIDTH))];
    case "cancelled":
    default:
      return [head];
  }
}

/**
 * 从 message.details 防御性提取批量 record。
 * 形态：{ batch: true, items: BgNotifyRecord[] }。结构不全返回 undefined。
 */
function extractBatch(
  details: unknown,
): { id: string; status: "done" | "failed" | "cancelled"; agent: string; model?: string; result?: string; error?: string }[] | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const d = details as Record<string, unknown>;
  if (d.batch !== true || !Array.isArray(d.items)) return undefined;
  const records: { id: string; status: "done" | "failed" | "cancelled"; agent: string; model?: string; result?: string; error?: string }[] = [];
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
): { id: string; status: "done" | "failed" | "cancelled"; agent: string; model?: string; result?: string; error?: string } | undefined {
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
    model: typeof d.model === "string" ? d.model : undefined,
    result: typeof d.result === "string" ? d.result : undefined,
    error: typeof d.error === "string" ? d.error : undefined,
  };
}

// firstLine 取首非空行（共享自 ./format.ts）；本文件额外压 \r\t 防多行展开。
function firstLineSanitized(text: string): string {
  return firstLine(text).replace(/[\r\t]+/g, " ");
}
