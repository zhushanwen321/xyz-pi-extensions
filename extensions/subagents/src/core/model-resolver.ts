// src/core/model-resolver.ts
//
// 5 级 fallback 模型解析链。runtime 层调此函数解析后传入 SessionRunner，
// SessionRunner 不重复解析。

/**
 * ModelRegistry 的最小接口（duck-typed，测试可 mock）。
 * 字段结构与 Pi SDK 的 ctx.modelRegistry 对齐（见 shared/types stub），
 * 保证 `runtime.initSession({ modelRegistry: ctx.modelRegistry })` 类型兼容。
 */
export interface ModelRegistryLike {
  /** 返回所有已配置的可用模型。 */
  getAvailable(): ModelInfo[];
  /** 按 (provider, modelId) 查找。 */
  find(provider: string, modelId: string): ModelInfo | undefined;
  /** 校验模型鉴权是否就绪。 */
  hasConfiguredAuth(model: unknown): boolean;
}

/** 模型信息（getAvailable 返回元素 / find 返回值）。 */
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, unknown>;
  contextWindow?: number;
}

/** agent .md frontmatter 解析结果。 */
export interface AgentConfig {
  /** agent 名（文件名 basename）。 */
  name: string;
  /** system prompt（markdown 正文）。 */
  systemPrompt: string;
  /** tool allowlist（三层过滤之一）。 */
  tools?: string[];
  /** 默认模型 override（"provider/modelId"）。 */
  model?: string;
  /** 默认 thinkingLevel override。 */
  thinkingLevel?: string;
  /** 默认 background 模式（true 时无显式 wait 走 background）。 */
  defaultBackground?: boolean;
  /** 工作区隔离策略。 */
  isolation?: "worktree";
}

/** 解析结果（model 实例 + 生效的 thinkingLevel）。复用 ModelInfo 消除重复。 */
export interface ResolvedModel {
  model: ModelInfo;
  thinkingLevel: string | undefined;
}

/** resolveModelForAgent 的入参。 */
export interface ResolveModelArgs {
  agentName: string;
  agentConfig: AgentConfig | undefined;
  /** agent 推断出的 category。 */
  category: string;
  globalConfig: { categories: Record<string, { model: string; thinkingLevel?: string }>; fallback: { model: string; thinkingLevel?: string } };
  sessionState: { categoryModels: Record<string, { model: string; thinkingLevel?: string }>; agentModels: Record<string, { model: string; thinkingLevel?: string }> };
  modelRegistry: ModelRegistryLike;
  /** 用户显式 override（tool 参数）。最高优先级。 */
  paramOverride?: { model?: string; thinkingLevel?: string };
}

// ============================================================
// 常量
// ============================================================

/** thinking level 支持顺序（低→高），用于 clamp 到 model 可用级别。 */
const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

/** 解析失败时错误信息列出的可用模型上限（防超长错误信息）。 */
const MODEL_LIST_LIMIT = 20;

/** agent 名 → category 的推断规则（按优先级，命中即返回）。 */
const NAME_INFERENCE: ReadonlyArray<{ pattern: RegExp; category: string }> = [
  { pattern: /cod|review|fix|refactor|implement|develop/i, category: "coding" },
  { pattern: /research|search|investigat|scout|explore/i, category: "research" },
  { pattern: /test|qa|lint|valid/i, category: "testing" },
  { pattern: /plan|architect|design|strateg/i, category: "planning" },
  { pattern: /vision|image|ocr|visual/i, category: "vision" },
];

/** 候选链条目：modelStr + 该级对应的 thinkingLevel。 */
interface ModelCandidate {
  modelStr: string;
  thinkingLevel?: string;
}

/**
 * 5 级 fallback 解析：
 *
 *   ╔═══════════════════════════════════════════════════════════════╗
//   ║  优先级（高→低）:                                              ║
//   ║    1. paramOverride.model      （用户显式指定，tool 参数）      ║
//   ║    2. agent.model              （agent .md frontmatter）        ║
//   ║    3. sessionState.agentModels （/subagents config 临时覆盖）   ║
//   ║    4. sessionState.categoryModels + category                   ║
//   ║    5. globalConfig.fallback    （兜底，保证总有一个 model）      ║
//   ║                                                                ║
//   ║  thinkingLevel 同链路解析（无指定时用 model 默认或 undefined）  ║
//   ║  解析失败（前 4 级全不可用）→ 抛错（让 Runtime 决定静默/失败）  ║
//   ╚═══════════════════════════════════════════════════════════════╝
 */
export function resolveModelForAgent(args: ResolveModelArgs): ResolvedModel {
  const { agentConfig, agentName, category, globalConfig, sessionState, modelRegistry } = args;

  // 组装候选链（按优先级）
  const candidates: ModelCandidate[] = [];
  if (args.paramOverride?.model) {
    candidates.push({ modelStr: args.paramOverride.model, thinkingLevel: args.paramOverride.thinkingLevel });
  }
  if (agentConfig?.model) {
    candidates.push({ modelStr: agentConfig.model, thinkingLevel: agentConfig.thinkingLevel });
  }
  const agentOverride = sessionState.agentModels[agentName];
  if (agentOverride) {
    candidates.push({ modelStr: agentOverride.model, thinkingLevel: agentOverride.thinkingLevel });
  }
  const categoryModel = sessionState.categoryModels[category] ?? globalConfig.categories[category];
  if (categoryModel) {
    candidates.push({ modelStr: categoryModel.model, thinkingLevel: categoryModel.thinkingLevel });
  }
  candidates.push({ modelStr: globalConfig.fallback.model, thinkingLevel: globalConfig.fallback.thinkingLevel });

  const tried: string[] = [];
  for (const candidate of candidates) {
    const model = lookupModel(candidate.modelStr, modelRegistry);
    if (!model || !modelRegistry.hasConfiguredAuth(model)) {
      tried.push(candidate.modelStr);
      continue;
    }
    return {
      model,
      thinkingLevel: resolveThinkingLevel(model, candidate.thinkingLevel),
    };
  }

  // 所有候选失败 → 列出可用模型辅助调试
  const available = modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
  throw new Error(
    `No available model for agent "${agentName}". Tried: ${tried.join(", ") || "(none)"}.` +
      (available.length > 0
        ? `\nAvailable models:\n  ${available.slice(0, MODEL_LIST_LIMIT).join("\n  ")}`
        : ""),
  );
}

/** 解析 "provider/modelId"（modelId 可含 /，取第一个 / 分割）并查 registry。 */
function lookupModel(modelStr: string, registry: ModelRegistryLike): ModelInfo | undefined {
  const idx = modelStr.indexOf("/");
  if (idx <= 0) return undefined;
  return registry.find(modelStr.slice(0, idx), modelStr.slice(idx + 1));
}

/**
 * 从 model.thinkingLevelMap 提取可用级别，clamp 到最高可用。
 * model.reasoning === false → undefined（不支持 thinking）
 */
function resolveThinkingLevel(
  model: { reasoning: boolean; thinkingLevelMap?: Record<string, unknown> },
  requested?: string,
): string | undefined {
  if (!model.reasoning) return undefined;
  const map = model.thinkingLevelMap;
  if (!map) return requested; // 无 map 信息，透传请求值

  const available = THINKING_ORDER.filter((lvl) => map[lvl] != null);
  if (available.length === 0) return undefined;

  if (requested && map[requested] != null) return requested;
  // requested 不可用 → 降级到最高可用
  return available[available.length - 1];
}

/** 从 agentName + config 推断 category（agentCategoryOverrides 优先）。 */
export function inferCategory(
  agentName: string,
  agentConfig: AgentConfig | undefined,
  overrides: Record<string, string>,
  defaultCategory: string,
): string {
  // 1. 显式 override 命中
  if (overrides[agentName]) return overrides[agentName];
  // 2. agent 名前缀/约定推断
  for (const rule of NAME_INFERENCE) {
    if (rule.pattern.test(agentName)) return rule.category;
  }
  // 3. fallback
  void agentConfig;
  return defaultCategory;
}
