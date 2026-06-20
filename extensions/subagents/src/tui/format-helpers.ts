// src/tui/format-helpers.ts
//
// 配置摘要格式化（/subagents 无参数时 notify 用）。
// 从 format.ts 拆出避免循环依赖（format.ts 不依赖 config 类型）。
//
// 返回纯字符串（不带 ANSI）——notify 文本走 Pi 消息通道，非对话流背景色 block。

import type { SessionModelState, SubagentsGlobalConfig } from "../types.ts";

/**
 * 格式化配置摘要（一行通知）。
 *
 *   "Subagents: max 4 · yolo off · coding=zhipu/glm-5.2 · research=anthropic/claude-sonnet-4.5 · fallback=zhipu/glm-5.2"
 *
 * 字段（`·` 分隔，spec 分隔符语义：同级并列字段）：
 *   - max {maxConcurrent}
 *   - yolo {on|off}（globalConfig.yoloByDefault）
 *   - 各 category：{label}={model}（按 categories 声明序）
 *   - fallback={model}（兜底模型）
 */
export function formatConfigSummary(
  globalConfig: SubagentsGlobalConfig,
  _sessionState: SessionModelState,
): string {
  const parts: string[] = [`max ${globalConfig.maxConcurrent}`];
  parts.push(`yolo ${globalConfig.yoloByDefault ? "on" : "off"}`);

  // 各 category 模型
  for (const [name, def] of Object.entries(globalConfig.categories)) {
    parts.push(`${name}=${def.model}`);
  }

  // 兜底模型
  parts.push(`fallback=${globalConfig.fallback.model}`);

  return `Subagents: ${parts.join(" · ")}`;
}
