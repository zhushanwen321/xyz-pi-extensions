// src/core/model-resolver.ts
//
// 5 级 fallback 模型解析链。runtime 层调此函数解析后传入 SessionRunner，
// SessionRunner 不重复解析。

/**
 * ModelRegistry 的最小接口（duck-typed，测试可 mock）。
 * 字段结构与 Pi SDK 的 ctx.modelRegistry 对齐（见 shared/types stub），
 * 保证 `runtime.injectModelRegistry(ctx.modelRegistry)` 类型兼容。
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

/**
 * 5 级 fallback 解析：
 *
//   ╔═══════════════════════════════════════════════════════════════╗
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
  //  1. 按优先级遍历 5 级，找到第一个 modelRegistry.find() 命中的
  //  2. 解析 thinkingLevel（override > agent > category > fallback > undefined）
  //  3. 全部不可用 → throw Error（调用方决定 undefined 还是抛错）
  void args;
  throw new Error("not implemented");
}

/** 从 agentName + config 推断 category（agentCategoryOverrides 优先）。 */
export function inferCategory(
  agentName: string,
  agentConfig: AgentConfig | undefined,
  overrides: Record<string, string>,
  defaultCategory: string,
): string {
  //  1. overrides[agentName] 命中则返回
  //  2. 否则按 agent 名前缀/约定推断（worker→coding, scout→research 等）
  //  3. fallback defaultCategory（"general"）
  void agentName; void agentConfig; void overrides; void defaultCategory;
  throw new Error("not implemented");
}
