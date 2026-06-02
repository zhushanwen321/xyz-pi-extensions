/**
 * skill-state-tracker Steering 提示词模板
 *
 * 所有函数返回纯文本字符串，供 sendMessage({ deliverAs: "steer" }) 使用。
 */

import type { TrackedItem } from "./state";

export function loadedSteeringPrompt(name: string, id: number): string {
  return (
    `[SKILL-STATE] skill "${name}" 已加载并开始追踪（id=${id}）。\n` +
    `执行完成后调用 skill_state(action=update, id=${id}, status=completed)。\n` +
    `遇到困难时调用 skill_state(action=update, id=${id}, status=error, detail="原因")。`
  );
}

export function remindSteeringPrompt(name: string, turnsSinceLoad: number): string {
  return `[SKILL-STATE] skill "${name}" 已加载 ${turnsSinceLoad} turn 未终态，请调用 skill_state 工具流转状态。`;
}

export function errorForceRecordPrompt(item: TrackedItem): string {
  return (
    `[SKILL-STATE] skill "${item.name}" 异常次数已达 ${item.errorCount} 次，需要记录问题。\n` +
    `请立即调用 subagent 工具（background 模式），任务如下：\n` +
    `1. 读取 ${item.skillMdPath}\n` +
    `2. 根据当前 session 上下文分析 skill "${item.name}" 执行中遇到的问题\n` +
    `3. 生成结构化问题记录（skill 名称、异常次数、问题描述、改进建议）\n` +
    `完成后调用 skill_state(action=update, id=${item.id}, status=recorded) 标记记录完成。`
  );
}

export function agentStartContextPrompt(items: TrackedItem[]): string {
  if (items.length === 0) return "";
  const lines = items.map(
    (item) => `  - "${item.name}" (id=${item.id}, status=${item.status})`,
  );
  return (
    `[SKILL-STATE] 以下 skill 正在追踪中，请适时调用 skill_state 工具流转状态：\n` +
    lines.join("\n")
  );
}
