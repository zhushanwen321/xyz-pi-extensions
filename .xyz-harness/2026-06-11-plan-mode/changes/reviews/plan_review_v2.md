---
verdict: fail
must_fix: 2
complexity: L1
---

# Plan Review v2 — Pi Plan Mode Extension (Independent Round)

## 评审记录

- **评审时间：** 2026-06-11
- **评审类型：** Plan 评审（Mode 1: 验证 plan 可实施性）
- **评审对象：** `.xyz-harness/2026-06-11-plan-mode/plan.md` 及关联 `e2e-test-plan.md` / `test_cases_template.json` / `use-cases.md` / `non-functional-design.md`
- **交叉对照：** `spec.md`、`plan-mode-design.md`、`CLAUDE.md` 测试规范 4 步清单、`extensions/goal/src/index.ts:390-422`（`__goalInit` 实际签名）、`extensions/coding-workflow/lib/tool-handlers.ts:496-540`（`__goalInit` 调用模式 + compact IIFE 错误处理）、`extensions/context-engineering/vitest.config.ts`（vitest 配置模板）、`extensions/todo/package.json`（test script 完整字段）、根目录 `.githooks/pre-commit`（vitest 步骤与 package.json 深度检查）
- **本评审模式：** 独立 v2 轮次，重新阅读当前 5 份 deliverable + 跨组依赖与测试规范符合性，独立判断

## 总体评估

**plan.md 整体设计质量较高**：8 个 Task（含 Task 0 项目同步）、3 个 Execution Group（BG0/BG1/BG2）、Spec Coverage Matrix 11/11 覆盖、Interface Contracts 完整、per-session 隔离用 `PlanSessionMap = Map<string, PlanState>` 满足 AC-11、`/plan abort` / `/plan status` 子命令 + 重入 4 选项 + `session_before_compact` / `session_before_tree` handler + `__goalInit` API + `create-template` 路径遍历防护 + SKILL.md 含 ask_user / subagent 检测——架构关键点都到位。

**但发现 2 项 MUST FIX 必须在进入 dev 阶段前修复**：

1. **M1（BG1→BG2 跨组 import 违反）**：tool.ts / command.ts / index.ts 共 6 处静态 import 引用 BG2 模块，Wave 2 subagent 创建文件后 `npx vitest run` 会因 `ERR_MODULE_NOT_FOUND` 失败——pre-commit hook 阻断级别。
2. **M2（package.json 缺 scripts.test / devDependencies.vitest）**：违反项目 CLAUDE.md 测试规范 4 步清单第 1、3 项，`pnpm --filter @zhushanwen/pi-plan test` 失败。

**3 项 SHOULD FIX（不阻塞 dev 但应修复）**：
- S1：`select-template` 未推进 `state.phase` 到 `"writing"`，导致状态机 4 变 3
- S2：`isolation` 参数未用 `StringEnum` 约束，AI 拼写错误会静默降级
- S3：`handlePlanComplete` 在 tree 模式也自动调用 `__goalInit`，违反 spec FR-5.4 "用户手动控制"

**9 项 LOW**（设计完整性、测试覆盖、文档完整性等），不阻塞 dev 阶段。

## MUST FIX（2 项）

### M1: BG1→BG2 跨组 import 违反（6 处）

**位置：**
- `plan.md` File Structure 表（行 30-32）— 显式分组
- `plan.md` Task 3 Step 3 `tool.ts` import 段（行 693-695）
- `plan.md` Task 4 Step 1 `command.ts` import 段（行 850）
- `plan.md` Task 4 Step 2 `index.ts` import 段（行 972-973）
- `plan.md` Wave Schedule（行 260-264）— 显式串行调度

**严重度：** must_fix（Wave 2 subagent 派遣时 ESM 解析失败，pre-commit hook 阻断）

**问题：**

plan EXPLICITLY 分组如下（File Structure 表）：

| File | Group |
|------|-------|
| `src/tool.ts` | **BG1** |
| `src/command.ts` | **BG1** |
| `src/index.ts` | **BG1** |
| `src/templates.ts` | **BG2** |
| `src/compact.ts` | **BG2** |
| `src/widget.ts` | **BG2** |

Wave 调度规定 Wave 2 = BG1，Wave 3 = BG2，**BG1 → BG2 单向依赖**。

但当前代码有 **6 处** BG1 → BG2 的静态 import（已通过 `rg` 验证行号）：

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

**影响维度：**

| 影响 | 详细说明 |
|------|---------|
| **运行时崩溃** | Wave 2 (BG1) subagent 按 TDD 步骤跑 `npx vitest run extensions/plan/src/__tests__/tool.test.ts`，`tool.ts` 的 import 解析会触发 `ERR_MODULE_NOT_FOUND`（templates/compact/widget 还未被 BG2 subagent 创建）。`npx vitest run` 退出码非零 → pre-commit hook 阻断。|
| **subagent 隔离风险** | BG1 subagent 拿不到 BG2 设计文档（按 plan 设计 BG2 由后续 Wave 处理），不知道 `handlePlanComplete` 实际签名、`updatePlanWidget` widget 渲染规则——可能写出简化 stub，让 `tsc --noEmit` 通过（type stub 全 `any`），但运行时崩溃。|
| **TSLint 阻断** | pre-commit hook 的 tsc + eslint 步骤会因 `Cannot find module './templates.js'` 而失败。|

**修复方案（推荐 v1 Option A，最小化变更）：**

| 步骤 | 改动 |
|------|------|
| 1 | 将 `templates.ts` 和 `widget.ts` 从 BG2 移到 BG1（File Structure 表 + Task 5 Files 列表）。理由：templates.ts 和 widget.ts 是纯函数/UI 组件，无 compact 那种副作用密集逻辑，适合与 state.ts 同组。|
| 2 | `tool.ts` 移除 `import { handlePlanComplete } from "./compact.js"`（行 694），改为在 `case "complete"` 分支内 **dynamic import**：`const { handlePlanComplete } = await import("./compact.js");` |
| 3 | `command.ts` 移除 `import { updatePlanWidget } from "./widget.js"`（行 850），改为 dynamic import 或重构成调用方注入函数。|
| 4 | `index.ts` 移除 `import { registerPlanEventHandlers } from "./compact.js"`（行 972），改为 dynamic import；`updatePlanWidget` 改为 dynamic import。|

### M2: package.json 缺 `scripts.test` / `devDependencies.vitest`

**位置：** `plan.md` Task 1 Step 3 `package.json` 内容（行 481-494）

**严重度：** must_fix（违反项目 CLAUDE.md 测试规范第 1、3 项；`pnpm --filter test` 失败）

**问题：**

CLAUDE.md 测试规范 4 步清单：

> 1. `pnpm --filter <pkg> add -D vitest`
> 2. 创建 `vitest.config.ts`（参考已有包的配置）
> 3. `package.json` 添加 `"test": "vitest run"` script
> 4. 创建 `src/__tests__/` 目录和测试文件

**当前 plan.md package.json 内容：**

```json
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
}
```

**缺失：**
- ❌ `scripts: { "test": "vitest run", "typecheck": "tsc --noEmit" }`（CLAUDE.md 第 3 项）
- ❌ `devDependencies: { "vitest": "^4.1.8" }`（CLAUDE.md 第 1 项）

**对比既有正确模式 `extensions/todo/package.json`（已读取验证）：**

```json
{
  "name": "@zhushanwen/pi-todo",
  "version": "0.1.6",
  "type": "module",
  "main": "src/index.ts",
  "pi": { "extensions": ["./index.ts"] },
  "keywords": ["pi-package", "extension", ...],
  "license": "MIT",
  "files": ["src/", "index.ts"],
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

**修复方向：**

在 plan.md Task 1 Step 3 的 `package.json` 代码块添加：

```json
"scripts": {
  "typecheck": "npx tsc --noEmit",
  "test": "vitest run"
},
"devDependencies": {
  "vitest": "^4.1.8"
}
```

## SHOULD FIX（3 项）

### S1: `select-template` 未推进 `state.phase` 到 `"writing"`（"writing" 死代码）

**位置：** `plan.md` Task 3 tool.ts `case "select-template"` handler（行 779-786）

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

### S2: `isolation` 参数缺 `StringEnum` 约束

**位置：** `plan.md` 行 727，tool.ts `parameters` schema 定义

**问题：**

```typescript
isolation: Type.Optional(Type.String({ description: "Context isolation method for complete: compact, tree, direct" })),
```

项目已有 `pi-ai` 的 `StringEnum` 工具（type stub 在 `shared/types/mariozechner/index.d.ts` 声明），其他 extension 的 tool 普遍用 `StringEnum` 限定枚举值（如 `extensions/goal`、`extensions/coding-workflow`）。这里用 `Type.String` 让 AI 可以传任意字符串，typebox 不做校验。

**修复方向：**

```typescript
import { StringEnum } from "@mariozechner/pi-ai";
isolation: Type.Optional(StringEnum(["compact", "tree", "direct"])),
```

### S3: `handlePlanComplete` 在 tree 模式下也自动调用 `__goalInit`（spec 偏离 + 逻辑错误）

**位置：** `plan.md` Task 6 Step 1 `compact.ts` `handlePlanComplete` 函数（行 1243-1290）

**问题：**

`handlePlanComplete` 的 `goalInit` 调用在 switch 语句**外部**（行 1304-1314），无论 `isolation` 是 `compact` / `tree` / `direct` 都会触发 goal init：

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

**问题 2：spec 偏离**

- spec FR-6.1："AI 读取 plan 文件后，检测 subagent 能力"（"检测" + "建议"，**不是**"自动执行"）
- spec FR-6.2 / FR-6.3："有 subagent → **建议**启动 goal" / "无 subagent → **建议**单 agent"
- spec FR-6.4："通过 goal extension 的 `__goalInit` API 启动 goal"（这是 AI **检测后**才调用的，不是 plan extension 自动调）

**问题 3：SKILL.md 与代码矛盾**

- SKILL.md Phase D3："1. **Check subagent capability**... 2. **If subagent available**: **Suggest** starting goal + wave... 3. **If no subagent**: **Suggest** single-agent phased execution"
- 代码却直接调用 `__goalInit`（无条件，不检测 subagent 工具是否存在）

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

## LOW（9 项，不阻塞 dev）

### L1: `loadTemplate` 静默 catch 返回 null（违反 no-silent-catch）

**位置：** `plan.md` Task 5 Step 3 `templates.ts`（`loadTemplate` 函数）

**问题：**
```typescript
try {
  return fs.readFileSync(template.path, "utf-8");
} catch {
  return null;  // ← silent catch
}
```

项目 `taste-lint` 规则有 `no-silent-catch`，catch 块不能为空或只有 console。需增加 ctx.ui.notify 或 console.warn。

### L2: 4/5 内置模板只有占位，章节结构未定义

**位置：** `plan.md` Task 5 Step 3 `templates/` 目录

**问题：** plan.md 只给出 `feature-plan.md` 的完整内容（6 章节），其他 4 个（bugfix / refactor / research / implementation）只写"（其他 4 个模板类似，各有不同的章节结构）"。

`plan-mode-design.md` 第 4.1 节给出了所有 5 个模板的完整章节列表（与 plan.md Task 5 给的 feature-plan 不完全一致）：

| 模板 | design.md 章节 | plan.md Task 5 内容 |
|------|----------------|---------------------|
| feature-plan | 背景 / 方案 / 关键文件 / 实现步骤 / 验证 | Overview / Requirements / Design Decisions / Implementation Steps / Testing Strategy / Risks & Mitigations |
| bugfix-plan | 现象 / 根因分析 / 修复策略 / 受影响文件 / 回归测试 | 缺失 |
| refactor-plan | 现状 / 目标结构 / 分步骤计划 / 风险与缓解 / 验证 | 缺失 |
| research-plan | 问题 / 候选方案 / 对比分析 / 推荐 / 后续步骤 | 缺失 |
| implementation-plan | Spec 摘要 / 任务分解 / 实现顺序 / 验证 | 缺失 |

**修复方向：** 在 plan.md Task 5 Step 3 中列出其他 4 个模板的章节列表（直接复用 design.md 第 4.1 节内容）。

### L3: 5 个 action handler 零单元测试

**位置：** `plan.md` Task 3 Step 1 `tool.test.ts`（行 640-665）

**问题：** 测试文件引用 `validateAction` 和 `PLAN_ACTIONS` 但实际未测试 plan tool 的 5 个 action handler 行为。`create-template` 路径遍历防护、`select-template` 模板不存在 throw、`complete` 状态推进、`abort` 状态重置全无回归保护。

**修复方向：** 至少增加一个 case 测试 `executePlanTool` 在不同 action 下的行为（mock pi + sessions + ctx）。

### L4: Task 1/Task 2 测试文件缺 import

**位置：** `plan.md` Task 1 Step 1 `state.test.ts`（行 337-389）+ Task 2 Step 1 `state.test.ts`（行 546-607）

**问题：** 两个测试文件都使用 `ExtensionContext` / `ExtensionAPI` 类型，但 import 语句没有包含。

**修复方向（不阻塞）：** 在测试文件顶部加：
```typescript
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
```

### L5: e2e-test-plan 9 个 TS 全是 happy path，缺负面场景

**位置：** `e2e-test-plan.md` 全文

**问题：** 9 个测试场景都是 happy path。plan.md 中有大量 `throw new Error` 错误处理路径无对应 E2E 覆盖：

- 未知 action → throw
- 模板不存在 → throw
- templateName 为空 → throw
- 路径遍历字符 → throw
- `/plan abort` 不在 plan mode 时 → notify
- `__goalInit` 调用失败 → catch
- compact 失败 → 降级

**修复方向：** 补充 TS-N-1 ~ TS-N-7 负面测试。

### L6: tree 隔离路径无 E2E/TC 覆盖

**位置：** `e2e-test-plan.md` + `test_cases_template.json`

**问题：** plan.md 在 Task 6 compact.ts `case "tree"` 实现了 tree 隔离（只 notify 不 inject steer），但 e2e-test-plan.md 完全没有 tree 路径的测试场景。TS-1~TS-9 覆盖了 compact (TS-5)、compact 失败 (TS-6)、direct (隐含于 UC-3 步骤 8)，但 tree 隔离方式（用户选 b）没有 E2E 覆盖。test_cases_template.json 也未涉及 tree 路径。

**修复方向：** 在 e2e-test-plan.md 增加 TS-5-3 "Complete + Tree 隔离" 测试场景。

### L7: test_cases_template.json 缺 `expected_result` / `priority` / `ac_coverage` 字段

**位置：** `test_cases_template.json` 18 个 case

**问题：** 所有 test case 仅有 `id` / `type` / `title` / `description` / `steps`，缺结构化字段。Phase 4 测试编写 subagent 需要推断期望值与 AC 关联。

**修复方向：** 给每个 case 加：
```json
{
  "expected_result": "...",
  "priority": "P0|P1|P2",
  "ac_coverage": ["AC-1", "AC-2"]
}
```

### L8: non-functional-design.md 缺 NFR 维度 + /tmp 权限错误

**位置：** `non-functional-design.md` §5 数据安全

**问题 1：** 缺 NFR 维度——可扩展性（模板 > 50 个时的性能、新增 plan action 的 API 稳定性）、可观测性（错误日志策略、关键状态变更的日志粒度）、兼容性（Pi 旧版本、Windows `/tmp` 路径（`%TEMP%`））、资源管理（`/tmp` 长期累积 plan 文件的风险）、跨 extension 契约稳定性（`__goalInit` 通过 `as Record<string, unknown>` 访问是 hack，pi-goal 重构时 plan 静默失败）。

**问题 2：** `non-functional-design.md §5` 写"Plan 文件权限继承 /tmp 默认（通常 755）"——`/tmp` 默认是 `1777`（rwxrwxrwt 含 sticky bit）非 755。

### L9: Task 2 是 test-only 任务，与 Task 1 重复

**位置：** `plan.md` Task 2 全文

**问题：** Task 1 已实现 `persistPlanState` / `reconstructPlanState`，Task 2 的 Step 1 只是在 `state.test.ts` 中**追加测试**，不修改 index.ts 也不引入新功能。Task 2 Step 2 直接说"Expected: PASS (persistence functions already implemented in Task 1)"——明确承认是补测试。

**修复方向（不阻塞）：** 改 Task 2 标题为 "State 持久化测试增量" + Type 改为 "test-only"。

## 跨文件一致性检查

| 检查项 | plan.md | e2e-test-plan.md | test_cases_template.json | use-cases.md | non-functional-design.md | 结论 |
|--------|---------|------------------|--------------------------|--------------|--------------------------|------|
| AC 覆盖 | 11/11 (matrix) | 9 TS, 11 AC | 18 TC, 11 AC | 4 UC 显式 + TC 补 AC-10/11 | 未涉及 | ✅ 一致 |
| 模板数量 | 5 builtin (1 完整 + 4 stub) | 未涉及 | TC-8 验证 | UC-1~4 引用 4 templates | 未涉及 | ⚠️ stub 模板（L2）|
| 状态机 | 4 phases | 同 | 同 | 同 | 同 | ⚠️ "writing" 死代码（S1）|
| 隔离方式 | 3 options (compact/tree/direct) | TS-5/6 覆盖 2 (compact/direct) | TC-5/6 覆盖 2 | UC-3 提及 direct | §1 稳定性 | ⚠️ tree 选项无 E2E/TC 覆盖（L6）|
| Extension 依赖 | Task 0 Step 2 声明 | 未涉及 | 未涉及 | UC-1 提及 goal | 未涉及 | ✅ 一致 |
| Subagent 检测 | SKILL.md Phase D3 "suggest" | 未涉及 | 未涉及 | UC-1 提及 "wave 并行" | 未涉及 | ⚠️ SKILL.md "suggest" vs 代码 auto-call goal 矛盾（S3）|
| Multi-session 隔离 | PlanSessionMap (Task 4) | TS-9 覆盖 | TC-9-01 覆盖 | 未涉及 | §2 简述 | ✅ 一致 |
| TUI 状态栏 | widget.ts (Task 5) | 未涉及 | TC-10-01/02 覆盖 | 未涉及 | 未涉及 | ✅ 一致 |
| 跨组依赖 | tool/command/index → BG2 | n/a | n/a | n/a | n/a | ❌ **MUST FIX M1** |
| vitest 三件套 | vitest.config.ts ✅ / scripts.test ❌ / devDependencies.vitest ❌ | n/a | n/a | n/a | n/a | ❌ **MUST FIX M2** |
| 测试 import | 缺 import（L4）| n/a | n/a | n/a | n/a | ⚠️ IDE-only 问题 |
| 内置模板章节 | 与 design.md 不一致（L2）| n/a | n/a | n/a | n/a | ⚠️ 章节粒度待统一 |

## 接口契约审查

| 接口 | plan.md 定义 | 实现位置 | 一致性 |
|------|------------|---------|-------|
| `PlanPhase` | 4 枚举值 | state.ts | ⚠️ "writing" 死代码（S1）|
| `PlanState` | 5 字段 | state.ts | ✅ |
| `PlanSessionMap` | `Map<string, PlanState>` | state.ts | ✅ |
| `getPlanState` | (sessions, sessionId, ctx) → PlanState | state.ts | ✅ |
| `persistPlanState` | (pi, state) → void | state.ts | ✅ |
| `reconstructPlanState` | (ctx) → PlanState | state.ts | ✅ |
| `executePlanTool` | 5 action handler | tool.ts | ✅ execute 签名已修复（`_toolCallId` / `_signal` / `_onUpdate`）|
| `listTemplates` | (projectDir?) → TemplateInfo[] | templates.ts | ✅ |
| `loadTemplate` | (name, projectDir?) → string \| null | templates.ts | ⚠️ silent catch（L1）|
| `handlePlanComplete` | (pi, ctx, state, isolation) → void | compact.ts | ⚠️ tree 模式仍 auto-call goal（S3）|
| `updatePlanWidget` | (ctx, state) → void | widget.ts | ✅ |
| `BG1 import BG2` | （无） | tool.ts/command.ts/index.ts | ❌ 6 处违反（M1）|

## 关键正面观察

- **AC 覆盖矩阵完整**：plan.md Spec Coverage Matrix 11/11 ACs 全部覆盖
- **Per-session 隔离用 Map<sessionId, PlanState>**：满足 AC-11 和 spec FR-9.1
- **`/plan abort` / `/plan status` 子命令完整**：满足 spec FR-1.4 / FR-7.1
- **Reentry 4 选项对话框**：满足 spec FR-1.3
- **`session_before_compact` / `session_before_tree` handler 都已实现**：满足 spec FR-5.6 / FR-5.7
- **`complete` action 调用 `handlePlanComplete`**：满足 spec FR-5.1
- **`tree` case 只 notify 不 inject steer**：满足 spec FR-5.4（**但 goal init 仍触发，见 S3**）
- **`__goalInit` 调用 + 运行时检测 + 缺失降级**：满足 spec FR-6.4，与 coding-workflow 调用模式一致
- **SKILL.md 含 ask_user 工具规范**：满足 spec FR-2.3
- **SKILL.md 含 subagent 检测 4 步骤**：满足 spec FR-6.1~6.3
- **`create-template` 路径遍历防护**：`templateName.replace(/[^a-zA-Z0-9_-]/g, "")` 拒绝特殊字符
- **Abort 流程清理完整**：`sessions.delete(sessionId)` + widget 清理
- **tool.ts execute 签名已修复**（`@typescript-eslint/no-unused-vars: 'error'` 不再触发）：`_toolCallId` / `_signal` / `_onUpdate`
- **compact.ts goal init catch 已修复**（非空 catch 块）：`catch (e) { ctx.ui.notify(...) }`
- **vitest.config.ts 已加入 plan**：File Structure 表 + Task 1 Files + 具体内容
- **BG 内文件数合理**（BG0: 3, BG1: 7, BG2: 10），均在 ≤10 阈值
- **Wave 编排串行清晰**（Wave 1 → 2 → 3），无循环依赖（**但跨组 import 破坏了子 Wave 内部的可执行性**）
- **vitest 配置准备**：`extensions/plan/tsconfig.json` 包含 `"exclude": ["src/__tests__", "dist"]`，与项目约定一致

## 修复优先级建议

按修复优先级（dev 阶段阻断性）：

1. **第一批（dev 会立即阻断）：**
   - M1（6 处跨组 import 违反 → Wave 2 subagent 跑 vitest 时崩溃）
   - M2（package.json 缺 scripts.test + devDependencies.vitest → pnpm --filter test 失败）
2. **第二批（dev 阶段顺手清理）：**
   - S1（"writing" 死代码）、S2（StringEnum）、S3（tree mode 误触发 goal init）
   - L1, L4（silent catch / test import）
3. **第三批（Phase 4 测试阶段）：** L3, L5, L6, L7（tool handler 测试 / E2E 负面场景 / tree 覆盖 / TC 字段）
4. **第四批（Phase 5 / 文档迭代）：** L8（NFR 维度 + /tmp 权限）
5. **第五批（设计精化）：** L2, L9（模板章节 / 任务拆分）

## 结论

**Fail。** 当前 plan.md 整体设计质量高，AC 11/11 覆盖，per-session 隔离、`/plan abort/status`、重入 4 选项、compact/tree handler、`__goalInit` API、SKILL.md 的 ask_user/subagent 检测、路径遍历防护——所有架构关键点都到位。

**但有 2 项 MUST FIX 必须在 dev 阶段前修复**：
- **M1：BG1→BG2 跨组 import 违反**（6 处），Wave 2 subagent 派遣时 ESM 解析直接失败
- **M2：package.json 缺 scripts.test + devDependencies.vitest**，违反项目 CLAUDE.md 测试规范 4 步清单

修复 M1 + M2 后，plan 可进入 dev 阶段无阻断。3 项 SHOULD FIX（S1/S2/S3）建议同步修复以避免 dev 阶段踩坑。9 项 LOW 属于代码风格 / 文档完整性 / 测试模板完整度 / NFR 覆盖度，可在 dev/Phase 4/Phase 5 阶段清理，不阻塞 plan 评审通过。

**v2 关键提示**：
- **M1 是违反 Wave 调度承诺的硬伤**——plan 自己规定 BG1/BG2 串行，但代码静态 import 跨越了 Wave 边界，subagent 派遣时必然失败
- **M2 是违反项目标准（CLAUDE.md 测试规范）的硬伤**——v3 已识别 vitest.config.ts 缺失，v6 修复了 vitest.config.ts 但未把 package.json 三件套（vitest.config.ts + scripts.test + devDependencies.vitest）视为一个原子修改

## 评审元数据

```yaml
review:
  type: plan_review
  round: 2
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
    独立 v2 评审。独立发现 2 项 MUST FIX：
    M1（BG1→BG2 跨组 import 违反 6 处，Wave 2 subagent 派遣时 ESM 解析失败，pre-commit hook 阻断）+
    M2（package.json 缺 scripts.test / devDependencies.vitest，违反项目 CLAUDE.md 测试规范 4 步清单）+
    3 项 SHOULD FIX（S1 PlanPhase "writing" 死代码 / S2 isolation 缺 StringEnum / S3 tree mode 误触发 goal init 违反 spec FR-5.4）+
    9 项 LOW（silent catch / 4/5 模板 stub / tool handler 缺测试 / test import 缺 / E2E 缺负面场景 /
    tree 隔离无 E2E 覆盖 / test_cases 缺字段 / NFR 维度不全 + /tmp 权限 755→1777 / Task 2 test-only）。
    修复 M1 + M2 后 plan 可进入 dev 阶段无阻断。

statistics:
  total_issues: 14
  must_fix: 2
  should_fix: 3
  low: 9
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
    - category: "设计完整性（silent catch / 模板 / 测试覆盖）"
      count: 4
      items: [L1, L2, L3, L9]
    - category: "测试完整性（import / 字段 / 覆盖度）"
      count: 3
      items: [L4, L5, L7]
    - category: "测试完整性（tree 隔离 E2E/TC 覆盖）"
      count: 1
      items: [L6]
    - category: "文档完整性（NFR 维度 + /tmp 权限）"
      count: 1
      items: [L8]
```

## MUST_FIX 列表

以下是评审中识别的所有 MUST FIX 问题，dev 阶段必须先修复：

### MUST_FIX_1
- **文件路径：** `plan.md` Task 1/3/4 跨组 import 段
- **问题：** BG1→BG2 跨组 import 违反 6 处，Wave 2 subagent 派遣时 ESM 解析失败
- **修复方向：** 把 templates.ts / widget.ts 移到 BG1；tool.ts 改 dynamic import compact.js；command.ts / index.ts 同样改 dynamic import

### MUST_FIX_2
- **文件路径：** `plan.md` Task 1 Step 3 `package.json` 代码块
- **问题：** 缺 `scripts: { "test": "vitest run", "typecheck": "npx tsc --noEmit" }` 和 `devDependencies: { "vitest": "^4.1.8" }`
- **修复方向：** 在 package.json 添加 scripts 和 devDependencies 字段，参考 `extensions/todo/package.json`
