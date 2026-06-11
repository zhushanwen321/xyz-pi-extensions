---
verdict: pass
complexity: L1
---

# Pi Plan Mode Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个轻量级 Plan Mode 扩展，融合 brainstorming + writing-plans 能力，通过 `/plan` 命令触发，产出临时 plan 文件，退出后可衔接 goal 工具执行。

**Architecture:** 新建 `extensions/plan/` 包（`@zhushanwen/pi-plan`），包含 plan tool（5 个 action）、`/plan` command、SKILL.md 提示词、模板系统。状态存储在 `ctx.sessionManager`，上下文隔离通过 `ctx.compact()` 实现，Goal API 通过 `pi.__goalInit` 调用。

**Tech Stack:** TypeScript, Pi Extension API, typebox, pi-tui (Text)

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `extensions/plan/package.json` | create | BG1 | 包配置 |
| `extensions/plan/index.ts` | create | BG1 | 顶层 re-export |
| `extensions/plan/tsconfig.json` | create | BG1 | TypeScript 配置 |
| `extensions/plan/src/index.ts` | create | BG1 | Extension 入口（工厂函数 + 注册） |
| `extensions/plan/src/state.ts` | create | BG1 | 状态类型定义 + 持久化逻辑 |
| `extensions/plan/src/tool.ts` | create | BG1 | plan tool 注册 + 5 个 action handler |
| `extensions/plan/src/command.ts` | create | BG1 | `/plan` command 注册 |
| `extensions/plan/src/templates.ts` | create | BG2 | 模板发现 + 加载逻辑 |
| `extensions/plan/src/compact.ts` | create | BG2 | compact/tree handler + steer 注入 |
| `extensions/plan/src/widget.ts` | create | BG3 | TUI 状态栏渲染 |
| `extensions/plan/skills/plan-mode/SKILL.md` | create | BG3 | Plan mode 系统提示词 |
| `extensions/plan/templates/*.md` | create | BG2 | 5 个内置模板文件 |
| `extensions/plan/src/__tests__/state.test.ts` | create | BG1 | 状态管理测试 |
| `extensions/plan/src/__tests__/templates.test.ts` | create | BG2 | 模板系统测试 |
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
| (pi: ExtensionAPI, ctx: ExtensionContext, action: string, params: unknown) → ToolResult | ToolResult | 未知 action → throw Error |

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
| AC-1 | executePlanTool(action="start") | /plan command → executePlanTool | Task 2, 5 |
| AC-2 | — | SKILL.md 提示词约束 | Task 8 |
| AC-3 | — | SKILL.md 提示词约束 | Task 8 |
| AC-4 | — | SKILL.md 提示词约束 | Task 8 |
| AC-5 | loadTemplate() | templates → write | Task 6 |
| AC-6 | executePlanTool(action="abort") | /plan abort → executePlanTool | Task 5 |
| AC-7 | handlePlanComplete(isolation="compact") | complete → compact → steer | Task 7 |
| AC-8 | handlePlanComplete(isolation="direct") | complete → steer (降级) | Task 7 |
| AC-9 | pi.__goalInit() | complete → goal init | Task 7 |
| AC-10 | listTemplates() | 模板发现逻辑 | Task 6 |
| AC-11 | persistPlanState/reconstructPlanState | sessionManager per-session | Task 3 |

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 进入 plan mode | adopted | Task 2, 5 |
| AC-2 先探索再提问 | adopted | Task 8 (SKILL.md) |
| AC-3 提出 2-3 方案 | adopted | Task 8 (SKILL.md) |
| AC-4 按章节顺序填写 | adopted | Task 8 (SKILL.md) |
| AC-5 Plan 文件格式正确 | adopted | Task 6 |
| AC-6 abort 可取消 | adopted | Task 5 |
| AC-7 compact 成功时读取 plan | adopted | Task 7 |
| AC-8 compact 失败时降级 | adopted | Task 7 |
| AC-9 Goal API 启动 | adopted | Task 7 |
| AC-10 自定义模板发现 | adopted | Task 6 |
| AC-11 多 session 隔离 | adopted | Task 3 |

---

## Execution Groups

#### BG1: 核心状态管理

**Description:** Plan state 类型定义、持久化/重建、plan tool 注册、/plan command 注册。这是整个扩展的基础。

**Tasks:** Task 1, Task 2, Task 3

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

**Dependencies:** 无

#### BG2: 模板系统 + Compact Handler

**Description:** 模板发现/加载逻辑、5 个内置模板文件、compact/tree handler、steer 注入。依赖 BG1 的 state 类型。

**Tasks:** Task 4, Task 6, Task 7

**Files (预估):** 9 个文件（9 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | taskComplexity: medium |
| 注入上下文 | Task 描述 + spec FR-4, FR-5 + coding-workflow compact 参考 |
| 读取文件 | extensions/coding-workflow/lib/tool-handlers.ts (compact 逻辑) |
| 修改/创建文件 | extensions/plan/src/templates.ts, extensions/plan/src/compact.ts, extensions/plan/templates/* |

**Execution Flow (BG2 内部):** 串行派遣

  Task 4:
    1. general-purpose → 写失败测试
    2. general-purpose → 写实现代码
    3. general-purpose → spec 合规检查

  Task 6 (depends on Task 4):
    1. general-purpose → 写失败测试
    2. general-purpose → 写实现代码
    3. general-purpose → spec 合规检查

  Task 7 (depends on Task 6):
    1. general-purpose → 写失败测试
    2. general-purpose → 写实现代码
    3. general-purpose → spec 合规检查

**Dependencies:** BG1 (state 类型)

#### BG3: TUI + SKILL.md

**Description:** TUI 状态栏渲染、SKILL.md 提示词（brainstorming + writing 流程融合）。依赖 BG1 和 BG2 的功能。

**Tasks:** Task 5, Task 8

**Files (预估):** 2 个文件（2 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | taskComplexity: medium |
| 注入上下文 | Task 描述 + spec FR-10 + coding-workflow widget 参考 |
| 读取文件 | extensions/coding-workflow/index.ts (widget 部分) |
| 修改/创建文件 | extensions/plan/src/widget.ts, extensions/plan/skills/plan-mode/SKILL.md |

**Execution Flow (BG3 内部):** 串行派遣

  Task 5:
    1. general-purpose → 写实现代码
    2. general-purpose → spec 合规检查

  Task 8:
    1. general-purpose → 写 SKILL.md
    2. general-purpose → spec 合规检查

**Dependencies:** BG1, BG2

---

## Dependency Graph & Wave Schedule

```
BG1 (核心状态) ──→ BG2 (模板+Compact) ──→ BG3 (TUI+SKILL)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | 核心状态管理，无依赖 |
| Wave 2 | BG2 | 模板系统 + compact handler，依赖 BG1 state 类型 |
| Wave 3 | BG3 | TUI + SKILL.md，依赖 BG1 和 BG2 |

---

## Tasks

### Task 1: 包结构 + State 类型定义

**Type:** backend

**Files:**
- Create: `extensions/plan/package.json`
- Create: `extensions/plan/index.ts`
- Create: `extensions/plan/tsconfig.json`
- Create: `extensions/plan/src/index.ts`
- Create: `extensions/plan/src/state.ts`
- Test: `extensions/plan/src/__tests__/state.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// extensions/plan/src/__tests__/state.test.ts
import { describe, it, expect } from "vitest";
import { DEFAULT_PLAN_STATE, type PlanState, type PlanPhase } from "../state.js";

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run extensions/plan/src/__tests__/state.test.ts`
Expected: FAIL with "Cannot find module '../state.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// extensions/plan/src/state.ts
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
```

```json
// extensions/plan/package.json
{
  "name": "@zhushanwen/pi-plan",
  "version": "0.1.0",
  "description": "Lightweight plan mode for Pi coding agent",
  "type": "module",
  "main": "index.ts",
  "pi": {
    "extensions": ["./index.ts"],
    "skills": ["./skills"]
  },
  "keywords": ["pi-package"],
  "files": ["index.ts", "src/", "skills/", "templates/"]
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
  // Registration will be added in Task 2
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run extensions/plan/src/__tests__/state.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add extensions/plan/
git commit -m "feat(plan): add package structure and state types"
```

### Task 2: Plan Tool 注册

**Type:** backend

**Files:**
- Create: `extensions/plan/src/tool.ts`
- Modify: `extensions/plan/src/index.ts`
- Test: `extensions/plan/src/__tests__/tool.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// extensions/plan/src/__tests__/tool.test.ts
import { describe, it, expect, vi } from "vitest";
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

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run extensions/plan/src/__tests__/tool.test.ts`
Expected: FAIL with "Cannot find module '../tool.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// extensions/plan/src/tool.ts
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { PlanState } from "./state.js";

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
  state: PlanState,
  persistState: (pi: ExtensionAPI, state: PlanState) => void,
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
    }),
    promptSnippet: "Use plan tool for plan mode operations",
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (partial: { content: Array<{ type: string; text: string }> }) => void,
      ctx: ExtensionContext,
    ) {
      const action = params.action as string;
      if (!validateAction(action)) {
        throw new Error(`Unknown plan action: ${action}. Valid actions: ${PLAN_ACTIONS.join(", ")}`);
      }

      // Action handlers will be added in subsequent tasks
      return {
        content: [{ type: "text" as const, text: `Plan action: ${action}` }],
        details: { action },
      };
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run extensions/plan/src/__tests__/tool.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add extensions/plan/src/tool.ts extensions/plan/src/index.ts extensions/plan/src/__tests__/tool.test.ts
git commit -m "feat(plan): add plan tool registration with action validation"
```

### Task 3: State 持久化与重建

**Type:** backend

**Files:**
- Modify: `extensions/plan/src/state.ts`
- Modify: `extensions/plan/src/index.ts`
- Test: `extensions/plan/src/__tests__/state.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// extensions/plan/src/__tests__/state.test.ts (add to existing)
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

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run extensions/plan/src/__tests__/state.test.ts`
Expected: FAIL with "persistPlanState is not a function"

- [ ] **Step 3: Write minimal implementation**

```typescript
// extensions/plan/src/state.ts (add to existing)
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run extensions/plan/src/__tests__/state.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add extensions/plan/src/state.ts extensions/plan/src/__tests__/state.test.ts
git commit -m "feat(plan): add state persistence and reconstruction"
```

### Task 4: 模板系统

**Type:** backend

**Files:**
- Create: `extensions/plan/src/templates.ts`
- Create: `extensions/plan/templates/feature-plan.md`
- Create: `extensions/plan/templates/bugfix-plan.md`
- Create: `extensions/plan/templates/refactor-plan.md`
- Create: `extensions/plan/templates/research-plan.md`
- Create: `extensions/plan/templates/implementation-plan.md`
- Test: `extensions/plan/src/__tests__/templates.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// extensions/plan/src/__tests__/templates.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { listTemplates, loadTemplate, getBuiltinTemplateDir } from "../templates.js";
import * as fs from "node:fs";
import * as path from "node:path";

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

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run extensions/plan/src/__tests__/templates.test.ts`
Expected: FAIL with "Cannot find module '../templates.js'"

- [ ] **Step 3: Write minimal implementation**

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

（其他 4 个模板类似，各有不同的章节结构）

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run extensions/plan/src/__tests__/templates.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add extensions/plan/src/templates.ts extensions/plan/templates/ extensions/plan/src/__tests__/templates.test.ts
git commit -m "feat(plan): add template system with 5 builtin templates"
```

### Task 5: /plan Command 注册

**Type:** backend

**Files:**
- Create: `extensions/plan/src/command.ts`
- Modify: `extensions/plan/src/index.ts`

- [ ] **Step 1: Write the implementation**

```typescript
// extensions/plan/src/command.ts
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { PlanState } from "./state.js";
import { persistPlanState } from "./state.js";
import * as path from "node:path";
import * as os from "node:os";

export function registerPlanCommand(
  pi: ExtensionAPI,
  state: PlanState,
  updateWidget: (ctx: ExtensionContext, state: PlanState) => void,
): void {
  pi.registerCommand("plan", {
    description:
      "Enter plan mode: /plan [description]. " +
      "With no args, show status or detect existing plan.",
    handler: async (args: string, ctx: ExtensionContext) => {
      const trimmed = args.trim();

      // If already in plan mode, show status
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

      // Enter plan mode
      const slug = trimmed
        ? trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30)
        : "untitled";

      const planFilePath = path.join(os.tmpdir(), `plan-${slug}.md`);

      state.isActive = true;
      state.phase = "brainstorming";
      state.planFilePath = planFilePath;
      state.requirement = trimmed;
      state.templateName = "";

      persistPlanState(pi, state);
      updateWidget(ctx, state);

      // Inject skill context
      pi.sendUserMessage(
        `[PLAN MODE] Entered plan mode.\n\n` +
        `Requirement: ${trimmed || "(from conversation context)"}\n` +
        `Plan file: ${planFilePath}\n\n` +
        `Follow the plan-mode skill instructions to begin brainstorming.`,
      );
    },
  });
}
```

- [ ] **Step 2: Update index.ts to register command**

```typescript
// extensions/plan/src/index.ts
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DEFAULT_PLAN_STATE, type PlanState, persistPlanState, reconstructPlanState } from "./state.js";
import { registerPlanTool } from "./tool.js";
import { registerPlanCommand } from "./command.js";

export default function planExtension(pi: ExtensionAPI) {
  const state: PlanState = { ...DEFAULT_PLAN_STATE };

  function updateWidget(ctx: ExtensionContext, state: PlanState): void {
    // Will be implemented in Task 8
  }

  // Register tool and command
  registerPlanTool(pi, state, persistPlanState);
  registerPlanCommand(pi, state, updateWidget);

  // Reconstruct state on session start
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    const reconstructed = reconstructPlanState(ctx);
    Object.assign(state, reconstructed);
    updateWidget(ctx, state);
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add extensions/plan/src/command.ts extensions/plan/src/index.ts
git commit -m "feat(plan): add /plan command with state management"
```

### Task 6: Plan Tool Action Handlers

**Type:** backend

**Files:**
- Modify: `extensions/plan/src/tool.ts`
- Modify: `extensions/plan/src/index.ts`

- [ ] **Step 1: Implement action handlers**

```typescript
// extensions/plan/src/tool.ts (update execute function)
async execute(
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  onUpdate: (partial: { content: Array<{ type: string; text: string }> }) => void,
  ctx: ExtensionContext,
) {
  const action = params.action as string;
  if (!validateAction(action)) {
    throw new Error(`Unknown plan action: ${action}. Valid actions: ${PLAN_ACTIONS.join(", ")}`);
  }

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
      persistState(pi, state);
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
      // Create in project-level directory
      const projectDir = process.cwd();
      const templateDir = path.join(projectDir, ".pi", "plan-templates");
      fs.mkdirSync(templateDir, { recursive: true });
      fs.writeFileSync(path.join(templateDir, `${templateName}.md`), templateContent);
      return {
        content: [{ type: "text" as const, text: `Template created: ${templateName}` }],
        details: { action, templateName },
      };
    }

    case "complete": {
      state.phase = "complete";
      persistState(pi, state);
      return {
        content: [{ type: "text" as const, text: "Plan complete. Switching to implementation..." }],
        details: { action, planFilePath: state.planFilePath },
      };
    }

    case "abort": {
      state.isActive = false;
      state.phase = "idle";
      state.planFilePath = "";
      state.requirement = "";
      state.templateName = "";
      persistState(pi, state);
      updateWidget(ctx, state);
      return {
        content: [{ type: "text" as const, text: "Plan mode aborted." }],
        details: { action },
      };
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add extensions/plan/src/tool.ts
git commit -m "feat(plan): implement all plan tool action handlers"
```

### Task 7: Compact Handler + Goal API

**Type:** backend

**Files:**
- Create: `extensions/plan/src/compact.ts`
- Modify: `extensions/plan/src/index.ts`

- [ ] **Step 1: Implement compact handler**

```typescript
// extensions/plan/src/compact.ts
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { PlanState } from "./state.js";

type GoalInitFn = (objective: string, tasks: string[], budget?: Record<string, unknown>) => boolean;

export function registerPlanEventHandlers(
  pi: ExtensionAPI,
  state: PlanState,
): void {
  // session_before_compact: customize compaction summary
  pi.on("session_before_compact", async (_event: unknown, _ctx: ExtensionContext) => {
    if (!state.isActive || state.phase !== "complete") return {};

    return {
      compaction: {
        summary:
          `Plan mode completed. Plan file: ${state.planFilePath}\n\n` +
          `Next step: Read the plan file and execute the implementation.\n` +
          `Use /goal or start implementing directly.`,
      },
    };
  });

  // session_before_tree: customize tree summary
  pi.on("session_before_tree", async (_event: unknown, _ctx: ExtensionContext) => {
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
      try {
        ctx.compact({
          customInstructions: `Plan file: ${state.planFilePath}. Read and execute.`,
          onComplete: () => {
            pi.sendUserMessage(steerMessage, { deliverAs: "steer" });
          },
          onError: () => {
            // Fallback to direct continue
            ctx.ui.notify("Compact failed, continuing without isolation.", "warning");
            pi.sendUserMessage(steerMessage, { deliverAs: "steer" });
          },
        });
      } catch {
        ctx.ui.notify("Compact failed, continuing without isolation.", "warning");
        pi.sendUserMessage(steerMessage, { deliverAs: "steer" });
      }
      break;
    }

    case "tree": {
      ctx.ui.notify("Use /tree to manually navigate back.", "info");
      pi.sendUserMessage(steerMessage, { deliverAs: "steer" });
      break;
    }

    case "direct":
    default: {
      pi.sendUserMessage(steerMessage, { deliverAs: "steer" });
      break;
    }
  }

  // Try to initialize goal
  try {
    const goalInit = (pi as unknown as Record<string, unknown>).__goalInit as GoalInitFn | undefined;
    if (goalInit) {
      goalInit(
        `Execute plan: ${state.planFilePath}`,
        ["Read plan file", "Execute implementation steps"],
      );
    }
  } catch { /* goal init failure is non-blocking */ }
}
```

- [ ] **Step 2: Update index.ts to register handlers**

```typescript
// extensions/plan/src/index.ts (add imports and registration)
import { registerPlanEventHandlers, handlePlanComplete } from "./compact.js";

// In the factory function:
registerPlanEventHandlers(pi, state);
```

- [ ] **Step 3: Commit**

```bash
git add extensions/plan/src/compact.ts extensions/plan/src/index.ts
git commit -m "feat(plan): add compact handler and goal API integration"
```

### Task 8: TUI Widget + SKILL.md

**Type:** backend

**Files:**
- Create: `extensions/plan/src/widget.ts`
- Create: `extensions/plan/skills/plan-mode/SKILL.md`

- [ ] **Step 1: Implement widget**

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

- [ ] **Step 2: Create SKILL.md**

```markdown
---
name: plan-mode
description: "Plan mode system prompt for brainstorming and writing implementation plans."
---

# Plan Mode

You are in **Plan Mode**. Follow these instructions strictly.

## Constraints

- **READ-ONLY**: Do NOT edit any files except the plan file. Do NOT run write commands.
- **Plan file only**: All writing goes to the plan file at `{planFilePath}`.

## Phase B: Brainstorming

### B1: Quick Overview
- `ls` project root, read README, package.json
- Build basic context (< 30 seconds)

### B2: Progressive Questioning
- Ask 2-3 questions at a time
- Explore code first (grep/read) before asking user
- Distinguish: explorable (code can answer) vs user-preference (ask user)

### B3: Propose Approaches
- Propose 2-3 approaches with trade-offs
- Give recommendation with reasoning

### B4: Assumption Audit
- Extract assumptions from design
- Grep-verify interfaces/types exist
- Mark unverified assumptions as `[UNVERIFIED]`

## Phase C: Writing

### Template Selection
1. Call `plan` tool (list-template) to show available templates
2. User selects template
3. Call `plan` tool (select-template) to load

### Chapter Writing
- Write chapters in order (follow template section sequence)
- Do NOT skip unwritten chapters
- Can go back to edit previous chapters
- Write all chapters in one turn, then ask user to review

### Completion
- User confirms plan is good
- Call `plan` tool (complete) to exit plan mode
- Choose context isolation method when prompted
```

- [ ] **Step 3: Commit**

```bash
git add extensions/plan/src/widget.ts extensions/plan/skills/plan-mode/SKILL.md
git commit -m "feat(plan): add TUI widget and SKILL.md system prompt"
```

---

## E2E Test Plan Summary

见 `e2e-test-plan.md`。

## Test Cases Template Summary

见 `test_cases_template.json`。
