---
verdict: fail
must_fix: 1
complexity: L1
review:
  type: plan_review
  round: 2
  mode: "Mode 1: Plan feasibility"
  timestamp: "2026-06-11T16:30:00+08:00"
  target: ".xyz-harness/2026-06-11-plan-mode/plan.md"
  related:
    - e2e-test-plan.md
    - test_cases_template.json
    - use-cases.md
    - non-functional-design.md
  reviewer: content-quality-reviewer
  summary: |
    独立 v2 评审（重新审查当前 5 份 deliverable + 项目 lint/tsconfig/vitest 配置）。
    v3 标记的 2 项 MUST FIX（M15 tool.ts 签名 + M16 goal init catch）已修复。
    但 v1 标记的 1 项 MUST FIX（M1 vitest.config.ts 缺失）仍存在于当前 plan.md，
    pre-commit hook 的 vitest 步骤会阻断 dev 第一次 commit。
    11 项 LOW 问题（死代码、test import、firstKeptEntryId、E2E 缺负面场景、
    test_cases 缺 expected_result、UC 不足、NFR 维度不全、4/5 模板 stub、
    GoalInitFn 类型、Task 2 test-only、/tmp 跨项目泄漏）均不阻塞 dev。
---

# Plan Review v2 — Pi Plan Mode Extension (Independent Round)

## 评审记录

- **评审时间：** 2026-06-11 16:30
- **评审类型：** Plan 评审（Mode 1: 验证 plan 可实施性）
- **评审对象：** `.xyz-harness/2026-06-11-plan-mode/plan.md` 及关联 `e2e-test-plan.md` / `test_cases_template.json` / `use-cases.md` / `non-functional-design.md`
- **交叉对照：** `spec.md`、`plan-mode-design.md`、`shared/taste-lint/base.mjs`、`shared/taste-lint/rules/no-silent-catch.mjs`、`extensions/context-engineering/vitest.config.ts`、`extensions/todo/src/tool.ts`（execute 签名惯用模式）、`extensions/goal/src/index.ts:390-422`（`__goalInit` 实际签名）、根目录 `tsconfig.json`、根目录 `eslint.config.mjs`、根目录 `.githooks/pre-commit`、根目录 `CLAUDE.md` 测试规范
- **前序 review 文件：** `plan_review_v1.md`（fail, 1 MUST FIX）、`plan_review_v2.md`（v1 时代 PASS + 7 LOW）、`plan_review_v3.md`（fail, 2 MUST FIX）、`plan_review_v4.md`（PASS）、`plan_review_v5.md`（PASS）。本评审为独立的 v2 轮次，重新阅读当前 5 份 deliverable 后独立判断。
- **评审模式：** 独立审查当前 5 份 deliverable + 项目 lint/tsconfig/vitest 配置，独立判断。不依赖历史 review 结论。

## 总体评估

**当前 plan.md 整体设计质量高**：8 个 Task（含 Task 0 项目同步）、3 个 Execution Group（BG0/BG1/BG2）、Spec Coverage Matrix 11/11 覆盖、Interface Contracts 完整、TDD 步骤清晰（除 Task 4/6/7）、Wave 1→2→3 串行无循环依赖、单 session 隔离用 `PlanSessionMap = Map<string, PlanState>` 满足 AC-11、`/plan abort` / `/plan status` 子命令 + 重入 4 选项 + `session_before_compact` / `session_before_tree` handler + `__goalInit` API + `create-template` 路径遍历防护 + SKILL.md 含 ask_user / subagent 检测——架构设计完整。

**v3 标记的 2 项 MUST FIX 已全部修复**（M15 tool.ts 签名 + M16 goal init catch），**但 v1 标记的 1 项 MUST FIX（M1 vitest.config.ts 缺失）仍存在于当前 plan.md**，是 pre-commit hook 阻断级别问题。

**v2 独立发现：1 项 MUST FIX + 11 项 LOW 问题**（与 v3 的 11 项 LOW 列表基本一致）。

## 前序 MUST FIX 回归验证

| 轮次 | 编号 | 描述 | 状态 | 证据 |
|------|------|------|------|------|
| v1 | M1 | 缺少 `extensions/plan/vitest.config.ts` | ❌ **未修复** | plan.md File Structure 表（行 38-41）+ Task 1 Files 列表（行 326-332）+ Task 1 Step 3（行 415-431）均未包含 vitest.config.ts。详见下文 MUST FIX 详述。 |
| v3 | M15 | tool.ts execute 签名 unused 参数无 `_` 前缀 | ✅ **已修复** | plan.md Task 3 Step 3（行 716-723）：`_toolCallId: string, _signal: AbortSignal, _onUpdate: ...` — 三个未使用参数均带 `_` 前缀 |
| v3 | M16 | compact.ts goal init catch 块为空 | ✅ **已修复** | plan.md Task 6 Step 1（行 1268-1273）：`} catch (e) { ctx.ui.notify(\`Goal init failed: ${e}\`, "warning"); }` |

**结论：v3 的 2 项 MUST FIX 完全修复，v1 的 1 项 MUST FIX 仍未修复。**

## MUST FIX（1 项，pre-commit hook 阻断级别）

### M1: plan.md 缺少 `extensions/plan/vitest.config.ts` 创建任务

**位置：** `plan.md` Task 1 `Files:` 列表（行 326-332）+ 整体 File Structure 表格（行 38-41）

**严重度：** must_fix（pre-commit hook 的 vitest 步骤会因缺配置而失败）

**问题：**

plan.md 计划在 `extensions/plan/src/__tests__/` 下创建 3 个测试文件（`state.test.ts` / `templates.test.ts` / `compact.test.ts`），但 **File Structure 表格和 Task 1/Task 5 文件列表均未包含 `extensions/plan/vitest.config.ts`**。

```yaml
# plan.md 行 38-41 (File Structure 表)
| `extensions/plan/src/__tests__/state.test.ts` | create | BG1 | 状态管理测试 |
| `extensions/plan/src/__tests__/templates.test.ts` | create | BG2 | 模板系统测试 |
| `extensions/plan/src/__tests__/compact.test.ts` | create | BG2 | compact handler 测试 |
```

```yaml
# plan.md 行 326-332 (Task 1 Files)
- Create: `extensions/plan/package.json`
- Create: `extensions/plan/index.ts`
- Create: `extensions/plan/tsconfig.json`
- Create: `extensions/plan/src/index.ts`
- Create: `extensions/plan/src/state.ts`
- Test: `extensions/plan/src/__tests__/state.test.ts`
```

**根因（CLAUDE.md 测试规范）：**

`/Users/zhushanwen/Code/xyz-pi-extensions-workspace/feat-plan-mode/CLAUDE.md` 测试规范第 1 项：

> 1. `pnpm --filter <pkg> add -D vitest`
> 2. **创建 `vitest.config.ts`（参考已有包的配置）**
> 3. `package.json` 添加 `"test": "vitest run"` script
> 4. 创建 `src/__tests__/` 目录和测试文件

**既有正确模式：** `extensions/context-engineering/vitest.config.ts`：

```typescript
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    root: __dirname,
  },
});
```

**为什么会阻断：**

dev 阶段 Task 1 完成后，subagent 会跑：
```bash
npx vitest run extensions/plan/src/__tests__/state.test.ts
```

如果 `extensions/plan/vitest.config.ts` 不存在，vitest 会尝试从 monorepo 根目录继承配置。根目录没有 vitest.config.ts，vitest 退到默认行为：扫描**项目根目录下的所有 .test.ts 文件**（会包括 `extensions/context-engineering/src/__tests__/compressor.test.ts` 等其他包的测试），但因为这些测试需要各自包的依赖（`@mariozechner/pi-coding-agent` 等路径解析不同），会因模块解析失败而批量报错。

更明确的问题：pre-commit hook 的 vitest 步骤会执行 `cd $pkg && npx vitest run`（参考 `.githooks/pre-commit` 的 vitest 步骤），`cd $pkg && npx vitest run` 在没有 `vitest.config.ts` 的包目录中，**vitest 会无法定位 `include` 规则，可能找不到任何测试**（"No test files found" 错误）→ 退出码非零 → pre-commit hook 阻断 commit。

**修复方向（最小修改，2-3 处同步）：**

**位置 1：** `plan.md` 行 38-41 File Structure 表格，添加：

```yaml
| `extensions/plan/vitest.config.ts` | create | BG1 | vitest 配置（CLAUDE.md 测试规范要求）|
```

**位置 2：** `plan.md` 行 326-332 Task 1 Files 列表，添加：

```yaml
- Create: `extensions/plan/vitest.config.ts`
- Create: `extensions/plan/package.json`
...
```

**位置 3（必要）：** `plan.md` Task 1 Step 3 中显式提到 `package.json` 的 `scripts` 字段需加 `"test": "vitest run"`（CLAUDE.md 规范第 3 项，目前 plan.md 的 package.json 缺失此字段），并给出 vitest.config.ts 的具体内容：

```typescript
// extensions/plan/vitest.config.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    root: __dirname,
  },
});
```

```json
// package.json (修订)
{
  ...
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  ...
}
```

**为什么是 MUST FIX（不是 LOW）：**

- pre-commit hook 的 vitest 步骤会立即阻断 dev 第一次 commit（不是"dev 阶段顺手清理"）
- 不是 subagent "自然发现并修复"的问题——subagent 拿到 plan.md 时，它会按 plan 的 Files 列表创建文件，不会主动加一个未列入的文件
- 修复成本极低（添加 1-2 行到 Files 列表 + 1 个配置文件内容 + 1 个 scripts 字段）
- 违反项目 CLAUDE.md 测试规范的 4 项要求中第 2、3 项
- v2/v3/v4/v5 评审均未发现（v3 焦点在 lint 阻断问题 M15/M16，未触及 vitest 配置；v2/v4/v5 主要做回归验证）

**为什么 v1 发现但 v2~v5 漏判：**

- v1 review 的聚焦是"dependency graph 完整性 + use-cases 完整性 + 测试规范遵循性"
- v2 review 做了 v1 的 14 项回归 + 新 7 项 LOW（核心在功能完整性 + LOW 标注）
- v3 review 做了 v2 的回归 + 新 2 项 MUST FIX（核心在 lint 阻断）
- v4/v5 review 是 PASS 摘要（仅 fix_summary）
- 整个评审链中只有 v1 触及了"CLAUDE.md 测试规范"维度，v2~v5 都没看 vitest.config.ts

**确认其他 Task 5 / Task 6 测试文件不受影响：**

- Task 5 `templates.test.ts` 创建时已假设 `vitest.config.ts` 存在（包含 `src/__tests__/**/*.test.ts` 规则）
- Task 6 `compact.test.ts` 同上
- 实际上 Task 5/6 的测试能跑的前提是 Task 1 已经创建了 `vitest.config.ts`——所以 M1 应在 Task 1 修复

## LOW（11 项，不阻塞 dev）

### LOW #1: plan.md Task 6 compact.ts 外层 try/catch 是死代码

**位置：** `plan.md` Task 6 Step 1 `compact.ts` `case "compact"` 块

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

**为什么不修复就 OK：** Pi SDK 内部 `agent-session.js` 的 `compact()` 用 IIFE 包裹 try/catch，错误只走 `options?.onError?.(err)`，**不会**作为同步异常向外抛出。所以外层 try/catch 永远不会触发，是死代码。`onError` 已处理所有错误路径，fallback 行为正确。

**修复方向（不阻塞 dev）：** 删除外层 try/catch，保留 `onError`，与 coding-workflow 一致。

### LOW #2: plan.md Task 1 / Task 2 测试文件缺 import

**位置：** `plan.md` Task 1 Step 1 `state.test.ts` + Task 2 Step 1 `state.test.ts`

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
  } as unknown as ExtensionContext;  // ← IDE 标红：Cannot find name 'ExtensionContext'
```

```typescript
// Task 2
import { persistPlanState, reconstructPlanState } from "../state.js";
// ← 缺 import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"

it("persistPlanState calls appendEntry with correct data", () => {
  const mockPi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;  // ← IDE 标红
```

**为什么不是 MUST FIX：** 根 `tsconfig.json` 和 `extensions/plan/tsconfig.json` 都 exclude 了 `**/__tests__`，`tsc --noEmit` 不会扫到。Vitest 用 esbuild 转译（容忍未知标识符），`vitest run` 不会失败。Dev 阶段 IDE 会标红，但不影响 CI。**M1 修复后才能让 CI 真正运行这些测试**。

**修复方向（不阻塞）：** 在测试文件顶部加：
```typescript
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
```

### LOW #3: `session_before_compact` handler 缺 `firstKeptEntryId` / `tokensBefore` 字段

**位置：** `plan.md` Task 6 Step 1 `compact.ts` `registerPlanEventHandlers`

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

### LOW #4: e2e-test-plan.md 全部 9 个 TS 缺 negative scenario

**位置：** `e2e-test-plan.md` 全文

**问题：** 9 个测试场景（TS-1 ~ TS-9）都是 happy path。plan.md 中有大量 `throw new Error` 错误处理路径无对应 E2E 覆盖：

- 未知 action → throw（应增加无效 action 测试）
- 模板不存在 → throw（应增加未注册模板测试）
- templateName 为空 → throw（应增加缺字段测试）
- 路径遍历字符 → throw（应增加特殊字符测试）
- `/plan abort` 不在 plan mode 时 → notify（应增加无激活 plan 的 abort 测试）
- `__goalInit` 调用失败 → catch（应增加 goal extension 未安装测试）
- compact 失败 → 降级（应增加模拟 compact 失败测试）

**修复方向（不阻塞 dev）：** 补充 TS-N-1 ~ TS-N-7 负面测试。

### LOW #5: test_cases_template.json 缺 `expected_result` / `priority` / `ac_coverage` 字段

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

### LOW #6: use-cases.md 仅 4 个 UC，plan-mode-design.md 列 11 个

**位置：** `use-cases.md` 全文

**问题：** `plan-mode-design.md` 列出 11 个 UC（UC-1 ~ UC-11），当前 `use-cases.md` 只覆盖 4 个（UC-1~UC-4），缺失：

- UC-3 (重构规划) — design.md 独立列出
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

- **可扩展性**：模板 > 50 个时的性能、新增 plan action 的 API 稳定性
- **可维护性**：模块拆分、测试覆盖率目标
- **可观测性**：错误日志策略、关键状态变更的日志粒度
- **兼容性**：Pi 旧版本、Windows `/tmp` 路径（`%TEMP%`）
- **错误处理**：`appendEntry` 失败、状态文件损坏、template I/O 错误路径
- **资源管理**：`/tmp` 长期累积 plan 文件的风险（spec 已声明不主动清理但 NFR 应说明累积影响）
- **跨 extension 契约稳定性**：`__goalInit` 通过 `as Record<string, unknown>` 访问是 hack，pi-goal 重构时 plan 静默失败

**修复方向（不阻塞 dev）：** 增加 1-2 段覆盖上述维度（最关键的是跨 extension 契约稳定性和资源管理）。

### LOW #8: 4/5 内置模板为 stub，章节结构未定义

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

### LOW #9: `__goalInit` 类型签名不匹配（`Record<string, unknown>` vs 具体 budget 对象）

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

### LOW #10: Task 2 是 test-only 任务，与 Task 1 重复

**位置：** `plan.md` Task 2 全文

**问题：** Task 1 已实现 `persistPlanState` / `reconstructPlanState`，Task 2 的 Step 1 只是在 `state.test.ts` 中**追加测试**，不修改 index.ts 也不引入新功能。Task 2 Step 2 直接说"Expected: PASS (persistence functions already implemented in Task 1)"——明确承认是补测试。

**为什么不修复就 OK：** Task 2 拆分有助于 BG1 内部分批派遣（4 个 subagent 而不是 3 个），但描述应为 "test-only (补 Task 1 持久化函数测试)"。

**修复方向（不阻塞 dev）：** 改 Task 2 标题为 "State 持久化测试增量" + Type 改为 "test-only"。

### LOW #11: `/tmp/plan-{slug}.md` 全局共享，跨项目泄漏

**位置：** `plan.md` Task 4 command.ts reentry 扫描 + `non-functional-design.md` §5 数据安全

**问题：** `os.tmpdir() + plan-{slug}.md` 是 OS 级别共享路径。两个不同项目使用 Pi 会在同一 `/tmp/plan-*.md` 池中产生文件。Task 4 reentry 逻辑扫描 `/tmp/plan-*.md` 会**误捡其他项目的 plan 文件**，提示用户的 4 选项（继续/实现/新建/取消）会指向其他项目的 plan。

spec FR-1.6 已规定 `/tmp/plan-{slug}.md`，所以这是 spec 设计选择而非 plan 错误。但 plan 应当显式声明"接受跨项目泄漏"或建议扩展为 `<projectHash>-plan-{slug}.md`（spec 升级到 v2 再改）。

**修复方向（不阻塞 dev）：** 在 plan.md Task 4 reentry 段加注释说明跨项目行为；在 `non-functional-design.md` §5 数据安全段加"跨项目泄漏风险"小节。

## 跨文件一致性检查

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
| Vitest 配置 | **缺失 (M1)** | n/a | n/a | n/a | n/a | ❌ 不一致（pre-commit hook 阻断）|
| 测试 import | LOW #2 | n/a | n/a | n/a | n/a | ⚠️ IDE-only 问题 |
| 内置模板章节 | 与 design.md 不一致 (LOW #8) | n/a | n/a | n/a | n/a | ⚠️ 章节粒度待统一 |

## 接口契约审查

| 接口 | plan.md 定义 | 实现位置 | 一致性 |
|------|------------|---------|--------|
| `PlanPhase` | 4 枚举值 | state.ts | ✅ |
| `PlanState` | 5 字段 | state.ts | ✅ |
| `PlanSessionMap` | `Map<string, PlanState>` | state.ts | ✅ |
| `getPlanState` | (sessions, sessionId, ctx) → PlanState | state.ts | ✅ |
| `persistPlanState` | (pi, state) → void | state.ts | ✅ |
| `reconstructPlanState` | (ctx) → PlanState | state.ts | ✅ |
| `executePlanTool` | (pi, ctx, sessions, action, params) → ToolResult | tool.ts | ✅ execute 签名已修复（`_toolCallId` / `_signal` / `_onUpdate`）|
| `listTemplates` | (projectDir?) → TemplateInfo[] | templates.ts | ✅ |
| `loadTemplate` | (name, projectDir?) → string \| null | templates.ts | ✅ catch 块仅 `return null`，warn 级别不阻断 |
| `handlePlanComplete` | (pi, ctx, state, isolation) → void | compact.ts | ✅ goal init catch 已修复为 `catch (e) { ctx.ui.notify(...) }` |
| `updatePlanWidget` | (ctx, state) → void | widget.ts | ✅ |

## 后端设计充分性检查（L1）

按 L1 后端检查清单逐项：

1. **"为什么"而非"做什么"**：✅ Task 3 tool.ts 每个 action 都有清晰目的；Task 6 compact.ts handlePlanComplete 注释解释了 tree case 为何不注入 steer
2. **存储变更选型理由**：✅ Task 0 Step 2 注释 "Extension 依赖管理 [MANDATORY]"；Task 1 Step 3 state.ts 注释 "per-session 隔离"
3. **API 端点与业务场景对应**：✅ 5 个 action 对应 spec FR-3.2 / FR-4.4 / FR-5.1 / FR-7.2 / FR-3.2 五个场景
4. **边界条件 / 异常处理**：
   - ✅ select-template: `loadTemplate` 返回 null 时 throw
   - ✅ create-template: 路径遍历防护 + 必填字段校验
   - ✅ complete: 必传 isolation（default 为 "direct"）
   - ✅ abort: 不在 plan mode 时 notify "No active plan mode"
   - ⚠️ LOW #1: compact 错误处理有冗余 try/catch
   - ❌ M1: 缺少 vitest.config.ts
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
- **tool.ts execute 签名已修复**（`@typescript-eslint/no-unused-vars: 'error'` 不再触发）：`_toolCallId` / `_signal` / `_onUpdate`
- **compact.ts goal init catch 已修复**（非空 catch 块）：`catch (e) { ctx.ui.notify(...) }`
- **BG 内文件数合理**（BG0: 3, BG1: 7, BG2: 10），均在 ≤10 阈值
- **Wave 编排串行清晰**（Wave 1 → 2 → 3），无循环依赖
- **vitest 配置准备**：`extensions/plan/tsconfig.json` 包含 `"exclude": ["src/__tests__", "dist"]`，与项目约定一致

## 修复优先级建议

按修复优先级（dev 阶段阻断性）：

1. **第一批（dev 会立即阻断）：** M1（vitest.config.ts 缺失，pre-commit hook 的 vitest 步骤会失败）
2. **第二批（dev 阶段顺手清理）：** LOW #1（死代码）、LOW #2（test import）、LOW #3（firstKeptEntryId）
3. **第三批（Phase 4 阶段清理）：** LOW #4 + LOW #5（e2e/test_cases 字段补全）
4. **第四批（Phase 5 / 文档迭代）：** LOW #6 + LOW #7（UC + NFR 完整性）
5. **第五批（设计精化）：** LOW #8 + LOW #9 + LOW #10 + LOW #11

## 结论

**Fail。** 当前 plan.md 整体设计质量高，AC 11/11 覆盖，per-session 隔离、`/plan abort/status`、重入 4 选项、compact/tree handler、`__goalInit` API、SKILL.md 的 ask_user/subagent 检测、路径遍历防护——所有架构关键点都到位。

v3 标记的 2 项 MUST FIX（M15 tool.ts 签名 + M16 silent catch）**均已修复**。但 v1 标记的 1 项 MUST FIX（M1 缺少 `vitest.config.ts` 创建任务）**仍未修复**，违反项目 CLAUDE.md 测试规范第 2、3 项，会导致 dev 阶段 pre-commit hook 的 vitest 步骤失败。

修复 M1 后，plan 可进入 dev 阶段无阻断。11 项 LOW 属于代码风格 / 文档完整性 / 测试模板完整度 / NFR 覆盖度，均可在 dev/Phase 4/Phase 5 阶段清理，不阻塞 plan 评审通过。

## 评审元数据

```yaml
review:
  type: plan_review
  round: 2
  mode: "Mode 1: Plan feasibility"
  timestamp: "2026-06-11T16:30:00+08:00"
  target: ".xyz-harness/2026-06-11-plan-mode/plan.md"
  related:
    - e2e-test-plan.md
    - test_cases_template.json
    - use-cases.md
    - non-functional-design.md
  verdict: fail
  summary: |
    独立 v2 评审。v3 标记的 2 项 MUST FIX（M15 tool.ts 签名 + M16 silent catch）均已修复。
    独立发现 1 项 MUST FIX（M1 缺少 vitest.config.ts 创建任务，违反 CLAUDE.md 测试规范，
    pre-commit hook 的 vitest 步骤会阻断 commit）——这是 v1 标记但 v2~v5 评审未回归的旧问题。
    另有 11 项 LOW（死代码 / test import / firstKeptEntryId / E2E 缺负面场景 /
    test_cases 缺字段 / UC 缺口 / NFR 维度不全 / 4/5 模板 stub / __goalInit 类型 /
    Task 2 test-only / /tmp 跨项目泄漏），均不阻塞 dev。

statistics:
  total_issues: 12
  must_fix: 1
  low: 11
  must_fix_breakdown:
    - category: "pre-commit hook 阻断（vitest 步骤）"
      count: 1
      items: [M1]
  low_breakdown:
    - category: "死代码 / 未使用"
      count: 1
      items: [LOW_1]
    - category: "测试文件不完整（import / 字段）"
      count: 3
      items: [LOW_2, LOW_4, LOW_5]
    - category: "handler 缺字段（firstKeptEntryId）"
      count: 1
      items: [LOW_3]
    - category: "文档完整性（UC / NFR）"
      count: 2
      items: [LOW_6, LOW_7]
    - category: "设计完整性（模板 / 类型 / 任务拆分）"
      count: 3
      items: [LOW_8, LOW_9, LOW_10]
    - category: "资源 / 跨项目"
      count: 1
      items: [LOW_11]
  prior_validation:
    v1_M1: unfixed
    v3_M15: fixed
    v3_M16: fixed
```
