// src/resolution/config-merger.ts
import type { AgentConfig, SubagentsGlobalConfig, SessionModelState } from "../types.ts";

export interface MergedConfig {
  /** "provider/modelId" 格式（未验证可用性，model-resolver 会验证） */
  model: string;
  thinkingLevel?: string;
  source: "param" | "per-agent" | "per-category" | "category-default" | "agent-default" | "global-fallback";
}

/**
 * FR-3.1: 5 级配置优先级合并（仅合并出 model/thinkingLevel 字符串，不验证可用性）。
 * 验证和 fallback 在 model-resolver 中做。
 *
 * 优先级（高→低）：param > per-agent > per-category > global-category-default > agent-frontmatter
 * 最终 fallback：global config.fallback
 */
export function mergeConfig(opts: {
  agentConfig: AgentConfig | undefined;
  agentName: string;
  category: string;
  globalConfig: SubagentsGlobalConfig;
  sessionState: SessionModelState;
  paramOverride?: { model?: string; thinkingLevel?: string };
}): MergedConfig {
  const { paramOverride, sessionState, globalConfig, category, agentConfig, agentName } = opts;

  // Level 5: param override
  if (paramOverride?.model) {
    return { model: paramOverride.model, thinkingLevel: paramOverride.thinkingLevel, source: "param" };
  }
  // Level 4: per-agent session
  const perAgent = sessionState.perAgent[agentName];
  if (perAgent?.model) {
    return { model: perAgent.model, thinkingLevel: perAgent.thinkingLevel, source: "per-agent" };
  }
  // Level 3: per-category session
  const perCategory = sessionState.perCategory[category];
  if (perCategory?.model) {
    return { model: perCategory.model, thinkingLevel: perCategory.thinkingLevel, source: "per-category" };
  }
  // Level 2: global category default
  const catDefault = globalConfig.categories[category];
  if (catDefault?.model) {
    return { model: catDefault.model, thinkingLevel: catDefault.thinkingLevel, source: "category-default" };
  }
  // Level 1: agent frontmatter
  if (agentConfig?.model) {
    return { model: agentConfig.model, thinkingLevel: undefined, source: "agent-default" };
  }
  // Final fallback
  return {
    model: globalConfig.fallback.model,
    thinkingLevel: globalConfig.fallback.thinkingLevel,
    source: "global-fallback",
  };
}
