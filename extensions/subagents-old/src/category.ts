// src/category.ts
import type { CategoryDefinition } from "./types.ts";

/** FR-4.5.1: 6 个默认 category */
export const DEFAULT_CATEGORIES: Record<string, CategoryDefinition> = {
  coding:   { label: "编码", model: "deepseek-router/ds-flash", thinkingLevel: "high" },
  research: { label: "调研", model: "mimo-router/mimo-v2.5", thinkingLevel: "medium" },
  testing:  { label: "测试", model: "mimo-router/mimo-v2.5", thinkingLevel: "low" },
  vision:   { label: "视觉", model: "zhipu-coding-plan-router/glm-5.1", thinkingLevel: "xhigh" },
  planning: { label: "规划", model: "deepseek-router/ds-pro", thinkingLevel: "xhigh" },
  general:  { label: "通用", model: "mimo-router/mimo-v2.5", thinkingLevel: "low" },
};

/** name → category 的推断正则（按优先级） */
const NAME_INFERENCE: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /cod|review|fix|refactor|implement|develop/i, category: "coding" },
  { pattern: /research|search|investigat|scout|explore/i, category: "research" },
  { pattern: /test|qa|lint|valid/i, category: "testing" },
  { pattern: /plan|architect|design|strateg/i, category: "planning" },
  { pattern: /vision|image|ocr|visual/i, category: "vision" },
];

/**
 * FR-4.5.3: 推断 agent 类别。
 * 优先级：agentConfig.category > agentCategoryOverrides > 名称正则 > "general"
 */
export function inferCategory(
  agentName: string,
  agentConfig: { category?: string } | undefined,
  overrides: Record<string, string>,
): string {
  if (agentConfig?.category) return agentConfig.category;
  if (overrides[agentName]) return overrides[agentName];
  for (const { pattern, category } of NAME_INFERENCE) {
    if (pattern.test(agentName)) return category;
  }
  return "general";
}
