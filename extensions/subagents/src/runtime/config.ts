// src/runtime/config.ts
//
// 全局配置（~/.pi/agent/subagents/config.json）+ session 级状态（内存）。

import type {
  CategoryConfirmResult,
  SessionModelState,
  SubagentsGlobalConfig,
} from "../types.ts";

/** 配置文件路径（~/.pi/agent/subagents/config.json）。 */
export function getGlobalConfigPath(homeDir: string): string {
  //  path.join(homeDir, ".pi/agent/subagents/config.json")
  void homeDir;
  throw new Error("not implemented");
}

/**
 * 加载全局配置。文件不存在时返回默认配置（保证 categories/fallback 完整）。
 */
export function loadGlobalConfig(homeDir: string): SubagentsGlobalConfig {
  //  1. readFileSync(getGlobalConfigPath) — 失败返回默认
  //  2. 与默认配置 deep-merge（保证新增字段有默认值）
  void homeDir;
  throw new Error("not implemented");
}

/** 保存全局配置（config-wizard 调用）。 */
export function saveGlobalConfig(homeDir: string, config: SubagentsGlobalConfig): Promise<void> {
  //  writeFileSync(getGlobalConfigPath, JSON.stringify(config, null, 2))
  void homeDir; void config;
  throw new Error("not implemented");
}

/**
 * 创建初始 session 状态（session_start 时调用）。
 * categoryConfirmed=false 触发首次确认拦截。
 */
export function createSessionState(): SessionModelState {
  //  { yoloMode:false, categoryConfirmed:false, categoryModels:{}, agentModels:{} }
  throw new Error("not implemented");
}

/**
 * 应用首次 category 确认结果。
 * 写入 sessionState.categoryModels + categoryConfirmed=true。
 */
export function applyCategoryConfirm(
  state: SessionModelState,
  result: CategoryConfirmResult,
): void {
  //  1. 合并 result.overrides 到 categoryModels
  //  2. categoryConfirmed = true
  void state; void result;
  throw new Error("not implemented");
}

/**
 * 从 entries 恢复 session 状态（/resume 时）。
 * 反序列化 appendEntry 写入的 categoryModels/yoloMode。
 */
export function restoreSessionState(entries: ReadonlyArray<{ type: string; data?: unknown }>): SessionModelState {
  //  1. createSessionState()
  //  2. 遍历 entries，匹配 subagent-config-entry 类型，反序列化覆盖
  //  3. 向后兼容：字段缺失时用默认
  void entries;
  throw new Error("not implemented");
}
