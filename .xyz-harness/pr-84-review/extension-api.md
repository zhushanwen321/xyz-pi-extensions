---
verdict: pass
must_fix: 0
---

# PR #84 扩展接口审查报告

审查范围：4 个扩展的 GUI 协议 + RPC 生命周期接入。base = `origin/main` (ca86484a)，HEAD 14 commits / 64 files。
核对依据：code-review skill 的接口契约 checklist + 真实 SDK 类型 `@earendil-works/pi-coding-agent` types.d.ts。

## Summary

接口契约层质量高，可放行。核心结论：

- **SDK 契约全部对齐真实 SDK**。`ctx.mode` / `ExtensionMode` / `ExtensionContext` 在真实 SDK (`node_modules/.../pi-coding-agent/dist/core/extensions/types.d.ts` L207-214) 中确认存在，stub (`shared/types/mariozechner/index.d.ts`) 已同步且与真实 SDK 一致。`registerCommand` 的 handler 签名 `(args: string, ctx: ExtensionCommandContext) => Promise<void>`（真实 SDK L798）与两个 command handler 实现完全匹配。
- **4 个扩展 typecheck 全部通过**（`tsc --noEmit` exit 0）。
- **`@xyz-agent/extension-protocol@0.2.0` 已正确声明在 4 个扩展的 `dependencies`**，且 pnpm 已解析安装（`node_modules/.pnpm/@xyz-agent+extension-protocol@0.2.0`）。
- **类型契约明显改善**：旧的 3 个不存在的自定义 GuiComponent 类型（`task-list` / `workflow-runs` / `subagent-trace`）已迁移到协议原语（`list-tree` / `card` / `stats-line`）；details union 各成员显式声明 `__gui__?` 后，`withGui` / `adapter` 不再需要 `as unknown as` 强转。
- **向后兼容**：`slug` 从 optional 变 required 仅发生在 4 个 **内部运行时类型**（ExecutionRecord / ExecuteOptions / SubagentToolResult start 分支 / SubagentListItem），反序列化对旧 record 兜底空串；tool schema 层 `slug` 包在 `Type.Optional(startParam)` 内 + 运行时校验，对 LLM 非 breaking。`_render` 删除仅影响已废弃的 todo 内部字段，GUI 消费者走新的 `__gui__`。

无 MUST_FIX。2 个 SUGGESTION（switch 兜底 + pi-ai 包名一致性），3 个 INFO（已确认的非问题）。

## Findings

| # | 类别 | 优先级 | 位置 | 问题与建议 |
|---|------|--------|------|-----------|
| 1 | command-schema | SUGGESTION | `subagent-workflow/src/interface/commands.ts` L84-103 / `subagents.ts` L33-52 | 两个 RPC command handler 的 `switch (parsed.action)` 是闭集判别联合，各 case 都 return，TS exhaustiveness 覆盖——但目前无 `default`。`parseWorkflowRpcCommand` / `parseSubagentRpcCommand` 是纯函数，未来若新增 action verb（如 `restart`）忘记加 case，handler 会静默 fall-through 到后面的 TUI 分支而非报错。建议在 switch 末尾加 `default: { const _exhaustive: never = parsed; ... }` 断言，把 exhaustiveness 变成承重约束（与同 PR `subagent-tool.ts` 的 `assertNever` 模式一致）。 |
| 2 | pi-manifest | SUGGESTION | `goal/src/adapters/goal-control-adapter.ts:27` vs `todo/src/tool.ts:5` | `StringEnum` 的 import 包名不一致：goal 用 `@mariozechner/pi-ai`（旧名），todo 用 `@earendil-works/pi-ai`（新名，pnpm-lock L805 标注 mariozechner 已 deprecated）。两包等价（stub L337 `export * from "@mariozechner/pi-ai"`），typecheck 通过。但 goal 的 `package.json` peerDep 声明的是 `@earendil-works/pi-ai`，import 却指向旧名——靠 stub 桥接而非真实包。建议 goal 统一到 `@earendil-works/pi-ai`（与包名迁移方向一致）。**注：此 import 非本 PR 引入，是历史遗留**，归为 SUGGESTION 而非本 PR 必修。 |
| 3 | tool-schema | INFO | `ask-user/src/index.ts:2` | import 路径从 `@mariozechner/pi-tui` 改为 `@earendil-works/pi-tui`。**已核实非 bug**：`@earendil-works/pi-tui` 是 `@mariozechner/pi-tui` 的继任包（npm 有发布 v0.80.6，lockfile L805 标注 deprecated），ask-user 的 devDep/peerDep 正确声明了 `@earendil-works/pi-tui: "*"`，pnpm 已解析到 `@earendil-works+pi-tui@0.78.0`，typecheck 通过。符合包名迁移方向。 |
| 4 | details-type | INFO | `subagent-workflow/src/interface/tool-workflow.ts:124-135` 等 | details union（`WorkflowToolDetails` / `SubagentToolResult` / `WorkflowScriptToolDetails`）各成员显式声明 `__gui__?: GuiRenderResult`，使 `withGui` 返回类型从 `Record<string, unknown>` 收窄为 `WorkflowToolDetails \| undefined`，消除了原 `as unknown as WorkflowToolDetails` 强转。类型契约正确且更安全。 |
| 5 | backward-compat | INFO | `subagent-workflow/src/execution/types.ts` (slug) + `execute-options-mapper.ts:40` | `slug` 从 optional 变 required 仅限内部类型，非 tool schema 层 breaking。`mapToExecuteOptions` 对缺失 `description` 的旧调用方兜底 `opts.agent ?? "workflow-agent"`；旧持久化 record 反序列化兜底空串（types.ts 注释已说明）。tool schema 层 `slug` 在 `startParam`（`Type.Optional`）内 + `startHandler` 运行时 `throw new Error` 校验（L141-143），符合 code-review checklist「条件必填：schema Optional + execute 内运行时校验」。 |

## 验证清单结果

### Tool / Command Schema 检查

- ✅ tool 参数用 `Type.Object()` + `StringEnum()` 定义（ask-user `InputSchema`、goal `GoalControlParams`、todo `TodoParams`、subagent `SubagentParams` / `WorkflowParams`）。
- ✅ execute 返回 `{ content, details }` 结构（ask-user/tool-workflow/subagent-actions 均符合 `AgentToolResult<TDetails>`）。
- ✅ details 有明确 typed union（`AskUserDetails`、`WorkflowToolDetails`、`SubagentToolResult`、`WorkflowScriptToolDetails`、`TodoDetails`、`GoalControlDetails`），无 `Record<string, unknown>` 逃逸。
- ✅ 错误用 `throw new Error()` + `try/catch`（ask-user 顶层 catch、`startHandler` slug 校验 throw），无「返回错误成功模式」。
- ✅ command handler `description` 已更新反映新语法（`/subagents [<id>] | /subagents cancel <id>`、`/workflows [runId] | /workflows pause|resume|abort <runId>`）。

### Pi Manifest 检查

- ✅ 4 个扩展 `pi.extensions` 均为 `["./index.ts"]`。
- ✅ 4 个扩展均有 `type: "module"` 和 `keywords: ["pi-package"]`。
- ✅ 4 个扩展 `dependencies` 正确声明 `@xyz-agent/extension-protocol: "^0.2.0"`（ask-user / todo / goal / subagent-workflow 全部确认，无遗漏）。

### 向后兼容性检查

- ✅ `slug` required 化仅限内部类型 + 反序列化兜底，非 breaking（Finding #5）。
- ✅ details 新增 `__gui__?` 字段为 optional 增量，不破坏既有 details 消费者（联合 narrowing 仍有效）。
- ✅ `_render` 删除仅限 todo（已废弃字段）；sibling `workflow` 扩展仍用 `_render` 但该包本 PR 已标 DEPRECATED（ADR-030），不影响。
- ✅ `isGuiCapable` 语义变更（`hasUI===false` → `mode==="rpc"`）：所有 caller 经 `toGuiCtx(ctx)` 提取 mode/hasUI 传入，真实协议实现 `ctx.mode === "rpc"` 与注释语义一致。

### 资源自包含检查

- ✅ 无引用扩展目录外的硬编码绝对路径。`process.cwd()` / `/tmp/pi-sub-run-*` 为 per-session 动态路径（pre-existing，非本 PR 新增），合规。

### SDK 契约核对（code-review checklist MANDATORY 项）

- ✅ handler 参数签名：`pi.registerCommand` handler `(args: string, ctx: ExtensionCommandContext) => Promise<void>`，与真实 SDK L798 一致。`ctx.ui` / `ctx.mode` 从第 2 参数 ctx 读取，无误读 event。
- ✅ `ctx.mode` 字段在真实 SDK types.d.ts 存在（L212），非仅 stub——已打开 `node_modules/.../pi-coding-agent/dist/core/extensions/types.d.ts` 核对。
- ✅ registerCommand handler 签名正确（见上）。

## 统计

- MUST_FIX: 0
- SUGGESTION: 2
- INFO: 3
