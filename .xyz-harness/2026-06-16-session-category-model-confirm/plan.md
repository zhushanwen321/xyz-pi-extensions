# Session 首次 Subagent 调用时确认各 Category 模型 — 实现计划

> **给 agentic worker：** 必备子技能：使用 subagent-driven-development（推荐）或 executing-plans 来逐任务执行此计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 在本 session 第一次执行任何 subagent 前，TUI input 区一次性确认所有 category 的模型；确认后写入会话级状态，后续不再弹窗。

**架构：** 在 `subagent` 工具 `execute` 拦截（补第 5 参数 `ctx`）。`sessionState` 新增 `categoryConfirmed` 标志。新写批量确认组件（provider→model→thinking 级联 + `(current)` 置顶伪预选 + 中途 Esc 跳过当前 category）。确认结果原子批量写入 `perCategory` + 标记 confirmed，复用现有 `pi.appendEntry` 持久化。

**技术栈：** TypeScript（ESM）、vitest、Pi ExtensionAPI（ExtensionUIContext 的 select/input/notify）、jiti 运行时加载。

**Spec 来源：** `.xyz-harness/2026-06-16-session-category-model-confirm/spec.md`

---

## 文件结构

| 文件 | 职责 | 动作 |
|------|------|------|
| `extensions/subagents/src/types.ts` | `SessionModelState` 新增 `categoryConfirmed` 字段 | 修改（IC-3）|
| `extensions/subagents/src/state/session-model-state.ts` | `createSessionModelState`/`serializeState`/`restoreState` 同步处理新字段 | 修改（IC-4）|
| `extensions/subagents/src/tui/category-confirm.ts` | 批量逐 category 确认组件（(current) 置顶伪预选 + 中途 Esc 跳过 + 批量跳过） | 创建（IC-2 + IC-7）|
| `extensions/subagents/src/tui/batch-model-resolver.ts` | 批量解析所有 category 当前模型的 helper | 创建（IC-7）|
| `extensions/subagents/src/runtime.ts` | 新增 `applyCategoryConfirm()`（原子批量写 perCategory + 标记 confirmed） | 修改（IC-5）|
| `extensions/subagents/src/tools/subagent-tool.ts` | execute 补第 5 参数 ctx + 插入确认拦截 | 修改（IC-1 + IC-6）|
| `extensions/subagents/src/__tests__/session-model-state.test.ts` | 新字段 round-trip 测试 | 修改 |
| `extensions/subagents/src/__tests__/batch-model-resolver.test.ts` | 批量解析测试 | 创建 |
| `extensions/subagents/src/__tests__/category-confirm.test.ts` | 确认组件交互测试（mock UI） | 创建 |
| `extensions/subagents/src/__tests__/runtime-confirm.test.ts` | applyCategoryConfirm 原子写测试 | 创建 |
| `extensions/subagents/src/__tests__/subagent-tool.test.ts` | 拦截逻辑测试（mock ctx + ctx.ui + categoryConfirmed） | 修改 |

**任务依赖顺序：** 1(types) → 2(state) → 3(batch-resolver) → 4(category-confirm) → 5(runtime) → 6(tool) → 7(集成 typecheck)。

---

## 任务 1: SessionModelState 新增 categoryConfirmed 字段

**文件：**
- 修改：`extensions/subagents/src/types.ts:400-404`
- 测试：`extensions/subagents/src/__tests__/session-model-state.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `extensions/subagents/src/__tests__/session-model-state.test.ts` 的 `describe("SessionModelState", ...)` 块内新增（紧接最后一个 `it` 之后，`});` 之前）：

```typescript
  it("createSessionModelState defaults categoryConfirmed to false", () => {
    const state = createSessionModelState(false);
    expect(state.categoryConfirmed).toBe(false);
  });

  it("serialize/restore round-trips categoryConfirmed", () => {
    const state = createSessionModelState(false);
    state.categoryConfirmed = true;
    const restored = restoreState(serializeState(state), false);
    expect(restored.categoryConfirmed).toBe(true);
  });

  it("restore defaults categoryConfirmed to false when missing", () => {
    const restored = restoreState({}, false);
    expect(restored.categoryConfirmed).toBe(false);
  });
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/subagents && npx vitest run src/__tests__/session-model-state.test.ts`
预期：FAIL，提示 `state.categoryConfirmed` 为 `undefined`（类型也不存在）

- [ ] **步骤 3：修改 types.ts 加字段**

`extensions/subagents/src/types.ts`，把 `SessionModelState` 接口改为（在 `perCategory` 后加一行）：

```typescript
export interface SessionModelState {
  yoloMode: boolean;
  perAgent: Record<string, { model: string; thinkingLevel?: string }>;
  perCategory: Record<string, { model: string; thinkingLevel?: string }>;
  /** 本 session 是否已完成首次 category 模型确认（确认后不再弹窗） */
  categoryConfirmed: boolean;
}
```

- [ ] **步骤 4：修改 session-model-state.ts 同步三函数**

`extensions/subagents/src/state/session-model-state.ts`：

`createSessionModelState` 改为：
```typescript
export function createSessionModelState(yoloByDefault: boolean): SessionModelState {
  return { yoloMode: yoloByDefault, perAgent: {}, perCategory: {}, categoryConfirmed: false };
}
```

`serializeState` 改为（在 `perCategory` 后加一行）：
```typescript
export function serializeState(state: SessionModelState): SessionModelState {
  return {
    yoloMode: state.yoloMode,
    perAgent: { ...state.perAgent },
    perCategory: { ...state.perCategory },
    categoryConfirmed: state.categoryConfirmed,
  };
}
```

`restoreState` 改为（return 对象加 `categoryConfirmed`）：
```typescript
export function restoreState(data: unknown, yoloByDefault: boolean): SessionModelState {
  if (!data || typeof data !== "object") {
    return createSessionModelState(yoloByDefault);
  }
  const d = data as Partial<SessionModelState>;
  return {
    yoloMode: typeof d.yoloMode === "boolean" ? d.yoloMode : yoloByDefault,
    perAgent: d.perAgent && typeof d.perAgent === "object" ? { ...d.perAgent } : {},
    perCategory: d.perCategory && typeof d.perCategory === "object" ? { ...d.perCategory } : {},
    categoryConfirmed: typeof d.categoryConfirmed === "boolean" ? d.categoryConfirmed : false,
  };
}
```

- [ ] **步骤 5：运行测试确认通过**

运行：`cd extensions/subagents && npx vitest run src/__tests__/session-model-state.test.ts`
预期：PASS（全部 it 通过）

- [ ] **步骤 6：提交**

```bash
git add extensions/subagents/src/types.ts extensions/subagents/src/state/session-model-state.ts extensions/subagents/src/__tests__/session-model-state.test.ts
git commit -m "feat(subagents): add categoryConfirmed to SessionModelState"
```

---

## 任务 2: 批量解析所有 category 当前模型（batch-model-resolver）

**文件：**
- 创建：`extensions/subagents/src/tui/batch-model-resolver.ts`
- 测试：`extensions/subagents/src/__tests__/batch-model-resolver.test.ts`

**说明：** 遍历 `globalConfig.categories`，对每个 category 解析 5 级配置链的当前值（返回 provider/modelId/thinkingLevel 供 (current) 置顶）。复用 `mergeConfig`（纯函数，不验证可用性）。单个 category 解析失败时 try/catch 隔离，返回 `unavailable`（tracing O2-002）。

- [ ] **步骤 1：编写失败的测试**

创建 `extensions/subagents/src/__tests__/batch-model-resolver.test.ts`：

```typescript
import { describe, expect, it } from "vitest";

import { DEFAULT_CATEGORIES } from "../category.ts";
import { resolveAllCategoryModels } from "../tui/batch-model-resolver.ts";
import type { SessionModelState, SubagentsGlobalConfig } from "../types.ts";

const sessionState: SessionModelState = {
  yoloMode: false,
  perAgent: {},
  perCategory: { research: { model: "anthropic/claude-haiku-4-5", thinkingLevel: "low" } },
  categoryConfirmed: false,
};

const globalConfig: SubagentsGlobalConfig = {
  version: 1,
  yoloByDefault: false,
  maxConcurrent: 4,
  categories: { ...DEFAULT_CATEGORIES },
  agentCategoryOverrides: {},
  fallback: { model: "fallback/m", thinkingLevel: "low" },
};

describe("resolveAllCategoryModels", () => {
  it("returns current model string for each category via config chain", () => {
    const result = resolveAllCategoryModels(globalConfig, sessionState);
    // coding 走 category-default（DEFAULT_CATEGORIES.coding.model）
    expect(result.coding).toBe(DEFAULT_CATEGORIES.coding.model);
    // research 走 perCategory 覆盖（优先级更高）
    expect(result.research).toBe("anthropic/claude-haiku-4-5");
  });

  it("returns map keyed by every category in globalConfig.categories", () => {
    const result = resolveAllCategoryModels(globalConfig, sessionState);
    expect(Object.keys(result).sort()).toEqual(Object.keys(DEFAULT_CATEGORIES).sort());
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/subagents && npx vitest run src/__tests__/batch-model-resolver.test.ts`
预期：FAIL，`resolveAllCategoryModels` 未定义（模块不存在）

- [ ] **步骤 3：创建 batch-model-resolver.ts**

创建 `extensions/subagents/src/tui/batch-model-resolver.ts`：

```typescript
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
```

- [ ] **步骤 4：运行测试确认通过**

运行：`cd extensions/subagents && npx vitest run src/__tests__/batch-model-resolver.test.ts`
预期：PASS

- [ ] **步骤 5：提交**

```bash
git add extensions/subagents/src/tui/batch-model-resolver.ts extensions/subagents/src/__tests__/batch-model-resolver.test.ts
git commit -m "feat(subagents): add resolveAllCategoryModels helper"
```

---

## 任务 3: 批量逐 category 确认组件（category-confirm）

**文件：**
- 创建：`extensions/subagents/src/tui/category-confirm.ts`
- 测试：`extensions/subagents/src/__tests__/category-confirm.test.ts`

**交互流程（FR-2）：**
1. 首屏 select：`逐个确认` / `全部用默认并记住` / `取消`
2. 选 `逐个确认` → 遍历每个 category：provider select（`(current)` 置顶）→ model select（`(current)` 置顶）→ thinking select（若 reasoning）。任一步 Esc → 跳过该 category 继续下一个。
3. 遍历每步的 provider select 提供 `剩余全部保留默认` 快捷项（FR-2.7）。
4. 返回 `{ action: "confirmed" | "use-default" | "cancelled", overrides: Record<category, {model, thinkingLevel}> }`。

**UI 接口**（复用 config-wizard 的 `WizardUI` 形状，避免新依赖）：

```typescript
export interface ConfirmUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string): void;
}
```

- [ ] **步骤 1：编写失败的测试**

创建 `extensions/subagents/src/__tests__/category-confirm.test.ts`：

```typescript
import { describe, expect, it, vi } from "vitest";

import { runCategoryConfirm, type ConfirmUI } from "../tui/category-confirm.ts";
import type { ModelInfo, SessionModelState, SubagentsGlobalConfig } from "../types.ts";

const sessionState: SessionModelState = {
  yoloMode: false, perAgent: {}, perCategory: {}, categoryConfirmed: false,
};
const globalConfig: SubagentsGlobalConfig = {
  version: 1, yoloByDefault: false, maxConcurrent: 4,
  categories: { coding: { label: "编码", model: "deepseek-router/ds-flash", thinkingLevel: "high" } },
  agentCategoryOverrides: {}, fallback: { model: "f/m", thinkingLevel: "low" },
};
const available: ModelInfo[] = [
  { id: "ds-flash", name: "DS Flash", provider: "deepseek-router", reasoning: true, thinkingLevelMap: { high: "h" } },
  { id: "claude-haiku-4-5", name: "Haiku", provider: "anthropic", reasoning: false },
];

/** 预编排 select 序列的 mock UI */
function makeUI(selects: string[]): ConfirmUI & { selects: string[] } {
  let i = 0;
  return { select: vi.fn(async () => selects[i++]), notify: vi.fn(), selects };
}

describe("runCategoryConfirm", () => {
  it("cancelled: 首屏选取消 → action=cancelled, 无 overrides", async () => {
    const ui = makeUI(["取消"]);
    const result = await runCategoryConfirm(ui, globalConfig, sessionState, available, { coding: "deepseek-router/ds-flash" });
    expect(result.action).toBe("cancelled");
    expect(result.overrides).toEqual({});
  });

  it("use-default: 首屏选全部用默认 → action=use-default, 无 overrides", async () => {
    const ui = makeUI(["全部用默认并记住"]);
    const result = await runCategoryConfirm(ui, globalConfig, sessionState, available, { coding: "deepseek-router/ds-flash" });
    expect(result.action).toBe("use-default");
    expect(result.overrides).toEqual({});
  });

  it("confirmed-keep-current: 逐个确认中首屏选逐个，provider 回车(current) → 保留，无 override", async () => {
    // provider select 第一项是 "(current) deepseek-router"，选中它 = 保留
    const ui = makeUI(["逐个确认", "(current) deepseek-router"]);
    const result = await runCategoryConfirm(ui, globalConfig, sessionState, available, { coding: "deepseek-router/ds-flash" });
    expect(result.action).toBe("confirmed");
    expect(result.overrides).toEqual({});
  });

  it("confirmed-change: 逐个确认中换 provider+model → override 写入", async () => {
    // coding 当前 deepseek-router/ds-flash，用户选 anthropic → haiku（无 reasoning，不问 thinking）
    const ui = makeUI([
      "逐个确认",
      "anthropic",            // provider
      "Haiku ( ctx)",         // model（anthropic 下唯一）
    ]);
    const result = await runCategoryConfirm(ui, globalConfig, sessionState, available, { coding: "deepseek-router/ds-flash" });
    expect(result.action).toBe("confirmed");
    expect(result.overrides.coding).toEqual({ model: "anthropic/claude-haiku-4-5" });
  });

  it("confirmed-skip-via-esc: provider 步 Esc(undefined) → 跳过该 category 继续，无 override", async () => {
    const ui = makeUI(["逐个确认", undefined as unknown as string]);
    const result = await runCategoryConfirm(ui, globalConfig, sessionState, available, { coding: "deepseek-router/ds-flash" });
    expect(result.action).toBe("confirmed");
    expect(result.overrides).toEqual({});
  });

  it("confirmed-batch-skip: provider 步选剩余全部保留默认 → 跳过剩余", async () => {
    const ui = makeUI(["逐个确认", "剩余全部保留默认"]);
    const result = await runCategoryConfirm(ui, globalConfig, sessionState, available, { coding: "deepseek-router/ds-flash" });
    expect(result.action).toBe("confirmed");
    expect(result.overrides).toEqual({});
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/subagents && npx vitest run src/__tests__/category-confirm.test.ts`
预期：FAIL，`runCategoryConfirm` 未定义

- [ ] **步骤 3：创建 category-confirm.ts**

创建 `extensions/subagents/src/tui/category-confirm.ts`：

```typescript
// src/tui/category-confirm.ts
import type { ModelInfo, SessionModelState, SubagentsGlobalConfig } from "../types.ts";
import { formatThinkingLevelOption } from "./format.ts";

const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** 确认弹窗 UI 接口（复用 config-wizard 的 WizardUI 形状） */
export interface ConfirmUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string): void;
}

/** 确认结果 */
export interface CategoryConfirmResult {
  action: "confirmed" | "use-default" | "cancelled";
  /** 用户修改过的 category → 新模型（仅 action=confirmed 时有值） */
  overrides: Record<string, { model: string; thinkingLevel?: string }>;
}

const SKIP_REST = "剩余全部保留默认";

/**
 * FR-2: 批量逐 category 确认组件。
 * currentModels: 每个 category 当前模型字符串（由 resolveAllCategoryModels 提供）。
 * available: modelRegistry.getAvailable() 的结果。
 */
export async function runCategoryConfirm(
  ui: ConfirmUI,
  globalConfig: SubagentsGlobalConfig,
  _sessionState: SessionModelState,
  available: ModelInfo[],
  currentModels: Record<string, string>,
): Promise<CategoryConfirmResult> {
  // FR-2.1 首屏入口
  const entry = await ui.select("首次使用 subagent — 确认各 category 模型", [
    "逐个确认",
    "全部用默认并记住",
    "取消",
  ]);
  if (entry === undefined || entry === "取消") {
    return { action: "cancelled", overrides: {} };
  }
  if (entry === "全部用默认并记住") {
    return { action: "use-default", overrides: {} };
  }

  // FR-2.2 逐 category 级联
  const overrides: Record<string, { model: string; thinkingLevel?: string }> = {};
  const categories = Object.keys(globalConfig.categories);
  const providers = [...new Set(available.map((m) => m.provider))];

  for (const category of categories) {
    const currentStr = currentModels[category]; // "provider/modelId" 或 undefined
    const currentProvider = currentStr?.split("/")[0];

    // ── provider select（(current) 置顶）──
    const providerOptions = [
      ...(currentProvider ? [`(current) ${currentProvider}`] : []),
      ...providers.filter((p) => p !== currentProvider),
      SKIP_REST,
    ];
    const providerPick = await ui.select(`[${category}] 选择 provider`, providerOptions);

    if (providerPick === undefined) {
      // FR-2.6 Esc = 跳过当前 category，继续下一个
      continue;
    }
    if (providerPick === SKIP_REST) {
      // FR-2.7 批量跳过剩余
      break;
    }

    // 判断是否选了 (current)
    const isCurrentProvider = providerPick.startsWith("(current)");
    const provider = isCurrentProvider ? currentProvider! : providerPick;

    const models = available.filter((m) => m.provider === provider);
    const currentModelId = currentStr?.startsWith(`${provider}/`) ? currentStr.slice(provider.length + 1) : undefined;
    const modelOptions = [
      ...(currentModelId && models.some((m) => m.id === currentModelId)
        ? [`(current) ${currentModelId}`]
        : []),
      ...models
        .filter((m) => m.id !== currentModelId)
        .map((m) => `${m.name} (${m.contextWindow ?? "?"} ctx${m.reasoning ? " · reasoning ✓" : ""})`),
    ];
    const modelPick = await ui.select(`[${category}] 选择 model`, modelOptions);

    if (modelPick === undefined) {
      continue; // Esc 跳过当前 category
    }

    let selectedModel: ModelInfo;
    let thinkingLevel: string | undefined;
    if (modelPick.startsWith("(current)")) {
      selectedModel = models.find((m) => m.id === currentModelId)!;
      // 保留当前 thinking（从 currentModels 无法拿到 thinking，用 category 默认）
      thinkingLevel = globalConfig.categories[category]?.thinkingLevel;
    } else {
      const idx = models.findIndex(
        (m) => `${m.name} (${m.contextWindow ?? "?"} ctx${m.reasoning ? " · reasoning ✓" : ""})` === modelPick,
      );
      selectedModel = models[idx];

      // thinking level（仅 reasoning 模型）
      if (selectedModel.reasoning && selectedModel.thinkingLevelMap) {
        const levels = THINKING_ORDER.filter((lvl) => selectedModel.thinkingLevelMap![lvl] != null);
        if (levels.length > 0) {
          const levelOptions = levels.map(formatThinkingLevelOption);
          const currentLevel = globalConfig.categories[category]?.thinkingLevel;
          const levelPick = await ui.select(`[${category}] 选择 thinking level`, [
            ...(currentLevel && levels.includes(currentLevel) ? [`(current) ${currentLevel}`] : []),
            ...levelOptions.filter((o) => !o.startsWith("(current)")),
          ]);
          if (levelPick === undefined) {
            // thinking 步 Esc：用 model 但不设 thinking（跳过 thinking 配置）
            thinkingLevel = undefined;
          } else if (levelPick.startsWith("(current)")) {
            thinkingLevel = currentLevel;
          } else {
            thinkingLevel = levels[levelOptions.indexOf(levelPick)];
          }
        }
      }
    }

    // 写入 override（仅当与当前不同时）
    const newModelStr = `${selectedModel.provider}/${selectedModel.id}`;
    if (newModelStr !== currentStr || (thinkingLevel && thinkingLevel !== globalConfig.categories[category]?.thinkingLevel)) {
      overrides[category] = { model: newModelStr, thinkingLevel };
    }
  }

  ui.notify("category 模型确认完成");
  return { action: "confirmed", overrides };
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`cd extensions/subagents && npx vitest run src/__tests__/category-confirm.test.ts`
预期：PASS（全部 6 个 it 通过）

- [ ] **步骤 5：提交**

```bash
git add extensions/subagents/src/tui/category-confirm.ts extensions/subagents/src/__tests__/category-confirm.test.ts
git commit -m "feat(subagents): add category-confirm batch confirm component"
```

---

## 任务 4: runtime 原子批量写方法（applyCategoryConfirm）

**文件：**
- 修改：`extensions/subagents/src/runtime.ts`（在 `setSessionCategoryModel` 方法后新增）
- 测试：`extensions/subagents/src/__tests__/runtime-confirm.test.ts`

**说明：** IC-5。一次调用内写多个 perCategory + 标记 categoryConfirmed，只触发一次 persistState（FR-3.1 原子）。

- [ ] **步骤 1：编写失败的测试**

创建 `extensions/subagents/src/__tests__/runtime-confirm.test.ts`：

```typescript
import { describe, expect, it } from "vitest";

import { SubagentRuntime } from "../runtime.ts";

function makeRuntime(): { rt: SubagentRuntime; entries: Array<{ customType: string; data: unknown }> } {
  const entries: Array<{ customType: string; data: unknown }> = [];
  const rt = new SubagentRuntime({ cwd: "/tmp", homeDir: "/tmp", agentDir: "/tmp/.pi/agent" });
  // 注入 mock pi 捕获 appendEntry
  (rt as unknown as { injectPi: (pi: unknown) => void }).injectPi({
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
    events: { emit: () => {} },
  });
  return { rt, entries };
}

describe("SubagentRuntime.applyCategoryConfirm", () => {
  it("writes overrides + sets categoryConfirmed in single persistState", () => {
    const { rt, entries } = makeRuntime();
    rt.applyCategoryConfirm({
      action: "confirmed",
      overrides: { coding: { model: "anthropic/claude-haiku-4-5" } },
    });
    expect(rt.sessionState.categoryConfirmed).toBe(true);
    expect(rt.sessionState.perCategory.coding).toEqual({ model: "anthropic/claude-haiku-4-5" });
    // 原子：只产生一条 subagent-model-state entry
    const stateEntries = entries.filter((e) => e.customType === "subagent-model-state");
    expect(stateEntries.length).toBe(1);
  });

  it("use-default: sets categoryConfirmed but writes no perCategory", () => {
    const { rt } = makeRuntime();
    rt.applyCategoryConfirm({ action: "use-default", overrides: {} });
    expect(rt.sessionState.categoryConfirmed).toBe(true);
    expect(rt.sessionState.perCategory).toEqual({});
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/subagents && npx vitest run src/__tests__/runtime-confirm.test.ts`
预期：FAIL，`rt.applyCategoryConfirm is not a function`

- [ ] **步骤 3：在 runtime.ts 新增方法**

`extensions/subagents/src/runtime.ts`，在 `setSessionCategoryModel` 方法（约 333 行 `}`）之后新增：

```typescript
  /**
   * FR-3.1: 原子批量写 — 将确认结果（多个 perCategory 覆盖）+ 标记 categoryConfirmed
   * 在同一次 persistState 中完成。避免分多次 persistState 产生多条 entry
   * 导致 restoreFromEntries 取最新条时字段不一致（tracing G-010）。
   */
  applyCategoryConfirm(result: { action: "confirmed" | "use-default"; overrides: Record<string, { model: string; thinkingLevel?: string }> }): void {
    for (const [category, val] of Object.entries(result.overrides)) {
      setCategoryModel(this.sessionState, category, val.model, val.thinkingLevel);
    }
    this.sessionState.categoryConfirmed = true;
    this.persistState();
  }
```

- [ ] **步骤 4：运行测试确认通过**

运行：`cd extensions/subagents && npx vitest run src/__tests__/runtime-confirm.test.ts`
预期：PASS

- [ ] **步骤 5：提交**

```bash
git add extensions/subagents/src/runtime.ts extensions/subagents/src/__tests__/runtime-confirm.test.ts
git commit -m "feat(subagents): add applyCategoryConfirm atomic batch write"
```

---

## 任务 5: subagent 工具 execute 补 ctx + 插入确认拦截

**文件：**
- 修改：`extensions/subagents/src/tools/subagent-tool.ts`（IC-1 + IC-6）
- 测试：`extensions/subagents/src/__tests__/subagent-tool.test.ts`

**说明：** execute 补第 5 参数 `ctx: ExtensionContext`。在 `assertAgentExists` 后、`effectiveWait` 前插入拦截：若 `ctx.hasUI && !rt.sessionState.categoryConfirmed`，调 `runCategoryConfirm`。按结果分流：cancelled → 抛错；confirmed/use-default → `rt.applyCategoryConfirm`。

- [ ] **步骤 1：编写失败的测试**

在 `extensions/subagents/src/__tests__/subagent-tool.test.ts` 顶部 import 区追加：

```typescript
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
```

更新 `CapturedTool` 接口（约 50-58 行），execute 加第 5 参数 ctx：

```typescript
interface CapturedTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (partial: ExecuteResult) => void,
    ctx?: Partial<ExtensionContext>,
  ) => Promise<ExecuteResult>;
}
```

更新 `MockRuntime` 接口（约 61-68 行），加 `sessionState`、`applyCategoryConfirm`、`globalConfig`：

```typescript
interface MockRuntime {
  runAgent: ReturnType<typeof vi.fn>;
  startBackground: ReturnType<typeof vi.fn>;
  getBackground: ReturnType<typeof vi.fn>;
  getAgentConfig: ReturnType<typeof vi.fn>;
  resolveModelForAgent: ReturnType<typeof vi.fn>;
  assertAgentExists: ReturnType<typeof vi.fn>;
  sessionState: { categoryConfirmed: boolean; perCategory: Record<string, { model: string; thinkingLevel?: string }>; yoloMode: boolean; perAgent: Record<string, { model: string; thinkingLevel?: string }> };
  applyCategoryConfirm: ReturnType<typeof vi.fn>;
  globalConfig: { categories: Record<string, unknown> };
}
```

更新 `makeMockRuntime`（约 88-100 行）加默认值：

```typescript
function makeMockRuntime(overrides: Partial<MockRuntime> = {}): MockRuntime {
  return {
    runAgent: overrides.runAgent ?? vi.fn(),
    startBackground: overrides.startBackground ?? vi.fn(),
    getBackground: overrides.getBackground ?? vi.fn(),
    getAgentConfig: overrides.getAgentConfig ?? vi.fn(() => undefined),
    resolveModelForAgent: overrides.resolveModelForAgent ?? vi.fn(() => ({ model: { id: "anthropic/claude-sonnet-4.5" }, thinkingLevel: "medium" })),
    assertAgentExists: overrides.assertAgentExists ?? vi.fn(),
    sessionState: overrides.sessionState ?? { categoryConfirmed: false, perCategory: {}, yoloMode: false, perAgent: {} },
    applyCategoryConfirm: overrides.applyCategoryConfirm ?? vi.fn(),
    globalConfig: overrides.globalConfig ?? { categories: { coding: { label: "编码", model: "p/m" } } },
  };
}
```

在 `describe("subagent tool execute()", ...)` 块末尾新增测试（在最后一个 `it` 之后、`});` 之前）：

```typescript
  // ── 首次 category 确认拦截 ──────────────────────────────
  it("categoryConfirmed=true → 跳过确认直接执行", async () => {
    const mockRt = makeMockRuntime({
      sessionState: { categoryConfirmed: true, perCategory: {}, yoloMode: false, perAgent: {} },
      runAgent: vi.fn(async () => successResult()),
    });
    mockedGetRuntime.mockReturnValue(mockRt as never);
    const tool = captureTool();
    const ctx = { hasUI: true, ui: { select: vi.fn() } } as unknown as Partial<ExtensionContext>;
    await tool.execute("call-1", { task: "do X", agent: "worker" }, undefined, undefined, ctx);
    expect((ctx.ui as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
  });

  it("hasUI=false → 跳过确认直接执行", async () => {
    const mockRt = makeMockRuntime({
      runAgent: vi.fn(async () => successResult()),
    });
    mockedGetRuntime.mockReturnValue(mockRt as never);
    const tool = captureTool();
    const ctx = { hasUI: false } as unknown as Partial<ExtensionContext>;
    await tool.execute("call-1", { task: "do X", agent: "worker" }, undefined, undefined, ctx);
    expect(mockRt.applyCategoryConfirm).not.toHaveBeenCalled();
  });

  it("首次确认 cancel → execute 抛错含'取消'，不调 runAgent", async () => {
    const mockRt = makeMockRuntime({
      runAgent: vi.fn(async () => successResult()),
    });
    mockedGetRuntime.mockReturnValue(mockRt as never);
    const tool = captureTool();
    const ctx = {
      hasUI: true,
      modelRegistry: { getAvailable: () => [] },
      ui: {
        select: vi.fn(async () => "取消"),
        notify: vi.fn(),
      },
    } as unknown as Partial<ExtensionContext>;
    await expect(
      tool.execute("call-1", { task: "do X", agent: "worker" }, undefined, undefined, ctx),
    ).rejects.toThrow(/取消/);
    expect(mockRt.runAgent).not.toHaveBeenCalled();
    expect(mockRt.applyCategoryConfirm).not.toHaveBeenCalled();
  });

  it("首次确认 use-default → applyCategoryConfirm 后继续执行", async () => {
    const mockRt = makeMockRuntime({
      runAgent: vi.fn(async () => successResult()),
    });
    mockedGetRuntime.mockReturnValue(mockRt as never);
    const tool = captureTool();
    const ctx = {
      hasUI: true,
      modelRegistry: { getAvailable: () => [] },
      ui: {
        select: vi.fn(async () => "全部用默认并记住"),
        notify: vi.fn(),
      },
    } as unknown as Partial<ExtensionContext>;
    await tool.execute("call-1", { task: "do X", agent: "worker" }, undefined, undefined, ctx);
    expect(mockRt.applyCategoryConfirm).toHaveBeenCalledWith({ action: "use-default", overrides: {} });
    expect(mockRt.runAgent).toHaveBeenCalled();
  });
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/subagents && npx vitest run src/__tests__/subagent-tool.test.ts`
预期：FAIL，新测试因 execute 未读 ctx / 未做拦截而失败

- [ ] **步骤 3：修改 subagent-tool.ts execute**

`extensions/subagents/src/tools/subagent-tool.ts`：

顶部 import 区追加（在现有 import 之后）：
```typescript
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { runCategoryConfirm } from "../tui/category-confirm.ts";
import { resolveAllCategoryModels } from "../tui/batch-model-resolver.ts";
import type { ModelInfo } from "../types.ts";
```

修改 `execute` 签名（约 208 行），补第 5 参数 `ctx: ExtensionContext`：

```typescript
    async execute(
      _toolCallId: string,
      params: {
        task?: string;
        agent?: string;
        wait?: boolean;
        backgroundId?: string;
        model?: string;
        thinkingLevel?: string;
        skillPath?: string;
        appendSystemPrompt?: string[];
        schema?: Record<string, unknown>;
        maxTurns?: number;
        graceTurns?: number;
      },
      signal: AbortSignal | undefined,
      onUpdate?: (partialResult: AgentToolResult<SubagentToolDetails>) => void,
      ctx: ExtensionContext,
    ) {
```

在 `rt.assertAgentExists(params.agent);`（约 285 行）之后、`// FR-O2.2: 判定 effective wait`（约 287 行）之前，插入拦截块：

```typescript
      // ── 首次 category 模型确认拦截（FR-1 / FR-2）──
      if (ctx.hasUI && !rt.sessionState.categoryConfirmed) {
        const currentModels = resolveAllCategoryModels(rt.globalConfig, rt.sessionState);
        const available: ModelInfo[] = ctx.modelRegistry.getAvailable();
        const confirmResult = await runCategoryConfirm(
          { select: (t, o) => ctx.ui.select(t, o), notify: (m) => ctx.ui.notify(m) },
          rt.globalConfig,
          rt.sessionState,
          available,
          currentModels,
        );
        if (confirmResult.action === "cancelled") {
          throw new Error(
            "用户主动取消了模型确认，不要重试本次 subagent 调用。请向用户说明情况并等待用户指示。",
          );
        }
        rt.applyCategoryConfirm(confirmResult);
      }
```

- [ ] **步骤 4：运行测试确认通过**

运行：`cd extensions/subagents && npx vitest run src/__tests__/subagent-tool.test.ts`
预期：PASS（新测试 + 原有测试全通过）

- [ ] **步骤 5：提交**

```bash
git add extensions/subagents/src/tools/subagent-tool.ts extensions/subagents/src/__tests__/subagent-tool.test.ts
git commit -m "feat(subagents): first-use category model confirm in subagent tool execute"
```

---

## 任务 6: 全量类型检查 + lint

**文件：** 无（验证任务）

- [ ] **步骤 1：全量 typecheck**

运行：`cd extensions/subagents && npx tsc --noEmit`
预期：PASS（无错误）

- [ ] **步骤 2：lint**

运行：`cd extensions/subagents && npx eslint src/ 2>/dev/null || pnpm -r lint 2>/dev/null; echo "done"`
预期：无新增 lint 错误（忽略既有无关错误）

- [ ] **步骤 3：全量测试**

运行：`cd extensions/subagents && npx vitest run`
预期：全部 PASS（含新增 + 既有测试）

- [ ] **步骤 4：若有修复则提交，否则跳过**

```bash
git status --short
# 若有未提交的修复：
# git commit -am "fix: typecheck/lint adjustments"
```

---

## 任务 7: 手动集成验证清单（人工）

> 这些无法自动化（涉及真实 TUI 交互），实现完成后人工走查。

- [ ] **步骤 1：启动 pi，新 session 首次调 subagent（sync）→ 确认弹窗出现，逐个确认能选模型，确认后执行。**
- [ ] **步骤 2：同 session 再次调 subagent（不同 category）→ 不再弹窗，直接执行。**
- [ ] **步骤 3：首屏选「全部用默认并记住」→ 不弹窗，执行，后续不再弹。**
- [ ] **步骤 4：首屏选「取消」→ subagent 调用被取消，错误信息出现；再次调用重新弹窗。**
- [ ] **步骤 5：background 模式（wait:false）首次调用 → 同样弹窗确认。**
- [ ] **步骤 6：RPC 模式（非 TUI）→ 不弹窗直接执行。**
- [ ] **步骤 7：/resume 已确认的 session → 不弹窗。**
- [ ] **步骤 8：/new 新 session → 重新弹窗。**
- [ ] **步骤 9：确认中某 category provider 步按 Esc → 跳过该 category 继续，不取消整体。**
