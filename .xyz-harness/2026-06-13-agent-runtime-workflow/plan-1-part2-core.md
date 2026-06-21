# Subagents 包实现计划 — Part 2：核心编排（任务 11-16）

> 本文档是 [`./plan-1-subagents.md`](./plan-1-subagents.md) 的续篇，包含剩余 6 个任务。
> 前置条件：plan-1 任务 1-10 已完成（types、pool、event-bridge、output-collector、turn-limiter、frontmatter、category、global-config、agent-registry 全部就绪）。

---

## 任务 11：config-merger + tool-filter

**文件：**
- 创建：`extensions/subagents/src/resolution/config-merger.ts`
- 创建：`extensions/subagents/src/resolution/tool-filter.ts`
- 创建：`extensions/subagents/src/__tests__/config-merger.test.ts`
- 创建：`extensions/subagents/src/__tests__/tool-filter.test.ts`

**职责：** FR-3（5 级配置合并）+ FR-6（三层 tool 过滤 → allowlist）。纯函数。

- [ ] **步骤 1：编写 config-merger 失败的测试**

```typescript
// src/__tests__/config-merger.test.ts
import { describe, it, expect } from "vitest";
import { mergeConfig } from "../resolution/config-merger.ts";
import { DEFAULT_CATEGORIES } from "../category.ts";
import type { SubagentsGlobalConfig, SessionModelState } from "../types.ts";

const baseConfig: SubagentsGlobalConfig = {
  version: 1, yoloByDefault: false, maxConcurrent: 4,
  categories: { ...DEFAULT_CATEGORIES },
  agentCategoryOverrides: {},
  fallback: { model: "fallback/model", thinkingLevel: "low" },
};
const emptyState: SessionModelState = { yoloMode: false, perAgent: {}, perCategory: {} };

describe("mergeConfig (5-level priority)", () => {
  it("level 5 (param override) wins over everything", () => {
    const result = mergeConfig({
      agentConfig: { name: "worker", systemPrompt: "", source: "builtin", model: "agent/model" },
      agentName: "worker",
      category: "coding",
      globalConfig: baseConfig,
      sessionState: { ...emptyState, perAgent: { worker: { model: "session/model" } } },
      paramOverride: { model: "param/model", thinkingLevel: "xhigh" },
    });
    expect(result.model).toBe("param/model");
    expect(result.thinkingLevel).toBe("xhigh");
    expect(result.source).toBe("param");
  });

  it("level 4 (per-agent session) wins over category default", () => {
    const result = mergeConfig({
      agentConfig: { name: "worker", systemPrompt: "", source: "builtin" },
      agentName: "worker",
      category: "coding",
      globalConfig: baseConfig,
      sessionState: { ...emptyState, perAgent: { worker: { model: "session/model", thinkingLevel: "high" } } },
    });
    expect(result.model).toBe("session/model");
    expect(result.source).toBe("per-agent");
  });

  it("level 3 (per-category session) wins over global category default", () => {
    const result = mergeConfig({
      agentConfig: { name: "x", systemPrompt: "", source: "builtin" },
      agentName: "x",
      category: "coding",
      globalConfig: baseConfig,
      sessionState: { ...emptyState, perCategory: { coding: { model: "session-cat/model" } } },
    });
    expect(result.model).toBe("session-cat/model");
    expect(result.source).toBe("per-category");
  });

  it("level 2 (global category default) used when no session override", () => {
    const result = mergeConfig({
      agentConfig: { name: "x", systemPrompt: "", source: "builtin" },
      agentName: "x",
      category: "coding",
      globalConfig: baseConfig,
      sessionState: emptyState,
    });
    expect(result.model).toBe(DEFAULT_CATEGORIES.coding.model);
    expect(result.source).toBe("category-default");
  });

  it("level 1 (agent frontmatter model) used when no category match", () => {
    const result = mergeConfig({
      agentConfig: { name: "x", systemPrompt: "", source: "builtin", model: "agent/model" },
      agentName: "x",
      category: "nonexistent-category",
      globalConfig: baseConfig,
      sessionState: emptyState,
    });
    expect(result.model).toBe("agent/model");
    expect(result.source).toBe("agent-default");
  });

  it("falls back to global fallback model when nothing else matches", () => {
    const result = mergeConfig({
      agentConfig: { name: "x", systemPrompt: "", source: "builtin" },
      agentName: "x",
      category: "nonexistent",
      globalConfig: baseConfig,
      sessionState: emptyState,
    });
    expect(result.model).toBe("fallback/model");
    expect(result.source).toBe("global-fallback");
  });
});
```

- [ ] **步骤 2：编写 tool-filter 失败的测试**

```typescript
// src/__tests__/tool-filter.test.ts
import { describe, it, expect } from "vitest";
import { filterTools, isExcludedBySuffix } from "../resolution/tool-filter.ts";

describe("isExcludedBySuffix", () => {
  it("matches plain name", () => {
    expect(isExcludedBySuffix("workflow_run", ["workflow_run"])).toBe(true);
  });
  it("matches scoped name by suffix", () => {
    expect(isExcludedBySuffix("@zhushanwen/workflow_run", ["workflow_run"])).toBe(true);
  });
  it("does not match unrelated", () => {
    expect(isExcludedBySuffix("read", ["workflow_run"])).toBe(false);
  });
});

describe("filterTools", () => {
  const allTools = [
    { name: "read" }, { name: "bash" }, { name: "grep" },
    { name: "@zhushanwen/workflow_run" }, { name: "structured-output" },
  ];

  it("builtinTools whitelist filters builtin tools", () => {
    const result = filterTools({
      allTools,
      config: { builtinTools: ["read"], extensions: false },
    });
    expect(result.allowedTools).toEqual(["read"]);
    expect(result.excludedTools.length).toBeGreaterThan(0);
  });

  it("builtinTools undefined = all builtin tools allowed", () => {
    const result = filterTools({ allTools, config: { extensions: false } });
    // 排除 EXCLUDED_TOOL_NAMES 后的 builtin
    expect(result.allowedTools).toContain("read");
    expect(result.allowedTools).not.toContain("@zhushanwen/workflow_run");
  });

  it("extensions=false excludes all extension tools (only builtin pass)", () => {
    const result = filterTools({
      allTools,
      config: { builtinTools: ["read"], extensions: false },
    });
    expect(result.allowedTools).toEqual(["read"]);
  });

  it("excludeTools removes specific tools", () => {
    const result = filterTools({
      allTools,
      config: { excludeTools: ["bash"] },
    });
    expect(result.allowedTools).not.toContain("bash");
  });

  it("always excludes EXCLUDED_TOOL_NAMES (workflow_* etc.)", () => {
    const result = filterTools({ allTools, config: {} });
    expect(result.allowedTools).not.toContain("@zhushanwen/workflow_run");
  });
});
```

- [ ] **步骤 3：运行测试确认失败**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：FAIL（两个模块不存在）。

- [ ] **步骤 4：创建 `resolution/config-merger.ts`**

```typescript
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
```

- [ ] **步骤 5：创建 `resolution/tool-filter.ts`**

```typescript
// src/resolution/tool-filter.ts
import type { ToolFilterConfig, ToolFilterResult, ToolInfo } from "../types.ts";
import { EXCLUDED_TOOL_NAMES } from "../types.ts";

/**
 * FR-6.2: 检查 toolName 是否以 EXCLUDED_TOOL_NAMES 中任一名字结尾（支持 @scope/name 格式）。
 */
export function isExcludedBySuffix(toolName: string, excluded: readonly string[]): boolean {
  return excluded.some((ex) => toolName === ex || toolName.endsWith("/" + ex));
}

/**
 * FR-6: 三层 tool 过滤，输出 allowlist（传给 createAgentSession.tools）。
 * SDK 无 excludeTools 参数，所以排除 = 从全集移除后取剩余作为 allowlist。
 *
 * 过滤逻辑：
 * 1. 从 allTools 出发
 * 2. 移除 EXCLUDED_TOOL_NAMES（递归排除，防嵌套）
 * 3. 移除 config.excludeTools（后缀匹配）
 * 4. builtinTools 白名单过滤（只保留白名单内的 builtin tool）
 * 5. extensions 策略（false=移除所有 extension tool，白名单=只保留匹配的）
 *
 * 注意：builtin vs extension 的区分基于 tool 名是否以 @ 开头（scoped = extension）。
 * 此函数无法 100% 准确区分 builtin/extension（SDK 层才知），做启发式判断。
 */
export function filterTools(opts: {
  allTools: ToolInfo[];
  config: ToolFilterConfig;
}): ToolFilterResult {
  const { allTools, config } = opts;
  const excluded: string[] = [];

  const isExcluded = (name: string): boolean => {
    if (isExcludedBySuffix(name, EXCLUDED_TOOL_NAMES)) return true;
    if (config.excludeTools && isExcludedBySuffix(name, config.excludeTools)) return true;
    return false;
  };

  const allowed = allTools
    .map((t) => t.name)
    .filter((name) => {
      if (isExcluded(name)) { excluded.push(name); return false; }

      const isExtension = name.startsWith("@");

      // builtinTools 白名单（仅作用于 builtin tool）
      if (!isExtension && config.builtinTools !== undefined) {
        if (!config.builtinTools.includes(name)) { excluded.push(name); return false; }
      }

      // extensions 策略
      if (isExtension) {
        if (config.extensions === false) { excluded.push(name); return false; }
        if (Array.isArray(config.extensions) && !config.extensions.some((ext) => isExcludedBySuffix(name, [ext]))) {
          excluded.push(name);
          return false;
        }
      }

      return true;
    });

  return { allowedTools: allowed, excludedTools: excluded };
}
```

- [ ] **步骤 6：运行测试确认通过**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：PASS（config-merger 6 + tool-filter 5 = 11 个用例）。

- [ ] **步骤 7：提交**

```bash
git add extensions/subagents/src/resolution/config-merger.ts extensions/subagents/src/resolution/tool-filter.ts extensions/subagents/src/__tests__/config-merger.test.ts extensions/subagents/src/__tests__/tool-filter.test.ts
git commit -m "feat(subagents): add config-merger (5-level) + tool-filter (3-layer → allowlist)"
```

---

## 任务 12：model-resolver

**文件：**
- 创建：`extensions/subagents/src/resolution/model-resolver.ts`
- 创建：`extensions/subagents/src/__tests__/model-resolver.test.ts`

**职责：** FR-4。`resolveModelForAgent()` 按 mergeConfig 结果 + fallback 链解析为 `ResolvedModel`（含 `Model<any>` 对象 + 验证过的 thinkingLevel）。依赖 config-merger（任务 11）、global-config（任务 9）。

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/model-resolver.test.ts
import { describe, it, expect, vi } from "vitest";
import { resolveModelForAgent } from "../resolution/model-resolver.ts";
import { DEFAULT_CATEGORIES } from "../category.ts";
import type { SubagentsGlobalConfig, SessionModelState } from "../types.ts";

// Mock ModelRegistry（duck-typed）
function makeRegistry(available: Record<string, { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> }>) {
  return {
    find: vi.fn((provider: string, modelId: string) => {
      const key = `${provider}/${modelId}`;
      const def = available[key];
      if (!def) return undefined;
      return {
        id: modelId, name: modelId, provider,
        reasoning: def.reasoning ?? true,
        thinkingLevelMap: def.thinkingLevelMap,
      };
    }),
    hasConfiguredAuth: vi.fn(() => true),
  };
}

const baseConfig: SubagentsGlobalConfig = {
  version: 1, yoloByDefault: false, maxConcurrent: 4,
  categories: { ...DEFAULT_CATEGORIES },
  agentCategoryOverrides: {},
  fallback: { model: "mimo-router/mimo-v2.5", thinkingLevel: "low" },
};
const emptyState: SessionModelState = { yoloMode: false, perAgent: {}, perCategory: {} };

describe("resolveModelForAgent", () => {
  it("resolves category default model and validates thinkingLevel", () => {
    const registry = makeRegistry({
      "deepseek-router/ds-flash": { thinkingLevelMap: { off: "off", low: "low", high: "high", xhigh: "max" } },
    });
    const result = resolveModelForAgent({
      agentName: "worker",
      agentConfig: { name: "worker", systemPrompt: "", source: "builtin" },
      category: "coding",
      globalConfig: baseConfig, sessionState: emptyState,
      modelRegistry: registry as never,
    });
    expect(result.model.provider).toBe("deepseek-router");
    expect(result.model.name).toBe("ds-flash");
    expect(result.thinkingLevel).toBe("high");
  });

  it("falls back to agent.modelCandidates when primary unavailable", () => {
    const registry = makeRegistry({
      "mimo-router/mimo-v2.5": { thinkingLevelMap: { low: "low", medium: "medium", high: "high" } },
    });
    const result = resolveModelForAgent({
      agentName: "x",
      agentConfig: { name: "x", systemPrompt: "", source: "builtin", model: "unavail/model", modelCandidates: ["mimo-router/mimo-v2.5"] },
      category: "nonexistent",
      globalConfig: baseConfig, sessionState: emptyState,
      modelRegistry: registry as never,
    });
    expect(result.model.name).toBe("mimo-v2.5");
    expect(result.source).toBe("agent-default");
  });

  it("falls back to global fallback when agent model and candidates unavailable", () => {
    const registry = makeRegistry({
      "mimo-router/mimo-v2.5": { thinkingLevelMap: { low: "low" } },
    });
    const result = resolveModelForAgent({
      agentName: "x",
      agentConfig: { name: "x", systemPrompt: "", source: "builtin", model: "unavail/model" },
      category: "nonexistent",
      globalConfig: baseConfig, sessionState: emptyState,
      modelRegistry: registry as never,
    });
    expect(result.model.name).toBe("mimo-v2.5");
    expect(result.source).toBe("global-fallback");
  });

  it("uses env SUBAGENT_MODEL as last resort", () => {
    process.env.SUBAGENT_MODEL = "env/model";
    const registry = makeRegistry({ "env/model": { thinkingLevelMap: { off: "off" } } });
    const result = resolveModelForAgent({
      agentName: "x",
      agentConfig: { name: "x", systemPrompt: "", source: "builtin" },
      category: "nonexistent",
      globalConfig: { ...baseConfig, fallback: { model: "alsounavail/model" } },
      sessionState: emptyState,
      modelRegistry: registry as never,
    });
    expect(result.model.provider).toBe("env");
    expect(result.source).toBe("env");
    delete process.env.SUBAGENT_MODEL;
  });

  it("throws when no model available", () => {
    const registry = makeRegistry({}); // 全部不可用
    expect(() => resolveModelForAgent({
      agentName: "x",
      agentConfig: { name: "x", systemPrompt: "", source: "builtin" },
      category: "nonexistent",
      globalConfig: { ...baseConfig, fallback: { model: "unavail/model" } },
      sessionState: emptyState,
      modelRegistry: registry as never,
    })).toThrow(/No available model/);
  });

  it("skips thinkingLevel when model.reasoning === false", () => {
    const registry = makeRegistry({
      "carbon-router/qwen3-0.6b": { reasoning: false },
    });
    const result = resolveModelForAgent({
      agentName: "x",
      agentConfig: { name: "x", systemPrompt: "", source: "builtin" },
      category: "general",
      globalConfig: { ...baseConfig, categories: { ...DEFAULT_CATEGORIES, general: { label: "g", model: "carbon-router/qwen3-0.6b", thinkingLevel: "low" } } },
      sessionState: emptyState,
      modelRegistry: registry as never,
    });
    expect(result.thinkingLevel).toBeUndefined();
  });

  it("clamps thinkingLevel to highest available when requested level unavailable", () => {
    const registry = makeRegistry({
      "zhipu-coding-plan-router/glm-5.1": {
        thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: "max" },
      },
    });
    const result = resolveModelForAgent({
      agentName: "x",
      agentConfig: { name: "x", systemPrompt: "", source: "builtin" },
      category: "general",
      globalConfig: { ...baseConfig, categories: { ...DEFAULT_CATEGORIES, general: { label: "g", model: "zhipu-coding-plan-router/glm-5.1", thinkingLevel: "medium" } } },
      sessionState: emptyState,
      modelRegistry: registry as never,
    });
    // medium 不可用（null），降到最高可用 = xhigh
    expect(result.thinkingLevel).toBe("xhigh");
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：FAIL。

- [ ] **步骤 3：编写实现**

```typescript
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
```

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：PASS（7 个用例）。

- [ ] **步骤 5：提交**

```bash
git add extensions/subagents/src/resolution/model-resolver.ts extensions/subagents/src/__tests__/model-resolver.test.ts
git commit -m "feat(subagents): add model-resolver — 5-level config + fallback chain + thinkingLevel clamping"
```

---

## 任务 13：fork-context + session-model-state

**文件：**
- 创建：`extensions/subagents/src/resolution/fork-context.ts`
- 创建：`extensions/subagents/src/state/session-model-state.ts`
- 创建：`extensions/subagents/src/__tests__/fork-context.test.ts`
- 创建：`extensions/subagents/src/__tests__/session-model-state.test.ts`

**职责：** FR-5（fork 截断）+ FR-4.7（会话状态持久化/恢复）。纯函数。

- [ ] **步骤 1：编写 fork-context 测试**

```typescript
// src/__tests__/fork-context.test.ts
import { describe, it, expect } from "vitest";
import { forkContext } from "../resolution/fork-context.ts";

function makeEntry(role: string, text: string) {
  return { type: role === "assistant" ? "assistantMessage" : "userMessage", content: text } as never;
}

describe("forkContext", () => {
  it("extracts last 5 exchanges by default", () => {
    const branch: never[] = [];
    for (let i = 0; i < 8; i++) {
      branch.push(makeEntry("user", `user msg ${i}`));
      branch.push(makeEntry("assistant", `assistant reply ${i}`));
    }
    const result = forkContext(branch, {});
    expect(result.exchangeCount).toBe(5);
    expect(result.context).toContain("user msg 3");
    expect(result.context).not.toContain("user msg 2");
  });

  it("respects maxExchanges override", () => {
    const branch: never[] = [];
    for (let i = 0; i < 5; i++) {
      branch.push(makeEntry("user", `u${i}`));
      branch.push(makeEntry("assistant", `a${i}`));
    }
    const result = forkContext(branch, { maxExchanges: 2 });
    expect(result.exchangeCount).toBe(2);
  });

  it("handles fewer than 5 exchanges", () => {
    const branch = [makeEntry("user", "hi"), makeEntry("assistant", "hello")];
    const result = forkContext(branch, {});
    expect(result.exchangeCount).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("truncates by token estimate", () => {
    const branch: never[] = [];
    for (let i = 0; i < 20; i++) {
      branch.push(makeEntry("user", "x".repeat(500))); // 每条 500 字符
      branch.push(makeEntry("assistant", "y".repeat(500)));
    }
    const result = forkContext(branch, { maxTokens: 400 }); // 约 1200 字符
    expect(result.truncated).toBe(true);
  });

  it("formats as Parent Conversation Context", () => {
    const branch = [makeEntry("user", "hello"), makeEntry("assistant", "hi there")];
    const result = forkContext(branch, {});
    expect(result.context).toContain("# Parent Conversation Context");
    expect(result.context).toContain("hello");
    expect(result.context).toContain("hi there");
  });
});
```

- [ ] **步骤 2：编写 session-model-state 测试**

```typescript
// src/__tests__/session-model-state.test.ts
import { describe, it, expect } from "vitest";
import { createSessionModelState, setAgentModel, setCategoryModel, serializeState, restoreState } from "../state/session-model-state.ts";

describe("SessionModelState", () => {
  it("creates with defaults", () => {
    const state = createSessionModelState(false);
    expect(state.yoloMode).toBe(false);
    expect(state.perAgent).toEqual({});
    expect(state.perCategory).toEqual({});
  });

  it("setAgentModel stores per-agent override", () => {
    const state = createSessionModelState(false);
    setAgentModel(state, "worker", "deepseek-router/ds-flash", "high");
    expect(state.perAgent.worker).toEqual({ model: "deepseek-router/ds-flash", thinkingLevel: "high" });
  });

  it("setCategoryModel stores per-category override", () => {
    const state = createSessionModelState(false);
    setCategoryModel(state, "coding", "mimo-router/mimo-v2.5", "medium");
    expect(state.perCategory.coding).toEqual({ model: "mimo-router/mimo-v2.5", thinkingLevel: "medium" });
  });

  it("serialize/restore round-trips correctly", () => {
    const state = createSessionModelState(true);
    setAgentModel(state, "worker", "m/m");
    setCategoryModel(state, "coding", "c/c", "low");
    const serialized = serializeState(state);
    expect(typeof serialized).toBe("string");
    const restored = restoreState(JSON.parse(serialized), false);
    expect(restored.yoloMode).toBe(true);
    expect(restored.perAgent.worker.model).toBe("m/m");
    expect(restored.perCategory.coding.model).toBe("c/c");
  });

  it("restore handles missing fields with defaults", () => {
    const restored = restoreState({}, false);
    expect(restored.yoloMode).toBe(false);
    expect(restored.perAgent).toEqual({});
  });
});
```

- [ ] **步骤 3：运行测试确认失败**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：FAIL。

- [ ] **步骤 4：创建 `resolution/fork-context.ts`**

```typescript
// src/resolution/fork-context.ts
import type { ForkOptions, ForkResult } from "../types.ts";

const DEFAULT_MAX_EXCHANGES = 5;
const DEFAULT_MAX_TOKENS = 4000;
// 粗略 token 估算：中文约 1 字 = 1 token，英文约 4 字符 = 1 token。
// 这里用字符数 / 3 作为近似（保守）
const CHARS_PER_TOKEN = 3;

/** FR-5.1: 从父 session branch 提取 user/assistant 消息，跳过 toolResult。 */
export function forkContext(branch: ReadonlyArray<unknown>, opts: ForkOptions): ForkResult {
  const maxExchanges = opts.maxExchanges ?? DEFAULT_MAX_EXCHANGES;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  // 提取 user/assistant 文本对
  interface Exchange { userText?: string; assistantText?: string; }
  const exchanges: Exchange[] = [];
  let current: Exchange | null = null;

  for (const entry of branch) {
    const e = entry as { type?: string; content?: string | string[] };
    const text = extractText(e.content);
    if (e.type === "userMessage") {
      if (current) exchanges.push(current);
      current = { userText: text };
    } else if (e.type === "assistantMessage") {
      if (current) current.assistantText = text;
      else current = { assistantText: text };
    }
    // toolResult / 其他类型跳过
  }
  if (current) exchanges.push(current);

  // 取最后 N 轮
  const limited = exchanges.slice(-maxExchanges);

  // token 截断
  let totalChars = 0;
  let truncated = false;
  const kept: Exchange[] = [];
  for (let i = limited.length - 1; i >= 0; i--) {
    const ex = limited[i];
    const chars = (ex.userText?.length ?? 0) + (ex.assistantText?.length ?? 0);
    if (totalChars + chars > maxTokens * CHARS_PER_TOKEN) {
      truncated = true;
      break;
    }
    totalChars += chars;
    kept.unshift(ex);
  }

  // 格式化
  const lines: string[] = ["# Parent Conversation Context", ""];
  for (const ex of kept) {
    if (ex.userText) { lines.push(`**User:** ${ex.userText}`, ""); }
    if (ex.assistantText) { lines.push(`**Assistant:** ${ex.assistantText}`, ""); }
  }

  return {
    context: lines.join("\n"),
    exchangeCount: kept.length,
    truncated,
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : (c as { text?: string })?.text ?? "")).join("");
  return "";
}
```

- [ ] **步骤 5：创建 `state/session-model-state.ts`**

```typescript
// src/state/session-model-state.ts
import type { SessionModelState } from "../types.ts";

/** FR-4.7.1: 创建默认状态 */
export function createSessionModelState(yoloByDefault: boolean): SessionModelState {
  return { yoloMode: yoloByDefault, perAgent: {}, perCategory: {} };
}

export function setAgentModel(state: SessionModelState, agent: string, model: string, thinkingLevel?: string): void {
  state.perAgent[agent] = { model, thinkingLevel };
}

export function setCategoryModel(state: SessionModelState, category: string, model: string, thinkingLevel?: string): void {
  state.perCategory[category] = { model, thinkingLevel };
}

/** FR-4.7.1: 序列化为 JSON 字符串（用于 pi.appendEntry 持久化） */
export function serializeState(state: SessionModelState): string {
  return JSON.stringify(state);
}

/**
 * FR-4.7.3: 从持久化数据恢复，缺失字段用默认值。
 * 输入 null/undefined 或格式错误时返回默认状态。
 */
export function restoreState(data: unknown, yoloByDefault: boolean): SessionModelState {
  if (!data || typeof data !== "object") {
    return createSessionModelState(yoloByDefault);
  }
  const d = data as Partial<SessionModelState>;
  return {
    yoloMode: typeof d.yoloMode === "boolean" ? d.yoloMode : yoloByDefault,
    perAgent: d.perAgent && typeof d.perAgent === "object" ? { ...d.perAgent } : {},
    perCategory: d.perCategory && typeof d.perCategory === "object" ? { ...d.perCategory } : {},
  };
}
```

- [ ] **步骤 6：运行测试确认通过**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：PASS（fork-context 5 + session-model-state 5 = 10 个用例）。

- [ ] **步骤 7：提交**

```bash
git add extensions/subagents/src/resolution/fork-context.ts extensions/subagents/src/state/session-model-state.ts extensions/subagents/src/__tests__/fork-context.test.ts extensions/subagents/src/__tests__/session-model-state.test.ts
git commit -m "feat(subagents): add fork-context (truncation) + session-model-state (persist/restore)"
```

---

## 任务 14：runAgent + ManagedSession

**文件：**
- 创建：`extensions/subagents/src/core/run-agent.ts`
- 创建：`extensions/subagents/src/core/session.ts`

**职责：** FR-1。核心执行逻辑。这是整个包的中枢，集成所有 L1+L2 组件。由于直接调用 Pi SDK（`createAgentSession`），无法在单元测试中 mock，因此本任务**不要求新写测试**——验证通过 typecheck + 任务 15 的 runtime 集成 + plan-2 的 workflow 端到端测试覆盖。

**依赖注入设计：** `runAgent()` 通过参数接收 `modelRegistry`、`agentRegistry`、`globalConfig`、`sessionState`，而非直接 import 全局单例。这样 runtime（任务 15）负责注入，runAgent 保持可测试性。

- [ ] **步骤 1：创建 `core/run-agent.ts`**

```typescript
// src/core/run-agent.ts
import type {
  RunAgentOptions, AgentResult, AgentEvent, ToolCallEntry,
  AgentConfig, SubagentsGlobalConfig, SessionModelState, ConcurrencyPool,
} from "../types.ts";
import { createEventBridge } from "./event-bridge.ts";
import { collectResponseText } from "./output-collector.ts";
import { createTurnLimiter } from "./turn-limiter.ts";
import { resolveModelForAgent, type ModelRegistryLike } from "../resolution/model-resolver.ts";
import { filterTools } from "../resolution/tool-filter.ts";
import { inferCategory } from "../category.ts";

/** runAgent 的依赖注入容器（由 SubagentRuntime 提供） */
export interface RunAgentContext {
  modelRegistry: ModelRegistryLike;
  resolveAgent: (name: string) => AgentConfig | undefined;
  globalConfig: SubagentsGlobalConfig;
  sessionState: SessionModelState;
  globalPool: ConcurrencyPool;
  /** cwd（传给 createAgentSession） */
  cwd: string;
  /** agentDir（传给 createAgentSession） */
  agentDir: string;
}

/** 动态 import Pi SDK（避免循环依赖 + 允许 vitest alias mock） */
async function getSdk(): Promise<{
  DefaultResourceLoader: new (opts: Record<string, unknown>) => { reload(): Promise<void> };
  SessionManager: { inMemory(cwd?: string): unknown };
  createAgentSession: (opts: Record<string, unknown>) => Promise<AgentSessionLike>;
}> {
  return await import("@mariozechner/pi-coding-agent");
}

/** AgentSession 的最小可用接口（duck-typed，与 SDK AgentSession 结构兼容） */
interface AgentSessionLike {
  prompt(task: string, options?: unknown): Promise<void>;
  steer(message: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(fn: (event: unknown) => void): () => void;
  sessionId: string;
  messages: ReadonlyArray<{ role: string; usage?: Record<string, unknown>; content?: ReadonlyArray<{ type: string; text?: string }> }>;
  getAllTools(): Array<{ name: string }>;
  setActiveToolsByName(names: string[]): void;
}

/**
 * FR-1.1: runAgent — 一次性执行 agent，返回 AgentResult。
 * 在主线程调用（Worker 线程无 Pi SDK 上下文）。
 */
export async function runAgent(opts: RunAgentOptions, ctx: RunAgentContext): Promise<AgentResult> {
  const startTime = Date.now();

  // 步骤 1: 解析 agent 配置
  const agentConfig = opts.agent ? ctx.resolveAgent(opts.agent) : undefined;
  const agentName = opts.agent ?? "default";

  // 步骤 1c: category 推断
  const category = inferCategory(agentName, agentConfig, ctx.globalConfig.agentCategoryOverrides);

  // 步骤 1a: 模型解析（含 fallback 链）
  const resolved = resolveModelForAgent({
    agentName, agentConfig, category,
    globalConfig: ctx.globalConfig, sessionState: ctx.sessionState,
    modelRegistry: ctx.modelRegistry,
    paramOverride: { model: opts.model, thinkingLevel: opts.thinkingLevel },
  });

  // 步骤 2: 并发控制
  const pool = opts.pool ?? ctx.globalPool;
  await pool.acquire(opts.priority);

  try {
    // 动态 import SDK（在 acquire 后，减少占用期间的 import 开销）
    const { DefaultResourceLoader, SessionManager, createAgentSession } = await getSdk();

    // 步骤 3: 构建 ResourceLoader（不含 tool 配置）
    const resourceLoader = new DefaultResourceLoader({
      cwd: ctx.cwd, agentDir: ctx.agentDir,
      appendSystemPrompt: opts.appendSystemPrompt,
      additionalSkillPaths: opts.skillPath ? [opts.skillPath] : undefined,
    });
    await resourceLoader.reload();

    // FR-6 tool 过滤配置（从 agentConfig 提取策略）
    const toolFilterConfig = {
      builtinTools: agentConfig?.builtinTools,
      extensions: agentConfig?.extensions,
      excludeTools: agentConfig?.excludeTools ?? [],
    };

    // 创建 session（tool 过滤在创建后通过 setActiveToolsByName 完成，见下方）
    const { session } = await createAgentSession({
      model: resolved.model,
      thinkingLevel: resolved.thinkingLevel as never,
      resourceLoader,
      sessionManager: SessionManager.inMemory(ctx.cwd),
    }) as { session: AgentSessionLike };

    // 创建后过滤 tool（FR-6: 移除 EXCLUDED + 按 agentConfig 策略）
    const allTools = session.getAllTools().map((t) => ({ name: t.name }));
    const filterResult = filterTools({ allTools, config: toolFilterConfig });
    if (filterResult.allowedTools && filterResult.allowedTools.length < allTools.length) {
      session.setActiveToolsByName(filterResult.allowedTools);
    }

    // 步骤 4 续: subscribe 事件桥接（bridge 累计 turn/toolCalls/usage）
    const bridge = createEventBridge(opts.onEvent ?? (() => {}));

    // turn 限制器
    const limiter = createTurnLimiter({
      maxTurns: opts.maxTurns ?? 0,
      graceTurns: opts.graceTurns ?? 2,
      steer: (msg) => { void session.steer(msg); },
      abort: () => { void session.abort(); },
    });

    const unsubscribe = session.subscribe((event: unknown) => {
      bridge.handle(event as never);
      if ((event as { type: string }).type === "turn_end") {
        limiter.onTurnEnd(bridge.turnCount);
      }
    });

    // AbortSignal
    let signalListener: (() => void) | undefined;
    if (opts.signal) {
      if (opts.signal.aborted) { void session.abort(); }
      else {
        signalListener = () => { void session.abort(); };
        opts.signal.addEventListener("abort", signalListener);
      }
    }

    let success = true;
    let error: string | undefined;

    try {
      // 步骤 5: 构建 task（schema 拼入）
      let task = opts.task;
      if (opts.schema) {
        task = task + "\n\n" + formatSchemaInstruction(opts.schema);
      }

      // 步骤 5b: 执行
      await session.prompt(task);
    } catch (err) {
      success = false;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      unsubscribe();
      if (signalListener && opts.signal) opts.signal.removeEventListener("abort", signalListener);
    }

    // 步骤 5c/d: 收集结果
    const text = collectResponseText(session.messages);

    // 提取 parsedOutput（从 toolCalls 找 structured-output）
    let parsedOutput: unknown;
    for (const tc of bridge.toolCalls) {
      if (tc.toolName === "structured-output" && tc.result?.details) {
        parsedOutput = tc.result.details;
        break;
      }
    }

    // FR-8.3: usage 从 bridge 累计器读取（已累加所有 message_end 事件）
    const accumulated = bridge.usage;
    const hasUsage = accumulated.input > 0 || accumulated.output > 0;

    return {
      text,
      parsedOutput,
      usage: hasUsage ? accumulated : undefined,
      turns: bridge.turnCount,
      durationMs: Date.now() - startTime,
      success,
      error,
      sessionId: session.sessionId,
      toolCalls: bridge.toolCalls,
    };
  } catch (err) {
    // createAgentSession 本身失败（如模型不可用）
    return {
      text: "",
      turns: 0,
      durationMs: Date.now() - startTime,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      sessionId: "",
      toolCalls: [],
    };
  } finally {
    pool.release();
  }
}

/** FR-9.6: schema 指令模板（与 workflow agent-opts-resolver 一致） */
function formatSchemaInstruction(schema: Record<string, unknown>): string {
  return [
    "MANDATORY: Structured Output Requirement",
    "You MUST call the `structured-output` tool with your final answer.",
    "The schema for the structured output is:",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
  ].join("\n");
}
```

> **注意**：`run-agent.ts` 故意使用动态 `import("@mariozechner/pi-coding-agent")` 而非顶层 import。原因：(1) 避免循环依赖（runtime → run-agent → sdk，而 sdk 类型在 vitest alias 中桩接）；(2) 允许 vitest 的 resolve.alias 生效。如果顶层 import，vitest 会尝试加载真实 SDK。

- [ ] **步骤 2：创建 `core/session.ts`**

```typescript
// src/core/session.ts
import type { ManagedSession, ManagedSessionOptions, AgentResult } from "../types.ts";
import type { RunAgentContext } from "./run-agent.ts";
import { runAgent } from "./run-agent.ts";

/**
 * FR-1.2: createManagedSession — 创建长生命周期 session，支持多次 prompt/steer/abort。
 * V1 实现：每次 prompt() 内部调用 runAgent()（创建新 session），steer/abort 通过
 * 闭包持有当前 runAgent 的 AbortSignal + steer 回调。
 *
 * 注意：真正的 ManagedSession（复用同一 session）需要更深度集成 createAgentSession。
 * V1 提供编程式 API 能力，steer/abort 在单次 prompt 内生效。
 */
export function createManagedSession(options: ManagedSessionOptions, ctx: RunAgentContext): ManagedSession {
  let disposed = false;
  let currentAbort: AbortController | null = null;
  let steerBuffer: string[] = [];

  const session: ManagedSession = {
    get sessionId() { return currentAbort ? "pending" : ""; },
    get alive() { return !disposed; },

    async prompt(task, promptOpts): Promise<AgentResult> {
      if (disposed) throw new Error("ManagedSession disposed");
      const controller = new AbortController();
      currentAbort = controller;

      // 合并 options
      const mergedSignal = promptOpts?.signal
        ? mergeSignals(promptOpts.signal, controller.signal)
        : controller.signal;

      const result = await runAgent({
        task,
        agent: options.agent,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        skillPath: options.skillPath,
        appendSystemPrompt: options.appendSystemPrompt,
        onEvent: options.onEvent,
        signal: mergedSignal,
        maxTurns: promptOpts?.maxTurns,
      }, ctx);

      currentAbort = null;
      return result;
    },

    steer(message: string): void {
      if (disposed) return;
      steerBuffer.push(message);
      // V1: steer buffer 在当前 runAgent 的 turn-limiter 层面暂未消费
      // V2: 通过 session.steer() 透传到运行中的 Pi session
      // V1 行为：记录但不注入（单次 prompt 内 steer 需要更深集成）
    },

    abort(): void {
      if (disposed) return;
      currentAbort?.abort();
    },

    dispose(): void {
      disposed = true;
      currentAbort?.abort();
      currentAbort = null;
    },
  };

  return session;
}

/** 合并两个 AbortSignal：任一触发则合并信号触发 */
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}
```

- [ ] **步骤 3：typecheck 验证**

运行：`pnpm --filter @zhushanwen/pi-subagents typecheck`
预期：PASS。如有 SDK 类型不匹配（如 `createAgentSession` 参数名差异），调整 `core/run-agent.ts` 中的调用。

- [ ] **步骤 4：提交**

```bash
git add extensions/subagents/src/core/run-agent.ts extensions/subagents/src/core/session.ts
git commit -m "feat(subagents): add runAgent + createManagedSession — core execution (FR-1)"
```

---

## 任务 15：runtime + api + 扩展工厂

**文件：**
- 创建：`extensions/subagents/src/runtime.ts`
- 创建：`extensions/subagents/src/api/index.ts`
- 修改：`extensions/subagents/src/index.ts`（完善任务 1 的占位）

**职责：** FR-11、FR-10.2、FR-4.7.1（session_start 注入）。`SubagentRuntime` 单例组合所有能力，扩展工厂创建骨架并在 `session_start` 注入 `modelRegistry`/`sessionManager`。

- [ ] **步骤 1：创建 `runtime.ts`**

```typescript
// src/runtime.ts
import type {
  RunAgentOptions, AgentResult, ManagedSession, ManagedSessionOptions,
  SubagentsGlobalConfig, SessionModelState, ConcurrencyPool, SubagentHooks,
  CategoryDefinition,
} from "./types.ts";
import { DefaultConcurrencyPool } from "./pool/concurrency-pool.ts";
import { loadGlobalConfig } from "./config/global-config.ts";
import { createSessionModelState, restoreState } from "./state/session-model-state.ts";
import { AgentRegistry } from "./registry/agent-registry.ts";
import { BuiltinAgentRegistry } from "./registry/builtin-agents.ts";
import { runAgent, type RunAgentContext } from "./core/run-agent.ts";
import { createManagedSession } from "./core/session.ts";
import { resolveModelForAgent, type ModelRegistryLike } from "./resolution/model-resolver.ts";

/**
 * FR-11.5: SubagentRuntime 单例。组合所有能力。
 * 创建时不含 modelRegistry（骨架），session_start 时注入。
 */
export class SubagentRuntime {
  readonly globalConfig: SubagentsGlobalConfig;
  readonly sessionState: SessionModelState;
  readonly globalPool: ConcurrencyPool;
  readonly agentRegistry: AgentRegistry;
  readonly builtinRegistry: BuiltinAgentRegistry;
  private readonly hooks: SubagentHooks[] = [];

  private modelRegistry: ModelRegistryLike | null = null;
  private homeDir: string;
  private cwd: string;
  private agentDir: string;

  constructor(opts: { cwd: string; homeDir: string; agentDir: string }) {
    this.cwd = opts.cwd;
    this.homeDir = opts.homeDir;
    this.agentDir = opts.agentDir;
    this.globalConfig = loadGlobalConfig(opts.homeDir);
    this.sessionState = createSessionModelState(this.globalConfig.yoloByDefault);
    this.globalPool = new DefaultConcurrencyPool(this.globalConfig.maxConcurrent);
    this.agentRegistry = new AgentRegistry(opts.cwd, opts.homeDir);
    this.builtinRegistry = new BuiltinAgentRegistry();
  }

  /** FR-11.5: session_start 时注入 modelRegistry，触发 agent 发现 */
  injectModelRegistry(registry: ModelRegistryLike): void {
    this.modelRegistry = registry;
    this.agentRegistry.discoverAll(this.builtinRegistry);
  }

  /** FR-11.5: session_start 时从 entries 恢复 session state */
  restoreFromEntries(entries: unknown[]): void {
    for (const entry of entries) {
      const e = entry as { type?: string; data?: unknown };
      if (e.type === "subagent-model-state" && e.data) {
        const restored = restoreState(e.data, this.globalConfig.yoloByDefault);
        Object.assign(this.sessionState, restored);
        break;
      }
    }
  }

  /** FR-14.6: 注册自定义 category（写入 config.json） */
  registerCategory(name: string, defaults: CategoryDefinition): void {
    this.globalConfig.categories[name] = defaults;
  }

  /** FR-14.7: 注册执行钩子 */
  registerHooks(hooks: SubagentHooks): void {
    this.hooks.push(hooks);
  }

  private buildContext(): RunAgentContext {
    if (!this.modelRegistry) {
      throw new Error("SubagentRuntime not initialized: modelRegistry not injected (session_start not fired). Call getRuntime() only after Pi session started.");
    }
    return {
      modelRegistry: this.modelRegistry,
      resolveAgent: (name) => this.agentRegistry.get(name),
      globalConfig: this.globalConfig,
      sessionState: this.sessionState,
      globalPool: this.globalPool,
      cwd: this.cwd,
      agentDir: this.agentDir,
    };
  }

  /** FR-11.1: runAgent */
  async runAgent(opts: RunAgentOptions): Promise<AgentResult> {
    const ctx = this.buildContext();
    // hooks: beforeRun
    let finalOpts = opts;
    for (const h of this.hooks) {
      if (h.beforeRun) finalOpts = await h.beforeRun(finalOpts);
    }
    try {
      const result = await runAgent(finalOpts, ctx);
      // hooks: afterRun
      for (const h of this.hooks) {
        if (h.afterRun) h.afterRun(result, finalOpts);
      }
      return result;
    } catch (err) {
      // hooks: onError
      for (const h of this.hooks) {
        if (h.onError) h.onError(err instanceof Error ? err : new Error(String(err)), finalOpts);
      }
      throw err;
    }
  }

  /** FR-11.1: createManagedSession */
  createManagedSession(options: ManagedSessionOptions): ManagedSession {
    return createManagedSession(options, this.buildContext());
  }

  /**
   * scene → model 字符串解析（workflow 调用，FR-9.9）。
   * scene 名作为 agent 名传入 5 级配置链，category 从 config 推断。
   */
  resolveModelForScene(scene: string): string | undefined {
    if (!this.modelRegistry) return undefined;
    try {
      const result = resolveModelForAgent({
        agentName: scene,
        agentConfig: undefined,
        category: scene,  // scene 名直接作为 category
        globalConfig: this.globalConfig,
        sessionState: this.sessionState,
        modelRegistry: this.modelRegistry,
      });
      return `${result.model.provider}/${result.model.name}`;
    } catch {
      return undefined;
    }
  }
}

// FR-11.5: 进程内单例
let runtimeInstance: SubagentRuntime | undefined;

export function setRuntime(rt: SubagentRuntime): void {
  runtimeInstance = rt;
}

export function getRuntime(): SubagentRuntime | undefined {
  return runtimeInstance;
}
```

- [ ] **步骤 2：创建 `api/index.ts`**（FR-11 公开 API re-export）

```typescript
// src/api/index.ts
export { runAgent } from "../core/run-agent.ts";
export { createManagedSession } from "../core/session.ts";
export { SubagentRuntime, getRuntime, setRuntime } from "../runtime.ts";
export { DefaultConcurrencyPool } from "../pool/concurrency-pool.ts";
export { AgentRegistry, BuiltinAgentRegistry, BUILTIN_AGENTS } from "../registry/index.ts";
export { resolveModelForAgent } from "../resolution/model-resolver.ts";
// resolveModelForScene 是 SubagentRuntime 的方法，通过 getRuntime() 访问
export { inferCategory, DEFAULT_CATEGORIES } from "../category.ts";
export { forkContext } from "../resolution/fork-context.ts";
export { filterTools } from "../resolution/tool-filter.ts";
export { loadGlobalConfig, saveGlobalConfig } from "../config/global-config.ts";

// 类型 re-export
export type {
  RunAgentOptions, AgentResult, AgentEvent, AgentEventType,
  ManagedSession, ManagedSessionOptions,
  AgentConfig, ResolvedModel, CategoryDefinition,
  SubagentsGlobalConfig, SessionModelState,
  ForkOptions, ForkResult, ToolFilterConfig, ToolFilterResult,
  ConcurrencyPool, SubagentHooks,
} from "../types.ts";
```

- [ ] **步骤 3：创建 `registry/index.ts`**（被 api 引用）

```typescript
// src/registry/index.ts
export { AgentRegistry } from "./agent-registry.ts";
export { BuiltinAgentRegistry, BUILTIN_AGENTS } from "./builtin-agents.ts";
export { parseAgentFrontmatter } from "./frontmatter.ts";
```

- [ ] **步骤 4：完善 `src/index.ts`**（扩展工厂）

```typescript
// src/index.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import { SubagentRuntime, setRuntime, getRuntime } from "./runtime.ts";
import { registerSubagentsCommand } from "./commands/config.ts";

/**
 * FR-10.2: Pi extension 工厂。
 * 创建 SubagentRuntime 骨架，在 session_start 注入 modelRegistry。
 */
export default function subagentsExtension(pi: ExtensionAPI): void {
  // 注册 /subagents 命令（FR-4.8）
  registerSubagentsCommand(pi);

  // session_start: 创建/复用 runtime，注入 modelRegistry
  pi.on("session_start", (ctx) => {
    const existing = getRuntime();
    const cwd = ctx.cwd;
    const homeDir = process.env.HOME || process.env.USERPROFILE || cwd;
    const agentDir = path.join(homeDir, ".pi", "agent");

    const rt = existing ?? new SubagentRuntime({ cwd, homeDir, agentDir });
    rt.injectModelRegistry(ctx.modelRegistry as never);

    // 从 session entries 恢复状态
    const entries = ctx.sessionManager.getEntries() as unknown[];
    rt.restoreFromEntries(entries);

    if (!existing) setRuntime(rt);
  });
}
```

- [ ] **步骤 5：typecheck 验证**

运行：`pnpm --filter @zhushanwen/pi-subagents typecheck`
预期：PASS。`commands/config.ts` 在任务 16 创建，此处先确认除 commands import 外无错误。
（如 typecheck 因 commands/config.ts 不存在失败，可临时注释 import，任务 16 恢复）

- [ ] **步骤 6：提交**

```bash
git add extensions/subagents/src/runtime.ts extensions/subagents/src/api/index.ts extensions/subagents/src/registry/index.ts extensions/subagents/src/index.ts
git commit -m "feat(subagents): add SubagentRuntime singleton + public API + extension factory"
```

---

## 任务 16：TUI + /subagents 命令

**文件：**
- 创建：`extensions/subagents/src/tui/format.ts`
- 创建：`extensions/subagents/src/tui/config-wizard.ts`
- 创建：`extensions/subagents/src/commands/config.ts`
- 创建：`extensions/subagents/src/__tests__/format.test.ts`

**职责：** FR-4.8（`/subagents` 命令 + 级联配置向导）、FR-4.9（YOLO）。format.ts 是纯函数可测试。

- [ ] **步骤 1：编写 format.ts 测试**

```typescript
// src/__tests__/format.test.ts
import { describe, it, expect } from "vitest";
import { formatConfigSummary, formatThinkingLevelOption } from "../tui/format.ts";
import { DEFAULT_CATEGORIES } from "../category.ts";
import type { SubagentsGlobalConfig } from "../types.ts";

const cfg: SubagentsGlobalConfig = {
  version: 1, yoloByDefault: false, maxConcurrent: 4,
  categories: { ...DEFAULT_CATEGORIES },
  agentCategoryOverrides: {},
  fallback: { model: "mimo-router/mimo-v2.5", thinkingLevel: "low" },
};

describe("formatConfigSummary", () => {
  it("includes all categories with model + thinkingLevel", () => {
    const summary = formatConfigSummary(cfg, false);
    expect(summary).toContain("coding");
    expect(summary).toContain("deepseek-router/ds-flash");
    expect(summary).toContain("research");
    expect(summary).toContain("YOLO: OFF");
  });

  it("shows YOLO status", () => {
    expect(formatConfigSummary(cfg, true)).toContain("YOLO: ON");
    expect(formatConfigSummary(cfg, false)).toContain("YOLO: OFF");
  });

  it("shows maxConcurrent", () => {
    expect(formatConfigSummary(cfg, false)).toContain("4");
  });
});

describe("formatThinkingLevelOption", () => {
  it("formats level with description", () => {
    expect(formatThinkingLevelOption("high")).toBe("high — 深度推理，耗时较长");
    expect(formatThinkingLevelOption("xhigh")).toBe("xhigh — 最深度推理，耗时最长");
    expect(formatThinkingLevelOption("off")).toBe("off — 不使用推理");
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：FAIL。

- [ ] **步骤 3：创建 `tui/format.ts`**

```typescript
// src/tui/format.ts
import type { SubagentsGlobalConfig } from "../types.ts";

const THINKING_DESCRIPTIONS: Record<string, string> = {
  off: "不使用推理",
  minimal: "极轻推理",
  low: "轻度推理",
  medium: "平衡推理",
  high: "深度推理，耗时较长",
  xhigh: "最深度推理，耗时最长",
};

export function formatThinkingLevelOption(level: string): string {
  return `${level} — ${THINKING_DESCRIPTIONS[level] ?? level}`;
}

/** FR-4.8.1: 格式化配置摘要（/subagents 不带参数时显示） */
export function formatConfigSummary(config: SubagentsGlobalConfig, yoloMode: boolean): string {
  const lines: string[] = [
    "# Subagents 配置",
    "",
    `YOLO: ${yoloMode ? "ON" : "OFF"}  |  全局并发: ${config.maxConcurrent}`,
    "",
    "## Categories",
  ];
  for (const [name, def] of Object.entries(config.categories)) {
    const thinking = def.thinkingLevel ? ` / ${def.thinkingLevel}` : "";
    lines.push(`- **${name}** (${def.label}): ${def.model}${thinking}`);
  }
  lines.push("", `## Fallback: ${config.fallback.model}`, "");
  lines.push("子命令: `/subagents config` | `/subagents config <category>`");
  return lines.join("\n");
}
```

- [ ] **步骤 4：创建 `tui/config-wizard.ts`**（FR-4.8.2 级联交互）

```typescript
// src/tui/config-wizard.ts
import * as path from "node:path";
import type { SubagentsGlobalConfig, CategoryDefinition } from "../types.ts";
import { saveGlobalConfig } from "../config/global-config.ts";
import { formatThinkingLevelOption } from "./format.ts";

const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** FR-4.8: UI 交互接口（由 ctx.ui 提供） */
export interface WizardUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string): void;
}

/** FR-4.8.2: 运行配置向导 */
export async function runConfigWizard(
  ui: WizardUI,
  args: string[],
  config: SubagentsGlobalConfig,
  homeDir: string,
  modelRegistry: { getAvailable(): Array<{ provider: string; name: string; reasoning: boolean; thinkingLevelMap?: Record<string, string | null> }> },
): Promise<void> {
  const quickCategory = args[0];

  if (!quickCategory) {
    const operation = await ui.select("选择操作", [
      "Edit category model",
      "Add custom category",
      "Toggle YOLO",
      "Show current config",
    ]);
    if (!operation) return;

    if (operation === "Show current config") { return; } // summary 已在命令层显示
    if (operation === "Toggle YOLO") {
      // YOLO 是会话状态，这里仅提示
      ui.notify("YOLO 切换通过会话状态管理，请使用 runtime API");
      return;
    }
    if (operation === "Add custom category") {
      const name = await ui.input("新 category 名称");
      if (!name) return;
      await editCategoryModel(ui, name, config, homeDir, modelRegistry, true);
      return;
    }
    // Edit category model
    const category = await ui.select("选择 category", Object.keys(config.categories));
    if (!category) return;
    await editCategoryModel(ui, category, config, homeDir, modelRegistry, false);
  } else {
    // 快捷路径
    await editCategoryModel(ui, quickCategory, config, homeDir, modelRegistry, false);
  }
}

async function editCategoryModel(
  ui: WizardUI, category: string, config: SubagentsGlobalConfig,
  homeDir: string, modelRegistry: WizardUI extends never ? never : { getAvailable(): Array<{ provider: string; name: string; reasoning: boolean; thinkingLevelMap?: Record<string, string | null> }> },
  isNew: boolean,
): Promise<void> {
  const available = modelRegistry.getAvailable();
  const providers = [...new Set(available.map((m) => m.provider))];
  if (providers.length === 0) { ui.notify("无可用模型（未配置 API key）"); return; }

  const provider = await ui.select("选择 provider", providers);
  if (!provider) return;

  const models = available.filter((m) => m.provider === provider);
  const modelOptions = models.map((m) => `${m.name} (${m.contextWindow ?? "?"} ctx${m.reasoning ? " · reasoning ✓" : ""})`);
  const modelIdx = await ui.select("选择 model", modelOptions);
  if (modelIdx === undefined) return;
  const selectedModel = models[modelOptions.indexOf(modelIdx)];

  // thinking level
  let thinkingLevel: string | undefined;
  if (selectedModel.reasoning && selectedModel.thinkingLevelMap) {
    const levels = THINKING_ORDER.filter((lvl) => selectedModel.thinkingLevelMap![lvl] != null);
    if (levels.length > 0) {
      const levelOptions = levels.map(formatThinkingLevelOption);
      const picked = await ui.select("选择 thinking level", levelOptions);
      if (picked) thinkingLevel = levels[levelOptions.indexOf(picked)];
    }
  }

  // 保存
  const def: CategoryDefinition = {
    label: config.categories[category]?.label ?? category,
    model: `${provider}/${selectedModel.name}`,
    thinkingLevel,
  };
  config.categories[category] = def;
  await saveGlobalConfig(homeDir, config);
  ui.notify(`${isNew ? "新增" : "更新"} category "${category}" → ${def.model}${thinkingLevel ? " / " + thinkingLevel : ""}`);
}
```

- [ ] **步骤 5：创建 `commands/config.ts`**

```typescript
// src/commands/config.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getRuntime } from "../runtime.ts";
import { formatConfigSummary } from "../tui/format.ts";
import { runConfigWizard } from "../tui/config-wizard.ts";

/** FR-4.8.1: 注册 /subagents 命令 */
export function registerSubagentsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("subagents", {
    description: "Subagents 配置: /subagents [config [category]]",
    handler: async (argsStr, ctx) => {
      const rt = getRuntime();
      if (!rt) { ctx.ui.notify("Subagents runtime 未初始化", "error"); return; }

      const args = argsStr.trim().split(/\s+/).filter(Boolean);

      // /subagents（无参数）→ 显示摘要
      if (args.length === 0 || (args.length === 1 && args[0] !== "config")) {
        ctx.ui.notify(formatConfigSummary(rt.globalConfig, rt.sessionState.yoloMode));
        return;
      }

      // /subagents config [category]
      const wizardArgs = args.slice(1); // 去掉 "config"
      await runConfigWizard(
        {
          select: (title, options) => ctx.ui.select(title, options),
          input: (title, placeholder) => ctx.ui.input(title, placeholder),
          notify: (msg) => ctx.ui.notify(msg),
        },
        wizardArgs,
        rt.globalConfig,
        process.env.HOME || process.env.USERPROFILE || ctx.cwd,
        ctx.modelRegistry as never,
      );
    },
  });
}
```

- [ ] **步骤 6：运行测试确认通过**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：PASS（format.test.ts 的用例）。

- [ ] **步骤 7：全量 typecheck**

运行：`pnpm --filter @zhushanwen/pi-subagents typecheck && pnpm -r typecheck`
预期：两个命令都 PASS（零错误）。

- [ ] **步骤 8：check-structure 验证**

运行：`bash .githooks/check-structure --quick`
预期：PASS。检查所有文件 < 1000 行、无模块级 `let`/`var`、入口文件含 default function。

> **注意模块级变量**：`runtime.ts` 的 `let runtimeInstance` 会触发 check-structure 规则 5（模块级 `let`）。需改为函数级闭包或加 `_` 前缀。修正：将单例改为 WeakRef 或在 index.ts 工厂内持有。如 check-structure 报错，将 `runtime.ts` 末尾的 `let runtimeInstance` 改为：
> ```typescript
> const _runtimeSlot: { current?: SubagentRuntime } = {};
> export function setRuntime(rt: SubagentRuntime) { _runtimeSlot.current = rt; }
> export function getRuntime() { return _runtimeSlot.current; }
> ```

- [ ] **步骤 9：提交**

```bash
git add extensions/subagents/src/tui/ extensions/subagents/src/commands/ extensions/subagents/src/__tests__/format.test.ts
git commit -m "feat(subagents): add /subagents command + config wizard + format functions"
```

---

## plan-1 完成验证

完成全部 16 个任务后，运行以下验证：

- [ ] **全量测试**：`pnpm --filter @zhushanwen/pi-subagents test`
  预期：所有测试用例 PASS（约 80+ 用例）

- [ ] **全量 typecheck**：`pnpm -r typecheck`
  预期：零错误

- [ ] **结构检查**：`bash .githooks/check-structure --quick`
  预期：PASS

- [ ] **AC 对照**（spec AC-1~4）：
  - AC-1（Runtime 核心）：runAgent/ManagedSession 已实现 ✓（任务 14）
  - AC-2（Agent 发现）：AgentRegistry.discoverAll + frontmatter ✓（任务 7, 10）
  - AC-3（Tool 过滤）：filterTools 三层 ✓（任务 11）
  - AC-4（并发控制）：ConcurrencyPool + 优先级 ✓（任务 3）

完成后可执行 `./plan-2-workflow-integration.md`（workflow 改造）。

---