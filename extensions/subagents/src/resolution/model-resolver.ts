// src/resolution/model-resolver.ts
import type { AgentConfig, ResolvedModel, SubagentsGlobalConfig, SessionModelState } from "../types.ts";
import { mergeConfig } from "./config-merger.ts";

/** ModelRegistry 的最小接口（duck-typed，避免强耦合 SDK 类型） */
export interface ModelRegistryLike {
  find(provider: string, modelId: string): { provider: string; name: string; reasoning: boolean; thinkingLevelMap?: Record<string, string | null>; contextWindow?: number } | undefined;
  hasConfiguredAuth(model: unknown): boolean;
  /** 返回所有已配置 auth 的可用模型（config-wizard 用） */
  getAvailable(): Array<{ provider: string; name: string; reasoning: boolean; thinkingLevelMap?: Record<string, string | null>; contextWindow?: number }>;
}

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
  const { agentConfig, modelRegistry, paramOverride } = opts;

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
    if (!provider || !modelId) { tried.push(candidate.modelStr); continue; }
    const model = modelRegistry.find(provider, modelId);
    if (!model || !modelRegistry.hasConfiguredAuth(model)) {
      tried.push(candidate.modelStr);
      continue;
    }
    return {
      model: model as never,
      thinkingLevel: resolveThinkingLevel(model, candidate.thinkingLevel),
      source: candidate.source,
    };
  }

  throw new Error(`No available model for agent "${opts.agentName}". Tried: ${tried.join(", ") || "(none)"}`);
}

/** 解析 "provider/modelId" 格式（modelId 可含 /，取第一个 / 分割） */
function parseModelString(s: string): [string, string] | [undefined, undefined] {
  const idx = s.indexOf("/");
  if (idx <= 0) return [undefined, undefined];
  return [s.slice(0, idx), s.slice(idx + 1)];
}
