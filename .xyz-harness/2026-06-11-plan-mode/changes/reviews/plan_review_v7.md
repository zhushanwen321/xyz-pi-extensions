---
verdict: fail
must_fix: 2
complexity: L1
---

# Plan Review v7 (Independent Round) — Pi Plan Mode Extension

## 评审记录

- **评审时间：** 2026-06-11 16:50
- **评审类型：** Plan 评审（Mode 1: 验证 plan 可实施性）
- **评审对象：** `.xyz-harness/2026-06-11-plan-mode/plan.md` 及关联 `e2e-test-plan.md` / `test_cases_template.json` / `use-cases.md` / `non-functional-design.md`
- **交叉对照：** `spec.md`、`plan-mode-design.md`、`extensions/goal/src/index.ts:390-422`（`__goalInit` 实际签名）、`extensions/coding-workflow/lib/tool-handlers.ts`（`__goalInit` 调用模式 + compact IIFE 错误处理）、`extensions/context-engineering/vitest.config.ts`（vitest 配置模板）、`extensions/todo/package.json`（test script 完整字段）、根目录 `extension-dependencies.json` + `extension-dependencies.schema.json`、根目录 `CLAUDE.md` 测试规范、根目录 `.githooks/pre-commit` vitest 步骤
- **前序 review 文件：** `plan_review_v1.md`（fail, 1 MUST FIX = BG1→BG2 跨组依赖违反）、`plan_review_v2.md`（fail, 1 MUST FIX = vitest.config.ts 缺失）、`plan_review_v3.md`（fail, 2 MUST FIX = tool.ts 签名 + silent catch）、`plan_review_v4.md`（PASS, 14 issues 修复）、`plan_review_v5.md`（PASS, 2 issues 修复）、`plan_review_v6.md`（PASS, M1 vitest.config.ts 修复）
- **本评审模式：** 独立 v7 轮次，重新阅读当前 5 份 deliverable + 跨组依赖与测试规范符合性，独立判断

## 总体评估

**当前 plan.md 整体设计质量高**：8 个 Task（含 Task 0 项目同步）、3 个 Execution Group（BG0/BG1/BG2）、Spec Coverage Matrix 11/11 覆盖、Interface Contracts 完整、TDD 步骤清晰（除 Task 4/6/7）、per-session 隔离用 `PlanSessionMap = Map<string, PlanState>` 满足 AC-11、`/plan abort` / `/plan status` 子命令 + 重入 4 选项 + `session_before_compact` / `session_before_tree` handler + `__goalInit` API + `create-template` 路径遍历防护 + SKILL.md 含 ask_user / subagent 检测——架构设计完整。

**但 v1 标记的 1 项 MUST FIX（M1 BG1→BG2 跨组 import 违反）依然存在于当前 plan.md**——tool.ts (BG1) 直接 `import` BG2 的 templates/compact/widget 三个模块，command.ts (BG1) 直接 `import` BG2 的 widget 模块，index.ts (BG1) 直接 `import` BG2 的 compact/widget 模块，共 **6 处跨组 import 违反**。这是 Wave 2 (BG1) subagent 创建文件后运行 `npx vitest run` 时会直接触发的 module resolution 失败（`ERR_MODULE_NOT_FOUND`），**是 pre-commit hook 阻断级别的硬伤**。

**v6 标记的 1 项 MUST FIX（M1 vitest.config.ts）部分修复**：vitest.config.ts 文件创建已加入 File Structure 和 Task 1 Files 列表，文件内容也已提供 ✅，但 **package.json 仍缺少 `scripts.test` 和 `devDependencies.vitest`**——违反项目 CLAUDE.md 测试规范 4 步清单第 1、3 项。这是 v3 原始 M1 的子项，v6 评审**未做完整回归**。

**v7 独立发现：2 项 MUST FIX + 3 项关键 SHOULD FIX + 13 项 LOW**。

## 前序 MUST FIX 回归验证

| 轮次 | 编号 | 描述 | 状态 | 证据 |
|------|------|------|------|------|
| v1 | M1 | BG1 跨组依赖违反（BG1 → BG2 import）| ❌ **未修复** | plan.md File Structure 表（行 30-32）显式将 tool.ts/command.ts/index.ts 归 BG1，templates.ts/compact.ts/widget.ts 归 BG2；但 Task 3 tool.ts（行 693-695）、Task 4 command.ts（行 850）、Task 4 index.ts（行 972-973）共 6 处直接 import BG2 模块。详见下文 M1 详述。|
| v3 | M15 | tool.ts execute 签名 unused 参数无 `_` 前缀 | ✅ **已修复** | plan.md Task 3 Step 3（行 717-722）：`_toolCallId` / `_signal` / `_onUpdate` — 三参数均带 `_` 前缀 |
| v3 | M16 | compact.ts goal init catch 块为空 | ✅ **已修复** | plan.md Task 6 Step 1（行 1286）：`} catch (e) { ctx.ui.notify(\`Goal init failed: ${e}\`, "warning"); }` |
| v6 | M1 | 缺少 `extensions/plan/vitest.config.ts` | ⚠️ **部分修复** | vitest.config.ts 文件已加入 File Structure（行 30）+ Task 1 Files（行 331）+ 给出具体内容（行 526-538）✅。但 **package.json 仍缺 `scripts.test` 和 `devDependencies.vitest`**（行 481-494）。详见下文 M2 详述。|

**结论：v3 的 2 项 MUST FIX 完整修复，v1 的 1 项 MUST FIX 仍未修复（4 个 review 轮次未识别此回归），v6 的 1 项 MUST FIX 部分修复（评审链未做完整子项回归）。**

## MUST FIX（2 项）

### M1: BG1→BG2 跨组 import 违反依然存在（v1 M1 仍未修复）

**位置：**
- `plan.md` File Structure 表（行 30-32）
- `plan.md` Task 3 Step 3 `tool.ts` import 段（行 693-695）
- `plan.md` Task 4 Step 1 `command.ts` import 段（行 850）
- `plan.md` Task 4 Step 2 `index.ts` import 段（行 972-973）
- `plan.md` Wave Schedule（行 260-264）

**严重度：** must_fix（Wave 2 subagent 创建 BG1 文件后，运行时 ESM 模块解析失败）

**问题：**

plan EXPLICITLY 分组如下（File Structure 表行 30-32）：

| File | Group |
|------|-------|
| `src/tool.ts` | **BG1** |
| `src/command.ts` | **BG1** |
| `src/index.ts` | **BG1** |
| `src/templates.ts` | **BG2** |
| `src/compact.ts` | **BG2** |
| `src/widget.ts` | **BG2** |

Wave 调度（行 260-264）规定 Wave 2 = BG1，Wave 3 = BG2，**BG1 → BG2 单向依赖**。

但当前代码有 **6 处** BG1 → BG2 的静态 import：

```typescript
// tool.ts (Task 3 Step 3, 行 693-695)
import { listTemplates, loadTemplate } from "./templates.js";   // ← BG2 (Task 5)
import { handlePlanComplete } from "./compact.js";               // ← BG2 (Task 6)
import { updatePlanWidget } from "./widget.js";                  // ← BG2 (Task 5)

// command.ts (Task 4 Step 1, 行 850)
import { updatePlanWidget } from "./widget.js";                  // ← BG2 (Task 5)

// index.ts (Task 4 Step 2, 行 972-973)
import { registerPlanEventHandlers } from "./compact.js";        // ← BG2 (Task 6)
import { updatePlanWidget } from "./widget.js";                  // ← BG2 (Task 5)
```

**为什么是 MUST FIX（v1 已识别、v4-v6 评审未做回归）：**

| 影响维度 | 详细说明 |
|---------|---------|
| **运行时崩溃** | Wave 2 (BG1) subagent 派遣时按 TDD 步骤跑 `npx vitest run extensions/plan/src/__tests__/tool.test.ts`，`tool.ts` 的 import 解析会触发 `ERR_MODULE_NOT_FOUND`（templates/compact/widget 还未被 BG2 subagent 创建）。`npx vitest run` 退出码非零 → pre-commit hook 阻断。|
| **subagent 隔离风险** | CLAUDE.md 明确"子任务间明确依赖关系：无依赖并行，有依赖串行"。BG1 subagent 拿不到 BG2 设计文档（按 plan 设计 BG2 由后续 Wave 处理），不知道 compact.ts 的 `handlePlanComplete` 实际签名、`updatePlanWidget` 的 widget 渲染规则——可能写出简化 stub，让 `tsc --noEmit` 通过（type stub 全 `any`），但运行时崩溃。|
| **TS 7006 错误风险** | type stub 的 `any` 会让 import 符号"看似有类型"，subagent 实现时若误用 stub 写简化版，commit 后跑真实 vitest 才暴露失败——回滚成本高。|
| **TSLint 阻断** | pre-commit hook 的 tsc + eslint 步骤会因 `Cannot find module './templates.js'` 而失败。|

**修复方案（推荐 v1 Option A，最小化变更）：**

| 步骤 | 改动 |
|------|------|
| 1 | 将 `templates.ts` 和 `widget.ts` 从 BG2 移到 BG1（File Structure 表 + Task 5 Files 列表）。理由：templates.ts 和 widget.ts 是纯函数/UI 组件，无 compact 那种副作用密集逻辑，适合与 state.ts 同组。|
| 2 | `tool.ts` 移除 `import { handlePlanComplete } from "./compact.js"`（行 694），改为在 `case "complete"` 分支内 **dynamic import**：`const { handlePlanComplete } = await import("./compact.js");` |
| 3 | `command.ts` 移除 `import { updatePlanWidget } from "./widget.js"`（行 850），改为 dynamic import 或重构成调用方注入函数。|
| 4 | `index.ts` 移除 `import { registerPlanEventHandlers } from "./compact.js"`（行 972），改为 dynamic import；`updatePlanWidget` 改为 dynamic import。|

或者采用 v1 Option B：在 BG1 增加 Task "stub 占位实现"，创建 `templates.ts`/`compact.ts`/`widget.ts` 的最小占位实现（只导出类型和空函数），BG2 再覆盖为完整实现。

或者采用 v1 Option C：所有 BG1→BG2 import 改为函数内 `await import()` 动态加载。

**为什么 v4-v6 评审漏判：**

- v1 review 最早发现 M1（2026-06-11 13:46）
- v2 review 做了 v1 的回归但被简化为 PASS（未具体验证 M1 是否真正修复）
- v3 review 焦点在 lint 阻断问题 M15/M16，未触及跨组依赖
- v4/v5/v6 review 是 PASS 摘要（仅 fix_summary，未单独执行跨组依赖检查）
- **整个评审链中只有 v1 触及了"BG1→BG2 跨组 import"维度，v2~v6 都没看 6 处 import 的目标模块属于哪个 BG**

### M2: package.json 仍缺 `scripts.test` 和 `devDependencies.vitest`（v6 M1 部分修复）

**位置：**
- `plan.md` Task 1 Step 3 `package.json` 内容（行 481-494）

**严重度：** must_fix（违反项目 CLAUDE.md 测试规范第 1、3 项；pre-commit hook 阻断）

**问题：**

v6 修复了 `vitest.config.ts` 文件的创建任务，但 `package.json` 仍未补全必要的 scripts 和 devDependencies：

```json
// plan.md 行 481-494 (Task 1 Step 3 package.json)
{
  "name": "@zhushanwen/pi-plan",
  "version": "0.1.0",
  "description": "Lightweight plan mode for Pi coding agent",
  "type": "module",
  "main": "src/index.ts",
  "pi": {
    "extensions": ["./index.ts"],
    "skills": ["./skills"]
  },
  "keywords": ["pi-package", "extension"],
  "license": "MIT",
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": ">=0.73.0"
  },
  "files": ["index.ts", "src/", "skills/", "templates/"]
  // ↑ 缺 "scripts": { "test": "vitest run", "typecheck": "npx tsc --noEmit" }
  // ↑ 缺 "devDependencies": { "vitest": "^4.1.8" }
}
```

**CLAUDE.md 测试规范 4 步清单：**

> 1. `pnpm --filter <pkg> add -D vitest`
> 2. **创建 `vitest.config.ts`（参考已有包的配置）**
> 3. `package.json` 添加 `"test": "vitest run"` script
> 4. 创建 `src/__tests__/` 目录和测试文件

**既有正确模式（extensions/todo/package.json 完整字段）：**

```json
{
  "name": "@zhushanwen/pi-todo",
  ...
  "devDependencies": {
    "vitest": "^4.1.8"
  },
  "peerDependencies": { ... },
  "scripts": {
    "typecheck": "npx tsc --noEmit",
    "test": "vitest run"
  }
}
```

**为什么会阻断：**

1. **`pnpm --filter @zhushanwen/pi-plan test` 失败**：没有 `scripts.test` → pnpm 报 "no script defined" → CI 失败
2. **测试依赖未声明**：`vitest` 不在 `devDependencies` → `pnpm install` 不安装 → 跑 `npx vitest run` 时 `npx` 临时下载可能与 monorepo 其他包的 vitest 版本不一致 → 行为不可预测
3. **`scripts.typecheck` 缺失**：dev 阶段 TypeScript 类型检查无法通过 `pnpm --filter @zhushanwen/pi-plan typecheck` 触发，只能手动 `npx tsc --noEmit`，增加 subagent 出错概率

**修复方向（3 处最小修改）：**

修改 `plan.md` Task 1 Step 3 的 `package.json` 代码块，添加：

```json
"scripts": {
  "typecheck": "npx tsc --noEmit",
  "test": "vitest run"
},
"devDependencies": {
  "vitest": "^4.1.8"
}
```

**为什么 v6 评审漏判：**

- v6 评审焦点是"vitest.config.ts 文件是否在 plan 中"，未对 package.json 三件套（vitest.config.ts + scripts.test + devDependencies.vitest）做完整回归
- v3 review 已识别"package.json 缺 scripts 和 devDependencies"，v6 修复了 vitest.config.ts 但**未把 package.json 三件套视为一个原子修改**

## SHOULD FIX（3 项，不阻塞但应修复）

### S1: PlanPhase "writing" 阶段是死代码（v1 S1 未修复）

**位置：** `plan.md` 行 55（`PlanPhase` 类型定义）、Task 3 tool.ts `select-template` handler（行 779-786）

**问题：** `PlanPhase = "idle" | "brainstorming" | "writing" | "complete"` 包含 "writing"，但运行时没有任何代码将 phase 切换到 "writing"：

| 设置点 | 文件:行 | 新值 |
|--------|---------|------|
| 进入 plan mode | `command.ts:944` | `"brainstorming"` |
| complete action | `tool.ts:793` | `"complete"` |
| abort action | `tool.ts:805` | `"idle"` |
| abort command | `command.ts:876` | `"idle"` |
| **select-template** | `tool.ts:784` | **未设置 phase（仍为 brainstorming）** |

唯一出现 "writing" 的代码是测试 fixture 数据（`state.test.ts` 第二个测试），运行时永远不会进入。

**修复方向：** 在 `tool.ts` 的 `select-template` handler 成功路径添加：
```typescript
state.phase = "writing";
persistPlanState(pi, state);
```
让状态机如实反映"已选模板、开始写 plan"的语义。

### S2: `isolation` 参数缺 `StringEnum` 约束（v1 S2 未修复）

**位置：** `plan.md` 行 727，tool.ts `parameters` schema 定义

**问题：**

```typescript
isolation: Type.Optional(Type.String({ description: "Context isolation method for complete: compact, tree, direct" })),
```

项目已有 `pi-ai` 的 `StringEnum` 工具（type-lint 通过：`shared/types/mariozechner/index.d.ts:125` 声明 `export function StringEnum`），其他 extension 的 tool 普遍用 `StringEnum` 限定枚举值（如 `extensions/goal`、`extensions/coding-workflow`）。这里用 `Type.String` 让 AI 可以传任意字符串，typebox 不做校验。

**修复方向：**

```typescript
import { StringEnum } from "@mariozechner/pi-ai";
isolation: Type.Optional(StringEnum(["compact", "tree", "direct"])),
```

### S3: tree mode 自动 goal init 违反 spec FR-5.4

**位置：** `plan.md` Task 6 Step 1 `compact.ts` `handlePlanComplete` 函数（行 1243-1290）

**问题：**

`handlePlanComplete` 的 `goalInit` 调用在 switch 语句**外部**（行 1281-1289），无论 `isolation` 是 `compact` / `tree` / `direct` 都会触发 goal init：

```typescript
switch (isolation) {
  case "compact": { ... }
  case "tree": {
    // Tree case: only notify, don't inject steer (user manually navigates)
    ctx.ui.notify("Use /tree to manually navigate back. Plan file: " + state.planFilePath, "info");
    break;  // ← 只 break switch，不影响外部的 goalInit
  }
  case "direct":
  default: { ... }
}

// Try to initialize goal  ← 这段代码在 switch 外部，三个 case 都会执行
try {
  const goalInit = (pi as unknown as Record<string, unknown>).__goalInit as GoalInitFn | undefined;
  if (goalInit) {
    goalInit(...);
  }
} catch (e) { ctx.ui.notify(`Goal init failed: ${e}`, "warning"); }
```

但 spec FR-5.4 明确：
> 选项 b：tree 回退 — 提示用户手动 `/tree`

tree 模式的设计意图是"用户手动控制何时回退、何时启动 goal"。自动触发 goal init 与此冲突——用户在看到通知后还没决定是否要 goal，goal 已经被启动了。

**修复方向：**

```typescript
if (isolation !== "tree") {  // 仅在 compact/direct 模式下启动 goal
  try {
    const goalInit = ...;
    if (goalInit) goalInit(...);
  } catch (e) { ... }
}
```

或更彻底：把 goal init 移到 `case "direct"` 和 `case "compact"` 各自的 `onComplete`/fallback 回调中。

## LOW（13 项，不阻塞 dev）

### LOW #1: plan.md Task 1 / Task 2 测试文件缺 import

**位置：** `plan.md` Task 1 Step 1 `state.test.ts`（行 337-389）+ Task 2 Step 1 `state.test.ts`（行 546-607）

**问题：** 两个测试文件都使用 `ExtensionContext` / `ExtensionAPI` 类型，但 import 语句没有包含：

```typescript
// Task 1 (行 337-338)
import { describe, it, expect, vi } from "vitest";
import { DEFAULT_PLAN_STATE, type PlanState, type PlanPhase, type PlanSessionMap, getPlanState } from "../state.js";
// ← 缺 import type { ExtensionContext } from "@mariozechner/pi-coding-agent"

const mockCtx = {
  sessionManager: { getEntries: () => [] },
} as unknown as ExtensionContext;  // ← IDE 标红：Cannot find name 'ExtensionContext'
```

```typescript
// Task 2 (行 546-547)
import { persistPlanState, reconstructPlanState } from "../state.js";
// ← 缺 import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"
```

**为什么不修复就 OK：** 根 `tsconfig.json` 和 `extensions/plan/tsconfig.json` 都 exclude 了 `**/__tests__`，`tsc --noEmit` 不会扫到。Vitest 用 esbuild 转译（容忍未知标识符），`vitest run` 不会失败。Dev 阶段 IDE 会标红，但不影响 CI。

**修复方向（不阻塞）：** 在测试文件顶部加：
```typescript
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
```

### LOW #2: Task 3 `tool.test.ts` 缺 import

**位置：** `plan.md` Task 3 Step 1 `tool.test.ts`（行 640-665）

**问题：** 测试文件引用 `validateAction` 和 `PLAN_ACTIONS` 但实际未测试 plan tool 的 5 个 action handler 行为。测试仅覆盖常量导出。

**修复方向（不阻塞）：** 至少增加一个 case 测试 `executePlanTool` 在不同 action 下的行为（mock pi + sessions + ctx）。

### LOW #3: `session_before_compact` handler 缺 `firstKeptEntryId` / `tokensBefore` 字段

**位置：** `plan.md` Task 6 Step 1 `compact.ts` `registerPlanEventHandlers`（行 1216-1228）

**问题：**
```typescript
return {
  compaction: {
    summary: `Plan mode completed. ...`,
    // ← 缺 firstKeptEntryId / tokensBefore
  },
};
```

`plan-mode-design.md` 第 5.7 节示例包含这两个字段。SDK 内部从 `event.preparation.firstKeptEntryId` 读取用于 `appendCompaction`。缺失时 SDK 用 `getCompaction()` 默认值，行为正确但失去精确控制。

**修复方向（不阻塞）：**
```typescript
return {
  compaction: {
    summary: ...,
    firstKeptEntryId: (event as { preparation?: { firstKeptEntryId?: string } })?.preparation?.firstKeptEntryId,
    tokensBefore: (event as { preparation?: { tokensBefore?: number } })?.preparation?.tokensBefore,
  },
};
```

### LOW #4: compact 错误处理外层 try/catch 是死代码

**位置：** `plan.md` Task 6 Step 1 `compact.ts` `case "compact"` 块（行 1248-1264）

**问题：** Pi SDK 内部 `agent-session.js` 的 `compact()` 用 IIFE 包裹 try/catch，错误只走 `options?.onError?.(err)`，**不会**作为同步异常向外抛出。所以外层 try/catch 永远不会触发，是死代码。`onError` 已处理所有错误路径，fallback 行为正确。

**修复方向（不阻塞）：** 删除外层 try/catch，保留 `onError`，与 coding-workflow 一致。

### LOW #5: e2e-test-plan.md 全部 9 个 TS 缺 negative scenario

**位置：** `e2e-test-plan.md` 全文

**问题：** 9 个测试场景（TS-1 ~ TS-9）都是 happy path。plan.md 中有大量 `throw new Error` 错误处理路径无对应 E2E 覆盖：

- 未知 action → throw（TS-2/TS-3 应增加无效 action 测试）
- 模板不存在 → throw（TS-3 应增加未注册模板测试）
- templateName 为空 → throw（TS-3 应增加缺字段测试）
- 路径遍历字符 → throw（TS-3 应增加特殊字符测试）
- `/plan abort` 不在 plan mode 时 → notify（TS-4 应增加无激活 plan 的 abort 测试）
- `__goalInit` 调用失败 → catch（TS-7 应增加 goal extension 未安装测试）
- compact 失败 → 降级（TS-5 应增加模拟 compact 失败测试）

**修复方向（不阻塞 dev）：** 补充 TS-N-1 ~ TS-N-7 负面测试。

### LOW #6: e2e-test-plan.md tree 隔离路径无测试覆盖

**位置：** `e2e-test-plan.md` 全文

**问题：** plan.md 在 Task 6 compact.ts `case "tree"` 实现了 tree 隔离（只 notify 不 inject steer，满足 spec FR-5.4），但 e2e-test-plan.md **完全没有 tree 路径的测试场景**。TS-1~TS-9 覆盖了 compact (TS-5)、compact 失败 (TS-6)、direct (隐含于 UC-3 步骤 8)，但 tree 隔离方式（用户选 b）没有 E2E 覆盖。test_cases_template.json 也未涉及 tree 路径。

**修复方向（不阻塞 dev）：** 在 e2e-test-plan.md 增加 TS-5-3 "Complete + Tree 隔离" 测试场景。

### LOW #7: test_cases_template.json 缺 `expected_result` / `priority` / `ac_coverage` 字段

**位置：** `test_cases_template.json` 18 个 case

**问题：** 所有 test case 仅有 `id` / `type` / `title` / `description` / `steps`，缺结构化字段。Phase 4 测试编写 subagent 需要推断期望值与 AC 关联。

**修复方向（不阻塞 dev）：** 给每个 case 加：
```json
{
  "expected_result": "...",
  "priority": "P0|P1|P2",
  "ac_coverage": ["AC-1", "AC-2"]
}
```

### LOW #8: use-cases.md 仅 4 个 UC，plan-mode-design.md 列 11 个

**位置：** `use-cases.md` 全文

**问题：** `plan-mode-design.md` 列出 11 个 UC（UC-1 ~ UC-11），当前 `use-cases.md` 只覆盖 4 个（UC-1~UC-4），缺失：

- UC-3 (重构规划) — design.md 独立列出
- UC-6 (Plan 迭代修改) — 涉及 spec FR-3.4
- UC-7 (中途切换到 Plan Mode) — 涉及 spec FR-1.8
- UC-9 (查看已有 Plan) — 涉及 spec FR-1.3 重入
- UC-10 (Plan 完成后进入实现) — 当前只作为 UC-1 步骤 11
- UC-11 (非代码任务规划)

use-cases.md 末尾"未覆盖的 AC"段已声明 AC-10/11 由 TC-8 和 TC-9 覆盖，但 UC 缺口未解释。

**修复方向（不阻塞 dev）：** 在 use-cases.md 增加一段"为什么缩减"说明（哪些 UC 合并到现有 4 个中），或在每个合并后 UC 的 Alternative Paths 中列出被合并场景的差异化处理。

### LOW #9: non-functional-design.md 缺多个 NFR 维度

**位置：** `non-functional-design.md` 5 个段落（稳定性 / 数据一致性 / 性能 / 业务安全 / 数据安全）

**缺失维度：**

- **可扩展性**：模板 > 50 个时的性能、新增 plan action 的 API 稳定性
- **可维护性**：模块拆分、测试覆盖率目标
- **可观测性**：错误日志策略、关键状态变更的日志粒度
- **兼容性**：Pi 旧版本、Windows `/tmp` 路径（`%TEMP%`）
- **错误处理**：`appendEntry` 失败、状态文件损坏、template I/O 错误路径
- **资源管理**：`/tmp` 长期累积 plan 文件的风险（spec 已声明不主动清理但 NFR 应说明累积影响）
- **跨 extension 契约稳定性**：`__goalInit` 通过 `as Record<string, unknown>` 访问是 hack，pi-goal 重构时 plan 静默失败

**修复方向（不阻塞 dev）：** 增加 1-2 段覆盖上述维度（最关键的是跨 extension 契约稳定性和资源管理）。

### LOW #10: 4/5 内置模板为 stub，章节结构未定义

**位置：** `plan.md` Task 5 Step 3 `templates/` 目录 + `plan-mode-design.md` 第 4.1 节

**问题：** plan.md 只给出 `feature-plan.md` 的完整内容（6 章节），其他 4 个（bugfix / refactor / research / implementation）只写"（其他 4 个模板类似，各有不同的章节结构）"。

`plan-mode-design.md` 第 4.1 节实际给出了所有 5 个模板的完整章节列表（与 plan.md Task 5 给的 feature-plan 不完全一致）：

| 模板 | design.md 章节 | plan.md Task 5 内容 |
|------|----------------|---------------------|
| feature-plan | 背景 / 方案 / 关键文件 / 实现步骤 / 验证 | Overview / Requirements / Design Decisions / Implementation Steps / Testing Strategy / Risks & Mitigations |
| bugfix-plan | 现象 / 根因分析 / 修复策略 / 受影响文件 / 回归测试 | 缺失 |
| refactor-plan | 现状 / 目标结构 / 分步骤计划 / 风险与缓解 / 验证 | 缺失 |
| research-plan | 问题 / 候选方案 / 对比分析 / 推荐 / 后续步骤 | 缺失 |
| implementation-plan | Spec 摘要 / 任务分解 / 实现顺序 / 验证 | 缺失 |

存在两个问题：
1. **plan.md 与 design.md 不一致**：feature-plan 章节列表不同
2. **4 个模板章节未在 plan.md 列出**

Phase 3 subagent 需要自行设计这 4 个模板的章节结构，缺少规格约束会导致：
- 各 subagent 设计风格不统一
- feature-plan 与其他模板章节粒度不一致
- test case 中断言 `expect(content).toContain("## ")` 太宽松，不能验证章节顺序

**修复方向（不阻塞 dev）：** 在 plan.md Task 5 Step 3 中：
1. 统一 feature-plan 章节（与 design.md 第 4.1 节一致）
2. 列出其他 4 个模板的预期章节列表（直接复用 design.md 第 4.1 节内容）

### LOW #11: `__goalInit` 类型签名不匹配（`Record<string, unknown>` vs 具体 budget 对象）

**位置：** `plan.md` Task 6 Step 1 `compact.ts` `GoalInitFn` 类型 + 调用点

**问题：**
```typescript
type GoalInitFn = (objective: string, tasks: string[], budget?: Record<string, unknown>) => boolean;
...
goalInit(
  `Execute plan: ${state.planFilePath}`,
  ["Read plan file", "Execute implementation steps"],
);
```

`extensions/goal/src/index.ts:390` 实际签名：
```typescript
function initializeGoalFromExternal(
  objective: string,
  tasks: string[],
  budget?: { tokenBudget?: number; timeBudgetMinutes?: number; maxTurns?: number },
): boolean
```

plan 用了 `Record<string, unknown>` 而非具体 budget 对象。运行时 plan 调用**不传 budget**，所以实际工作，但 `as GoalInitFn` 断言是谎言（签名不兼容）。如果 dev 未来想加 budget 字段，会因类型不严而静默不报错。

**修复方向（不阻塞 dev）：** 把 `GoalInitFn` 类型改为与 `extensions/goal/src/index.ts` 一致：
```typescript
type GoalInitFn = (
  objective: string,
  tasks: string[],
  budget?: { tokenBudget?: number; timeBudgetMinutes?: number; maxTurns?: number },
) => boolean;
```

注意：项目既有 `extensions/coding-workflow/lib/tool-handlers.ts` 同样用 `Record<string, unknown>` 作为 budget 类型，所以 plan 沿用此模式有一定合理性（一致性）。但严格来说 budget 应该用具体类型。

### LOW #12: Task 2 是 test-only 任务，与 Task 1 重复

**位置：** `plan.md` Task 2 全文

**问题：** Task 1 已实现 `persistPlanState` / `reconstructPlanState`，Task 2 的 Step 1 只是在 `state.test.ts` 中**追加测试**，不修改 index.ts 也不引入新功能。Task 2 Step 2 直接说"Expected: PASS (persistence functions already implemented in Task 1)"——明确承认是补测试。

**为什么不修复就 OK：** Task 2 拆分有助于 BG1 内部分批派遣（4 个 subagent 而不是 3 个），但描述应为 "test-only (补 Task 1 持久化函数测试)"。

**修复方向（不阻塞 dev）：** 改 Task 2 标题为 "State 持久化测试增量" + Type 改为 "test-only"。

### LOW #13: `/tmp/plan-{slug}.md` 全局共享，跨项目泄漏

**位置：** `plan.md` Task 4 command.ts reentry 扫描 + `non-functional-design.md` §5 数据安全

**问题：** `os.tmpdir() + plan-{slug}.md` 是 OS 级别共享路径。两个不同项目使用 Pi 会在同一 `/tmp/plan-*.md` 池中产生文件。Task 4 reentry 逻辑扫描 `/tmp/plan-*.md` 会**误捡其他项目的 plan 文件**，提示用户的 4 选项（继续/实现/新建/取消）会指向其他项目的 plan。

spec FR-1.6 已规定 `/tmp/plan-{slug}.md`，所以这是 spec 设计选择而非 plan 错误。但 plan 应当显式声明"接受跨项目泄漏"或建议扩展为 `<projectHash>-plan-{slug}.md`（spec 升级到 v2 再改）。

**修复方向（不阻塞 dev）：** 在 plan.md Task 4 reentry 段加注释说明跨项目行为；在 `non-functional-design.md` §5 数据安全段加"跨项目泄漏风险"小节。

## 跨文件一致性检查

| 检查项 | plan.md | e2e-test-plan.md | test_cases_template.json | use-cases.md | non-functional-design.md | 结论 |
|--------|---------|------------------|--------------------------|--------------|--------------------------|------|
| AC 覆盖 | 11/11 (matrix) | 9 TS, 11 AC | 18 TC, 11 AC | 4 UC 显式 + TC 补 AC-10/11 | 未涉及 | ✅ 一致 |
| 模板数量 | 5 builtin (1 完整 + 4 stub) | 未涉及 | TC-8 验证 | UC-1~4 引用 4 templates | 未涉及 | ⚠️ stub 模板（LOW #10）|
| 状态机 | 4 phases | 同 | 同 | 同 | 同 | ✅ 一致 |
| 隔离方式 | 3 options (compact/tree/direct) | TS-5/6 覆盖 2 (compact/direct) | TC-5/6 覆盖 2 | UC-3 提及 direct | §1 稳定性 | ⚠️ tree 选项无 E2E/TC 覆盖（LOW #6）|
| Extension 依赖 | Task 0 Step 2 声明 | 未涉及 | 未涉及 | UC-1 提及 goal | 未涉及 | ✅ 一致 |
| Subagent 检测 | SKILL.md Phase D3 | 未涉及 | 未涉及 | UC-1 提及 "wave 并行" | 未涉及 | ✅ 一致 |
| Multi-session 隔离 | PlanSessionMap (Task 4) | TS-9 覆盖 | TC-9-01 覆盖 | 未涉及 | §2 简述 | ✅ 一致 |
| TUI 状态栏 | widget.ts (Task 5) | 未涉及 | TC-10-01/02 覆盖 | 未涉及 | 未涉及 | ✅ 一致 |
| 跨组依赖 | tool/command/index → BG2 | n/a | n/a | n/a | n/a | ❌ **MUST FIX M1** |
| vitest 三件套 | vitest.config.ts ✅ / scripts.test ❌ / devDependencies.vitest ❌ | n/a | n/a | n/a | n/a | ❌ **MUST FIX M2** |
| 测试 import | LOW #1, #2 | n/a | n/a | n/a | n/a | ⚠️ IDE-only 问题 |
| 内置模板章节 | 与 design.md 不一致 (LOW #10) | n/a | n/a | n/a | n/a | ⚠️ 章节粒度待统一 |

## 接口契约审查

| 接口 | plan.md 定义 | 实现位置 | 一致性 |
|------|------------|---------|-------|
| `PlanPhase` | 4 枚举值 | state.ts | ⚠️ "writing" 死代码（SHOULD FIX S1）|
| `PlanState` | 5 字段 | state.ts | ✅ |
| `PlanSessionMap` | `Map<string, PlanState>` | state.ts | ✅ |
| `getPlanState` | (sessions, sessionId, ctx) → PlanState | state.ts | ✅ |
| `persistPlanState` | (pi, state) → void | state.ts | ✅ |
| `reconstructPlanState` | (ctx) → PlanState | state.ts | ✅ |
| `executePlanTool` | (pi, ctx, sessions, action, params) → ToolResult | tool.ts | ✅ execute 签名已修复（`_toolCallId` / `_signal` / `_onUpdate`）|
| `listTemplates` | (projectDir?) → TemplateInfo[] | templates.ts | ✅ |
| `loadTemplate` | (name, projectDir?) → string \| null | templates.ts | ✅ catch 块仅 `return null`，warn 级别不阻断 |
| `handlePlanComplete` | (pi, ctx, state, isolation) → void | compact.ts | ⚠️ SHOULD FIX S3: goal init 在 tree case 也触发 |
| `updatePlanWidget` | (ctx, state) → void | widget.ts | ✅ |

## 后端设计充分性检查（L1）

按 SKILL 的 L1 后端检查清单逐项：

1. **"为什么"而非"做什么"**：✅ Task 3 tool.ts 每个 action 都有清晰目的；Task 6 compact.ts handlePlanComplete 注释解释了 tree case 为何不注入 steer
2. **存储变更选型理由**：✅ Task 0 Step 2 注释 "Extension 依赖管理 [MANDATORY]"；Task 1 Step 3 state.ts 注释 "per-session 隔离"
3. **API 端点与业务场景对应**：✅ 5 个 action 对应 spec FR-3.2 / FR-4.4 / FR-5.1 / FR-7.2 / FR-3.2 五个场景
4. **边界条件 / 异常处理**：
   - ✅ select-template: `loadTemplate` 返回 null 时 throw
   - ✅ create-template: 路径遍历防护 + 必填字段校验
   - ✅ complete: 必传 isolation（default 为 "direct"）
   - ✅ abort: 不在 plan mode 时 notify "No active plan mode"
   - ⚠️ LOW #4: compact 错误处理有冗余 try/catch
   - ❌ M1: 跨组 import 违反
   - ❌ M2: 缺 scripts.test + devDependencies.vitest
5. **非功能性要求对应 task**：✅ Task 5 性能（listTemplates 三层扫描）、Task 6 稳定性（compact 失败降级）

## 关键正面观察

- **AC 覆盖矩阵完整**：plan.md Spec Coverage Matrix 11/11 ACs 全部覆盖
- **Per-session 隔离用 Map<sessionId, PlanState>**：满足 AC-11 和 spec FR-9.1
- **`/plan abort` / `/plan status` 子命令完整**：满足 spec FR-1.4 / FR-7.1
- **Reentry 4 选项对话框**：满足 spec FR-1.3
- **`session_before_compact` / `session_before_tree` handler 都已实现**：满足 spec FR-5.6 / FR-5.7
- **`complete` action 调用 `handlePlanComplete`**：满足 spec FR-5.1
- **`tree` case 只 notify 不 inject steer**：满足 spec FR-5.4（**但 goal init 仍触发，见 SHOULD FIX S3**）
- **`__goalInit` 调用 + 运行时检测 + 缺失降级**：满足 spec FR-6.4，与 coding-workflow 调用模式一致
- **SKILL.md 含 ask_user 工具规范**：满足 spec FR-2.3
- **SKILL.md 含 subagent 检测 4 步骤**：满足 spec FR-6.1~6.3
- **`create-template` 路径遍历防护**：`templateName.replace(/[^a-zA-Z0-9_-]/g, "")` 拒绝特殊字符
- **Abort 流程清理完整**：`sessions.delete(sessionId)` + widget 清理
- **tool.ts execute 签名已修复**（`@typescript-eslint/no-unused-vars: 'error'` 不再触发）：`_toolCallId` / `_signal` / `_onUpdate`
- **compact.ts goal init catch 已修复**（非空 catch 块）：`catch (e) { ctx.ui.notify(...) }`
- **vitest.config.ts 已加入 plan**（v6 修复）：File Structure 表 + Task 1 Files + 具体内容
- **BG 内文件数合理**（BG0: 3, BG1: 7, BG2: 10），均在 ≤10 阈值
- **Wave 编排串行清晰**（Wave 1 → 2 → 3），无循环依赖（**但跨组 import 破坏了子 Wave 内部的可执行性**）
- **vitest 配置准备**：`extensions/plan/tsconfig.json` 包含 `"exclude": ["src/__tests__", "dist"]`，与项目约定一致

## 修复优先级建议

按修复优先级（dev 阶段阻断性）：

1. **第一批（dev 会立即阻断）：**
   - M1（6 处跨组 import 违反 → Wave 2 subagent 跑 vitest 时崩溃）
   - M2（package.json 缺 scripts.test + devDependencies.vitest → pnpm --filter test 失败）
2. **第二批（dev 阶段顺手清理）：**
   - SHOULD FIX S1（"writing" 死代码）、SHOULD FIX S2（StringEnum）、SHOULD FIX S3（tree mode 误触发 goal init）
   - LOW #1, #2, #3, #4（test import / firstKeptEntryId / 死代码）
3. **第三批（Phase 4 阶段清理）：** LOW #5, #6, #7（e2e/test_cases 字段补全 + tree 路径测试）
4. **第四批（Phase 5 / 文档迭代）：** LOW #8, #9（UC + NFR 完整性）
5. **第五批（设计精化）：** LOW #10, #11, #12, #13（模板 / 类型 / 任务拆分 / 跨项目）

## 结论

**Fail。** 当前 plan.md 整体设计质量高，AC 11/11 覆盖，per-session 隔离、`/plan abort/status`、重入 4 选项、compact/tree handler、`__goalInit` API、SKILL.md 的 ask_user/subagent 检测、路径遍历防护——所有架构关键点都到位。

v3 标记的 2 项 MUST FIX（M15 tool.ts 签名 + M16 silent catch）**均已修复**。v6 标记的 1 项 MUST FIX（M1 vitest.config.ts）**部分修复**（vitest.config.ts 已添加但 package.json 缺 scripts + devDependencies）。**但 v1 标记的 1 项 MUST FIX（M1 6 处跨组 import 违反）在 v2~v6 评审中均未被识别或回归，整个评审链中只有 v1 触及"BG1→BG2 跨组 import"维度。**

修复 M1 + M2 后，plan 可进入 dev 阶段无阻断。SHOULD FIX S1/S2/S3 属于设计语义层面问题，建议 dev 阶段一并处理。13 项 LOW 属于代码风格 / 文档完整性 / 测试模板完整度 / NFR 覆盖度 / 测试覆盖度，均可在 dev/Phase 4/Phase 5 阶段清理，不阻塞 plan 评审通过。

**v7 关键提示：**
- **M1（跨组 import 违反）是 v1 发现但 v2~v6 评审未做回归的旧问题**。v6 的 PASS 结论基于 fix_summary 检查（前序 v3/v5 修复列表），未对 v1 标记的 M1 做回扫。整个评审链中只有 v1 触及了"BG1→BG2 跨组 import"维度。
- **M2（package.json 三件套不完整）是 v3 发现但 v6 评审未做完整子项回归**。v6 只追加了 vitest.config.ts，未对 package.json 三件套（vitest.config.ts + scripts.test + devDependencies.vitest）做原子回归。

## 评审元数据

```yaml
review:
  type: plan_review
  round: 7
  mode: "Mode 1: Plan feasibility"
  timestamp: "2026-06-11T16:50:00+08:00"
  target: ".xyz-harness/2026-06-11-plan-mode/plan.md"
  related:
    - e2e-test-plan.md
    - test_cases_template.json
    - use-cases.md
    - non-functional-design.md
  verdict: fail
  summary: |
    独立 v7 评审。v6 标记的 1 项 MUST FIX（vitest.config.ts）部分修复（package.json 缺 scripts/devDependencies）。
    独立发现 1 项 MUST FIX（M1 6 处跨组 import 违反，v1 标记但 v2~v6 评审均未做回归，
    是 v1 标记但 v2~v6 评审未做回归的旧问题，pre-commit hook 的 tsc/vitest 步骤会阻断） +
    1 项 MUST FIX（M2 package.json 缺 scripts.test + devDependencies.vitest，
    违反 CLAUDE.md 测试规范第 1、3 项，pnpm --filter test 失败） +
    3 项 SHOULD FIX（PlanPhase "writing" 死代码 / isolation 缺 StringEnum / tree mode 误触发 goal init 违反 spec FR-5.4） +
    13 项 LOW（test import / firstKeptEntryId / 死代码 / E2E 缺负面场景 / tree 隔离无 E2E 覆盖 /
    test_cases 缺字段 / UC 缺口 / NFR 维度不全 / 4/5 模板 stub 与 design.md 不一致 /
    __goalInit 类型 / Task 2 test-only / /tmp 跨项目泄漏），LOW 均可后续清理。

statistics:
  total_issues: 18
  must_fix: 2
  should_fix: 3
  low: 13
  must_fix_breakdown:
    - category: "跨组 import 违反（pre-commit hook tsc/vitest 阻断）"
      count: 1
      items: [M1]
    - category: "package.json 测试规范不完整（pnpm --filter 失败）"
      count: 1
      items: [M2]
  should_fix_breakdown:
    - category: "状态机 / 参数约束 / spec 违规"
      count: 3
      items: [S1, S2, S3]
  low_breakdown:
    - category: "测试文件不完整（import / 字段 / 覆盖度）"
      count: 4
      items: [LOW_1, LOW_2, LOW_5, LOW_6, LOW_7]
    - category: "handler 缺字段（firstKeptEntryId）"
      count: 1
      items: [LOW_3]
    - category: "死代码 / 冗余 try/catch"
      count: 1
      items: [LOW_4]
    - category: "文档完整性（UC / NFR）"
      count: 2
      items: [LOW_8, LOW_9]
    - category: "设计完整性（模板 / 类型 / 任务拆分 / 资源）"
      count: 4
      items: [LOW_10, LOW_11, LOW_12, LOW_13]
  prior_validation:
    v1_M1: unfixed
    v3_M15: fixed
    v3_M16: fixed
    v6_M1: partial_fixed
```
