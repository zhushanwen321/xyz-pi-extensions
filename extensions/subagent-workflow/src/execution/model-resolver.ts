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

/**
 * lookup + auth 校验 + thinkingLevel clamp。显式指定但失败 → 抛错（不降级）。
 *
 * 错误信息区分两种失败（避免误导排查方向）：
 *   - model 不存在 → 提示检查拼写 + 列出相近可用 model
 *   - model 存在但 auth 未配置 → 提示在 models.json 配置鉴权
 */
function lookupAndResolve(
  modelStr: string,
  requestedThinking: string | undefined,
  registry: ModelRegistryLike,
  source: "paramOverride" | "agentConfig",
): ResolvedModel {
  const model = lookupModel(modelStr, registry);
  if (!model) {
    throw new Error(
      `Model "${modelStr}" (${source}) not found in registry. ` +
        suggestSimilarModels(modelStr, registry),
    );
  }
  if (!registry.hasConfiguredAuth(model)) {
    throw new Error(
      `Model "${modelStr}" (${source}) exists but auth is not configured. ` +
        `Configure auth in models.json or switch to an authorized model.`,
    );
  }
  return {
    model,
    thinkingLevel: resolveThinkingLevel(model, requestedThinking),
  };
}

/**
 * 解析 "provider/modelId" 并查 registry。
 *
 * 容错：剥离尾部 ":thinkingLevel" 后缀（off/minimal/low/medium/high/xhigh）。
 * 原因：LLM 常把平台复合标识 "provider/modelId:thinkingLevel"（如
 * "deepseek-router/ds-pro:xhigh"）整体当 model 参数传入。registry 仅存
 * "provider/modelId"（无后缀），不剥离则 modelId="ds-pro:xhigh" 查不到。
 * 剥离后 thinkingLevel 仍由独立的 thinkingLevel 参数/resolveThinkingLevel 处理。
 *
 * modelId 可含 /，按第一个 / 分割 provider 与 modelId。
 */
function lookupModel(modelStr: string, registry: ModelRegistryLike): ModelInfo | undefined {
  const cleanStr = stripThinkingSuffix(modelStr);
  const idx = cleanStr.indexOf("/");
  if (idx <= 0) return undefined;
  return registry.find(cleanStr.slice(0, idx), cleanStr.slice(idx + 1));
}

/**
 * 剥离模型字符串尾部 ":thinkingLevel" 后缀（如 "ds-pro:xhigh" → "ds-pro"）。
 * 仅匹配合法 thinking level，避免误剥 "foo:bar" 这类无关冒号。
 * 返回去除后缀的字符串；无后缀则原样返回。
 */
function stripThinkingSuffix(modelStr: string): string {
  // THINKING_ORDER 含 off/minimal/low/medium/high/xhigh，按长度降序拼正则避免短串误匹配
  const alt = THINKING_ORDER.slice().sort((a, b) => b.length - a.length).join("|");
  return modelStr.replace(new RegExp(`:(${alt})$`), "");
}

/**
 * 为 not-found 错误生成「相近可用 model」建议，辅助定位拼写错误。
 * 策略：取 provider/modelId 的末段，与每个可用 model 的末段做小写包含匹配，
 * 命中则列出。无命中则列出前 N 个全部可用 model（兜底）。空 registry 不列。
 */
function suggestSimilarModels(modelStr: string, registry: ModelRegistryLike): string {
  const available = registry.getAvailable();
  if (available.length === 0) return "Registry has no available models.";
  const target = modelStr.split("/").pop()?.toLowerCase() ?? "";
  // ponytail: 末段子串包含足够定位拼写错误，无需编辑距离/相似度库
  const similar = available
    .filter((m) => m.id.toLowerCase().includes(target) || target.includes(m.id.toLowerCase()))
    .map((m) => `${m.provider}/${m.id}`)
    .slice(0, MODEL_LIST_LIMIT);
  const list = similar.length > 0 ? similar : available.slice(0, MODEL_LIST_LIMIT).map((m) => `${m.provider}/${m.id}`);
  return `Check the model string (maybe a typo, or a ":thinkingLevel" suffix that should be passed via the thinkingLevel param instead). Similar available models:\n  ${list.join("\n  ")}`;
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
