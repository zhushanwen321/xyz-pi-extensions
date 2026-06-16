// src/tui/batch-model-resolver.ts
import { mergeConfig } from "../resolution/config-merger.ts";
import type { SessionModelState, SubagentsGlobalConfig } from "../types.ts";

/**
 * 批量解析所有 category 的当前模型字符串（"provider/modelId" 格式）。
 * 遍历 globalConfig.categories，对每个 category 跑 mergeConfig（5 级配置链），
 * 返回 { [category]: modelStr }。
 *
 * 不验证模型可用性（mergeConfig 是纯合并），仅用于确认弹窗的 (current) 展示。
 * 单个 category 异常时 catch 隔离，该 category 不出现在结果中（O2-002）。
 */
export function resolveAllCategoryModels(
  globalConfig: SubagentsGlobalConfig,
  sessionState: SessionModelState,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const category of Object.keys(globalConfig.categories)) {
    try {
      const merged = mergeConfig({
        agentConfig: undefined,
        agentName: category,
        category,
        globalConfig,
        sessionState,
      });
      result[category] = merged.model;
    } catch {
      // 单个 category 解析失败 → 跳过（不置顶 current，弹窗展示该 category 无预选）
    }
  }
  return result;
}
