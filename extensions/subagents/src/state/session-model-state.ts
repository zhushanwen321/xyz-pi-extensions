// src/state/session-model-state.ts
import type { SessionModelState } from "../types.ts";

/** FR-4.7.1: 创建默认状态 */
export function createSessionModelState(yoloByDefault: boolean): SessionModelState {
  return { yoloMode: yoloByDefault, perAgent: {}, perCategory: {} };
}

export function setAgentModel(state: SessionModelState, agent: string, model: string, thinkingLevel?: string): void {
  state.perAgent[agent] = { model, thinkingLevel };
}

export function setCategoryModel(state: SessionModelState, category: string, model: string, thinkingLevel?: string): void {
  state.perCategory[category] = { model, thinkingLevel };
}

/** FR-4.7.1: 序列化为 JSON 字符串（用于 pi.appendEntry 持久化） */
export function serializeState(state: SessionModelState): string {
  return JSON.stringify(state);
}

/**
 * FR-4.7.3: 从持久化数据恢复，缺失字段用默认值。
 * 输入 null/undefined 或格式错误时返回默认状态。
 */
export function restoreState(data: unknown, yoloByDefault: boolean): SessionModelState {
  if (!data || typeof data !== "object") {
    return createSessionModelState(yoloByDefault);
  }
  const d = data as Partial<SessionModelState>;
  return {
    yoloMode: typeof d.yoloMode === "boolean" ? d.yoloMode : yoloByDefault,
    perAgent: d.perAgent && typeof d.perAgent === "object" ? { ...d.perAgent } : {},
    perCategory: d.perCategory && typeof d.perCategory === "object" ? { ...d.perCategory } : {},
  };
}
