# Aggregated Review Report — Round 1

## Summary
- Must-fix: 3
- Suggestions: 15
- Infos: 14
- Dimensions reviewed: business-logic, extension-api, monorepo-impact, type-safety, test-coverage

> 协调者验证说明：type-safety 和 extension-api 两个维度判定 `ctx.mode` 判定为「类型正确」并标记为 pass/INFO，但二者仅做了 tsc 类型层面验证。monorepo-impact 维度进一步核对了真实 SDK 运行时实现，发现 `ctx.mode` 在运行时不存在。协调者已独立复核 SDK 源码（见 MF#1 验证记录），确认 monorepo-impact 的 MUST_FIX 成立，type-safety/extension-api 的相关 INFO 结论被推翻。

## Must-Fix Issues

| # | 文件 | 行号 | 维度 | 描述 | 修复方向 |
|---|------|------|------|------|----------|
| MF#1 | shared/types/mariozechner/index.d.ts | 15-29 | monorepo-impact | **stub 虚构了 `ctx.mode` 字段，导致 4 个扩展的 GUI 协议在运行时全部失效。** stub（L16, L28）声明了 `ExtensionMode` 类型和 `ExtensionContext.mode` 字段，但真实 SDK `@mariozechner/pi-coding-agent@0.73.1` 的 `ExtensionContext` 接口（`dist/core/extensions/types.d.ts:207-236`）**没有 `mode` 字段**，`createContext()` 运行时实现（`dist/core/extensions/runner.js:377-438`）**不设置 `mode` 属性**。后果：(1) ask-user（index.ts:197）`if (ctx.mode !== "tui" && ctx.mode !== "rpc")` → `undefined !== "tui"` 为 true → **TUI 模式下 ask-user 工具被误禁用**（致命回归）；(2) ask-user（index.ts:237）`const useRpc = ctx.mode === "rpc"` → 永远 false → **RPC 富交互分支永远走不到**；(3) todo（tool.ts:217）、goal（goal-control-adapter.ts:351）、subagent-workflow（经 `isGuiCapable` → `ctx.mode === "rpc"`）的 `__gui__` 输出条件永远不满足 → **GUI 协议零输出**。 | 二选一：(A) 升级 SDK 到真实提供 `ctx.mode` 的版本并同步 stub；(B) 若 SDK 0.73.1 是当前 target，删除 stub 中的 `mode` 字段，改回用 `ctx.hasUI` 做 headless 判定，RPC 分支用其他机制（如 try/catch `ctx.ui.select` 抛错、或 env/flag、或协议包的 `askUserInteract` 内置 select 可用性检测）区分。**需先确认 xyz-agent 实际运行时如何注入 RPC 上下文**——如果 xyz-agent 的 sidecar 进程通过自定义方式设置 mode，则 stub 需对齐该注入点而非对齐 SDK。 |
| MF#2 | extensions/subagent-workflow/src/interface/tool-workflow.ts | 157-167 | business-logic | `buildWorkflowGui` 的 run 分支：workflow "not_found" 错误路径（`actionRun` 返回 `status:"not_found"` + `isError:true`）经 `mapRunStatus("not_found")` 被渲染成 `status:"done"` + `icon:"check"` 的**成功**状态，与 isError 文案直接矛盾，RPC 模式下用户看到错误操作的绿色对勾。 | 在 run 分支前对 `status === "not_found"` 短路返回 `guiComponent("stats-line", { items: [{ label:"run", value:"not found", severity:"danger" }] })`；或将 "not_found" 归入 `mapRunStatus`/`mapRunIcon` 的 failed 分支。 |
| MF#3 | extensions/subagent-workflow/src/interface/tool-workflow-script.ts | 83-153 | test-coverage | `buildScriptGui`/`withScriptGui` 为本次新增的 GUI 协议构造逻辑（约 100 行，5 个 action 分支），**完全无测试**。是 PR 四扩展中唯一「新增可测函数零测试」的扩展。 | 新建测试文件，对 5 个 action（generate/lint/list/save/delete）各写用例，覆盖 ok/warn severity 与 RPC 模式 `__gui__` 透传。 |

## Suggestions

| # | 文件 | 行号 | 维度 | 描述 | 修复方向 |
|---|------|------|------|------|----------|
| S#1 | extensions/subagent-workflow/src/interface/subagent-actions.ts | 283-289 | business-logic | start 分支丢弃 subagentId/agent/slug，输出无身份的 "subagent / running" 卡片，信息密度低于旧 subagent-trace，并发 subagent 无法区分。 | 用 `input.domain` 构造 header（slug 或 subagentId 前 8 位），body 加 agent/id/running 信息。 |
| S#2 | extensions/goal/src/adapters/goal-control-adapter.ts | 241-244 | business-logic | `statusSeverity` 把 budget_limited/time_limited 兜底为 "warn"，应为 "danger"（与 widget.ts 的 error 红色不一致）。当前不可达（goal_control 不产生这些状态），属防御性隐患。 | budget_limited/time_limited/cancelled → "danger"；paused → "warn"。 |
| S#3 | extensions/ask-user/src/index.ts | 109-115 | business-logic | `protoAnswersToResult` 多选 answers 未按 options 索引排序，TUI 版 sort 了，可能产出 "C, A" vs "A, C" 的文本差异。 | 多选按 `q.options` 索引重排后再 join。 |
| S#4 | extensions/subagent-workflow/src/interface/subagent-actions.ts | 247-275 | extension-api | `SubagentToolResult` discriminated union 未声明 `__gui__?: GuiRenderResult`，运行时写入但靠 `as unknown as` 强转绕过类型检查，类型契约不完整。 | 在 `SubagentToolDetails` 接口补 `__gui__?: GuiRenderResult`，去掉强转。 |
| S#5 | extensions/subagent-workflow/src/interface/tool-workflow-script.ts | 99-107 | extension-api/type-safety | `WorkflowScriptToolDetails` union 未声明 `__gui__`，`withScriptGui` 用 `as unknown as` 强转（no-unsafe-cast warn）。同 S#4。 | union 各成员补 `__gui__?: GuiRenderResult`。 |
| S#6 | extensions/subagent-workflow/src/interface/tool-workflow.ts | 145-154, 277-281 | extension-api/type-safety | `WorkflowToolDetails` union 未声明 `__gui__`，`withGui` 用强转。同 S#4。 | union 各成员补 `__gui__?: GuiRenderResult`。 |
| S#7 | extensions/subagent-workflow/src/interface/helpers.ts | 89-101 | extension-api | `notifyDone()` 的 details 是裸 `Record<string, unknown>`，RPC 模式写入 `__gui__`，建议抽取 `WorkflowNotifyDetails` 接口明确契约。 | 新增接口替代裸 Record。 |
| S#8 | extensions/subagent-workflow/package.json | 46-48 | monorepo-impact | `slug` 字段扩散到 6 个公开类型（4 个必填），构成对 npm 外部消费者的 breaking change，但 changeset 标 minor。 | slug 设为可选，或 changeset 升级为 major，或注明 breaking。 |
| S#9 | extensions/subagent-workflow/src/interface/tool-workflow-script.ts | 100-106 | type-safety | `as unknown as WorkflowScriptToolDetails` 双重断言（与 S#5 同根因）。 | 同 S#5。 |
| S#10 | extensions/subagent-workflow/src/interface/tool-render.ts | 103 | type-safety | `(startParam as { slug?: unknown }).slug` 结构断言，已有 typeof guard 兜底。紧邻 pre-existing 同模式。 | 可接受现状，有运行时 guard。 |
| S#11 | extensions/ask-user/src/index.ts | 137-141 | type-safety | `guiCtx` 构造未显式标注 `: GuiContext`，经结构推断收窄。实现正确，与 `toGuiCtx` 同构。 | 可选：显式标注提升可读性。 |
| S#12 | extensions/subagent-workflow/src/interface/gui-mappers.ts | 11-17 | test-coverage | `toGuiCtx(ctx)` 新增 export，被 3 处调用，无直接测试。 | 补 `describe("toGuiCtx")`：undefined、rpc、tui 三种输入。 |
| S#13 | extensions/subagent-workflow/src/interface/helpers.ts | 87-99 | test-coverage | `notifyDone` 的 GUI 分支（list-tree + reason 拼接）重写，无测试。 | 补 reason 非空/空两个用例。 |
| S#14 | extensions/goal/src/adapters/goal-control-adapter.ts | 241-244, 250-270 | test-coverage | `statusSeverity` 的 warn 兜底分支未测；预算阈值边界（正好 0.9/0.7）未测。 | 补 budget_limited 状态用例 + 精确边界用例。 |
| S#15 | extensions/subagent-workflow/src/interface/gui-mappers.ts | 39-82 | test-coverage | `mapRunStatus`/`mapRunIcon` 未测未知状态（如 "foobar"、""）的 default 落点。 | 补 unknown/空串用例。 |

## Infos

| # | 文件 | 行号 | 维度 | 描述 |
|---|------|------|------|------|
| I#1 | extensions/goal/src/adapters/goal-control-adapter.ts | 246-264 | business-logic | tokenBudget=0 时 hasBudget 与进度条判定口径不一致（包了 card 但无进度条）。影响轻微。 |
| I#2 | extensions/ask-user/src/index.ts | 137-142 | business-logic | RPC 模式 `ui.select` 缺失时 `.bind` 抛错，已被外层 try/catch 优雅降级。 |
| I#3 | extensions/subagent-workflow/src/interface/helpers.ts | 92-100 | business-logic | notifyDone label 未含 slug，与 buildWorkflowGui 不一致。 |
| I#4 | extensions/subagent-workflow/src/interface/tool-workflow-script.ts | 110-142 | business-logic | buildScriptGui switch 无 default，被守卫兜住，不可达。 |
| I#5 | extensions/ask-user/src/index.ts | 95-152 | extension-api | ask-user headless 守卫从 `!ctx.hasUI` 改为 `mode !== "tui" && mode !== "rpc"`——**注意此 INFO 结论被 MF#1 推翻**：运行时 `ctx.mode` 为 undefined，TUI 模式会误禁用。 |
| I#6 | extensions/todo/src/model.ts | 19-25 | extension-api | `_render` 字段删除无消费者回归。 |
| I#7 | extensions/subagent-workflow/src/execution/session-reconstructor.ts | 435-441 | extension-api | slug 兜底 `?? ""`，向后兼容。 |
| I#8 | extensions/{ask-user,goal,todo,subagent-workflow}/package.json | - | monorepo-impact | 4 扩展的 `@xyz-agent/extension-protocol: ^0.2.0` 版本一致，声明位置统一。 |
| I#9 | pnpm-lock.yaml | - | monorepo-impact | lockfile 正确 resolve，无 floating 版本。 |
| I#10 | extensions/subagent-workflow/src/interface/gui-adapter.ts (已删除) | - | monorepo-impact | 删除的 gui-adapter.ts 零残留引用，导入链无循环。 |
| I#11 | extension-dependencies.json | - | monorepo-impact | 4 extension 间依赖无变化，无需更新。 |
| I#12 | extensions/subagent-workflow/src/interface/gui-mappers.ts | 25-29 | type-safety | `toGuiCtx` 省略 ui 字段合理（subagent-workflow GUI 路径只渲染不交互）。 |
| I#13 | shared/types/mariozechner/index.d.ts | 15-29 | type-safety | **此 INFO 结论被 MF#1 推翻**：`ExtensionMode` 和 `mode` 字段看似正确，但真实 SDK 不提供。 |
| I#14 | extensions/subagent-workflow/src/__tests__/gui.test.ts | 1-449 | test-coverage | import 格式风格问题（逗号后无空格、`.ts` 后缀），非测试覆盖问题。 |

## 协调者验证记录

### MF#1 验证（`ctx.mode` 运行时是否存在）

**结论：MF#1 成立。`ctx.mode` 在 SDK 0.73.1 运行时不存在。**

验证路径：
1. SDK `createContext()` 实现（`node_modules/.pnpm/@mariozechner+pi-coding-agent@0.73.1.../dist/core/extensions/runner.js:377-438`）：返回对象有 `ui`/`hasUI`/`cwd`/`sessionManager`/`modelRegistry`/`model`/`isIdle`/`signal`/`abort`/`hasPendingMessages`/`shutdown`/`getContextUsage`/`compact`/`getSystemPrompt`——**无 `mode`**。
2. `ExtensionRunner` 构造函数（runner.js:117）：`(extensions, runtime, cwd, sessionManager, modelRegistry)`——**无 mode 参数**。
3. 真实 `ExtensionContext` 接口（`dist/core/extensions/types.d.ts:207-236`）：14 个成员，**无 `mode` 字段**。注释 `hasUI: "Whether UI is available (false in print/RPC mode)"`。
4. 全 SDK grep `mode:` in extensions/*.js：无 context/runner 相关的 mode 注入。
5. 协议包 `isGuiCapable` 实现（`@xyz-agent/extension-protocol/dist/index.mjs:8-9`）：`return ctx.mode === "rpc"` → 运行时永远 false。

stub（index.d.ts L16/L28）声明 `mode` 是虚构的，tsc 通过是因为 ambient module declaration 不校验运行时。

**补充假设（需用户确认）**：xyz-agent 的 sidecar 可能通过非标准方式注入 `mode`（例如 RPC 进程启动时 monkey-patch ctx 或传递自定义 context）。如果是这种情况，stub 需要对齐 xyz-agent 的注入机制而非对齐标准 SDK。MF#1 的修复方向需要先确认 xyz-agent 运行时如何提供 RPC 模式标识。

### 跨维度冲突解决

| 冲突 | type-safety/extension-api 结论 | monorepo-impact 结论 | 协调者裁决 |
|------|------|------|------|
| `ctx.mode` 是否可用 | INFO：类型正确，tsc 通过 | MUST_FIX：运行时不存在 | **采信 monorepo-impact**。tsc 通过 ≠ 运行时正确，ambient stub 不校验运行时。type-safety/extension-api 的相关 INFO（I#5, I#13）标注为「被推翻」。 |
