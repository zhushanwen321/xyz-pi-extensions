// src/resolution/model-resolver.ts
import type { AgentConfig, ModelInfo, ResolvedModel, SessionModelState, SubagentsGlobalConfig } from "../types.ts";
import { mergeConfig } from "./config-merger.ts";

/** ModelRegistry 的最小接口（duck-typed，避免强耦合 SDK 类型）。
 *
 * 返回类型与 `ModelInfo` 对齐（含 `id` 字段）——真实 SDK 的 `ModelRegistry`
 * 返回 `Model<Api>`（结构超集，可结构子类型赋值给 `ModelInfo`）。
 * 此前 find/getAvailable 的返回类型遗漏了 `id`，导致下游 ResolvedModel.model
 * 赋值需要 `as never` 绕过类型检查。 */
export interface ModelRegistryLike {
  find(provider: string, modelId: string): ModelInfo | undefined;
  hasConfiguredAuth(model: unknown): boolean;
  /** 返回所有已配置 auth 的可用模型（config-wizard 用） */
  getAvailable(): ModelInfo[];
}

/** Fuzzy 匹配打分常量 */
const SCORE_EXACT = 100;
const SCORE_ID_SUBSTR_BASE = 60;
const SCORE_ID_SUBSTR_BONUS = 30;
const SCORE_NAME_SUBSTR_BASE = 40;
const SCORE_NAME_SUBSTR_BONUS = 20;
const SCORE_ALL_PARTS = 20;
const FUZZY_THRESHOLD = 20;
const MODEL_LIST_LIMIT = 20;

const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

/**
 * FR-4.3: 从 model.thinkingLevelMap 提取可用级别，clamping 到最高可用。
 * model.reasoning === false → 返回 undefined（不支持 thinking）
 */
function resolveThinkingLevel(
  model: { reasoning: boolean; thinkingLevelMap?: Record<string, string | null> },
  requested?: string,
): string | undefined {
  if (!model.reasoning) return undefined;
  const map = model.thinkingLevelMap;
  if (!map) return requested; // 无 map 信息，透传请求值

  // 收集可用级别（值非 null）
  const available = THINKING_ORDER.filter((lvl) => map[lvl] != null);
  if (available.length === 0) return undefined;

  if (requested && map[requested] != null) return requested;
  // requested 不可用 → 降级到最高可用
  return available[available.length - 1];
}

/**
 * FR-4.1 / FR-4.2: 按 5 级配置链 + fallback 链解析模型。
 * 每级通过 modelRegistry.find() 验证，不可用则降级。
 */
export function resolveModelForAgent(opts: {
  agentName: string;
  agentConfig: AgentConfig | undefined;
  category: string;
  globalConfig: SubagentsGlobalConfig;
  sessionState: SessionModelState;
  modelRegistry: ModelRegistryLike;
  paramOverride?: { model?: string; thinkingLevel?: string };
}): ResolvedModel {
  const { agentConfig, modelRegistry } = opts;

  // 收集候选链（按优先级）
  const candidates: Array<{ modelStr: string; thinkingLevel?: string; source: ResolvedModel["source"] }> = [];

  const merged = mergeConfig(opts);
  candidates.push({ modelStr: merged.model, thinkingLevel: merged.thinkingLevel, source: merged.source });

  // agent.modelCandidates（FR-4.2 fallback 链）
  if (agentConfig?.modelCandidates) {
    for (const c of agentConfig.modelCandidates) {
      candidates.push({ modelStr: c, source: "agent-default" });
    }
  }

  // global fallback
  candidates.push({ modelStr: opts.globalConfig.fallback.model, thinkingLevel: opts.globalConfig.fallback.thinkingLevel, source: "global-fallback" });

  // env SUBAGENT_MODEL
  const envModel = process.env.SUBAGENT_MODEL;
  if (envModel) {
    candidates.push({ modelStr: envModel, source: "env" });
  }

  const tried: string[] = [];

  for (const candidate of candidates) {
    const [provider, modelId] = parseModelString(candidate.modelStr);
    let model: ModelInfo | undefined;

    if (provider && modelId) {
      model = modelRegistry.find(provider, modelId);
      // 精确匹配失败 → 尝试 fuzzy（如拼写错误或部分 id）
      if (!model) model = fuzzyMatchModel(candidate.modelStr, modelRegistry);
    } else {
      // 无 "/" → 尝试 fuzzy 匹配（如 "haiku" → "anthropic/claude-haiku-4-5"）
      model = fuzzyMatchModel(candidate.modelStr, modelRegistry);
    }

    if (!model || !modelRegistry.hasConfiguredAuth(model)) {
      tried.push(candidate.modelStr);
      continue;
    }
    return {
      model,
      thinkingLevel: resolveThinkingLevel(model, candidate.thinkingLevel),
      source: candidate.source,
    };
  }

  // 所有候选失败 → 列出可用模型辅助调试
  const available = modelRegistry.getAvailable().map((m) => `${m.provider}/${m.name}`);
  throw new Error(
    `No available model for agent "${opts.agentName}". Tried: ${tried.join(", ") || "(none)"}.` +
    (available.length > 0 ? `\nAvailable models:\n  ${available.slice(0, MODEL_LIST_LIMIT).join("\n  ")}` : ""),
  );
}

/**
 * FR-4.2 fuzzy model matching（参考 tintinweb model-resolver）。
 * 支持缩写/子串匹配："haiku" → "anthropic/claude-haiku-4-5"。
 * 打分：exact id=100, id 子串=60+, name 子串=40+, 全分词命中=20。阈值 ≥20。
 */
export function fuzzyMatchModel(
  query: string,
  modelRegistry: ModelRegistryLike,
): ModelInfo | undefined {
  const q = query.toLowerCase().trim();
  if (!q) return undefined;
  const available = modelRegistry.getAvailable();
  if (available.length === 0) return undefined;

  let best: { model: typeof available[number]; score: number } | undefined;

  for (const m of available) {
    const id = `${m.provider}/${m.name}`.toLowerCase();
    const name = m.name.toLowerCase();
    let score = 0;

    if (m.name.toLowerCase() === q || id === q) {
      score = SCORE_EXACT;
    } else if (id.includes(q)) {
      score = SCORE_ID_SUBSTR_BASE + Math.round((q.length / id.length) * SCORE_ID_SUBSTR_BONUS);
    } else if (name.includes(q)) {
      score = SCORE_NAME_SUBSTR_BASE + Math.round((q.length / name.length) * SCORE_NAME_SUBSTR_BONUS);
    } else {
      // 全分词命中检查（空格/连字符/斜线分词）
      const parts = q.split(/[\s\-/_]+/).filter(Boolean);
      if (parts.length > 0 && parts.every((p) => id.includes(p) || name.includes(p) || m.provider.toLowerCase().includes(p))) {
        score = SCORE_ALL_PARTS;
      }
    }

    if (score >= FUZZY_THRESHOLD && (!best || score > best.score)) {
      best = { model: m, score };
    }
  }

  return best?.model;
}

/** 解析 "provider/modelId" 格式（modelId 可含 /，取第一个 / 分割） */
function parseModelString(s: string): [string, string] | [undefined, undefined] {
  const idx = s.indexOf("/");
  if (idx <= 0) return [undefined, undefined];
  return [s.slice(0, idx), s.slice(idx + 1)];
}
