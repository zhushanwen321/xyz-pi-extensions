---
verdict: fail
must_fix: 10
---

# Plan Review v2 — Pi Plan Mode Extension

## 评审记录

- 评审时间：2026-06-11
- 评审类型：Plan 评审（Mode 1: 验证 plan 可实施性）
- 评审对象：`.xyz-harness/2026-06-11-plan-mode/plan.md` 及关联 e2e-test-plan.md / test_cases_template.json / use-cases.md / non-functional-design.md
- 前序评审：plan_review_v1.md（10 项 MUST FIX，本次 v2 独立验证并修正 v1 错误项）
- 交叉对照：spec.md（v2 已通过）、plan-mode-design.md、Pi SDK 0.73.1 实际事件签名（`@mariozechner/pi-coding-agent@0.73.1@@@1/dist/core/extensions/types.d.ts` + `agent-session.js`）、extensions/coding-workflow/lib/tool-handlers.ts（compact 正确实现）、extensions/goal/src/index.ts:387-422（`__goalInit` 实际签名）

## 总体评估

plan.md 整体结构完整：8 个 Task、3 个 Execution Group、Spec Coverage Matrix 覆盖 AC-1~AC-11、接口契约定义了 state/tool/templates/compact 四个模块、6 个测试文件路径明确。**但 plan 在 Pi 运行时 API 假设、核心控制流、spec 全量覆盖、项目约定上存在 10 项阻塞性问题**。本次 v2 在 v1 基础上做了严格独立验证：

- v1 的 **M1（事件名错误）经独立验证为 false positive**——plan 使用的 `session_before_compact` / `session_before_tree` 确实是 Pi SDK 中用于自定义压缩/回退摘要的正确事件（SDK 在 `runner.d.ts:28-30` 和 `types.d.ts:403,438` 明确注册，且 SDK `agent-session.js:1268-1278` 显示只有 `_before_` 变体才支持返回 `result.compaction` 覆盖默认行为）
- v1 的 **M2~M10 经独立验证全部成立**——通过对比 Pi SDK 源码、coding-workflow 参考实现、goal API 实际签名、extension-dependencies.json 实际内容、package.json 字段对比
- v2 新发现 **1 项 MUST FIX**（N1：tree case 错误地注入 steer message）

## v1 验证结果

| v1 项 | 验证结果 | 证据 |
|-------|---------|------|
| M1 (事件名错误) | **❌ false positive** | SDK 类型文件明确注册 `session_before_compact` / `session_before_tree`（types.d.ts:788,791）。v1 误把 evolve-daily 的 `session_compact`（post-event 通知）当作"正确事件"，实际上 `session_before_compact` 才是允许返回 `compaction` 覆盖的预事件。 |
| M2 (complete 未调用 handlePlanComplete) | ✅ valid | Task 6 case "complete" 仅设置 `state.phase = "complete"` 并 return；`handlePlanComplete` 在 compact.ts 中定义但无任何调用方 |
| M3 (try/catch 双重) | ✅ valid | SDK 源码 `agent-session.js:1305-1311` 显示 `compact(options)` 内部用 IIFE 包裹 try/catch，错误只走 onError 回调，try/catch 无法捕获（见下文新证据）|
| M4 (/plan abort 子命令) | ✅ valid | command.ts 只识别 4 种分支，无 `abort` 子命令 |
| M5 (重入逻辑) | ✅ valid | command.ts 走简单 isActive 判断，无 spec FR-1.3 要求的 4 选项对话框 |
| M6 (SKILL.md subagent 检测) | ✅ valid | Task 8 SKILL.md 模板未包含 FR-6.1~6.3 步骤 |
| M7 (SKILL.md ask_user 工具) | ✅ valid | Task 8 SKILL.md 模板 B2 章节未提及 ask_user |
| M8 (onError 签名) | ✅ valid | SDK `types.d.ts:ExtensionUIContext.compact: (options?: CompactOptions): void` + `CompactOptions.onError?: (error: Error) => void` |
| M9 (extension-dependencies.json) | ✅ valid | 根目录 extension-dependencies.json 现有 7 个 extension 条目，无 `@zhushanwen/pi-plan` |
| M10 (package.json 字段) | ✅ valid | goal 的 package.json 有 `main: "src/index.ts"`、`keywords` 含 `"extension"`、`license: MIT`、完整 `peerDependencies`；plan 的 package.json 缺这些 |

## MUST FIX（10 项）

### M2. `complete` action 未触发 `handlePlanComplete`（plan.md Task 6 + Task 7）

**位置：** `plan.md` Task 6 `tool.ts` 的 `case "complete"` 块（行 985-995）和 Task 7 `compact.ts` 的 `handlePlanComplete` 函数

**严重度：** must_fix

**问题：** Task 6 的 `complete` handler 只做了三件事：设置 `phase = "complete"`、持久化、返回 "Plan complete. Switching to implementation..."。它**没有调用** Task 7 导出的 `handlePlanComplete` 函数。`handlePlanComplete` 包含四个关键能力：ask_user 选择 compact/tree/direct、调用 `ctx.compact()`、尝试 `__goalInit`——全部永远不会被执行。

**证据：** grep "handlePlanComplete" 全文（plan.md 内）只有一处定义（Task 7），无任何调用方。

**后果：** spec FR-5.1~5.8 全部失效。退出 plan mode 时：
- 用户没有 3 选项对话框（FR-5.2）
- 不会调用 `ctx.compact()`（FR-5.3）
- 不会注入执行 steer（FR-5.4~5.5）
- 不会尝试 `__goalInit`（FR-6.4 / AC-9）

**修复方向：** Task 6 的 `complete` case 应该：
1. 通过 `ask_user` 工具（pi-ask-user 提供的 `ask_user_question`）让用户选择 a/b/c
2. 根据选择调用 `handlePlanComplete(pi, ctx, state, isolation)`
3. 用 `pi.sendUserMessage` 配合 `deliverAs: "steer"` 注入提示词

### M3. `ctx.compact()` 错误处理双重且 try/catch 无效（plan.md Task 7）

**位置：** `plan.md` Task 7 `compact.ts` `case "compact"` 块

**严重度：** must_fix

**问题：** plan 用 `try { ctx.compact({...}) } catch { fallback }` 包裹调用，同时又给 `ctx.compact` 传 `onError` callback 走降级。这是死代码。

**SDK 源码证据（`agent-session.js:1302-1316`）：**

```javascript
compact: (options) => {
    void (async () => {
        try {
            const result = await this.compact(options?.customInstructions);
            options?.onComplete?.(result);
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            options?.onError?.(err);
        }
    })();
},
```

错误被内部 IIFE 捕获后**只**走 `options?.onError?.(err)` 路径，**不会**作为同步异常向外抛出。所以外层 try/catch 永远不会触发。`onError` 已经走降级，外层 try/catch 走的是同一条降级路径但用的是旧的"Compact failed"消息。

**参考正确实现：** `extensions/coding-workflow/lib/tool-handlers.ts:554-590` 只用 `onError: (error: Error) => {...}`，无外层 try/catch。

**修复方向：** 删除外层 try/catch，仅保留 `onError` 回调的错误处理（与 coding-workflow 一致）。

### M4. `command.ts` 缺失 `/plan abort` 和 `/plan status` 子命令（plan.md Task 5）

**位置：** `plan.md` Task 5 `command.ts` 行 835-880

**严重度：** must_fix

**问题：** 当前 `command.ts` 只识别 4 种情况：active+empty（显示状态）、active+text（警告）、inactive+text（进入 plan mode）。缺失：
1. **FR-7.1** `/plan abort` 在任何阶段均可取消——plan 没有解析 `/plan abort`
2. **L3 (spec_review_v1)** `/plan status` 子命令——FR-1.4 描述的 "/plan status" 语义未在 plan 中明确
3. **FR-1.3** 4 选项对话框 "继续/实现/新建/取消"——plan 完全未实现

**后果：** AC-6（abort 取消）无法通过。`/plan abort` 是用户在 plan 中想退出的唯一主动方式，没有这个命令则只能通过 `plan` tool (abort) action 取消，UX 严重劣化。

**修复方向：** 在 `command.ts` handler 的开头增加子命令解析：
- `if (trimmed === "abort")` → 调用 abort 逻辑
- `if (trimmed === "status")` → 显示状态
- 其他 → 走现有的"已进入/未激活"判断

### M5. plan-mode 重入处理未实现（FR-1.8）

**位置：** `plan.md` Task 5 `command.ts`

**严重度：** must_fix

**问题：** FR-1.8 规定"重入时先读已有 plan 文件，判断是新任务覆盖还是同一任务迭代"。Task 5 的 handler 走的是简单的 "isActive 状态判断"，没有处理 "not in plan mode + `/tmp/plan-*.md` 已存在" 的场景。当用户输入 `/plan` 不带参数时，spec 期望：
- 扫描 `/tmp/plan-*.md`
- 找到 1+ 个 plan 文件
- 提示 4 选项（继续/实现/新建/取消）
- 选"继续"时读 plan 文件并恢复到 writing 阶段
- 选"实现"时退出 plan mode + 注入执行 steer
- 选"新建"时覆盖旧文件（spec N5 建议明确"覆盖 vs 新 slug"）
- 选"取消"时什么也不做

plan.md 完全未涉及此逻辑。

**修复方向：** 在 `command.ts` 中：
- 当 `!state.isActive && !trimmed` 时，扫描 `/tmp/plan-*.md`
- 如果有，使用 `ask_user` 工具呈现 4 选项（spec N5 建议给每个选项明确语义）
- 把选中的 plan 文件路径恢复到 state.planFilePath

### M6. SKILL.md 缺失 subagent 能力检测流程（FR-6.1~6.3）

**位置：** `plan.md` Task 8 `skills/plan-mode/SKILL.md`

**严重度：** must_fix

**问题：** FR-6.1~6.3 规定 AI 读取 plan 文件后应：
- FR-6.1: 检查 pi-subagents 包是否已安装 + Pi tool 注册表是否有 subagent tool
- FR-6.2: 有 subagent → 建议启动 goal + wave 并行开发
- FR-6.3: 无 subagent → 建议单 agent 分阶段执行

plan 的 SKILL.md（Task 8）只描述了 B1~B4（brainstorming）和 Phase C/D（writing + completion）的简化版，**完全没有 subagent 能力检测的步骤**。`handlePlanComplete` 的 steer message 写的是 "Check for subagent capability and suggest goal + wave execution if available"——这是给 AI 的指令，但 SKILL.md 是 AI 行为的唯一系统提示词入口；不在 SKILL.md 中详细规定，AI 大概率不会执行检测而是直接启动 goal。

**修复方向：** 在 SKILL.md 末尾添加 "Phase D3: Implementation Handoff" 章节：
1. 读取 plan 文件
2. 执行 subagent 检测：
   - `ls node_modules/pi-subagents 2>/dev/null` 或 `cat package.json | grep pi-subagents`
   - 通过 `getActiveTools()` / `getAllTools()` 检查 subagent tool 是否注册
3. 根据检测结果给出执行建议

### M7. SKILL.md 缺失 ask_user 工具使用规范（FR-2.3）

**位置：** `plan.md` Task 8 `skills/plan-mode/SKILL.md`

**严重度：** must_fix

**问题：** FR-2.3 规定"提问时优先使用 `ask_user` 工具（如已安装 pi-ask-user）"。plan 的 SKILL.md 写的是 "Ask 2-3 questions at a time"（B2 章节），没有任何对 `ask_user` 工具的指引。对照参考实现 `extensions/coding-workflow/skills/xyz-harness-brainstorming/SKILL.md:172` 明确说：

> **Use `ask_user` tool when available** — if `ask_user` / `ask_user_question` tool is registered (from pi-ask-user or similar extension), prefer it over plain text for structured questions.

plan 应遵循相同模式。

**修复方向：** 在 B2 Progressive Questioning 章节加一段 "Question Tooling"：
- 优先使用 `ask_user` / `ask_user_question` 工具
- 备选：纯文本多选
- 何时用哪种场景

### M8. onError 回调签名与 SDK 不一致

**位置：** `plan.md` Task 7 `compact.ts` 行 1091-1096

**严重度：** must_fix

**问题：** plan 写的是 `onError: () => {...}`（无参数），而 SDK 的实际类型签名是 `onError: (error: Error) => {...}`（`extensions/types.d.ts:CompactOptions.onError?: (error: Error) => void`）。

**SDK 实际签名：**
```typescript
export interface CompactOptions {
    customInstructions?: string;
    onComplete?: (result: CompactionResult) => void;
    onError?: (error: Error) => void;
}
```

这导致错误信息无法传递到 fallback 路径，用户收到的只是通用的 "Compact failed" 通知，而不是具体的错误原因（"stale context", "compaction in progress" 等）。

**修复方向：** `onError: (error: Error) => {...}`，并把 error.message 包含在通知文本中（参考 `coding-workflow/lib/tool-handlers.ts:580` 的 `error.message` 使用模式）。

### M9. `extension-dependencies.json` 未注册新 extension（项目约定违反）

**位置：** 根目录 `extension-dependencies.json`

**严重度：** must_fix（违反 CLAUDE.md 的 `[MANDATORY]` 条款）

**问题：** CLAUDE.md "Extension 依赖管理 [MANDATORY]" 规定：
> 所有 extension 之间的依赖关系必须在根目录的 `extension-dependencies.json` 中声明。新增、修改、删除 extension 时必须同步更新此文件。

plan-mode 对外有 3 个依赖：
- `@zhushanwen/pi-goal`（package 依赖，调用 `__goalInit`）
- `pi-ask-user`（optional，使用 `ask_user` 工具）
- `pi-subagents`（optional，subagent 能力检测）

plan.md 完全没有 plan 更新 `extension-dependencies.json`。

**修复方向：** 在 plan.md 增加一个 Task（建议作为 Task 0 / 准备工作），在 extension 初始化时同步更新 `extension-dependencies.json`，添加 `@zhushanwen/pi-plan` 条目和 3 个 `dependsOn` 记录。设计文档 plan-mode-design.md 第 10 节已有正确示例可参考。

### M10. `package.json` 字段与项目其他 extension 不一致

**位置：** `plan.md` Task 1 `package.json`

**严重度：** must_fix

**问题：** plan 的 `package.json` 与项目现有 extension（如 `extensions/goal/package.json`）不一致：

| 字段 | plan 当前值 | goal 等 extension | 差异 |
|------|----------|------------------|------|
| `main` | `"index.ts"` | `"src/index.ts"` | 路径错误（虽然 Pi 会 fallback，但 npm pack 时会指向错误）|
| `keywords` | `["pi-package"]` | `["pi-package", "extension", "goal", ...]` | 缺 "extension" |
| `license` | 缺失 | `"MIT"` | 缺 |
| `peerDependencies` | 缺失 | 完整声明 pi-coding-agent, pi-tui, pi-ai, typebox | 缺 |
| `pi.skills` | `["./skills"]` | 缺 | 缺（项目内大部分 extension 无 skills）|

**证据：** 实际 `extensions/goal/package.json`：
```json
{
  "name": "@zhushanwen/pi-goal",
  "main": "src/index.ts",
  "pi": { "extensions": ["./index.ts"] },
  "keywords": ["pi-package", "extension", "goal", "autonomous", "loop"],
  "license": "MIT",
  "files": ["src/", "index.ts"],
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "@earendil-works/pi-ai": "*",
    "@sinclair/typebox": "*"
  }
}
```

**后果：** pre-commit hook 的 `pi manifest 检查`（CLAUDE.md 列出）会失败。`npm pack` 行为可能异常。

**修复方向：** 修改 plan 的 Task 1 `package.json` 示例，对齐 goal 等现有 extension 的字段。CLAUDE.md 已有强制规范要求 `pi.extensions: ["./index.ts"]`（注意不是 `"./src/index.ts"`，plan 写的 `["./index.ts"]` 实际是对的，但 main 字段指向了 .ts 文件本身而非 src/index.ts，与项目约定不一致）。

### N1. `tree` case 错误地注入 steer message（plan.md Task 7）

**位置：** `plan.md` Task 7 `compact.ts` `case "tree"` 块

**严重度：** must_fix

**问题：** plan 的 `tree` case 同时执行 `ctx.ui.notify(...)` 和 `pi.sendUserMessage(steerMessage, { deliverAs: "steer" })`。但 spec 和设计文档都规定 tree 路径只通知，不注入 steer。

**spec FR-5.4：** "选项 b：tree 回退 — 提示用户手动 `/tree`"
**plan-mode-design.md D2：** "若选 tree：提示用户手动 /tree"
**plan-mode-design.md 5.4 Behavior（plan tool 表格）：** "若选 tree：提示用户手动 /tree"

三处来源都明确：tree 路径**只**通知用户手动执行 /tree，**不**注入 steer。注入 steer 会与 `session_before_tree` handler 的设计意图冲突——handler 是在用户后续手动 /tree 时把 "Read plan file and execute" 写进回退摘要；如果在 tree 路径下先注入 steer，再触发 /tree 摘要化，steer message 会被摘要化掉或者落到错误的分支。

**修复方向：** 删除 `case "tree"` 中的 `pi.sendUserMessage(steerMessage, ...)` 调用，仅保留 `ctx.ui.notify("Use /tree to manually navigate back.", "info")`（可考虑在 notify 中包含 plan 文件路径以提升 UX）。

## LOW（信息级改进，不阻塞）

### L1. `complete` action 应清理 `state.templateName`

`state.templateName` 在 abort 时被清空（行 998-1002），但在 `complete` 时未清空。`complete` 是终止态，模板名无意义。建议在 `case "complete"` 中也 reset（虽然下次进入时会被 `state.requirement = trimmed` 重置）。

### L2. 模板系统优先级检查应补充测试

Task 4 的 `listTemplates` 实现正确实现了 project > global > builtin 优先级，但 templates.test.ts 的测试用例只验证 builtin 列表，没有 project 覆盖 global 的测试。`test_cases_template.json:TC-8-02` 已有此测试，但 plan.md Task 4 的 Step 1 测试代码没有覆盖。

### L3. 模板路径 `getBuiltinTemplateDir()` 依赖源码运行

`getBuiltinTemplateDir()` 用 `path.resolve(__dirname, "..", "templates")` 定位。Pi extension 不编译（运行时由 Pi 加载 .ts），所以 `__dirname` 始终是 `extensions/plan/src/`，路径 `extensions/plan/templates/` 正确。但 plan.md 没有说明"不编译"的部署假设——未来如果有人加 `tsc` 编译到 `dist/`，路径会指向错误位置。建议在 plan.md 顶部 Architecture 段落显式声明 "no build step"。

### L4. `create-template` action 缺少路径遍历防护

`fs.writeFileSync(path.join(templateDir, `${templateName}.md`), templateContent)` 不验证 `templateName` 是否包含 `/`、`..` 等字符。`templateName = "../../../tmp/evil"` 会写到 `templateDir` 之外。Task 6 的实现无路径验证。

### L5. `e2e-test-plan.md` TS-5 期望与 plan 实际行为不符

TS-5 步骤 4 "验证 compact 成功执行" / "验证新上下文中 AI 读取 plan 文件"——但 plan 的 `complete` action（M2）从未调用 `handlePlanComplete`，所以 compact 实际不会执行。TS-5 在 dev 阶段会立即 fail。

### L6. `test_cases_template.json` TC-1-02 与 spec FR-1.3 冲突

TC-1-02 描述 "/plan without args enters plan mode with empty requirement"——但 spec FR-1.3 规定 `/plan` 不带参数且当前不在 plan mode 时应**先检测已有 plan 文件并提示选择**，而不是直接进入 plan mode。测试用例与 spec 行为相反。

### L7. `use-cases.md` UC-2 覆盖 AC 重复且未覆盖 AC-6

UC-2 描述"bug 修复"覆盖 AC-1, AC-2, AC-4, AC-5, AC-6，但 main flow 步骤 1-9 没有 abort 触发的场景，AC-6（abort 取消）实际只在 alternative path 中提到。use case 的 main flow 应明确展示一个 abort 触发的步骤（如步骤 5 用户觉得信息不足，调用 abort）。

### L8. `non-functional-design.md` 缺少可观测性 / 日志段落

只提到 `ctx.ui.notify` 和 `console.warn` 的隐式使用（实际在 M3 修复后会用到），但没有显式声明：
- error 路径的日志输出策略（生产 vs debug）
- 关键状态变更的日志粒度
- plan 文件 IO 失败的错误传播

建议增加"Observability"段落。

### L9. `session_before_compact` 自定义 compaction 缺 firstKeptEntryId/tokensBefore

plan-mode-design.md 第 5.7 节的示例代码包含了：
```typescript
return {
  compaction: {
    summary: ...,
    firstKeptEntryId: event.preparation.firstKeptEntryId,
    tokensBefore: event.preparation.tokensBefore,
  },
};
```

但 plan.md Task 7 的实现只返回 `summary`，缺 `firstKeptEntryId` 和 `tokensBefore`。SDK 内部 `agent-session.js:1286-1290` 会从 `extensionCompaction.firstKeptEntryId` 读取，缺失可能致 `appendCompaction` 失败或行为异常。

### L10. `GoalInitFn` 类型定义与 actual 不完全对齐

plan 的 compact.ts 中 `GoalInitFn = (objective: string, tasks: string[], budget?: Record<string, unknown>) => boolean`，与 goal 实际签名 `(objective, tasks, budget?: { tokenBudget?, timeBudgetMinutes?, maxTurns? }) => boolean` 不完全匹配。但 coding-workflow/lib/tool-handlers.ts:498 用的是 `Record<string, unknown>` 同样简化版，所以这是项目现有约定，**非缺陷**。仅作信息记录。

## 关键正面观察

- **AC 覆盖矩阵完整**：plan.md 的 Spec Coverage Matrix 覆盖 AC-1~AC-11
- **接口契约清晰**：state、tool、templates、compact 四个模块的函数签名都有定义
- **测试驱动结构正确**：每个 Task 都有 Step 1 (写失败测试) → Step 2 (验证失败) → Step 3 (实现) → Step 4 (验证通过) → Step 5 (commit) 循环
- **Vitest 配置正确**：与项目其他 extension 一致
- **依赖模板系统设计合理**：project > global > builtin 优先级明确
- **Goal API 引用正确**：`__goalInit` 实际存在于 `extensions/goal/src/index.ts:422`，且 plan 的调用模式与 `extensions/coding-workflow/lib/tool-handlers.ts:498-525` 完全一致
- **Pi 事件名使用正确**：`session_before_compact` / `session_before_tree` 是 SDK 中用于自定义 compaction/tree summary 的正确事件（v1 M1 是误判）
- **subagent 设计文档决策明确**：plan-mode-design.md 第 9 节有跨工具对比分析

## 跨文件一致性检查

| 检查项 | plan.md | e2e-test-plan.md | test_cases_template.json | use-cases.md | non-functional-design.md | 结论 |
|--------|---------|------------------|--------------------------|--------------|--------------------------|------|
| AC 覆盖 | 11/11 | 9 scenarios, 11 AC | 18 cases, 11 AC | 4 UCs, 8 AC explicit | 未涉及 AC 维度 | 一致 |
| 模板数量 | 5 builtin | 未涉及 | 未涉及 | 4 UCs 引用 4 templates | 未涉及 | 一致（5 内置 vs 4 UC 引用 4 个，UC-2 提了 bugfix-plan，符合）|
| 状态机 | 4 phases (idle/brainstorming/writing/complete) | 同 | 同 | 同 | 同 | 一致 |
| 隔离方式 | 3 options (compact/tree/direct) | TS-5/6 覆盖 2 (compact/direct) | TC-5-01/02/6-01 覆盖 2 | UC-3 提及 direct | §1 稳定性 | **不一致**——plan 提 3 options 但测试只覆盖 2 |
| 事件名 | session_before_compact / session_before_tree | 未涉及 | 未涉及 | 未涉及 | 未涉及 | 一致（与 SDK 签名匹配）|
| Goal API | pi.__goalInit() | TS-7 覆盖 | TC-7-01 覆盖 | UC-1 提及 goal 启动 | 未涉及 | 一致 |
| Extension 依赖 | 未涉及（缺失） | 未涉及 | 未涉及 | 提及 goal | 未涉及 | **缺失**——plan-mode-design.md 第 10 节有声明，plan.md 无对应 Task |

## 修复优先级建议

1. **M2 (complete 触发 handlePlanComplete) + M3 (compact 错误处理) + M8 (onError 签名)** 是 dev 阶段会立即阻断的关键修复，应一次性修齐
2. **M4 (subcommands) + M5 (重入)** 是 spec 行为完整性修复，UX 影响大
3. **M6 + M7 (SKILL.md 缺失)** 是 spec 行为完整性修复，AI 行为影响大
4. **M9 + M10 (项目约定)** 是 pre-commit hook 阻断项，必须修
5. **N1 (tree 错误注入)** 是 spec 行为正确性修复，必须修

## 结论

**Fail。** plan.md 的 Task 列表、文件结构、Spec Coverage Matrix 在形式上完整，但**核心控制流存在 3 处未接线**（complete 不触发 handlePlanComplete、subcommands 缺失、重入未实现），**Pi runtime API 假设存在 1 处错误**（onError 签名），**spec 行为存在 1 处未正确实现 + 2 处未在 SKILL.md 体现**（tree 错误注入 steer、subagent 检测缺失、ask_user 工具缺失），**违反项目约定 2 处**（extension-dependencies.json、package.json 字段）。

修复 10 项 MUST FIX 后，dev 阶段可正常推进。**v1 的 M1 经独立验证为 false positive**，plan 的事件名使用正确，v1 评审误把 `session_compact`（post-event 通知）当作"正确事件"，实际 `session_before_compact`（pre-event 支持自定义 compaction）才是正确选择。

## 评审元数据

```yaml
review:
  type: plan_review
  round: 2
  timestamp: "2026-06-11T14:15:00+08:00"
  target: ".xyz-harness/2026-06-11-plan-mode/plan.md"
  related: [e2e-test-plan.md, test_cases_template.json, use-cases.md, non-functional-design.md]
  verdict: fail
  summary: "plan 评审 v2 失败。10 项 MUST FIX。v1 的 M1（事件名错误）经独立验证为 false positive，事件名使用正确。其余 9 项 MUST FIX 全部成立。新增 1 项 N1（tree 路径错误注入 steer）。"

statistics:
  total_issues: 20
  must_fix: 10
  low: 10
  must_fix_breakdown:
    - category: "Pi runtime API 错误"
      count: 1
      items: [M8]
    - category: "核心控制流未接线"
      count: 3
      items: [M2, M4, M5]
    - category: "spec 行为错误或缺失"
      count: 3
      items: [N1, M6, M7]
    - category: "项目约定违反"
      count: 2
      items: [M9, M10]
    - category: "Pi compact 错误处理"
      count: 1
      items: [M3]
  v1_validation:
    confirmed: 9  # M2-M10
    false_positive: 1  # M1
    new_in_v2: 1  # N1
```
