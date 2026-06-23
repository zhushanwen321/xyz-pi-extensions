// src/core/model-resolver.ts
//
// 模型解析（三层）：
//   1. 用户显式 override（tool 参数 startParam.model）→ registry lookup + auth
//   2. agent .md frontmatter model（agent 作者指定）→ registry lookup + auth
//   3. 主 agent 当前模型（ctx.model）→ 直接透传，无需 lookup
//
// 设计：默认与主 agent 同模型（零配置）。只有「有人显式指定 model」时才查
// registry 做解析 + 鉴权校验。thinkingLevel 同链路，无指定时 undefined。

/**
 * ModelRegistry 的最小接口（duck-typed，测试可 mock）。
 * 字段结构与 Pi SDK 的 ctx.modelRegistry 对齐（见 shared/types stub）。
 */
export interface ModelRegistryLike {
  /** 返回所有已配置鉴权的可用模型。 */
  getAvailable(): ModelInfo[];
  /** 按 (provider, modelId) 查找。 */
  find(provider: string, modelId: string): ModelInfo | undefined;
  /** 校验模型鉴权是否就绪。 */
  hasConfiguredAuth(model: unknown): boolean;
}

/**
 * 模型信息（registry 返回元素 / ctx.model 鸭子类型兼容）。
 * ctx.model（SDK Model<Api>）是此类型的超集，运行时直接当 ModelInfo 用。
 */
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
  /** 默认模型 override（"provider/modelId"）。agent 作者显式指定。 */
  model?: string;
  /** 默认 thinkingLevel override。 */
  thinkingLevel?: string;
  /** 默认 background 模式（true 时无显式 wait 走 background）。 */
  defaultBackground?: boolean;
}

/** 解析结果（model 实例 + 生效的 thinkingLevel）。 */
export interface ResolvedModel {
  model: ModelInfo;
  thinkingLevel: string | undefined;
}

// ============================================================
// 常量
// ============================================================

/** thinking level 支持顺序（低→高），用于 clamp 到 model 可用级别。 */
const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

/** 解析失败时错误信息列出的可用模型上限（防超长错误信息）。 */
const MODEL_LIST_LIMIT = 20;

// ============================================================
// 解析
// ============================================================

/**
 * 三层模型解析：
 *
 *   ╔═══════════════════════════════════════════════════════════════╗
//   ║  优先级（高→低）:                                              ║
//   ║    1. paramOverride.model      （调用方显式指定，tool 参数）     ║
//   ║    2. agentConfig.model        （agent .md frontmatter）        ║
//   ║    3. ctxModel                 （主 agent 当前模型，直接透传）   ║
//   ║                                                                ║
//   ║  1/2 级查 registry + auth 校验；3 级无需 lookup（主 agent 在用  ║
//   ║  说明 auth OK）。thinkingLevel 无指定时 undefined（model 默认） ║
//   ║                                                                ║
//   ║  显式指定但 lookup/auth 失败 → 抛错（不静默降级到主 agent，     ║
//   ║  因为用户明确要求了某个 model，降级会造成「以为用了 X 实际用 Y」║
//   ╚═══════════════════════════════════════════════════════════════╝
 *
 * @param agentConfig     agent .md 解析结果（查 model override + thinkingLevel）
 * @param modelRegistry   registry（仅 override 路径用）
 * @param paramOverride   调用方显式 override（最高优先级）
 * @param ctxModel        主 agent 当前模型（兜底，直接透传）
 */
export function resolveModel(
  agentConfig: AgentConfig | undefined,
  modelRegistry: ModelRegistryLike,
  paramOverride?: { model?: string; thinkingLevel?: string },
  ctxModel?: ModelInfo,
): ResolvedModel {
  // 1. paramOverride（最高优先级）。显式指定但 lookup/auth 失败 → 直接抛错，
  // 不降级到下层（避免「以为用了 X 实际用 Y」的静默错误）。
  if (paramOverride?.model) {
    return lookupAndResolve(
      paramOverride.model,
      paramOverride.thinkingLevel,
      modelRegistry,
      "paramOverride",
    );
  }

  // 2. agentConfig.model（agent 作者指定）。同样显式 → 失败即抛错。
  if (agentConfig?.model) {
    return lookupAndResolve(
      agentConfig.model,
      agentConfig.thinkingLevel,
      modelRegistry,
      "agentConfig",
    );
  }

  // 3. 主 agent model（直接透传，thinkingLevel 用 override 或 undefined）
  if (ctxModel) {
    return {
      model: ctxModel,
      thinkingLevel: paramOverride?.thinkingLevel ?? agentConfig?.thinkingLevel,
    };
  }

  // 全部不可用 → 列出可用模型辅助调试
  const available = modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
  throw new Error(
    `No available model. Main agent has no active model, and no override was resolved.` +
      (available.length > 0
        ? `\nAvailable models:\n  ${available.slice(0, MODEL_LIST_LIMIT).join("\n  ")}`
        : ""),
  );
}

/** lookup + auth 校验 + thinkingLevel clamp。显式指定但失败 → 抛错（不降级）。 */
function lookupAndResolve(
  modelStr: string,
  requestedThinking: string | undefined,
  registry: ModelRegistryLike,
  source: "paramOverride" | "agentConfig",
): ResolvedModel {
  const model = lookupModel(modelStr, registry);
  if (!model || !registry.hasConfiguredAuth(model)) {
    throw new Error(
      `Model "${modelStr}" (${source}) not found or auth not configured. ` +
        `Fix the model string or configure auth in models.json.`,
    );
  }
  return {
    model,
    thinkingLevel: resolveThinkingLevel(model, requestedThinking),
  };
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
  const levels = availableThinkingLevels(model);
  if (levels.length === 0) return model.reasoning ? requested : undefined;
  if (requested && levels.includes(requested)) return requested;
  // requested 不可用 → 降级到最高可用
  return levels[levels.length - 1];
}

/**
 * 列出 model 实际支持的 thinking level（升序）。
 *
 *   - model.reasoning === false → [] （不支持 thinking）
 *   - 无 thinkingLevelMap → [] （无级别信息，调用方按需透传）
 *   - 有 map → THINKING_ORDER 中 map[lvl] != null 的子集（保留升序）
 */
export function availableThinkingLevels(
  model: { reasoning: boolean; thinkingLevelMap?: Record<string, unknown> },
): readonly string[] {
  if (!model.reasoning) return [];
  const map = model.thinkingLevelMap;
  if (!map) return [];
  return THINKING_ORDER.filter((lvl) => map[lvl] != null);
}
