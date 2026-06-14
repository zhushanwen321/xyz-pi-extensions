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

/** FR-4.7.1: 序列化为可持久化的 snapshot 对象（供 pi.appendEntry 存储）。
 * 返回深拷贝快照，避免后续 sessionState 变异影响已写入的 entry 引用。
 * 与 restoreState 对称（均操作 object），与 extensions/plan 的 appendEntry 约定一致。 */
export function serializeState(state: SessionModelState): SessionModelState {
  return {
    yoloMode: state.yoloMode,
    perAgent: { ...state.perAgent },
    perCategory: { ...state.perCategory },
  };
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
