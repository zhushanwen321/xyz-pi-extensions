// src/tui/format-helpers.ts
//
// 配置摘要格式化（/subagents 无参数时 notify 用）。
// 从 format.ts 拆出避免循环依赖（format.ts 不依赖 config 类型）。

import type { SessionModelState, SubagentsGlobalConfig } from "../types.ts";

/** 格式化配置摘要（一行通知）：maxConcurrent + yolo + 各 category 模型。 */
export function formatConfigSummary(
  globalConfig: SubagentsGlobalConfig,
  sessionState: SessionModelState,
): string {
  //  "Subagents: max 4 · yolo off · coding=zhipu/glm-5.2 · ..."
  void globalConfig; void sessionState;
  throw new Error("not implemented");
}
