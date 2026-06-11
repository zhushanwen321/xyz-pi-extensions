---
verdict: pass
complexity: L1
---

# Pi Plan Mode Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个轻量级 Plan Mode 扩展，融合 brainstorming + writing-plans 能力，通过 `/plan` 命令触发，产出临时 plan 文件，退出后可衔接 goal 工具执行。

**Architecture:** 新建 `extensions/plan/` 包（`@zhushanwen/pi-plan`），包含 plan tool（5 个 action）、`/plan` command（内联 plan mode 提示词）、模板系统。**状态存储在 `ctx.sessionManager`（per-session 隔离）**，不用闭包变量缓存。上下文隔离通过 `ctx.compact()` 实现，Goal API 通过 `pi.__goalInit` 调用。

**Tech Stack:** TypeScript, Pi Extension API, typebox, pi-tui (Text)

**无编译步骤：** Extension 由 Pi 运行时直接加载 TypeScript，无需 build。

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `CLAUDE.md` | modify | BG0 | 新增 @zhushanwen/pi-plan 条目 |
| `.changeset/plan-mode-init.md` | create | BG0 | changeset for new package |
| `extension-dependencies.json` | modify | BG0 | 新增 pi-plan 条目 |
| `extensions/plan/package.json` | create | BG1 | 包配置 |
| `extensions/plan/index.ts` | create | BG1 | 顶层 re-export |
| `extensions/plan/tsconfig.json` | create | BG1 | TypeScript 配置 |
| `extensions/plan/vitest.config.ts` | create | BG1 | Vitest 配置 |
| `extensions/plan/src/index.ts` | create | BG1 | Extension 入口（工厂函数 + 注册） |
| `extensions/plan/src/state.ts` | create | BG1 | 状态类型定义 + 持久化逻辑 + session Map |
| `extensions/plan/src/tool.ts` | create | BG1 | plan tool 注册 + 5 个 action handler |
| `extensions/plan/src/command.ts` | create | BG1 | `/plan` command 注册（含 abort/status/重入） |
| `extensions/plan/src/templates.ts` | create | BG1 | 模板发现 + 加载逻辑 |
| `extensions/plan/src/compact.ts` | create | BG2 | compact/tree handler + steer 注入 |
| `extensions/plan/src/widget.ts` | create | BG1 | TUI 状态栏渲染 |
| `extensions/plan/templates/*.md` | create | BG2 | 5 个内置模板文件 |
| `extensions/plan/src/__tests__/state.test.ts` | create | BG1 | 状态管理测试 |
| `extensions/plan/src/__tests__/templates.test.ts` | create | BG1 | 模板系统测试 |
| `extensions/plan/src/__tests__/compact.test.ts` | create | BG2 | compact handler 测试 |
| `shared/types/mariozechner/index.d.ts` | modify | — | 类型 stub（如需） |

## Interface Contracts

### Module: state

#### Type: PlanPhase

| Value | Description |
|-------|-------------|
| `"idle"` | Plan mode 未激活 |
| `"brainstorming"` | 需求探索阶段 |
| `"writing"` | Plan 文件编写阶段 |
| `"complete"` | Plan 完成，准备退出 |

#### Type: PlanState

| Field | Type | Description |
|-------|------|-------------|
| isActive | boolean | Plan mode 是否激活 |
| phase | PlanPhase | 当前阶段 |
| planFilePath | string | Plan 文件路径 |
| requirement | string | 用户输入的需求描述 |
| templateName | string | 选中的模板名 |

#### Type: PlanSessionMap

`Map<string, PlanState>` — 按 sessionId 索引的 per-session 状态缓存。

#### Function: getPlanState

| Signature | Returns | Edge Cases |
|-----------|---------|------------|
| (sessions: PlanSessionMap, sessionId: string, ctx: ExtensionContext) → PlanState | PlanState | sessionId 不存在时从 ctx.sessionManager 重建 |

#### Function: persistPlanState

| Signature | Returns | Edge Cases |
|-----------|---------|------------|
| (pi: ExtensionAPI, state: PlanState) → void | void | 无 |

#### Function: reconstructPlanState

| Signature | Returns | Edge Cases |
|-----------|---------|------------|
| (ctx: ExtensionContext) → PlanState | PlanState | entries 为空时返回 DEFAULT_PLAN_STATE |

### Module: tool

#### Function: executePlanTool

| Signature | Returns | Edge Cases |
|-----------|---------|------------|
| (pi: ExtensionAPI, ctx: ExtensionContext, sessions: PlanSessionMap, action: string, params: unknown) → ToolResult | ToolResult | 未知 action → throw Error |

### Module: templates

#### Function: listTemplates

| Signature | Returns | Edge Cases |
|-----------|---------|------------|
| (projectDir?: string) → TemplateInfo[] | TemplateInfo[] | 无模板时返回空数组 |

#### Function: loadTemplate

| Signature | Returns | Edge Cases |
|-----------|---------|------------|
| (name: string, projectDir?: string) → string \| null | string \| null | 模板不存在时返回 null |

### Module: compact

#### Function: handlePlanComplete

| Signature | Returns | Edge Cases |
|-----------|---------|------------|
| (pi: ExtensionAPI, ctx: ExtensionContext, state: PlanState, isolation: string) → void | void | compact 失败时降级为直接继续 |

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1 | executePlanTool(action="start") | /plan command → executePlanTool | Task 3, 4 |
| AC-2 | — | command 内联提示词约束 | Task 4 |
| AC-3 | — | command 内联提示词约束 | Task 4 |
| AC-4 | — | command 内联提示词约束 | Task 4 |
| AC-5 | loadTemplate() | templates → write | Task 5 |
| AC-6 | executePlanTool(action="abort") | /plan abort → executePlanTool | Task 4 |
| AC-7 | handlePlanComplete(isolation="compact") | complete → compact → steer | Task 6 |
| AC-8 | handlePlanComplete(isolation="direct") | complete → steer (降级) | Task 6 |
| AC-9 | pi.__goalInit() | complete → goal init | Task 6 |
| AC-10 | listTemplates() | 模板发现逻辑 | Task 5 |
| AC-11 | PlanSessionMap + reconstructPlanState | sessionManager per-session | Task 2, 3 |

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 进入 plan mode | adopted | Task 3, 4 |
| AC-2 先探索再提问 | adopted | Task 4 (command 内联提示词) |
| AC-3 提出 2-3 方案 | adopted | Task 4 (command 内联提示词) |
| AC-4 按章节顺序填写 | adopted | Task 4 (command 内联提示词) |
| AC-5 Plan 文件格式正确 | adopted | Task 5 |
| AC-6 abort 可取消 | adopted | Task 4 |
| AC-7 compact 成功时读取 plan | adopted | Task 6 |
| AC-8 compact 失败时降级 | adopted | Task 6 |
| AC-9 Goal API 启动 | adopted | Task 6 |
| AC-10 自定义模板发现 | adopted | Task 5 |
| AC-11 多 session 隔离 | adopted | Task 2, 3 |

---

## Execution Groups

#### BG0: 项目结构同步

**Description:** 更新 CLAUDE.md、extension-dependencies.json、创建 changeset。项目约定要求。

**Tasks:** Task 0

**Files (预估):** 3 个文件（1 create + 2 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | taskComplexity: low |
| 注入上下文 | Task 描述 + CLAUDE.md [MANDATORY] 规则 |
| 读取文件 | CLAUDE.md, extension-dependencies.json |
| 修改/创建文件 | CLAUDE.md, extension-dependencies.json, .changeset/plan-mode-init.md |

**Dependencies:** 无

#### BG1: 核心状态管理

**Description:** Plan state 类型定义、per-session Map 持久化/重建、plan tool 注册（含 5 个 action handler）、/plan command 注册（含 abort/status/重入）。

**Tasks:** Task 1, Task 2, Task 3, Task 4

**Files (预估):** 7 个文件（7 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | taskComplexity: medium |
| 注入上下文 | Task 描述 + spec FR-1, FR-7, FR-9 + coding-workflow/index.ts 参考 |
| 读取文件 | extensions/coding-workflow/index.ts, extensions/goal/src/state.ts |
| 修改/创建文件 | extensions/plan/* |

**Execution Flow (BG1 内部):** 串行派遣

  Task 1:
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 2 (depends on Task 1):
    1. general-purpose → 写失败测试
    2. general-purpose → 写实现代码
    3. general-purpose → spec 合规检查

  Task 3 (depends on Task 1):
    1. general-purpose → 写失败测试
    2. general-purpose → 写实现代码
    3. general-purpose → spec 合规检查

  Task 4 (depends on Task 1, Task 2):
    1. general-purpose → 写失败测试
    2. general-purpose → 写实现代码
    3. general-purpose → spec 合规检查

**Dependencies:** BG0

#### BG2: Compact + 模板

**Description:** compact/tree handler、steer 注入。templates.ts 和 widget.ts 已移至 BG1，compact.ts 通过 dynamic import 被 BG1 的 tool.ts 调用。

**Tasks:** Task 6

**Files (预估):** 8 个文件（8 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | taskComplexity: medium |
| 注入上下文 | Task 描述 + spec FR-5, FR-6 + coding-workflow compact 参考 |
| 读取文件 | extensions/coding-workflow/lib/tool-handlers.ts (compact 逻辑) |
| 修改/创建文件 | extensions/plan/src/compact.ts, extensions/plan/templates/* |

**Execution Flow (BG2 内部):** 串行派遣

  Task 6 (depends on Task 5):
    1. general-purpose → 写失败测试
    2. general-purpose → 写实现代码
    3. general-purpose → spec 合规检查

**Dependencies:** BG1

---

## Dependency Graph & Wave Schedule

```
BG0 (项目同步) ──→ BG1 (核心状态) ──→ BG2 (Compact + 模板)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG0 | 项目结构同步，无依赖 |
| Wave 2 | BG1 | 核心状态管理，依赖 BG0 |
| Wave 3 | BG2 | Compact + 模板，依赖 BG1 |

---

## Tasks

### Task 0: 项目结构同步

**Type:** backend

**Files:**
- Modify: `CLAUDE.md`
- Modify: `extension-dependencies.json`
- Create: `.changeset/plan-mode-init.md`

- [x] **Step 1: Update CLAUDE.md**

在 "Monorepo 架构" 的 extensions 列表中添加：
```
│   ├── plan/                → @zhushanwen/pi-plan
```

在 "当前包清单" 的 `extensions/` 表格中添加：
```
| `extensions/plan/` | `@zhushanwen/pi-plan` | 轻量级 Plan Mode（brainstorming + writing-plans） | plan-mode |
```

- [x] **Step 2: Update extension-dependencies.json**

在 `extension-dependencies.json` 中添加 pi-plan 条目：
```json
{
  "name": "@zhushanwen/pi-plan",
  "dependsOn": [
    { "name": "@zhushanwen/pi-goal", "type": "optional" }
  ]
}
```

- [x] **Step 3: Create changeset**

创建 `.changeset/plan-mode-init.md`：
```markdown
---
"@zhushanwen/pi-plan": minor
---

Add new @zhushanwen/pi-plan extension: lightweight plan mode with brainstorming + writing-plans capabilities
```

- [x] **Step 4: Commit**

```bash
git add CLAUDE.md extension-dependencies.json .changeset/plan-mode-init.md
git commit -m "chore: register @zhushanwen/pi-plan in project structure"
```

### Task 1: 包结构 + State 类型定义

**Type:** backend

**Files:**
- Create: `extensions/plan/package.json`
- Create: `extensions/plan/index.ts`
- Create: `extensions/plan/tsconfig.json`
- Create: `extensions/plan/vitest.config.ts`
- Create: `extensions/plan/src/index.ts`
- Create: `extensions/plan/src/state.ts`
- Test: `extensions/plan/src/__tests__/state.test.ts`

- [x] **Step 1: Write the failing test**

```typescript
// extensions/plan/src/__tests__/state.test.ts
import { describe, it, expect, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DEFAULT_PLAN_STATE, type PlanState, type PlanPhase, type PlanSessionMap, getPlanState } from "../state.js";

describe("PlanState", () => {
  it("DEFAULT_PLAN_STATE has correct defaults", () => {
    expect(DEFAULT_PLAN_STATE.isActive).toBe(false);
    expect(DEFAULT_PLAN_STATE.phase).toBe("idle");
    expect(DEFAULT_PLAN_STATE.planFilePath).toBe("");
    expect(DEFAULT_PLAN_STATE.requirement).toBe("");
    expect(DEFAULT_PLAN_STATE.templateName).toBe("");
  });

  it("PlanPhase type includes all required phases", () => {
    const phases: PlanPhase[] = ["idle", "brainstorming", "writing", "complete"];
    expect(phases).toHaveLength(4);
  });

  it("getPlanState returns cached state if exists", () => {
    const sessions: PlanSessionMap = new Map();
    const cached: PlanState = { ...DEFAULT_PLAN_STATE, isActive: true, phase: "brainstorming" };
    sessions.set("session-1", cached);

    const mockCtx = {
      sessionManager: { getEntries: () => [] },
    } as unknown as ExtensionContext;

    const result = getPlanState(sessions, "session-1", mockCtx);
    expect(result).toBe(cached); // same reference
  });

  it("getPlanState reconstructs from sessionManager if not cached", () => {
    const sessions: PlanSessionMap = new Map();
    const mockCtx = {
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "plan-state",
            data: { isActive: true, phase: "writing", planFilePath: "/tmp/plan-test.md", requirement: "test", templateName: "feature-plan" },
          },
        ],
      },
    } as unknown as ExtensionContext;

    const result = getPlanState(sessions, "session-2", mockCtx);
    expect(result.isActive).toBe(true);
    expect(result.phase).toBe("writing");
    expect(sessions.get("session-2")).toBe(result); // cached for next call
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run extensions/plan/src/__tests__/state.test.ts`
Expected: FAIL with "Cannot find module '../state.js'"

- [x] **Step 3: Write minimal implementation**

```typescript
// extensions/plan/src/state.ts
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export type PlanPhase = "idle" | "brainstorming" | "writing" | "complete";

export interface PlanState {
  isActive: boolean;
  phase: PlanPhase;
  planFilePath: string;
  requirement: string;
  templateName: string;
}

export const DEFAULT_PLAN_STATE: PlanState = {
  isActive: false,
  phase: "idle",
  planFilePath: "",
  requirement: "",
  templateName: "",
};

/** Per-session state cache. Keyed by sessionId. */
export type PlanSessionMap = Map<string, PlanState>;

/**
 * Get plan state for a session. Returns cached state if available,
 * otherwise reconstructs from sessionManager and caches it.
 */
export function getPlanState(
  sessions: PlanSessionMap,
  sessionId: string,
  ctx: ExtensionContext,
): PlanState {
  const cached = sessions.get(sessionId);
  if (cached) return cached;

  const reconstructed = reconstructPlanState(ctx);
  sessions.set(sessionId, reconstructed);
  return reconstructed;
}

export function persistPlanState(pi: ExtensionAPI, state: PlanState): void {
  pi.appendEntry("plan-state", {
    isActive: state.isActive,
    phase: state.phase,
    planFilePath: state.planFilePath,
    requirement: state.requirement,
    templateName: state.templateName,
  });
}

export function reconstructPlanState(ctx: ExtensionContext): PlanState {
  const state = { ...DEFAULT_PLAN_STATE };
  const entries = ctx.sessionManager.getEntries();

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry.type === "custom" &&
      (entry as { customType: string }).customType === "plan-state"
    ) {
      const data = (entry as { data: unknown }).data as Partial<PlanState> | undefined;
      if (data) {
        state.isActive = data.isActive ?? false;
        state.phase = data.phase ?? "idle";
        state.planFilePath = data.planFilePath ?? "";
        state.requirement = data.requirement ?? "";
        state.templateName = data.templateName ?? "";
      }
      break;
    }
  }

  return state;
}
```

```json
// extensions/plan/package.json
{
  "name": "@zhushanwen/pi-plan",
  "version": "0.1.0",
  "description": "Lightweight plan mode for Pi coding agent",
  "type": "module",
  "main": "src/index.ts",
  "pi": {
    "extensions": ["./index.ts"]
  },
  "keywords": ["pi-package", "extension"],
  "license": "MIT",
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": ">=0.73.0"
  },
  "scripts": {
    "typecheck": "npx tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^4.1.8"
  },
  "files": ["index.ts", "src/", "templates/"]
}
```

```typescript
// extensions/plan/index.ts
export { default } from "./src/index.js";
```

```json
// extensions/plan/tsconfig.json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src/**/*.ts", "index.ts"],
  "exclude": ["src/__tests__", "dist"]
}
```

```typescript
// extensions/plan/src/index.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function planExtension(pi: ExtensionAPI) {
  // Registration will be added in subsequent tasks
}
```

```typescript
// extensions/plan/vitest.config.ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@mariozechner/pi-coding-agent": path.resolve(
        __dirname,
        "../../shared/types/mariozechner/index",
      ),
    },
  },
});
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run extensions/plan/src/__tests__/state.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add extensions/plan/
git commit -m "feat(plan): add package structure and state types with session isolation"
```

### Task 2: State 持久化测试增量（test-only）

**Type:** backend

**Files:**
- Modify: `extensions/plan/src/index.ts`
- Test: `extensions/plan/src/__tests__/state.test.ts` (extend)

- [x] **Step 1: Write the failing test**

```typescript
// extensions/plan/src/__tests__/state.test.ts (add to existing)
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { persistPlanState, reconstructPlanState } from "../state.js";

describe("State persistence", () => {
  it("persistPlanState calls appendEntry with correct data", () => {
    const mockPi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
    const state: PlanState = {
      isActive: true,
      phase: "brainstorming",
      planFilePath: "/tmp/plan-test.md",
      requirement: "test requirement",
      templateName: "feature-plan",
    };

    persistPlanState(mockPi, state);

    expect(mockPi.appendEntry).toHaveBeenCalledWith("plan-state", {
      isActive: true,
      phase: "brainstorming",
      planFilePath: "/tmp/plan-test.md",
      requirement: "test requirement",
      templateName: "feature-plan",
    });
  });

  it("reconstructPlanState returns DEFAULT_PLAN_STATE when no entries", () => {
    const mockCtx = {
      sessionManager: { getEntries: () => [] },
    } as unknown as ExtensionContext;

    const state = reconstructPlanState(mockCtx);
    expect(state).toEqual(DEFAULT_PLAN_STATE);
  });

  it("reconstructPlanState restores state from entries", () => {
    const mockCtx = {
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "plan-state",
            data: {
              isActive: true,
              phase: "writing",
              planFilePath: "/tmp/plan-test.md",
              requirement: "test",
              templateName: "feature-plan",
            },
          },
        ],
      },
    } as unknown as ExtensionContext;

    const state = reconstructPlanState(mockCtx);
    expect(state.isActive).toBe(true);
    expect(state.phase).toBe("writing");
    expect(state.planFilePath).toBe("/tmp/plan-test.md");
  });
});
```

- [x] **Step 2: Run test to verify it passes**

Run: `npx vitest run extensions/plan/src/__tests__/state.test.ts`
Expected: PASS (persistence functions already implemented in Task 1)

- [x] **Step 3: Commit**

```bash
git add extensions/plan/src/__tests__/state.test.ts
git commit -m "test(plan): add state persistence tests"
```

### Task 3: Plan Tool 注册 + 5 个 Action Handler

**Type:** backend

**Files:**
- Create: `extensions/plan/src/tool.ts`
- Modify: `extensions/plan/src/index.ts`
- Test: `extensions/plan/src/__tests__/tool.test.ts`

- [x] **Step 1: Write the failing test**

```typescript
// extensions/plan/src/__tests__/tool.test.ts
import { describe, it, expect } from "vitest";
import { PLAN_ACTIONS, validateAction } from "../tool.js";

describe("Plan Tool", () => {
  it("PLAN_ACTIONS contains all required actions", () => {
    expect(PLAN_ACTIONS).toContain("list-template");
    expect(PLAN_ACTIONS).toContain("select-template");
    expect(PLAN_ACTIONS).toContain("create-template");
    expect(PLAN_ACTIONS).toContain("complete");
    expect(PLAN_ACTIONS).toContain("abort");
    expect(PLAN_ACTIONS).toHaveLength(5);
  });

  it("validateAction returns true for valid actions", () => {
    for (const action of PLAN_ACTIONS) {
      expect(validateAction(action)).toBe(true);
    }
  });

  it("validateAction returns false for invalid actions", () => {
    expect(validateAction("invalid")).toBe(false);
    expect(validateAction("")).toBe(false);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run extensions/plan/src/__tests__/tool.test.ts`
Expected: FAIL with "Cannot find module '../tool.js'"

- [x] **Step 3: Write minimal implementation**

```typescript
// extensions/plan/src/tool.ts
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { PlanSessionMap, PlanState } from "./state.js";
import { getPlanState, persistPlanState } from "./state.js";
import { listTemplates, loadTemplate } from "./templates.js";
import { updatePlanWidget } from "./widget.js";
import * as fs from "node:fs";
import * as path from "node:path";

export const PLAN_ACTIONS = [
  "list-template",
  "select-template",
  "create-template",
  "complete",
  "abort",
] as const;

export type PlanAction = (typeof PLAN_ACTIONS)[number];

export function validateAction(action: string): action is PlanAction {
  return (PLAN_ACTIONS as readonly string[]).includes(action);
}

export function registerPlanTool(
  pi: ExtensionAPI,
  sessions: PlanSessionMap,
): void {
  pi.registerTool({
    name: "plan",
    label: "Plan Mode",
    description:
      "Plan mode tool for brainstorming and writing implementation plans. " +
      "Actions: list-template, select-template, create-template, complete, abort.",
    parameters: Type.Object({
      action: Type.String({ description: "Action to perform" }),
      templateName: Type.Optional(Type.String({ description: "Template name (for select-template)" })),
      templateContent: Type.Optional(Type.String({ description: "Template content (for create-template)" })),
      isolation: Type.Optional(StringEnum(["compact", "tree", "direct"])),
    }),
    promptSnippet: "Use plan tool for plan mode operations",
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal,
      _onUpdate: (partial: { content: Array<{ type: string; text: string }> }) => void,
      ctx: ExtensionContext,
    ) {
      const action = params.action as string;
      if (!validateAction(action)) {
        throw new Error(`Unknown plan action: ${action}. Valid actions: ${PLAN_ACTIONS.join(", ")}`);
      }

      const sessionId = ctx.sessionId ?? "default";
      const state = getPlanState(sessions, sessionId, ctx);

      switch (action) {
        case "list-template": {
          const templates = listTemplates();
          return {
            content: [{ type: "text" as const, text: JSON.stringify(templates, null, 2) }],
            details: { action, templates },
          };
        }

        case "select-template": {
          const templateName = params.templateName as string;
          if (!templateName) {
            throw new Error("templateName is required for select-template");
          }
          const content = loadTemplate(templateName);
          if (!content) {
            throw new Error(`Template not found: ${templateName}`);
          }
          state.templateName = templateName;
          state.phase = "writing";
          persistPlanState(pi, state);
          return {
            content: [{ type: "text" as const, text: `Template selected: ${templateName}` }],
            details: { action, templateName, content },
          };
        }

        case "create-template": {
          const templateName = params.templateName as string;
          const templateContent = params.templateContent as string;
          if (!templateName || !templateContent) {
            throw new Error("templateName and templateContent are required for create-template");
          }
          // Sanitize template name to prevent path traversal
          const sanitizedName = templateName.replace(/[^a-zA-Z0-9_-]/g, "");
          if (!sanitizedName) {
            throw new Error("Invalid template name: must contain alphanumeric characters");
          }
          const projectDir = process.cwd();
          const templateDir = path.join(projectDir, ".pi", "plan-templates");
          fs.mkdirSync(templateDir, { recursive: true });
          fs.writeFileSync(path.join(templateDir, `${sanitizedName}.md`), templateContent);
          return {
            content: [{ type: "text" as const, text: `Template created: ${sanitizedName}` }],
            details: { action, templateName: sanitizedName },
          };
        }

        case "complete": {
          state.phase = "complete";
          persistPlanState(pi, state);
          const isolation = (params.isolation as string) ?? "direct";
          // Dynamic import: compact.ts is in BG2, tool.ts is in BG1
          const { handlePlanComplete } = await import("./compact.js");
          handlePlanComplete(pi, ctx, state, isolation);
          return {
            content: [{ type: "text" as const, text: "Plan complete. Switching to implementation..." }],
            details: { action, planFilePath: state.planFilePath, isolation },
          };
        }

        case "abort": {
          state.isActive = false;
          state.phase = "idle";
          state.planFilePath = "";
          state.requirement = "";
          state.templateName = "";
          persistPlanState(pi, state);
          sessions.delete(sessionId);
          updatePlanWidget(ctx, state);
          return {
            content: [{ type: "text" as const, text: "Plan mode aborted." }],
            details: { action },
          };
        }
      }
    },
  });
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run extensions/plan/src/__tests__/tool.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add extensions/plan/src/tool.ts extensions/plan/src/index.ts extensions/plan/src/__tests__/tool.test.ts
git commit -m "feat(plan): add plan tool with 5 action handlers and session isolation"
```

### Task 4: /plan Command 注册（含 abort/status/重入）

**Type:** backend

**Files:**
- Create: `extensions/plan/src/command.ts`
- Modify: `extensions/plan/src/index.ts`

- [x] **Step 1: Write the implementation**

```typescript
// extensions/plan/src/command.ts
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { PlanSessionMap, PlanState } from "./state.js";
import { getPlanState, persistPlanState } from "./state.js";
import { updatePlanWidget } from "./widget.js";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

export function registerPlanCommand(
  pi: ExtensionAPI,
  sessions: PlanSessionMap,
): void {
  pi.registerCommand("plan", {
    description:
      "Enter plan mode: /plan [description]. " +
      "Subcommands: /plan abort, /plan status. " +
      "With no args, show status or detect existing plan.",
    handler: async (args: string, ctx: ExtensionContext) => {
      const trimmed = args.trim();
      const sessionId = ctx.sessionId ?? "default";
      const state = getPlanState(sessions, sessionId, ctx);

      // Subcommand: abort
      if (trimmed === "abort") {
        if (!state.isActive) {
          ctx.ui.notify("No active plan mode.", "info");
          return;
        }
        state.isActive = false;
        state.phase = "idle";
        state.planFilePath = "";
        state.requirement = "";
        state.templateName = "";
        persistPlanState(pi, state);
        sessions.delete(sessionId);
        updatePlanWidget(ctx, state);
        ctx.ui.notify("Plan mode aborted.", "info");
        return;
      }

      // Subcommand: status
      if (trimmed === "status") {
        if (!state.isActive) {
          ctx.ui.notify("No active plan mode.", "info");
          return;
        }
        ctx.ui.notify(
          `Plan Mode: ${state.phase}\nPlan: ${state.planFilePath}\nTemplate: ${state.templateName || "(not selected)"}`,
          "info",
        );
        return;
      }

      // If already in plan mode with no args, show status
      if (state.isActive && !trimmed) {
        ctx.ui.notify(
          `Plan Mode: ${state.phase}\nPlan: ${state.planFilePath}`,
          "info",
        );
        return;
      }

      // If already in plan mode with args, warn
      if (state.isActive && trimmed) {
        ctx.ui.notify("Plan mode is already active. Use /plan abort to cancel first.", "warning");
        return;
      }

      // Reentry: check for existing plan files in /tmp
      if (!state.isActive && !trimmed) {
        const tmpDir = os.tmpdir();
        const existingPlans = fs.readdirSync(tmpDir)
          .filter((f) => f.startsWith("plan-") && f.endsWith(".md"))
          .map((f) => path.join(tmpDir, f));

        if (existingPlans.length > 0) {
          // Found existing plan files — ask user what to do
          pi.sendUserMessage(
            `[PLAN MODE] Found existing plan files:\n${existingPlans.map((p, i) => `  ${i + 1}. ${p}`).join("\n")}\n\n` +
            `Choose an option:\n` +
            `  a) Continue existing plan\n` +
            `  b) Implement existing plan\n` +
            `  c) Create new plan\n` +
            `  d) Cancel`,
          );
          return;
        }
      }

      // Enter plan mode
      const slug = trimmed
        ? trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30)
        : "untitled";

      // 注意：/tmp 是 OS 级共享路径，不同项目的 plan 文件会混在一起
      // spec v1 设计选择，接受跨项目泄漏风险（reentry 扫描会误捡其他项目的 plan）
      const planFilePath = path.join(os.tmpdir(), `plan-${slug}.md`);

      state.isActive = true;
      state.phase = "brainstorming";
      state.planFilePath = planFilePath;
      state.requirement = trimmed;
      state.templateName = "";

      persistPlanState(pi, state);
      updatePlanWidget(ctx, state);

      // Inject plan mode system prompt inline (no separate SKILL.md)
      pi.sendUserMessage(
        `[PLAN MODE] Entered plan mode.\n\n` +
        `Requirement: ${trimmed || "(from conversation context)"}\n` +
        `Plan file: ${planFilePath}\n\n` +
        `## Constraints\n` +
        `- READ-ONLY: Do NOT edit any files except the plan file (${planFilePath}).\n` +
        `- Do NOT run write commands on non-plan files.\n` +
        `- All plan content goes to the plan file only.\n\n` +
        `## Phase B: Brainstorming\n` +
        `1. **Quick Overview**: ls project root, read README, package.json — build context (< 30s).\n` +
        `2. **Explore before asking**: grep/read code first. Only ask user for preferences.\n` +
        `3. **Progressive questioning**: Ask 2-3 questions at a time. Use ask_user tool if available.\n` +
        `4. **Propose 2-3 approaches** with trade-offs + recommendation.\n` +
        `5. **Assumption audit**: Grep-verify interfaces/types exist. Mark [UNVERIFIED] what can't be verified.\n\n` +
        `## Phase C: Writing\n` +
        `1. Call plan tool (list-template) to show available templates.\n` +
        `2. After user selects template, call plan tool (select-template).\n` +
        `3. Write chapters in template order — do NOT skip unwritten chapters.\n` +
        `4. Write all chapters in one turn, then ask user to review.\n\n` +
        `## Phase D: Completion\n` +
        `1. Ask user to review the complete plan.\n` +
        `2. Call plan tool (complete) with isolation method (compact/tree/direct).\n` +
        `3. After plan complete: check subagent capability → suggest goal + wave or single-agent execution.`,
      );
    },
  });
}
```

- [x] **Step 2: Update index.ts**

```typescript
// extensions/plan/src/index.ts
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type PlanSessionMap, type PlanState, DEFAULT_PLAN_STATE, reconstructPlanState } from "./state.js";
import { registerPlanTool } from "./tool.js";
import { registerPlanCommand } from "./command.js";
import { updatePlanWidget } from "./widget.js";

export default function planExtension(pi: ExtensionAPI) {
  // Per-session state cache — keyed by sessionId
  const sessions: PlanSessionMap = new Map();

  // Register tool and command with session map (BG1)
  registerPlanTool(pi, sessions);
  registerPlanCommand(pi, sessions);

  // Dynamic import compact handlers (BG2) — avoids cross-group static import
  import("./compact.js").then(({ registerPlanEventHandlers }) => {
    registerPlanEventHandlers(pi, sessions);
  }).catch(() => { /* compact is optional at load time */ });

  // Register tool and command with session map
  registerPlanTool(pi, sessions);
  registerPlanCommand(pi, sessions);
  registerPlanEventHandlers(pi, sessions);

  // Reconstruct state on session start
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionId ?? "default";
    const state = reconstructPlanState(ctx);
    sessions.set(sessionId, state);
    updatePlanWidget(ctx, state);
  });

  // Clean up on session end
  pi.on("session_end", async (_event: unknown, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionId ?? "default";
    sessions.delete(sessionId);
  });
}
```

- [x] **Step 3: Commit**

```bash
git add extensions/plan/src/command.ts extensions/plan/src/index.ts
git commit -m "feat(plan): add /plan command with abort/status/reentry and session isolation"
```

### Task 5: 模板系统 + TUI Widget

**Type:** backend

**Files:**
- Create: `extensions/plan/src/templates.ts`
- Create: `extensions/plan/src/widget.ts`
- Create: `extensions/plan/templates/feature-plan.md`
- Create: `extensions/plan/templates/bugfix-plan.md`
- Create: `extensions/plan/templates/refactor-plan.md`
- Create: `extensions/plan/templates/research-plan.md`
- Create: `extensions/plan/templates/implementation-plan.md`
- Test: `extensions/plan/src/__tests__/templates.test.ts`

- [x] **Step 1: Write the failing test**

```typescript
// extensions/plan/src/__tests__/templates.test.ts
import { describe, it, expect } from "vitest";
import { listTemplates, loadTemplate, getBuiltinTemplateDir } from "../templates.js";
import * as fs from "node:fs";

describe("Template system", () => {
  it("listTemplates returns builtin templates", () => {
    const templates = listTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(5);
    const names = templates.map((t) => t.name);
    expect(names).toContain("feature-plan");
    expect(names).toContain("bugfix-plan");
    expect(names).toContain("refactor-plan");
    expect(names).toContain("research-plan");
    expect(names).toContain("implementation-plan");
  });

  it("loadTemplate returns content for existing builtin template", () => {
    const content = loadTemplate("feature-plan");
    expect(content).not.toBeNull();
    expect(content).toContain("## ");
  });

  it("loadTemplate returns null for non-existent template", () => {
    const content = loadTemplate("non-existent-template");
    expect(content).toBeNull();
  });

  it("getBuiltinTemplateDir returns valid path", () => {
    const dir = getBuiltinTemplateDir();
    expect(fs.existsSync(dir)).toBe(true);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run extensions/plan/src/__tests__/templates.test.ts`
Expected: FAIL with "Cannot find module '../templates.js'"

- [x] **Step 3: Write minimal implementation**

```typescript
// extensions/plan/src/templates.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TemplateInfo {
  name: string;
  source: "builtin" | "global" | "project";
  path: string;
}

export function getBuiltinTemplateDir(): string {
  return path.resolve(__dirname, "..", "templates");
}

export function listTemplates(projectDir?: string): TemplateInfo[] {
  const templates: TemplateInfo[] = [];
  const seen = new Set<string>();

  // 1. Project-level templates (highest priority)
  if (projectDir) {
    const projectTemplateDir = path.join(projectDir, ".pi", "plan-templates");
    if (fs.existsSync(projectTemplateDir)) {
      for (const file of fs.readdirSync(projectTemplateDir)) {
        if (file.endsWith(".md")) {
          const name = file.replace(/\.md$/, "");
          templates.push({ name, source: "project", path: path.join(projectTemplateDir, file) });
          seen.add(name);
        }
      }
    }
  }

  // 2. Global templates
  const globalTemplateDir = path.join(process.env.HOME || "", ".pi", "agent", "plan-templates");
  if (fs.existsSync(globalTemplateDir)) {
    for (const file of fs.readdirSync(globalTemplateDir)) {
      if (file.endsWith(".md")) {
        const name = file.replace(/\.md$/, "");
        if (!seen.has(name)) {
          templates.push({ name, source: "global", path: path.join(globalTemplateDir, file) });
          seen.add(name);
        }
      }
    }
  }

  // 3. Builtin templates (lowest priority)
  const builtinDir = getBuiltinTemplateDir();
  if (fs.existsSync(builtinDir)) {
    for (const file of fs.readdirSync(builtinDir)) {
      if (file.endsWith(".md")) {
        const name = file.replace(/\.md$/, "");
        if (!seen.has(name)) {
          templates.push({ name, source: "builtin", path: path.join(builtinDir, file) });
        }
      }
    }
  }

  return templates;
}

export function loadTemplate(name: string, projectDir?: string): string | null {
  const templates = listTemplates(projectDir);
  const template = templates.find((t) => t.name === name);
  if (!template) return null;

  try {
    return fs.readFileSync(template.path, "utf-8");
  } catch {
    return null;
  }
}
```

```typescript
// extensions/plan/src/widget.ts
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { PlanState } from "./state.js";

export function updatePlanWidget(ctx: ExtensionContext, state: PlanState): void {
  if (!state.isActive) {
    ctx.ui.setWidget("plan-mode", undefined);
    ctx.ui.setStatus("plan-mode", undefined);
    return;
  }

  const th = ctx.ui.theme;
  ctx.ui.setWidget("plan-mode", [th.fg("accent", "[Plan Mode]")]);
  ctx.ui.setStatus("plan-mode", th.fg("accent", "Plan Mode"));
}
```

```markdown
<!-- extensions/plan/templates/feature-plan.md -->
---
template: feature-plan
created: ""
status: draft
---

# Feature Plan: [Feature Name]

## Overview
<!-- 简述功能目标和价值 -->

## Requirements
<!-- 用户需求、业务需求 -->

## Design Decisions
<!-- 技术选型、架构决策 -->

## Implementation Steps
<!-- 分步骤的实现计划 -->

## Testing Strategy
<!-- 测试策略 -->

## Risks & Mitigations
<!-- 风险和缓解措施 -->
```

其他 4 个模板章节结构如下（与 plan-mode-design.md §4.1 一致）：

```markdown
<!-- extensions/plan/templates/bugfix-plan.md -->
---
template: bugfix-plan
created: ""
status: draft
---

# Bugfix Plan: [Bug Name]

## 现象
<!-- Bug 的具体表现 -->

## 根因分析
<!-- 通过代码探索和日志分析得出的根因 -->

## 修复策略
<!-- 修复方案和替代方案 -->

## 受影响文件
<!-- 需要修改的文件列表 -->

## 回归测试
<!-- 如何验证修复不会引入新问题 -->
```

```markdown
<!-- extensions/plan/templates/refactor-plan.md -->
---
template: refactor-plan
created: ""
status: draft
---

# Refactor Plan: [Refactor Name]

## 现状
<!-- 当前代码的问题 -->

## 目标结构
<!-- 重构后的目标架构 -->

## 分步骤计划
<!-- 重构的分步执行计划 -->

## 风险与缓解
<!-- 重构风险和缓解措施 -->

## 验证
<!-- 如何验证重构正确性 -->
```

```markdown
<!-- extensions/plan/templates/research-plan.md -->
---
template: research-plan
created: ""
status: draft
---

# Research Plan: [Topic]

## 问题
<!-- 需要调研的问题 -->

## 候选方案
<!-- 候选方案列表 -->

## 对比分析
<!-- 方案的优劣对比 -->

## 推荐
<!-- 推荐方案和理由 -->

## 后续步骤
<!-- 调研结论后的下一步 -->
```

```markdown
<!-- extensions/plan/templates/implementation-plan.md -->
---
template: implementation-plan
created: ""
status: draft
---

# Implementation Plan: [Feature Name]

## Spec 摘要
<!-- 对应 spec 的关键要求 -->

## 任务分解
<!-- 分解为可执行的任务 -->

## 实现顺序
<!-- 任务的依赖关系和执行顺序 -->

## 验证
<!-- 如何验证实现正确性 -->
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run extensions/plan/src/__tests__/templates.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add extensions/plan/src/templates.ts extensions/plan/src/widget.ts extensions/plan/templates/ extensions/plan/src/__tests__/templates.test.ts
git commit -m "feat(plan): add template system with 5 builtin templates and TUI widget"
```

### Task 6: Compact Handler + Goal API

**Type:** backend

**Files:**
- Create: `extensions/plan/src/compact.ts`

- [x] **Step 1: Implement compact handler**

```typescript
// extensions/plan/src/compact.ts
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { PlanSessionMap } from "./state.js";
import { getPlanState, persistPlanState } from "./state.js";

type GoalInitFn = (objective: string, tasks: string[], budget?: { tokenBudget?: number; timeBudgetMinutes?: number; maxTurns?: number }) => boolean;

export function registerPlanEventHandlers(
  pi: ExtensionAPI,
  sessions: PlanSessionMap,
): void {
  // session_before_compact: customize compaction summary
  pi.on("session_before_compact", async (event: unknown, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionId ?? "default";
    const state = getPlanState(sessions, sessionId, ctx);
    if (!state.isActive || state.phase !== "complete") return {};

    const prep = (event as { preparation?: { firstKeptEntryId?: string; tokensBefore?: number } })?.preparation;
    return {
      compaction: {
        summary:
          `Plan mode completed. Plan file: ${state.planFilePath}\n\n` +
          `Next step: Read the plan file and execute the implementation.\n` +
          `Use /goal or start implementing directly.`,
        firstKeptEntryId: prep?.firstKeptEntryId,
        tokensBefore: prep?.tokensBefore,
      },
    };
  });

  // session_before_tree: customize tree summary
  pi.on("session_before_tree", async (_event: unknown, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionId ?? "default";
    const state = getPlanState(sessions, sessionId, ctx);
    if (!state.isActive || state.phase !== "complete") return {};

    return {
      summary:
        `Plan mode completed. Plan file: ${state.planFilePath}\n\n` +
        `Next step: Read the plan file and execute the implementation.`,
    };
  });
}

export function handlePlanComplete(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PlanState,
  isolation: string,
): void {
  const steerMessage =
    `Plan complete. Plan file: ${state.planFilePath}\n\n` +
    `Read the plan file and start implementing.\n` +
    `Check for subagent capability and suggest goal + wave execution if available.`;

  switch (isolation) {
    case "compact": {
      // SDK compact() 用 IIFE 包裹 try/catch，错误只走 onError，不会向外抛出
      ctx.compact({
        customInstructions: `Plan file: ${state.planFilePath}. Read and execute.`,
        onComplete: () => {
          pi.sendUserMessage(steerMessage, { deliverAs: "steer" });
        },
        onError: (_error: Error) => {
          // Fallback to direct continue
          ctx.ui.notify("Compact failed, continuing without isolation.", "warning");
          pi.sendUserMessage(steerMessage, { deliverAs: "steer" });
        },
      });
      break;
    }

    case "tree": {
      // Tree case: only notify, don't inject steer (user manually navigates)
      ctx.ui.notify("Use /tree to manually navigate back. Plan file: " + state.planFilePath, "info");
      break;
    }

    case "direct":
    default: {
      pi.sendUserMessage(steerMessage, { deliverAs: "steer" });
      break;
    }
  }

  // Try to initialize goal (skip for tree — user manually controls when to start goal)
  if (isolation !== "tree") {
    try {
      const goalInit = (pi as unknown as Record<string, unknown>).__goalInit as GoalInitFn | undefined;
      if (goalInit) {
        goalInit(
          `Execute plan: ${state.planFilePath}`,
          ["Read plan file", "Execute implementation steps"],
        );
      }
    } catch (e) { ctx.ui.notify(`Goal init failed: ${e}`, "warning"); }
  }
}
```

- [x] **Step 2: Commit**

```bash
git add extensions/plan/src/compact.ts
git commit -m "feat(plan): add compact handler with proper error signature and tree case fix"
```

---

## E2E Test Plan Summary

见 `e2e-test-plan.md`。

## Test Cases Template Summary

见 `test_cases_template.json`。
