// src/tui/bg-notify-render.ts
//
// `subagent-bg-notify` custom message 的对话流渲染器。
//
// 问题背景：bg-notifier 原先用 display:false 静默把完成通知注入给 LLM，
// 用户在对话流里看不到任何信号（只看到 AI 突然开始回复）。改为 display:true
// 后，此处 renderer 把通知渲染成与 subagent tool block 同风格的完成块，
// 让异步任务的完成有显式视觉信号。
//
// 渲染策略：
//   - single（首条零延迟通知）：复用 SubagentResultComponent，视觉与 tool block 一致
//     （done → toolSuccessBg / failed·cancelled → toolErrorBg）
//   - batch（合并窗口内的多条）：渲染汇总行列表（每条一行，状态图标 + agent + 预览）
//
// CustomMessageComponent 契约：renderer 返回 Component 时原样使用，不再套默认
// 紫底 box（custom-message.js rebuild() 的 customRenderer 分支）。因此
// SubagentResultComponent 自带的背景色 block 会被直接渲染进对话流。

import { type Component,Container, Text } from "@earendil-works/pi-tui";

import type { BgNotifyDetails, BgNotifyRecord } from "../persistence/bg-notifier.ts";
import { truncVisible } from "./format.ts";
import { SubagentResultComponent, type SubagentToolDetails, type ThemeLike } from "./subagent-render.ts";

/** ms → seconds */
const MS_PER_SECOND = 1000;
/** batch 模式每条预览的最大字符数（单行展示，截断长结果） */
const BATCH_PREVIEW_MAX = 120;

/** 把 BgNotifyRecord 映射为 SubagentToolDetails，复用 SubagentResultComponent。
 *  eventLog 留空——通知块只展示终态摘要，详细事件链用户可 /subagents list 查看。 */
function recordToDetails(rec: BgNotifyRecord): SubagentToolDetails {
  const usage = rec.result?.usage;
  const totalTokens = usage
    ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite
    : 0;
  return {
    eventLog: [],
    status: rec.status,
    agent: rec.agent ?? "default",
    turns: rec.result?.turns ?? 0,
    totalTokens,
    elapsedSeconds: rec.endedAt ? Math.round((rec.endedAt - rec.startedAt) / MS_PER_SECOND) : 0,
    result: rec.result?.text,
    error: rec.error,
    backgroundId: rec.id,
  };
}

function statusGlyph(status: BgNotifyRecord["status"], theme: ThemeLike): string {
  switch (status) {
    case "done":
      return theme.fg("success", "✓");
    case "failed":
      return theme.fg("error", "✗");
    case "cancelled":
      return theme.fg("muted", "■");
  }
}

/** batch 预览：压成单行，截断到 BATCH_PREVIEW_MAX。 */
function previewOneLine(rec: BgNotifyRecord): string {
  const body = rec.result?.text ?? rec.error ?? "(no output)";
  const flat = body.replace(/\s+/g, " ").trim();
  // P1#2: 用 truncVisible（grapheme-safe）替代 .slice——结果文本可能含 CJK/emoji，
  // .slice 会劈半代理对/grapheme cluster 产生乱码。
  return truncVisible(flat, BATCH_PREVIEW_MAX);
}

/** 渲染合并通知：标题行 + 每条一行摘要。 */
function renderBatch(records: BgNotifyRecord[], theme: ThemeLike): Component {
  const container = new Container();
  container.addChild(new Text(theme.bold(`${records.length} background tasks completed:`), 0, 0));
  for (const rec of records) {
    const glyph = statusGlyph(rec.status, theme);
    const agent = rec.agent ?? "default";
    const line = `${glyph} ${theme.bold(agent)} (${rec.id}) — ${previewOneLine(rec)}`;
    container.addChild(new Text(line, 0, 0));
  }
  return container;
}

/**
 * message renderer 入口。注册到 pi.registerMessageRenderer("subagent-bg-notify", ...)。
 * 返回 undefined 时 SDK fallback 到默认紫底渲染（details 缺失的防御场景）。
 */
export function renderBgNotifyMessage(
  message: { details?: BgNotifyDetails },
  _options: { expanded: boolean },
  theme: ThemeLike,
): Component | undefined {
  const details = message.details;
  if (!details) return undefined;
  if (details.kind === "single") {
    return new SubagentResultComponent(recordToDetails(details.record), theme);
  }
  return renderBatch(details.records, theme);
}
