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
| `extensions/subagents/src/tui/category-confirm.ts` | 自定义组件（extends Container）：category 平铺主视图 + model 二级菜单 + 自定义 fuzzy filter + thinking 子菜单。通过 `ctx.ui.custom()` 渲染 | 重写（IC-2）|
| `extensions/subagents/src/tui/batch-model-resolver.ts` | 批量解析所有 category 当前模型的 helper | 已实现（IC-7，复用）|
| `extensions/subagents/src/runtime.ts` | 新增 `applyCategoryConfirm()`（原子批量写 perCategory + 标记 confirmed） | 已实现（IC-5）|
| `extensions/subagents/src/tools/subagent-tool.ts` | execute 补第 5 参数 ctx + 插入确认拦截（调 `ctx.ui.custom`） | 修改（IC-1 + IC-6）|
| `extensions/subagents/src/__tests__/session-model-state.test.ts` | 新字段 round-trip 测试 | 已实现 |
| `extensions/subagents/src/__tests__/batch-model-resolver.test.ts` | 批量解析测试 | 已实现 |
| `extensions/subagents/src/__tests__/category-confirm.test.ts` | 组件交互测试（构造组件 + handleInput 模拟按键 + 断言 done 回调） | 重写 |
| `extensions/subagents/src/__tests__/runtime-confirm.test.ts` | applyCategoryConfirm 原子写测试 | 已实现 |
| `extensions/subagents/src/__tests__/subagent-tool.test.ts` | 拦截逻辑测试（mock ctx.ui.custom + categoryConfirmed） | 修改 |

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

## 任务 3: category-confirm 自定义组件（重写为 custom 组件）

> 本任务重写已实现的串行 select 版本，改为 `ctx.ui.custom()` 状态机组件（FR-2 平铺 + 二级菜单）。
> 任务 1/2/4 已实现并提交；本任务只动 `category-confirm.ts` + 其测试。

**文件：**
- 重写：`extensions/subagents/src/tui/category-confirm.ts`
- 重写：`extensions/subagents/src/__tests__/category-confirm.test.ts`

**组件设计**：`CategoryConfirmComponent extends Container`，构造参数 `(categories, currentModels, available, theme, kb, done)`。
- 内部状态机：`view = "categories" | "model-menu" | "thinking-menu"`。
- 主视图（categories）：平铺所有 category 行 + `✓ 完成确认`/`✗ 取消` 虚拟项，↑↓ 导航，Enter 进入二级菜单 / 提交 / 取消，Esc 取消。
- 二级菜单（model-menu）：顶部 Input filter + 模型列表（自定义 fuzzy filter）。Enter 选定回主视图，Esc 回主视图。
- `done({ action, overrides })` 通过 custom 的 done 回调返回。

**测试策略**：组件可单测——构造组件，调 `component.handleInput(keyData)` 模拟按键序列，断言 `done` 回调收到的结果。不依赖 ctx.ui.custom。

- [ ] **步骤 1：编写失败的测试**

重写 `extensions/subagents/src/__tests__/category-confirm.test.ts`：

```typescript
import { describe, expect, it, vi } from "vitest";

import { CategoryConfirmComponent, type CategoryConfirmResult } from "../tui/category-confirm.ts";
import { getKeybindings, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { ModelInfo } from "../types.ts";

setKeybindings(TUI_KEYBINDINGS);
const kb = getKeybindings();

const categories = [
  { name: "coding", model: "deepseek-router/ds-flash" },
  { name: "research", model: "anthropic/claude-haiku-4-5" },
];
const available: ModelInfo[] = [
  { id: "ds-flash", name: "DS Flash", provider: "deepseek-router", reasoning: true, thinkingLevelMap: { high: "h" } },
  { id: "claude-haiku-4-5", name: "Haiku", provider: "anthropic", reasoning: false },
];

/** 捕获 done 回调结果 */
function makeComponent(): { comp: CategoryConfirmComponent; result: { value: CategoryConfirmResult | null } } {
  const holder = { value: null as CategoryConfirmResult | null };
  const comp = new CategoryConfirmComponent(
    categories, { coding: "deepseek-router/ds-flash", research: "anthropic/claude-haiku-4-5" },
    available, kb, (r: CategoryConfirmResult) => { holder.value = r; },
  );
  return { comp, result: holder };
}

const UP = () => kb.getKeys("tui.select.up")[0] ?? "↑";
const DOWN = () => kb.getKeys("tui.select.down")[0] ?? "↓";
const ENTER = "\r";

describe("CategoryConfirmComponent", () => {
  it("cancel: 移到 ✗取消 + Enter → action=cancelled", () => {
    const { comp, result } = makeComponent();
    // items: coding(0), research(1), ✓完成(2), ✗取消(3)。光标初始 0，下移 3 次到取消
    comp.handleInput(DOWN()); comp.handleInput(DOWN()); comp.handleInput(DOWN());
    comp.handleInput(ENTER);
    expect(result.value).toEqual({ action: "cancelled", overrides: {} });
  });

  it("confirm-without-changes: 移到 ✓完成 + Enter → action=confirmed, 无 overrides", () => {
    const { comp, result } = makeComponent();
    comp.handleInput(DOWN()); comp.handleInput(DOWN()); // 到 ✓完成
    comp.handleInput(ENTER);
    expect(result.value?.action).toBe("confirmed");
    expect(result.value?.overrides).toEqual({});
  });

  it("enter-then-back-esc: 进入 coding 二级菜单后 Esc 回主视图", () => {
    const { comp, result } = makeComponent();
    comp.handleInput(ENTER); // 进入 coding 二级菜单
    comp.handleInput("\x1b"); // Esc 回主视图
    expect(result.value).toBeNull(); // 未提交
  });

  it("change-model: 进入 coding → Enter 选第一个 → 回主视图 → ✓完成", () => {
    const { comp, result } = makeComponent();
    comp.handleInput(ENTER); // 进入 coding 二级菜单，列表第一项即 ds-flash（当前）
    comp.handleInput(DOWN()); // 移到第二项（claude-haiku，非 reasoning）
    comp.handleInput(ENTER); // 选定，回主视图
    comp.handleInput(DOWN()); comp.handleInput(DOWN()); // 到 ✓完成
    comp.handleInput(ENTER);
    expect(result.value?.action).toBe("confirmed");
    expect(result.value?.overrides.coding).toEqual({ model: "anthropic/claude-haiku-4-5" });
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/subagents && npx vitest run src/__tests__/category-confirm.test.ts`
预期：FAIL（`CategoryConfirmComponent` 未导出，旧文件是 `runCategoryConfirm`）

- [ ] **步骤 3：重写 category-confirm.ts**

重写 `extensions/subagents/src/tui/category-confirm.ts`（核心结构，完整代码见实现）：

```typescript
// src/tui/category-confirm.ts
import {
  Container, fuzzyFilter, getKeybindings, Input, type KeybindingsManager,
  type SelectItem, SelectList, type SelectListTheme, Spacer, Text,
} from "@earendil-works/pi-tui";
import type { ModelInfo, Theme } from "@earendil-works/pi-coding-agent";

export type CategoryConfirmResult =
  | { action: "confirmed"; overrides: Record<string, { model: string; thinkingLevel?: string }> }
  | { action: "cancelled"; overrides: Record<string, never> };

const DONE_ITEM = "✓ 完成确认";
const CANCEL_ITEM = "✗ 取消";
const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh"];

type View = "categories" | "model-menu" | "thinking-menu";

export class CategoryConfirmComponent extends Container {
  private categories: { name: string; model: string }[];
  private currentModels: Record<string, string>;
  private available: ModelInfo[];
  private theme: Theme;
  private kb: KeybindingsManager;
  private done: (r: CategoryConfirmResult) => void;

  private overrides = new Map<string, { model: string; thinkingLevel?: string }>();
  private view: View = "categories";
  private selectedCategoryIndex = 0;
  private editingCategory: string | null = null;
  private editingModelId: ModelInfo | null = null;
  private filterText = "";
  private filteredModels: ModelInfo[] = [];
  private modelSelectedIndex = 0;
  private thinkingSelectedIndex = 0;
  private finished = false;

  // items = category 行 + 两个虚拟项
  private get items(): string[] {
    return [...this.categories.map((c) => c.name), DONE_ITEM, CANCEL_ITEM];
  }

  constructor(
    categories: { name: string; model: string }[],
    currentModels: Record<string, string>,
    available: ModelInfo[],
    theme: Theme,
    kb: KeybindingsManager,
    done: (r: CategoryConfirmResult) => void,
  ) {
    super();
    this.categories = categories;
    this.currentModels = currentModels;
    this.available = available;
    this.theme = theme;
    this.kb = kb;
    this.done = done;
    this.renderView();
  }

  // renderView / renderCategories / renderModelMenu / renderThinkingMenu
  // handleInput 分发到 handleCategoryInput / handleModelMenuInput / handleThinkingInput
  // 完整实现见实现步骤。
}
```

- [ ] **步骤 4：实现组件完整逻辑（render + handleInput 状态机）**

补全 `CategoryConfirmComponent` 的 `renderCategories()`、`openModelMenu(category)`、`openThinkingMenu(model)`、`renderModelMenu()`、`renderThinkingMenu()`、`handleCategoryInput(keyData)`、`handleModelMenuInput(keyData)`、`handleThinkingInput(keyData)`、`submit()`、`cancel()`。

关键点：
- `renderCategories()`：用 `theme.fg/underline/bold` 着色，clear+addChild 重建。
- `openModelMenu(category)`：重置 filterText=""，filteredModels=全部，modelSelectedIndex=0。
- filter 变化（普通字符输入）→ `filteredModels = available.filter(m => fuzzyFilter(filterText, m.name).score > 0)`，重建列表显示。
- `handleModelMenuInput`：↑↓ 改 modelSelectedIndex；Enter 写 overrides（`provider/id`，仅当与当前不同）→ 若 reasoning 且有 thinkingLevelMap 进 thinking-menu，否则回主视图；Esc 回主视图。
- `handleThinkingInput`：↑↓ 选 thinking level；Enter 写 overrides.thinkingLevel 回主视图；Esc 跳过 thinking 回主视图。
- `submit()`：`done({ action:"confirmed", overrides: Object.fromEntries(this.overrides) })`，finished=true。
- `cancel()`：`done({ action:"cancelled", overrides: {} })`，finished=true。

- [ ] **步骤 5：运行测试确认通过**

运行：`cd extensions/subagents && npx vitest run src/__tests__/category-confirm.test.ts`
预期：PASS（4 个 it 通过）

- [ ] **步骤 6：提交**

```bash
git add extensions/subagents/src/tui/category-confirm.ts extensions/subagents/src/__tests__/category-confirm.test.ts
git commit -m "refactor(subagents): rewrite category-confirm as custom TUI component (flat list + submenu)"
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

## 任务 5: subagent-tool 拦截层改用 ctx.ui.custom

> IC-1（execute 补 ctx 参数）已实现。本任务把拦截块从「调旧 runCategoryConfirm（select 版）」改为「调 ctx.ui.custom(CategoryConfirmComponent factory)」，并更新测试。

**文件：**
- 修改：`extensions/subagents/src/tools/subagent-tool.ts`（IC-6 重写拦截块）
- 修改：`extensions/subagents/src/__tests__/subagent-tool.test.ts`

**说明：** 拦截块改为 `await ctx.ui.custom((tui, theme, kb, done) => new CategoryConfirmComponent(...))`。custom 返回 `CategoryConfirmResult`。cancelled → 抛错；confirmed → `rt.applyCategoryConfirm(result)`。use-default 语义合并进 confirmed（不改任何 category 直接提交）。

- [ ] **步骤 1：更新测试（mock ctx.ui.custom 替代 select）**

在 `extensions/subagents/src/__tests__/subagent-tool.test.ts`：

(a) MockRuntime/sessionState 等已在上一轮加好（任务 5 旧版已实现），保持不变。

(b) 把 4 个确认拦截测试的 mock ctx 从 `ui.select` 改为 `ui.custom`：

```typescript
  // categoryConfirmed=true → 跳过确认直接执行（不变，custom 不被调用）
  it("categoryConfirmed=true → 跳过确认直接执行", async () => {
    const mockRt = makeMockRuntime({
      sessionState: { categoryConfirmed: true, perCategory: {}, yoloMode: false, perAgent: {} },
      runAgent: vi.fn(async () => successResult()),
    });
    mockedGetRuntime.mockReturnValue(mockRt as never);
    const tool = captureTool();
    const custom = vi.fn();
    const ctx = { hasUI: true, ui: { custom } } as unknown as Partial<ExtensionContext>;
    await tool.execute("call-1", { task: "do X", agent: "worker" }, undefined, undefined, ctx);
    expect(custom).not.toHaveBeenCalled();
  });

  // hasUI=false → 跳过确认直接执行（不变）
  it("hasUI=false → 跳过确认直接执行", async () => {
    const mockRt = makeMockRuntime({ runAgent: vi.fn(async () => successResult()) });
    mockedGetRuntime.mockReturnValue(mockRt as never);
    const tool = captureTool();
    const ctx = { hasUI: false } as unknown as Partial<ExtensionContext>;
    await tool.execute("call-1", { task: "do X", agent: "worker" }, undefined, undefined, ctx);
    expect(mockRt.applyCategoryConfirm).not.toHaveBeenCalled();
  });

  // custom 返回 cancelled → 抛错
  it("custom 返回 cancelled → execute 抛错含'取消'，不调 runAgent", async () => {
    const mockRt = makeMockRuntime({ runAgent: vi.fn(async () => successResult()) });
    mockedGetRuntime.mockReturnValue(mockRt as never);
    const tool = captureTool();
    const custom = vi.fn(async (_f: unknown) => ({ action: "cancelled", overrides: {} }));
    const ctx = { hasUI: true, modelRegistry: { getAvailable: () => [] }, ui: { custom } } as unknown as Partial<ExtensionContext>;
    await expect(tool.execute("call-1", { task: "do X", agent: "worker" }, undefined, undefined, ctx)).rejects.toThrow(/取消/);
    expect(mockRt.runAgent).not.toHaveBeenCalled();
  });

  // custom 返回 confirmed（无改动）→ applyCategoryConfirm 后执行
  it("custom 返回 confirmed → applyCategoryConfirm 后继续执行", async () => {
    const mockRt = makeMockRuntime({ runAgent: vi.fn(async () => successResult()) });
    mockedGetRuntime.mockReturnValue(mockRt as never);
    const tool = captureTool();
    const custom = vi.fn(async (_f: unknown) => ({ action: "confirmed", overrides: {} }));
    const ctx = { hasUI: true, modelRegistry: { getAvailable: () => [] }, ui: { custom } } as unknown as Partial<ExtensionContext>;
    await tool.execute("call-1", { task: "do X", agent: "worker" }, undefined, undefined, ctx);
    expect(mockRt.applyCategoryConfirm).toHaveBeenCalledWith({ action: "confirmed", overrides: {} });
    expect(mockRt.runAgent).toHaveBeenCalled();
  });
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/subagents && npx vitest run src/__tests__/subagent-tool.test.ts`
预期：FAIL（拦截块仍调 runCategoryConfirm，custom 未被调用）

- [ ] **步骤 3：改 subagent-tool.ts 拦截块用 ctx.ui.custom**

`extensions/subagents/src/tools/subagent-tool.ts`：

更新 import（替换旧的 runCategoryConfirm import）：
```typescript
import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";

import { CategoryConfirmComponent } from "../tui/category-confirm.ts";
import { resolveAllCategoryModels } from "../tui/batch-model-resolver.ts";
```

替换拦截块（assertAgentExists 之后、effectiveWait 之前）：

```typescript
      // ── 首次 category 模型确认拦截（FR-1 / FR-2）──
      // ctx 缺失（旧测试/非工具路径）或 hasUI=false（RPC/print）时跳过，直接执行。
      if (ctx?.hasUI && !rt.sessionState.categoryConfirmed) {
        const categories = Object.entries(rt.globalConfig.categories).map(([name, def]) => ({ name, model: def.model }));
        const currentModels = resolveAllCategoryModels(rt.globalConfig, rt.sessionState);
        const available = ctx.modelRegistry.getAvailable();
        const kb = getKeybindings();
        const theme: Theme = ctx.theme;
        const confirmResult = await ctx.ui.custom<CategoryConfirmResult>((tui, _t, _kb, done) => {
          return new CategoryConfirmComponent(categories, currentModels, available, theme, kb, done);
        });
        if (confirmResult.action === "cancelled") {
          throw new Error(
            "用户主动取消了模型确认，不要重试本次 subagent 调用。请向用户说明情况并等待用户指示。",
          );
        }
        rt.applyCategoryConfirm({ action: "confirmed", overrides: confirmResult.overrides });
      }
```

- [ ] **步骤 4：运行测试确认通过**

运行：`cd extensions/subagents && npx vitest run src/__tests__/subagent-tool.test.ts`
预期：PASS（4 个拦截测试 + 原有测试全通过）

- [ ] **步骤 5：提交**

```bash
git add extensions/subagents/src/tools/subagent-tool.ts extensions/subagents/src/__tests__/subagent-tool.test.ts
git commit -m "refactor(subagents): interception uses ctx.ui.custom(CategoryConfirmComponent)"
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
