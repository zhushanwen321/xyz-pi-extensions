---
verdict: fail
must_fix: 2
complexity: L1
review:
  type: plan_review
  round: 3
  mode: "Mode 1: Plan feasibility"
  timestamp: "2026-06-11T15:20:00+08:00"
  target: ".xyz-harness/2026-06-11-plan-mode/plan.md"
  related:
    - e2e-test-plan.md
    - test_cases_template.json
    - use-cases.md
    - non-functional-design.md
  reviewer: content-quality-reviewer
  summary: |
    独立 v3 评审（重新审查当前 plan.md，非回归 v1/v2）。
    上一轮 plan_review_v3.md 标记的 14 项 MUST FIX 在当前 plan.md 中**全部已修复**：
    M2/M3/M4/M5/M6/M7/M8/M9/M10/N1/N11/N12/N13/N14 均已解决。
    独立审查发现 2 项新 MUST FIX，均为 pre-commit hook 阻断级别的 lint 问题：
    (1) plan.md Task 3 tool.ts 的 execute 签名中 toolCallId/signal/onUpdate 三个参数
    均未使用但缺少 `_` 前缀，违反 taste-lint 的 no-unused-vars 规则；
    (2) plan.md Task 6 compact.ts 的 goal init catch 块为空（只有注释），
    违反 taste-lint 的 no-silent-catch 规则。
    此外 11 项 LOW 问题遗留（test 文件缺 import、e2e 缺 negative scenario、
    test_cases 缺 expected_result、use-cases UC 不足 11、non-functional 缺维度、
    4/5 内置模板为 stub、M3 外层 try/catch 死代码残留等），均不阻塞 dev。
---

# Plan Review v3 — Pi Plan Mode Extension (Independent Round)

## 评审记录

- **评审时间：** 2026-06-11 15:20
- **评审类型：** Plan 评审（Mode 1: 验证 plan 可实施性）
- **评审对象：** `.xyz-harness/2026-06-11-plan-mode/plan.md` 及关联 `e2e-test-plan.md` / `test_cases_template.json` / `use-cases.md` / `non-functional-design.md`
- **交叉对照：** spec.md、`plan-mode-design.md`、`shared/taste-lint/base.mjs`、`shared/taste-lint/rules/no-silent-catch.mjs`、`extensions/todo/src/tool.ts`（execute 签名惯用模式）、`extensions/goal/src/index.ts:390-422`（`__goalInit` 实际签名）、根目录 `tsconfig.json`（strict 模式与 __tests__ 排除）、根目录 `eslint.config.mjs`、根目录 `.githooks/pre-commit`
- **前序 review 文件：** `plan_review_v3.md`（旧版，评审 14 项 MUST FIX，已全部修复）；`plan_review_v4.md`（PASS）；`plan_review_v1.md`（独立 4 项 MUST FIX）；`plan_review_v2.md`（独立 PASS + 7 LOW）。本评审为独立第三轮。
- **评审模式：** 重新阅读当前 5 份 deliverable + 项目 lint/tsconfig 配置，独立判断

## 总体评估

**当前 plan.md 整体质量高**：8 个 Task（含 Task 0 项目同步）、3 个 Execution Group（BG0/BG1/BG2）、Spec Coverage Matrix 11/11 覆盖、Interface Contracts 完整、TDD 步骤清晰、Wave 1→2→3 串行无循环依赖、单 session 隔离用 `PlanSessionMap = Map<string, PlanState>` 满足 AC-11、`/plan abort` / `/plan status` 子命令 + 重入 4 选项 + `session_before_compact` / `session_before_tree` handler + `__goalInit` API + `create-template` 路径遍历防护 + SKILL.md 含 ask_user / subagent 检测 —— **所有 v3 前序 MUST FIX 已修复**。

但独立审查发现 2 项新的 MUST FIX：

1. **plan.md Task 3 tool.ts 的 execute 签名有 3 个未使用参数无 `_` 前缀**（toolCallId / signal / onUpdate），违反项目 taste-lint 的 `@typescript-eslint/no-unused-vars` 规则（`argsIgnorePattern: '^_'`）。`extensions/todo/src/tool.ts` 已有正确模式：`_toolCallId` / `_onUpdate`。Dev 阶段复制 plan 示例代码后会立即在 pre-commit hook 阻断。

2. **plan.md Task 6 compact.ts 的 goal init catch 块为空**（`} catch { /* goal init failure is non-blocking */ }`），违反项目 taste-lint 的 `no-silent-catch` 规则（`emptyCatch` 报告）。`shared/taste-lint/rules/no-silent-catch.mjs` 第 56-58 行：`if (body.length === 0) context.report({ node, messageId: 'emptyCatch' })` —— 注释不构成 statement，因此 body.length === 0。Dev 阶段 pre-commit 阻断。

**这两项是 pre-commit hook 阻断级别**，必须在 dev 启动前修复。v1/v2 评审均未发现（v2 LOW #4 只标了 silent catch 为 LOW，未升级到 MUST FIX；v1 焦点在 dependency graph 与 use-cases 完整性）。

## v3 前序 MUST FIX 回归验证（14 项）

| v3 编号 | 描述 | 状态 | 证据 |
|---------|------|------|------|
| M2 | `complete` 不触发 `handlePlanComplete` | ✅ **已修复** | plan.md Task 3 `case "complete"` 末尾 `handlePlanComplete(pi, ctx, state, isolation);` |
| M3 | compact 双重错误处理 | ⚠️ **部分修复** | onError 签名已正为 `(_error: Error)`；**外层 try/catch 仍存在**（LOW #1 详述）|
| M4 | `/plan abort` 子命令缺失 | ✅ **已修复** | Task 4 command.ts 头部 `if (trimmed === "abort")` 分支完整 + `if (trimmed === "status")` 分支 |
| M5 | 重入逻辑缺失 | ✅ **已修复** | Task 4 `if (!state.isActive && !trimmed)` 块扫描 `/tmp/plan-*.md` 并 sendUserMessage 4 选项 |
| M6 | SKILL.md 缺 subagent 检测 | ✅ **已修复** | Task 7 SKILL.md Phase D3 4 步（check subagent tool、wave 并行 / 单 agent 分阶段）|
| M7 | SKILL.md 缺 ask_user 工具 | ✅ **已修复** | Task 7 SKILL.md B2 "Use `ask_user` tool (from pi-ask-user)" |
| M8 | `onError` 签名错误 | ✅ **已修复** | Task 6 `onError: (_error: Error) => {...}` |
| M9 | `extension-dependencies.json` 未更新 | ✅ **已修复** | Task 0 Step 2 添加 `@zhushanwen/pi-plan` 条目（optional pi-goal 依赖）|
| M10 | `package.json` 字段不一致 | ✅ **已修复** | Task 1 package.json 含 `main: "src/index.ts"`、`keywords: ["pi-package", "extension"]`、`license: "MIT"`、`peerDependencies` |
| N1 | `tree` case 错误注入 steer | ✅ **已修复** | Task 6 `case "tree"` 只调用 `ctx.ui.notify(...)`，不调用 `pi.sendUserMessage` |
| N11 | 工厂函数级 `const state` 闭包变量 | ✅ **已修复** | Task 4 index.ts 使用 `const sessions: PlanSessionMap = new Map()` + `session_start` 重建 + `session_end` 清理 |
| N12 | 缺 CLAUDE.md 更新任务 | ✅ **已修复** | Task 0 Step 1 在 BG0 阶段同步更新 CLAUDE.md 目录结构和"当前包清单" |
| N13 | 缺 changeset 任务 | ✅ **已修复** | Task 0 Step 3 创建 `.changeset/plan-mode-init.md` |
| N14 | Task 5 BG 归属 + tool.ts 跨组矛盾 | ✅ **已修复** | File Structure 把 command.ts / tool.ts 都标为 BG1；BG1 = Task 1-4（state / state 测试 / tool / command）；BG2 = Task 5-7（templates / compact / SKILL）|

**结论：v3 前序 14 项 MUST FIX 中 13 项完全修复，1 项（M3）部分修复（不影响功能但有 dead code 残留）。**

## v3 独立新发现 MUST FIX（2 项）

### M15. plan.md Task 3 tool.ts execute 签名 3 个未使用参数无 `_` 前缀（pre-commit 阻断）

**位置：** `plan.md` Task 3 Step 3 `tool.ts` 行 716-723

**严重度：** must_fix（taste-lint `no-unused-vars` 错误，pre-commit hook 阻断）

**问题：**

```typescript
async execute(
  toolCallId: string,                    // ← 未使用，无 _ 前缀
  params: Record<string, unknown>,
  signal: AbortSignal,                    // ← 未使用，无 _ 前缀
  onUpdate: (partial: { content: Array<{ type: string; text: string }> }) => void,  // ← 未使用，无 _ 前缀
  ctx: ExtensionContext,
) {
  const action = params.action as string;
  ...
  const sessionId = ctx.sessionId ?? "default";
  const state = getPlanState(sessions, sessionId, ctx);
  ...
```

函数体内**完全没有引用** `toolCallId` / `signal` / `onUpdate`，只用了 `params` 和 `ctx`。

**根因（lint 规则）：** `shared/taste-lint/base.mjs` 第 40 行：
```javascript
'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
```

`argsIgnorePattern: '^_'` 意味着未使用参数必须以 `_` 开头才被忽略。三个参数均无 `_` 前缀 → ESLint `error` 级 → pre-commit hook 阻断 commit。

**项目既有正确模式：** `extensions/todo/src/tool.ts:25`：

```typescript
async execute(_toolCallId: string, params: Static<typeof TodoParams>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
    // P1-5: 尊重 signal —— 异步被取消时提前返回
    if (signal?.aborted) {
      return {
        content: [{ type: "text" as const, text: "Todo call aborted by signal." }],
```

项目用 `_toolCallId` / `_onUpdate`（带 `_` 前缀）+ `signal` 实际使用（abort 检查）。plan 模式没有 abort 检查需求，但 unused 参数必须带 `_` 前缀。

**修复方向（dev 实施前 1 行修改）：**

方案 A（推荐，匹配 todo 模式）：参数名加 `_` 前缀 + 可选加 abort 检查：
```typescript
async execute(
  _toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  _onUpdate: (partial: { content: Array<{ type: string; text: string }> }) => void,
  ctx: ExtensionContext,
) {
  if (signal?.aborted) {
    return { content: [{ type: "text" as const, text: "Plan tool aborted by signal." }], details: {} };
  }
  ...
```

方案 B（最小修改）：仅加 `_` 前缀：
```typescript
async execute(
  _toolCallId: string,
  params: Record<string, unknown>,
  _signal: AbortSignal,
  _onUpdate: (partial: { content: Array<{ type: string; text: string }> }) => void,
  ctx: ExtensionContext,
) {
```

**为什么是 MUST FIX（不是 LOW）：**
- pre-commit hook 会立即阻断 dev 第一次 commit
- 不是 dev 可以"自然发现并修复"的问题（实施 subagent 复制 plan 代码后才发现）
- 修复合规成本极低（5 个字符修改），但 plan.md 必须先正确

### M16. plan.md Task 6 compact.ts goal init catch 块为空（pre-commit 阻断）

**位置：** `plan.md` Task 6 Step 1 `compact.ts` 末尾行 1268-1273

**严重度：** must_fix（taste-lint `no-silent-catch` 错误，pre-commit hook 阻断）

**问题：**

```typescript
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
```

catch 块**只有一个注释**，无任何语句。注释不构成 statement。

**根因（lint 规则）：** `shared/taste-lint/rules/no-silent-catch.mjs` 第 56-58 行：
```javascript
if (body.length === 0) {
  context.report({ node, messageId: 'emptyCatch' });
}
```

注释不计为 statement，因此 `body.length === 0` → 报告 `emptyCatch: 空 catch 块吞掉了错误，至少需要记录日志。` → ESLint `error` 级 → pre-commit hook 阻断。

**修复方向：**

最小修改（满足 lint + 保持 non-blocking 语义）：
```typescript
  } catch (error) {
    // goal init 失败不阻塞 plan 完成流程（用户可手动 /goal）
    console.debug("[plan] goal init failed:", error);
  }
```

或匹配项目既有 pattern（`extensions/coding-workflow/lib/tool-handlers.ts:520-525` 用 `try { ... } catch { /* non-blocking */ }`）——但**该项目 pattern 也违反 `no-silent-catch` 规则**，只是历史遗留。`/Users/zhushanwen/Code/xyz-pi-extensions-workspace/feat-plan-mode/extensions/coding-workflow/lib/tool-handlers.ts:520` 实际跑 eslint 时也会报错。Plan 不应该沿用错误 pattern。

**为什么是 MUST_FIX：**
- 同 M15，pre-commit hook 阻断
- catch 块语义是 "non-blocking fallback" 但**没有 fallback 逻辑**，plan.md 应该至少有 console.debug / ctx.ui.notify 之一
- v2 LOW #4 提到这个 catch 但**未升级到 MUST FIX**——v2 误判其优先级（认为"与 coding-workflow 一致"），但 coding-workflow 的模式本身就是 lint 错误的

## v3 独立新发现 LOW（11 项，不阻塞）

### LOW #1: M3 外层 try/catch 死代码残留（v3 前序部分修复）

**位置：** `plan.md` Task 6 compact.ts `case "compact"` 块

**问题：**
```typescript
case "compact": {
  try {
    ctx.compact({
      customInstructions: `Plan file: ${state.planFilePath}. Read and execute.`,
      onComplete: () => { ... },
      onError: (_error: Error) => { ... fallback ... },
    });
  } catch {
    ctx.ui.notify("Compact failed, continuing without isolation.", "warning");
    pi.sendUserMessage(steerMessage, { deliverAs: "steer" });
  }
  break;
}
```

**为什么不修复就 OK：** SDK `agent-session.js:1302-1316` 的 `compact()` 内部用 IIFE 包裹 try/catch，错误只走 `options?.onError?.(err)`，**不会**作为同步异常向外抛出。所以外层 try/catch 永远不会触发，是死代码。但 onError 已处理所有错误路径，fallback 行为正确。

**修复方向（不阻塞 dev）：** 删除外层 try/catch，保留 onError，与 coding-workflow 一致。

### LOW #2: Task 1 / Task 2 测试文件缺 import

**位置：** `plan.md` Task 1 Step 1 `state.test.ts` 行 471、Task 2 Step 1 `state.test.ts` 行 558

**问题：** 两个测试文件都使用 `ExtensionContext` / `ExtensionAPI` 类型，但 import 语句没有包含：

```typescript
// Task 1
import { describe, it, expect, vi } from "vitest";
import { DEFAULT_PLAN_STATE, type PlanState, type PlanPhase, type PlanSessionMap, getPlanState } from "../state.js";
// ← 缺 import { ExtensionContext } from "@mariozechner/pi-coding-agent"

describe("PlanState", () => {
  ...
  const mockCtx = {
    sessionManager: { getEntries: () => [] },
  } as unknown as ExtensionContext;  // ← TS2304: Cannot find name 'ExtensionContext'
```

```typescript
// Task 2
import { persistPlanState, reconstructPlanState } from "../state.js";
// ← 缺 import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"

it("persistPlanState calls appendEntry with correct data", () => {
  const mockPi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;  // ← TS2304
```

**为什么不是 MUST FIX：** 根 tsconfig 和 `extensions/plan/tsconfig.json` 都 exclude 了 `**/__tests__`，`tsc --noEmit` 不会扫到。Vitest 用 esbuild 转译（容忍未知标识符），vitest run 不会失败。Dev 阶段 IDE 会标红，但不影响 CI。

**修复方向（不阻塞）：** 在测试文件顶部加：
```typescript
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
```

### LOW #3: `session_before_compact` handler 缺 `firstKeptEntryId` / `tokensBefore` 字段

**位置：** `plan.md` Task 6 compact.ts `registerPlanEventHandlers` 行 1216-1228

**问题：**
```typescript
return {
  compaction: {
    summary: `Plan mode completed. ...`,
    // ← 缺 firstKeptEntryId / tokensBefore
  },
};
```

`plan-mode-design.md` 第 5.7 节示例包含这两个字段。SDK 内部从 `extensionCompaction.firstKeptEntryId` 读取用于 `appendCompaction`。缺失时 SDK 用 `getCompaction()` 默认值，行为正确但失去精确控制。

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

### LOW #4: e2e-test-plan.md 全部 9 个 TS 缺 negative scenario

**位置：** `e2e-test-plan.md` 全文

**问题：** 9 个测试场景都是 happy path。`plan.md` 中有大量 `throw new Error` 错误处理路径（未知 action、模板不存在、templateName 为空、路径遍历字符、`/plan abort` 不在 plan mode 时等）无对应 E2E 覆盖。

**修复方向（不阻塞 dev）：** 补充 TS-N-1 ~ TS-N-5。

### LOW #5: test_cases_template.json 缺 `expected_result` 字段

**位置：** `test_cases_template.json` 18 个 case

**问题：** 所有 test case 仅有 `id` / `type` / `title` / `description` / `steps`，缺 `expected_result` / `priority` / `ac_coverage` 结构化字段。Phase 4 测试编写 subagent 需要推断期望值。

**修复方向（不阻塞 dev）：** 给每个 case 加 `expected_result` + `priority` 字段。

### LOW #6: use-cases.md 仅 4 个 UC，design.md 列 11 个

**位置：** `use-cases.md` 全文

**问题：** `plan-mode-design.md` 列出 11 个 UC（UC-1 ~ UC-11），当前 use-cases.md 只覆盖 4 个（UC-1~UC-4），缺失：
- UC-3 (重构规划) — 在 design.md 中独立
- UC-6 (Plan 迭代修改) — 涉及 spec FR-3.4
- UC-7 (中途切换到 Plan Mode) — 涉及 spec FR-1.8
- UC-9 (查看已有 Plan) — 涉及 spec FR-1.3 重入
- UC-10 (Plan 完成后进入实现) — 当前只作为 UC-1 步骤 11
- UC-11 (非代码任务规划)

use-cases.md 末尾"未覆盖的 AC"段已声明 AC-10/11 由 TC-8/TC-9 覆盖，但 UC 缺口未解释。

**修复方向（不阻塞 dev）：** 在 use-cases.md 增加一段"为什么缩减"说明（哪些 UC 合并到现有 4 个中），或在每个合并后 UC 的 Alternative Paths 中列出被合并场景的差异化处理。

### LOW #7: non-functional-design.md 缺多个 NFR 维度

**位置：** `non-functional-design.md` 5 个段落（稳定性 / 数据一致性 / 性能 / 业务安全 / 数据安全）

**缺失维度：**
- 可扩展性（模板 > 50 个时的性能、新增 plan action 的 API 稳定性）
- 可维护性（模块拆分、测试覆盖率目标）
- 可观测性（错误日志策略、关键状态变更的日志粒度）
- 兼容性（Pi 旧版本、Windows /tmp 路径 `%TEMP%`）
- 错误处理（appendEntry 失败、状态文件损坏、template I/O 错误路径）
- 资源管理（`/tmp` 长期累积 plan 文件的风险，spec 已声明不主动清理但 NFR 应说明累积影响）
- 跨 extension 契约稳定性（`__goalInit` 通过 `as Record<string, unknown>` 访问是 hack，pi-goal 重构时 plan 静默失败）

**修复方向（不阻塞 dev）：** 增加 1-2 段覆盖上述维度。

### LOW #8: 4/5 内置模板为 stub，章节结构未定义

**位置：** `plan.md` Task 5 Step 3 `templates/` 目录

**问题：** plan.md 只给出 `feature-plan.md` 的完整内容（6 章节），其他 4 个（bugfix / refactor / research / implementation）只写"（其他 4 个模板类似，各有不同的章节结构）"。

Phase 3 subagent 需要自行设计这 4 个模板的章节结构，缺少规格约束会导致：
- 各 subagent 设计风格不统一
- feature-plan 与其他模板章节粒度不一致
- test case 中断言 `expect(content).toContain("## ")` 太宽松，不能验证章节顺序

**修复方向（不阻塞 dev）：** 在 plan.md 中列出每个模板的预期章节列表（如 bugfix-plan: Symptom / Root Cause / Fix Strategy / Verification / Rollback）。

### LOW #9: `__goalInit` 类型签名不匹配（`Record<string, unknown>` vs 具体 budget 对象）

**位置：** `plan.md` Task 6 compact.ts `GoalInitFn` 类型 + 调用点

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

### LOW #10: Task 2 是 test-only 任务，与 Task 1 重复

**位置：** `plan.md` Task 2 全文

**问题：** Task 1 已实现 `persistPlanState` / `reconstructPlanState`，Task 2 的 Step 1 只是在 `state.test.ts` 中**追加测试**，不修改 index.ts 也不引入新功能。Task 2 Step 2 直接说"Expected: PASS (persistence functions already implemented in Task 1)"——明确承认是补测试。

**为什么不修复就 OK：** v1 SHOULD_FIX-4 已记录，v2 未改。Task 2 拆分有助于 BG1 内部分批派遣（3 个 subagent 而不是 2 个），但描述应为 "test-only (补 Task 1 持久化函数测试)"。

**修复方向（不阻塞 dev）：** 改 Task 2 标题为 "State 持久化测试增量" + Type 改为 "test-only"。

### LOW #11: `/tmp/plan-{slug}.md` 全局共享，跨项目泄漏

**位置：** `plan.md` Task 4 command.ts reentry 扫描 + `non-functional-design.md` §5 数据安全

**问题：** `os.tmpdir() + plan-{slug}.md` 是 OS 级别共享路径。两个不同项目使用 Pi 会在同一 `/tmp/plan-*.md` 池中产生文件。Task 4 reentry 逻辑扫描 `/tmp/plan-*.md` 会**误捡其他项目的 plan 文件**，提示用户的 4 选项（继续/实现/新建/取消）会指向其他项目的 plan。

spec FR-1.6 已规定 `/tmp/plan-{slug}.md`，所以这是 spec 设计选择而非 plan 错误。但 plan 应当显式声明"接受跨项目泄漏"或建议扩展为 `<projectHash>-plan-{slug}.md`（spec 升级到 v2 再改）。

**修复方向（不阻塞 dev）：** 在 plan.md Task 4 reentry 段加注释说明跨项目行为；在 non-functional-design.md §5 数据安全段加"跨项目泄漏风险"小节。

## v3 跨文件一致性检查

| 检查项 | plan.md | e2e-test-plan.md | test_cases_template.json | use-cases.md | non-functional-design.md | 结论 |
|--------|---------|------------------|--------------------------|--------------|--------------------------|------|
| AC 覆盖 | 11/11 (matrix) | 9 TS, 11 AC | 18 TC, 11 AC | 4 UC 显式 + TC 补 AC-10/11 | 未涉及 | ✅ 一致 |
| 模板数量 | 5 builtin (1 完整 + 4 stub) | 未涉及 | TC-8 验证 | UC-1~4 引用 4 templates | 未涉及 | ⚠️ stub 模板（LOW #8）|
| 状态机 | 4 phases | 同 | 同 | 同 | 同 | ✅ 一致 |
| 隔离方式 | 3 options (compact/tree/direct) | TS-5/6 覆盖 2 (compact/direct) | TC-5/6 覆盖 2 | UC-3 提及 direct | §1 稳定性 | ⚠️ tree 选项无 E2E/TC 覆盖 |
| Extension 依赖 | Task 0 Step 2 声明 | 未涉及 | 未涉及 | UC-1 提及 goal | 未涉及 | ✅ 一致 |
| Subagent 检测 | SKILL.md Phase D3 | 未涉及 | 未涉及 | UC-1 提及 "wave 并行" | 未涉及 | ✅ 一致 |
| Multi-session 隔离 | PlanSessionMap (Task 4) | TS-9 覆盖 | TC-9-01 覆盖 | 未涉及 | §2 简述 | ✅ 一致 |
| TUI 状态栏 | widget.ts (Task 5) | 未涉及 | TC-10-01/02 覆盖 | 未涉及 | 未涉及 | ✅ 一致 |
| Lint 兼容 | 2 处违规 (M15/M16) | n/a | n/a | n/a | n/a | ❌ 不一致（pre-commit 阻断）|

## v3 接口契约审查

| 接口 | plan.md 定义 | 实现位置 | 一致性 |
|------|------------|---------|--------|
| `PlanPhase` | 4 枚举值 | state.ts | ✅ |
| `PlanState` | 5 字段 | state.ts | ✅ |
| `PlanSessionMap` | `Map<string, PlanState>` | state.ts | ✅（v3 关键修复）|
| `getPlanState` | (sessions, sessionId, ctx) → PlanState | state.ts | ✅ |
| `persistPlanState` | (pi, state) → void | state.ts | ✅ |
| `reconstructPlanState` | (ctx) → PlanState | state.ts | ✅ |
| `executePlanTool` | (pi, ctx, sessions, action, params) → ToolResult | tool.ts | ✅ 但 execute 签名有 lint 问题 (M15) |
| `listTemplates` | (projectDir?) → TemplateInfo[] | templates.ts | ✅ |
| `loadTemplate` | (name, projectDir?) → string \| null | templates.ts | ✅ |
| `handlePlanComplete` | (pi, ctx, state, isolation) → void | compact.ts | ✅ 但 goal init catch 块 lint 问题 (M16) |
| `updatePlanWidget` | (ctx, state) → void | widget.ts | ✅ |

## v3 后端设计充分性检查（L1）

按 SKILL 的 L1 后端检查清单逐项：

1. **"为什么"而非"做什么"**：✅ Task 3 tool.ts 每个 action 都有清晰目的；Task 6 compact.ts handlePlanComplete 注释解释了 tree case 为何不注入 steer
2. **存储变更选型理由**：✅ Task 0 Step 2 注释 "Extension 依赖管理 [MANDATORY]"；Task 1 Step 3 state.ts 注释 "per-session 隔离"
3. **API 端点与业务场景对应**：✅ 5 个 action 对应 spec FR-3.2 / FR-4.4 / FR-5.1 / FR-7.2 / FR-3.2 五个场景
4. **边界条件 / 异常处理**：
   - ✅ select-template: `loadTemplate` 返回 null 时 throw
   - ✅ create-template: 路径遍历防护 + 必填字段校验
   - ✅ complete: 必传 isolation（default 为 "direct"）
   - ✅ abort: 不在 plan mode 时 notify "No active plan mode"
   - ⚠️ LOW #1: compact 错误处理有冗余 try/catch
   - ❌ M15/M16: lint 规则违反
5. **非功能性要求对应 task**：✅ Task 5 性能（listTemplates 三层扫描）、Task 6 稳定性（compact 失败降级）

## 关键正面观察

- **AC 覆盖矩阵完整**：plan.md Spec Coverage Matrix 11/11 ACs 全部覆盖
- **Per-session 隔离用 Map<sessionId, PlanState>**：满足 AC-11 和 spec FR-9.1
- **`/plan abort` / `/plan status` 子命令完整**：满足 spec FR-1.4 / FR-7.1
- **Reentry 4 选项对话框**：满足 spec FR-1.3
- **`session_before_compact` / `session_before_tree` handler 都已实现**：满足 spec FR-5.6 / FR-5.7
- **`complete` action 调用 `handlePlanComplete`**：满足 spec FR-5.1
- **`tree` case 只 notify 不 inject steer**：满足 spec FR-5.4
- **`__goalInit` 调用 + 运行时检测 + 缺失降级**：满足 spec FR-6.4，与 coding-workflow 调用模式一致
- **SKILL.md 含 ask_user 工具规范**：满足 spec FR-2.3
- **SKILL.md 含 subagent 检测 4 步骤**：满足 spec FR-6.1~6.3
- **`create-template` 路径遍历防护**：`templateName.replace(/[^a-zA-Z0-9_-]/g, "")` 拒绝特殊字符
- **Abort 流程清理完整**：`sessions.delete(sessionId)` + widget 清理
- **BG 内文件数合理**（BG0: 3, BG1: 7, BG2: 10），均在 ≤10 阈值
- **Wave 编排串行清晰**（Wave 1 → 2 → 3），无循环依赖
- **vitest 配置正确**：`extensions/plan/tsconfig.json` 包含 `"exclude": ["src/__tests__", "dist"]`，与项目约定一致
- **TDD 步骤完整**（除 Task 4 / 6 / 7 偏实现）：Task 1 / 2 / 3 / 5 都有 Step 1 写失败测试 → Step 3 实现 → Step 4 验证

## 修复优先级建议

按修复优先级（dev 阶段阻断性）：

1. **第一批（dev 会立即阻断）：** M15 + M16（pre-commit hook 阻断）
2. **第二批（dev 阶段顺手清理）：** LOW #1（死代码）、LOW #2（test import）、LOW #3（firstKeptEntryId）
3. **第三批（Phase 4 阶段清理）：** LOW #4 + LOW #5（e2e/test_cases 字段补全）
4. **第四批（Phase 5 / 文档迭代）：** LOW #6 + LOW #7（UC + NFR 完整性）
5. **第五批（设计精化）：** LOW #8 + LOW #9 + LOW #10 + LOW #11

## 结论

**Fail。** 当前 plan.md 整体设计质量高，所有 v3 前序 14 项 MUST FIX 全部已修复（13 项完全 + 1 项 M3 部分）。但独立审查发现 **2 项新 MUST FIX**（M15 工具签名 unused 参数、M16 goal init 空 catch 块），均会被 pre-commit hook 阻断——dev 阶段实施 subagent 复制 plan 示例代码后会立即遇到。

修复 M15 + M16 后，plan 可进入 dev 阶段无阻断。11 项 LOW 属于代码风格 / 文档完整性 / 测试模板完整度，均可在 dev/Phase 4/Phase 5 阶段清理，不阻塞 v3 评审通过。

**v3 关键提示：M15（unused 参数）和 M16（silent catch）是 v1/v2 评审漏掉的具体 lint 阻断问题。** v1 焦点在 dependency graph 与 use-cases 完整性，v2 焦点在 v3 回归验证 + LOW 标注——两者均未对 plan.md 中的代码示例做 lint 静态检查。v4 评审虽然 PASS，但 review 文档（plan_review_v4.md）只列出"v3 的 14 项 MUST FIX 全部修复"作为 fix_summary，未单独执行 lint 兼容性检查。

## 评审元数据

```yaml
review:
  type: plan_review
  round: 3
  mode: "Mode 1: Plan feasibility"
  timestamp: "2026-06-11T15:20:00+08:00"
  target: ".xyz-harness/2026-06-11-plan-mode/plan.md"
  related:
    - e2e-test-plan.md
    - test_cases_template.json
    - use-cases.md
    - non-functional-design.md
  verdict: fail
  summary: |
    独立 v3 评审。v3 前序 14 项 MUST FIX 全部已修复（13 完全 + 1 部分）。
    独立发现 2 项 MUST FIX（M15 unused 参数 + M16 silent catch，pre-commit 阻断）
    + 11 项 LOW。修复 2 项 MUST FIX 后可进入 dev。

statistics:
  total_issues: 13
  must_fix: 2
  low: 11
  must_fix_breakdown:
    - category: "taste-lint 阻断（pre-commit hook）"
      count: 2
      items: [M15, M16]
  v3_prior_validation:
    confirmed_fixed: 13  # M2, M4, M5, M6, M7, M8, M9, M10, N1, N11, N12, N13, N14
    confirmed_partially_fixed: 1  # M3 (dead code residual)
    confirmed_unfixed: 0
  v3_independent_new:
    must_fix: 2  # M15, M16
    low: 11
```
