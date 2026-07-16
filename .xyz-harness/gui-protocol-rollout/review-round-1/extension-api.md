---
verdict: pass
must_fix: 0
---

## Summary
0 must-fix, 4 suggestions, 3 infos.

本次 PR（#84）将 ask-user / subagent-workflow / todo / goal 四个扩展接入 `@xyz-agent/extension-protocol@0.2.0` 的 `__gui__` 渲染协议。核心契约 `result.details.__gui__ = { v: 1, component: { type, props } }` 在四个扩展中均被正确实现：`__gui__` 字段均为可选、仅 RPC 模式填充、TUI/print/json 模式走原生渲染路径。Pi manifest 四项（`pi.extensions: ["./index.ts"]`、`type: "module"`、`keywords: ["pi-package"]`、`@xyz-agent/extension-protocol` 在 dependencies）全部合规。ask-user 的 headless 兼容性（TUI 行为不变）经核对 main 分支对比确认未破坏。无 must-fix。

## Findings

| 优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向 |
|--------|------|------|------|------|----------|
| SUGGESTION | extensions/subagent-workflow/src/interface/subagent-actions.ts | 247-275 | details-type | `adapter()` 返回的 `details` 是 `Record<string, unknown>` 并以 `as unknown as SubagentToolResult` 强转回 `SubagentToolResult`，但 RPC 模式下实际已附加 `__gui__` 字段。`SubagentToolDetails`（execution/types.ts:362-386）和 `SubagentToolResult`（types.ts:489-492）均未声明 `__gui__?: GuiRenderResult`，下游若按此类型消费 RPC details 会类型丢失 `__gui__`。运行时正确（字段已写入），仅类型契约不完整。 | 在 `SubagentToolDetails` 接口（execution/types.ts:362）补 `__gui__?: GuiRenderResult;`，并在 `SubagentToolResult` 三分支统一加该可选字段，去掉 `as unknown as` 强转。 |
| SUGGESTION | extensions/subagent-workflow/src/interface/tool-workflow-script.ts | 99-107 | details-type | `withScriptGui()` 把 `__gui__` 写入 details 后用 `as unknown as WorkflowScriptToolDetails` 强转。`WorkflowScriptToolDetails`（本文件 69-74 行）是 discriminated union，未声明 `__gui__` 字段。与 subagent-actions 同类问题：运行时正确，类型契约不完整。 | 在 `WorkflowScriptToolDetails` 每个 union 成员补 `__gui__?: GuiRenderResult;`（或定义 wrapper 类型），去掉 `as unknown as` 强转。 |
| SUGGESTION | extensions/subagent-workflow/src/interface/tool-workflow.ts | 145-154, 277-281 | details-type | `withGui()` 返回 `Record<string, unknown>`，execute 末尾 `as unknown as WorkflowToolDetails` 强转。`WorkflowToolDetails`（本文件 129-133 行）discriminated union 未声明 `__gui__`。与上两条同类问题。 | 在 `WorkflowToolDetails` 每个 union 成员补 `__gui__?: GuiRenderResult;`，让 `withGui` 返回类型安全。 |
| SUGGESTION | extensions/subagent-workflow/src/interface/helpers.ts | 89-101 | details-type | `notifyDone()` 构造的 `details` 是 `Record<string, unknown>`，RPC 模式下写入 `__gui__`。该 details 经 `pi.sendMessage` 透传给前端，本身无强类型约束，但建议抽取一个 `WorkflowNotifyDetails` 接口（含 `__gui__?: GuiRenderResult`）以明确契约，便于其他 notify 路径复用。 | 新增 `WorkflowNotifyDetails` 接口替代裸 `Record<string, unknown>`。 |
| INFO | extensions/ask-user/src/index.ts | 95-152, 237-242 | backward-compat | ask-user 的 headless 守卫从 main 分支的 `if (!ctx.hasUI)` 改为 `if (ctx.mode !== "tui" && ctx.mode !== "rpc")`，并新增 RPC 分支走 `askUserInteract`（select 通道）。核对 main 分支：原逻辑是 `!hasUI` 直接禁用工具。新逻辑：TUI（hasUI=true）行为完全不变；RPC（hasUI=true，mode='rpc'）新增富交互；print/json（hasUI=false）仍被禁用。TUI 模式行为不变，兼容性正确。 | 无需修复。`ctx.mode === 'rpc'` 判定与 `extension-protocol@0.2.0` 的 `isGuiCapable`（`ctx.mode === 'rpc'`）实现一致。 |
| INFO | extensions/todo/src/model.ts | 19-25 | backward-compat | `TodoDetails` 删除 `_render` 字段，新增 `__gui__?: GuiRenderResult`。全仓搜索确认 `_render`/`buildRender` 在 todo 扩展内已无任何引用（handlers.ts 的 reconstructState 只读 `details.todos`/`details.nextId`，不读 `_render`）。`__gui__` 为可选字段，旧版 xyz-agent 不识别时忽略，向后兼容。 | 无需修复。 |
| INFO | extensions/subagent-workflow/src/execution/session-reconstructor.ts | 435-441 | backward-compat | 新增 `slug` 字段到 `ReconstructedRecord` / `SubagentIdentityData`（optional），`reconstructFromFile` 读取时 `identity.slug ?? ""` 兜底空串。旧持久化文件（无 slug 字段）反序列化为空串，不破坏状态恢复。`deserializeState` 路径未触碰，本次变更理论不影响状态持久化。 | 无需修复。slug 兜底处理正确。 |

## 合规性总览

### Tool/Command Schema
- 所有新增/修改 tool 参数均用 `Type.Object()` + `StringEnum()` 定义 schema（todo 的 `TodoParams`、goal 的 `GoalControlParams`、workflow 的 `WorkflowParams`/`WorkflowScriptParams`、subagent 的 `SubagentParams`）。合规。
- `execute` 返回值结构 `{ content: [...], details: {...} }` 在四个扩展均符合。合规。
- 错误处理：todo/goal handler 用 `throw new Error()`，ask-user 用 `isError: true` 返回（两种模式都符合 ask-user 的设计意图——ask-user 需要向 LLM 返回结构化错误文案而非让框架接管）。合规。

### Pi Manifest（4 个扩展 package.json）
- `pi.extensions: ["./index.ts"]`：四个扩展全部合规（非 `./src/index.ts`）。
- `type: "module"`：四个扩展全部存在。
- `keywords: ["pi-package"]`：四个扩展全部存在。
- `@xyz-agent/extension-protocol: "^0.2.0"` 在 `dependencies`（非 peerDependencies）：四个扩展全部正确声明。
- `pi.skills`：仅 subagent-workflow 有 skills 目录（`./skills`），已在 `pi.skills` 声明。合规。

### 向后兼容性
- `__gui__` 字段在所有 Details 接口（`TodoDetails`、`GoalControlDetails`）均声明为可选（`__gui__?:`）。subagent-workflow 的三个 union details 类型未显式声明（见 suggestions），但运行时为可选填充，不破坏旧版。
- todo 的 `_render` 删除：内部无消费者，向后兼容。
- ask-user TUI 模式行为不变（见 INFO）。
- 状态反序列化未受影响（slug 兜底处理正确）。

### 资源自包含
- 四个扩展均未引用自身目录外的绝对路径。
- `package.json` 的 `files` 字段均包含 `src/`（或具体子目录）+ `index.ts`，资源自包含。ask-user 额外含 `README.md`/`ARCHITECTURE.md`。
