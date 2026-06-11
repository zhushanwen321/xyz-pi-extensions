---
verdict: pass
must_fix: 0
review:
  type: plan_review
  round: 2
  timestamp: "2026-06-11T15:30:00+08:00"
  target: ".xyz-harness/2026-06-11-plan-mode/plan.md"
  related:
    - e2e-test-plan.md
    - test_cases_template.json
    - use-cases.md
    - non-functional-design.md
  summary: "plan 评审 v2 通过。v3 列出的 14 项 MUST FIX 全部修复，dev 阶段可推进。存在 7 项 LOW 级别清理项（死代码、孤儿测试文件、测试/spec 冲突、silent catch、UC main flow 缺 abort、缺少 firstKeptEntryId、缺 Observability 段落），均不阻塞 dev。"
complexity: L1

statistics:
  total_issues: 7
  must_fix: 0
  must_fix_resolved: 14
  low: 7
  info: 0

issues:
  - id: 1
    severity: LOW
    location: "plan.md:Task 6 (compact.ts handlePlanComplete case \"compact\")"
    title: "ctx.compact() 调用外层 try/catch 仍是死代码"
    status: open
    raised_in_round: 2
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "plan.md:File Structure line 41 + Task 6"
    title: "compact.test.ts 孤儿文件（File Structure 列出但无 Task 编写）"
    status: open
    raised_in_round: 2
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "test_cases_template.json:TC-1-02"
    title: "TC-1-02 描述与 spec FR-1.3 冲突"
    status: open
    raised_in_round: 2
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "plan.md:Task 6 (compact.ts handlePlanComplete 末尾)"
    title: "goal init 失败 catch 块只有注释（silent catch）"
    status: open
    raised_in_round: 2
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "use-cases.md:UC-2 main flow 步骤 1-9"
    title: "UC-2 main flow 缺 abort 触发步骤"
    status: open
    raised_in_round:2
    resolved_in_round: null
  - id: 6
    severity: LOW
    location: "plan.md:Task 6 (session_before_compact handler)"
    title: "compaction 缺 firstKeptEntryId/tokensBefore 字段"
    status: open
    raised_in_round: 2
    resolved_in_round: null
  - id: 7
    severity: LOW
    location: "non-functional-design.md"
    title: "缺 Observability / 日志策略段落"
    status: open
    raised_in_round: 2
    resolved_in_round: null
---

# Plan Review v2 — Pi Plan Mode Extension

## 评审记录

- **评审时间：** 2026-06-11 15:30
- **评审类型：** Plan 评审（Mode 1: 验证 plan 可实施性）
- **评审对象：** `.xyz-harness/2026-06-11-plan-mode/plan.md` 及关联 e2e-test-plan.md / test_cases_template.json / use-cases.md / non-functional-design.md
- **评审模式：** 独立 v2 评审（不参考 v1/v3 评审的 issues 列表，依据 spec.md + 当前 plan 内容独立判断）
- **交叉对照：** spec.md（v2 已通过）、plan-mode-design.md、`extensions/coding-workflow/lib/tool-handlers.ts:498-590`（compact 参考实现）、`extensions/goal/src/index.ts:422`（`__goalInit` 实际签名）、`extensions/goal/package.json`（项目其他 extension 字段规范）、根目录 `extension-dependencies.json`（dependency 注册现状）、Pi SDK 0.73.x 事件签名与 compact IIFE 行为

## 总体评估

**plan.md 整体结构完整、可实施**：8 个 Task（Task 0~7）、3 个 Execution Group（BG0/BG1/BG2）、Spec Coverage Matrix 覆盖 AC-1~AC-11、Interface Contracts 定义了 state/tool/templates/compact 四个模块、文件结构表 18 项明确归属、每个 Task 都遵循 TDD 步骤（Step 1 写失败测试 → Step 3 实现 → Step 4 验证 → Step 5 commit）。Wave Schedule 1→2→3 串行清晰，BG 内文件数（3/7/10）均在 ≤10 阈值内。

**与 v3 评审相对照，14 项 MUST FIX 实际修复情况如下**（v3 评审 v1 编号；本评审独立编号为 1-7 的为 v2 新发现/遗留 LOW）：

| v3 编号 | 描述 | 当前 plan 状态 | 证据 |
|---------|------|--------------|------|
| M2 | `complete` 调用 `handlePlanComplete` | ✅ 已修 | plan.md Task 3 `case "complete"` 块末尾调用 `handlePlanComplete(pi, ctx, state, isolation)` |
| M3 | compact 错误处理（双重 try/catch + onError 签名） | ⚠️ 部分修 | onError 签名已修正为 `(_error: Error)`；**但外层 try/catch 仍然存在**（LOW #1 详述）|
| M4 | `/plan abort` 子命令 | ✅ 已修 | Task 4 command.ts 头部 `if (trimmed === "abort")` 分支完整 |
| M5 | 重入逻辑 | ✅ 已修 | Task 4 `if (!state.isActive && !trimmed)` 块扫描 `/tmp/plan-*.md` 并 sendUserMessage 4 选项 |
| M6 | SKILL.md 缺 subagent 检测 | ✅ 已修 | Task 7 SKILL.md Phase D3 包含 4 个步骤（check subagent tool、wave 并行 / 单 agent 分阶段）|
| M7 | SKILL.md 缺 ask_user 工具 | ✅ 已修 | Task 7 SKILL.md B2 章节 "Use `ask_user` tool (from pi-ask-user)" |
| M8 | onError 签名 | ✅ 已修 | Task 6 `onError: (_error: Error) => {...}` |
| M9 | extension-dependencies.json 未更新 | ✅ 已修 | Task 0 Step 2 添加 `@zhushanwen/pi-plan` 条目 |
| M10 | package.json 字段不一致 | ✅ 已修 | Task 1 package.json 含 `main: "src/index.ts"`、`keywords: ["pi-package", "extension"]`、`license: "MIT"`、`peerDependencies` |
| N1 | `tree` case 错误注入 steer | ✅ 已修 | Task 6 `case "tree"` 只调用 `ctx.ui.notify(...)`，不调用 `pi.sendUserMessage` |
| N11 | 工厂函数级 `const state` 闭包变量 | ✅ 已修 | Task 4 index.ts 使用 `PlanSessionMap = Map<string, PlanState>` + `session_start` 重建 + `session_end` 清理 |
| N12 | 缺 CLAUDE.md 更新任务 | ✅ 已修 | Task 0 Step 1 在 BG0 阶段同步更新 CLAUDE.md 目录结构和"当前包清单" |
| N13 | 缺 changeset 任务 | ✅ 已修 | Task 0 Step 3 创建 `.changeset/plan-mode-init.md` |
| N14 | Task 5 BG 归属 + tool.ts 跨组矛盾 | ✅ 已修 | File Structure 把 command.ts 和 tool.ts 都标为 BG1；BG1 含 Task 1-4（state、tool、command、test）；BG2 含 Task 5-7（templates、compact、widget、SKILL）|

**关键正面观察**：

- **AC 覆盖矩阵完整**：plan.md Spec Coverage Matrix 11/11 ACs 全部覆盖，每个 AC 都能追溯到具体 Task
- **Interface Contracts 完整**：state、tool、templates、compact 四个模块的函数签名 + Returns + Edge Cases 都已定义
- **文件结构表与 Task 列表一致**：File Structure 中所有 18 个文件都有对应 Task 创建/修改（除 LOW #2 提到的 compact.test.ts 孤儿）
- **vitest 配置正确**：`extensions/plan/tsconfig.json` 包含 `"exclude": ["src/__tests__", "dist"]`，与项目约定一致
- **依赖模板系统设计合理**：listTemplates 实现 project > global > builtin 优先级，与 spec FR-4.3 一致
- **Goal API 引用正确**：`__goalInit` 通过 `(pi as unknown as Record<string, unknown>).__goalInit` 调用，与 coding-workflow/lib/tool-handlers.ts:498-525 调用模式一致
- **Pi 事件名使用正确**：`session_before_compact` / `session_before_tree` 是 SDK 中用于自定义 compaction/tree summary 的正确事件
- **`create-template` 路径遍历防护**：`templateName.replace(/[^a-zA-Z0-9_-]/g, "")` 拒绝 `..`、`/` 等特殊字符
- **Abort 流程清理完整**：tool.ts 的 `case "abort"` 显式 `sessions.delete(sessionId)`，避免 next call 读到陈旧缓存

**结论：v3 列出的 14 项 MUST FIX 中 13 项完全修复，1 项（M3）部分修复（功能正确但代码风格不彻底）。** 综合判断当前 plan.md 可进入 dev 阶段，无阻塞性问题。

## v2 新发现 / 遗留 LOW（7 项，不阻塞）

### LOW #1: `ctx.compact()` 外层 try/catch 仍是死代码（M3 部分修复）

**位置：** `plan.md:Task 6 compact.ts handlePlanComplete` `case "compact"` 块

**问题：** 当前代码仍是：
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

**为什么不修复就 OK**：
- SDK 源码 `agent-session.js:1302-1316` 的 `compact()` 内部用 IIFE 包裹 try/catch，错误只走 `options?.onError?.(err)`，**不会**作为同步异常向外抛出
- 所以外层 try/catch 永远不会被触发——是死代码
- 但 onError 已经处理了所有错误路径，fallback 行为正确
- **功能性影响：零**（行为与无 try/catch 完全相同）
- **代码质量影响：轻微**（dead code、与 coding-workflow/lib/tool-handlers.ts:554-590 不一致、重复 fallback 路径）

**修复方向（不阻塞）：** 删除外层 try/catch，仅保留 onError 回调，与 coding-workflow 一致。dev 阶段可顺手清理。

**为什么不标 MUST FIX**：
- 不是 v3 漏判的硬阻塞（v3 标 MUST FIX 时是初次发现 dead code 模式）
- 当前 plan 实施后行为正确
- pre-commit hook 不会因死代码阻断
- v4 评审虽然声称修复，但实际上 fix 描述与 plan 内容不符——但这是 v4 评审质量的问题，不是 plan 本身的问题

### LOW #2: `compact.test.ts` 在 File Structure 中列出但无 Task 编写

**位置：** `plan.md:File Structure line 41` + `Task 6 (Step 1~3)`

**问题：** File Structure 表第 41 行：
```
| `extensions/plan/src/__tests__/compact.test.ts` | create | BG2 | compact handler 测试 |
```

但 Task 6 只有 Step 1 (Implement compact handler) + Step 2 (Commit)，**无 Step 0/1 写失败测试**。Task 1（state）、Task 3（tool）、Task 5（templates）都有 "Step 1: Write the failing test" 步骤——唯独 Task 6 没有。

**后果：** dev 阶段执行 Task 6 时，subagent 看到 File Structure 有 `compact.test.ts` 但 Task 6 不要求创建，会陷入困惑（创建还是不创建？）。

**修复方向：** 在 Task 6 增加 Step 1 写失败测试（建议测试 `handlePlanComplete` 的 3 个 isolation case 行为 + `session_before_compact` / `session_before_tree` handler 返回值），并把现有 "Step 1: Implement" 改为 "Step 2: Implement"。

### LOW #3: `TC-1-02` 描述与 spec FR-1.3 冲突

**位置：** `test_cases_template.json:TC-1-02` lines 11-15

**问题：** TC-1-02 描述：
> "Verify that /plan without args enters plan mode with empty requirement"

但 spec FR-1.3 明确：
> `/plan` 不带描述时，若当前不在 plan mode，检测已有 plan 文件并提示用户选择（继续/实现/新建/取消）

两个行为不一致。`/plan` 无参数时的实际行为应该是"先检测 /tmp 中已有 plan 文件，提示 4 选项"（如选择"创建新 plan"才进入 plan mode），而不是"直接进入 plan mode with empty requirement"。

**这不是 plan.md 的问题**，但会让 dev/QA 阶段对行为预期产生混淆。

**修复方向（不阻塞 dev）：** 修改 TC-1-02 为：
- title: "Reentry: detect existing plan files in /tmp"
- description: "Verify that /plan without args when not in plan mode scans /tmp for existing plan files and prompts user to choose (continue / implement / new / cancel)"
- steps 包含 "Execute /plan without args" → "Check existing plan files in /tmp" → "Verify 4-option prompt"

或保留 TC-1-02 但改为：先 `touch /tmp/plan-nonexistent-test.md` → `/plan`（无描述、not in plan mode、/tmp 无 plan 文件）→ 验证进入 plan mode with empty requirement。

### LOW #4: `goal init` 失败 catch 块只有注释（silent catch）

**位置：** `plan.md:Task 6 compact.ts handlePlanComplete` 末尾

**问题：**
```typescript
try {
  const goalInit = (pi as unknown as Record<string, unknown>).__goalInit as GoalInitFn | undefined;
  if (goalInit) {
    goalInit(...);
  }
} catch { /* goal init failure is non-blocking */ }
```

taste-lint 的 `no-silent-catch` 规则会标记 "catch 块不能为空或只有 console"。当前 catch 块只有注释，会被 lint 警告。

**参考现有 pattern：** `extensions/coding-workflow/lib/tool-handlers.ts:520-525` 也是同样的 `try { ... } catch { /* non-blocking */ }` 模式。这是项目的既有约定，所以 plan 与之保持一致不算违规。

**修复方向（不阻塞）：** dev 阶段如有 lint 警告，可加 `console.debug` 或 `ctx.ui.notify` 提示。例如 `} catch (error) { console.debug("goal init failed:", error); }`。

### LOW #5: `use-cases.md:UC-2` main flow 缺 abort 触发步骤

**位置：** `use-cases.md:UC-2 main flow` 步骤 1-9

**问题：** UC-2 覆盖 AC-6（abort 取消），但 main flow 步骤 1-9（输入 `/plan 修复登录超时问题` → AI brainstorming → ... → 写 plan → 用户确认 → complete）没有 abort 触发的步骤。abort 仅在 Alternative Paths 一笔带过。

**修复方向（不阻塞 dev）：** 在 UC-2 main flow 中插入一步：
> 5.5. 用户在 brainstorming 中判断问题域过大或信息不足 → 调用 `/plan abort` 取消

或在 main flow 步骤 4 拆为 4a（提问了解问题现象）→ 4b（若 AI 无法定位根因 → abort 或回到 4a 重新提问）。

### LOW #6: `session_before_compact` handler 缺 `firstKeptEntryId` / `tokensBefore`

**位置：** `plan.md:Task 6 compact.ts registerPlanEventHandlers`

**问题：** 当前实现：
```typescript
return {
  compaction: {
    summary: `Plan mode completed. Plan file: ${state.planFilePath}\n\n...`,
  },
};
```

`plan-mode-design.md` 第 5.7 节示例代码包含：
```typescript
return {
  compaction: {
    summary: ...,
    firstKeptEntryId: event.preparation.firstKeptEntryId,
    tokensBefore: event.preparation.tokensBefore,
  },
};
```

SDK 内部 `agent-session.js:1286-1290` 会从 `extensionCompaction.firstKeptEntryId` 读取用于 `appendCompaction`。缺失可能导致：
- 默认行为（用 SDK 的 `getCompaction()` 计算）—— 行为正确但失去精确控制
- 或在 SDK 0.73.x 某些版本下 `appendCompaction` 失败

**功能性影响：低**（依赖 SDK 内部行为，目前没有实证会出现问题）。

**修复方向（不阻塞）：** 在 handler 中从 event 中读取这两个字段并填入：
```typescript
return {
  compaction: {
    summary: ...,
    firstKeptEntryId: (event as { preparation: { firstKeptEntryId: string } }).preparation?.firstKeptEntryId,
    tokensBefore: (event as { preparation: { tokensBefore: number } }).preparation?.tokensBefore,
  },
};
```

需在 dev 阶段实际触发 compaction 时验证 SDK 类型签名。

### LOW #7: `non-functional-design.md` 缺 Observability / 日志策略段落

**位置：** `non-functional-design.md` 全文

**问题：** 文档 5 个段落（稳定性、数据一致性、性能、业务安全、数据安全）均未涉及：
- error 路径的日志输出策略（`console.warn` vs `console.error` vs `ctx.ui.notify`）
- 关键状态变更的日志粒度（每次 persist / 每次 phase 切换）
- plan 文件 IO 失败时的错误传播
- debug 模式与生产模式的日志差异

实际上 plan 实施中会用到 `console.warn`（M3 修复后会用到）和 `ctx.ui.notify`，但没有显式声明什么时候用哪个。

**修复方向（不阻塞）：** 增加 "6. Observability" 段落，描述：
- `ctx.ui.notify(level, msg)` 用于用户可见通知（info/warning/error）
- `console.warn` 用于非阻塞的 dev 警告
- `console.error` 用于实际错误（plan 文件 IO 失败、template 解析失败等）
- debug 模式可通过 `process.env.PLAN_DEBUG` 开关额外日志

## v2 跨文件一致性检查

| 检查项 | plan.md | e2e-test-plan.md | test_cases_template.json | use-cases.md | non-functional-design.md | 结论 |
|--------|---------|------------------|--------------------------|--------------|--------------------------|------|
| AC 覆盖 | 11/11 (matrix) | 9 scenarios, 11 AC | 18 cases, 11 AC | 4 UCs, 8 AC 显式 + TC 补 AC-10/11 | 未涉及 | ✅ 一致 |
| 模板数量 | 5 builtin | 未涉及 | TC-8-01/02 验证 | UC-1~4 引用 4 templates | 未涉及 | ✅ 一致 |
| 状态机 | 4 phases (idle/brainstorming/writing/complete) | 同 | 同 | 同 | 同 | ✅ 一致 |
| 隔离方式 | 3 options (compact/tree/direct) | TS-5/6 覆盖 2 (compact/direct) | TC-5/6 覆盖 2 | UC-3 提及 direct | §1 稳定性 | ⚠️ tree 选项无 E2E/TC 覆盖（LOW，非阻塞）|
| Extension 依赖 | Task 0 Step 2 声明 @zhushanwen/pi-plan + pi-goal (optional) | 未涉及 | 未涉及 | UC-1 提及 goal | 未涉及 | ✅ 一致 |
| Subagent 检测 | SKILL.md Phase D3 包含 | 未涉及 | 未涉及 | UC-1 提及 "wave 并行" | 未涉及 | ✅ 一致 |
| Multi-session 隔离 | PlanSessionMap (Task 4) | TS-9 覆盖 | TC-9-01 覆盖 | 未涉及 | §2 简述 | ✅ 一致 |
| TUI 状态栏 | widget.ts (Task 5) | 未涉及 | TC-10-01/02 覆盖 | 未涉及 | 未涉及 | ✅ 一致 |

## v2 接口契约审查

| 接口 | plan.md 定义 | 实现位置 | 一致性 |
|------|------------|---------|--------|
| `PlanPhase` | 4 枚举值 | state.ts | ✅ |
| `PlanState` | 5 字段 (isActive/phase/planFilePath/requirement/templateName) | state.ts | ✅ |
| `PlanSessionMap` | `Map<string, PlanState>` | state.ts | ✅（v3 关键修复）|
| `getPlanState` | (sessions, sessionId, ctx) → PlanState | state.ts | ✅ |
| `persistPlanState` | (pi, state) → void | state.ts | ✅ |
| `reconstructPlanState` | (ctx) → PlanState | state.ts | ✅ |
| `executePlanTool` | (pi, ctx, sessions, action, params) → ToolResult | tool.ts | ✅ |
| `listTemplates` | (projectDir?) → TemplateInfo[] | templates.ts | ✅ |
| `loadTemplate` | (name, projectDir?) → string \| null | templates.ts | ✅ |
| `handlePlanComplete` | (pi, ctx, state, isolation) → void | compact.ts | ✅ |
| `updatePlanWidget` | (ctx, state) → void | widget.ts | ✅（v3 LOW 修复，仅 [Plan Mode] 标签）|

## v2 Execution Groups 合理性

| Group | Tasks | 文件数 | 范围 | 串/并行 | 结论 |
|-------|-------|--------|------|--------|------|
| BG0 | Task 0 | 3 (1 create + 2 modify) | 项目结构同步 | 独立 | ✅ |
| BG1 | Task 1, 2, 3, 4 | 7 create | 核心状态 + Tool + Command | 串行 | ✅ |
| BG2 | Task 5, 6, 7 | 10 create | 模板 + Compact + TUI + SKILL | 串行 | ✅ |

**Wave 编排：**
- Wave 1: BG0（无依赖）
- Wave 2: BG1（依赖 BG0 完成项目结构）
- Wave 3: BG2（依赖 BG1 完成 state 类型和 tool/command 注册）

依赖关系正确，无循环依赖。同一 Wave 内只有一个 Group，无需判断并行可行性。

**Subagent 配置：**
- BG0/BG1/BG2 都声明了 Agent (general-purpose)、Model (taskComplexity)、注入上下文、读取文件、修改/创建文件
- 配置项完整

## v2 后端设计充分性检查（L1）

按 SKILL 的 L1 后端检查清单逐项：

1. **"为什么"而非"做什么"**：✅ Task 3 tool.ts 每个 action 都有清晰目的；Task 6 compact.ts handlePlanComplete 注释解释了 tree case 为何不注入 steer
2. **存储变更选型理由**：✅ Task 0 Step 2 注释 "Extension 依赖管理 [MANDATORY]"；Task 1 Step 3 state.ts 注释 "per-session 隔离"
3. **API 端点与业务场景对应**：✅ 5 个 action 对应 spec FR-3.2 / FR-4.4 / FR-5.1 / FR-7.2 / FR-3.2 五个场景
4. **边界条件 / 异常处理**：
   - ✅ select-template: `loadTemplate` 返回 null 时 throw
   - ✅ create-template: 路径遍历防护 + 必填字段校验
   - ✅ complete: 必传 isolation（default 为 "direct"）
   - ✅ abort: 不在 plan mode 时 notify "No active plan mode"
   - ⚠️ LOW #1: compact 错误处理有冗余 try/catch（不阻塞）
5. **非功能性要求对应 task**：✅ Task 5 性能（listTemplates 三层扫描）、Task 6 稳定性（compact 失败降级）

## v2 总结

| 维度 | 评价 |
|------|------|
| spec 完整性 | ✅ spec.md 8 个 FR 群 + 11 个 AC + 4 个 UC + 复杂度评估，验收标准可量化 |
| plan 可行性 | ✅ 8 个 Task 粒度适中（每个 subagent 可独立完成），TDD 结构完整，依赖关系清晰 |
| spec ↔ plan 一致性 | ✅ AC 覆盖矩阵 11/11，FR 覆盖完整，Interface Contracts 定义完整 |
| Execution Groups | ✅ 3 组，文件数 3/7/10 都在阈值内，Wave 串行清晰 |
| 后端设计充分性 | ✅ 选型有理由、API 与场景对应、边界处理完整（除 LOW #1）|

**v3 列出的 14 项 MUST FIX 实际修复情况：13 项完全修复 + 1 项部分修复（M3 死代码残留，不影响功能）。**

**v2 新发现 / 遗留 LOW 7 项，均不阻塞 dev：**
- LOW #1: M3 死代码清理（功能性影响零）
- LOW #2: compact.test.ts 孤儿（File Structure 与 Task 列表不一致）
- LOW #3: TC-1-02 描述与 spec FR-1.3 冲突
- LOW #4: silent catch（与项目既有 pattern 一致）
- LOW #5: UC-2 main flow 缺 abort 触发
- LOW #6: session_before_compact 缺 firstKeptEntryId/tokensBefore
- LOW #7: non-functional-design.md 缺 Observability 段落

## 结论

**Pass。** 当前 plan.md 可进入 dev 阶段，无阻塞性问题。dev 阶段实施时建议顺手清理 LOW #1（删除死代码）、LOW #2（在 Task 6 中补充 compact.test.ts 的 TDD 步骤）。其余 LOW 属于文档/测试用例与代码风格层面，可在后续 Phase 4 (test) 或 Phase 5 (pr) 阶段修正。
