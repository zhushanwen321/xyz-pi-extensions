---
verdict: fail
must_fix: 2
---

# 扩展接口审查报告

## Summary
2 must-fix, 3 suggestions, 4 infos. 审查范围：`git diff main...HEAD` 共 66 文件 / +15237/-2546，对照真实 SDK 类型 `node_modules/.pnpm/@mariozechner+pi-coding-agent@0.73.1_*/dist/core/extensions/types.d.ts` 逐项核查 tool/command schema、Pi manifest、SDK 接口契约、向后兼容性、资源自包含。

## Findings

| 优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向 |
|--------|------|------|------|------|----------|
| MUST_FIX | `extensions/goal/src/persistence.ts` | 38-94 | backward-compat | `deserializeState` 为"严格模式"——任何缺字段（含 `tokenWarning70Sent` 等 4 个新拆分 flag、`lastTurnTokensUsed`、`completedAtTurnIndex`）一律 `throw`。`reconstructGoalState`(session.ts:78-82) catch 后把 `state=null`，**导致升级前的旧 goal-state entry 被静默全丢**（用户重启后任务进度消失）。changeset 仅声明 `minor` 且说"behavior-equivalent for happy path"，但这是面向用户的破坏性变更。 | 要么 (a) changeset 改 `major` 并在 README 注明升级需 reset；要么 (b) 对缺失的 4 个新 flag 用 `?? false`、`lastTurnTokensUsed ?? 0`、`completedAtTurnIndex ?? undefined` 兜底（仅核心字段缺失才 throw），保留旧格式向后兼容。 |
| MUST_FIX | `extensions/goal/src/index.ts` | 309-318 vs `extensions/coding-workflow/lib/tool-handlers.ts` 504/528 | backward-compat | `__goalInit` 签名从 `(objective, tasks, budget?, ctx?) => boolean`（ctx 可选，省略走 `lastCtx` fallback）变为 **ctx 必填**（省略返回 false）。coding-workflow 在 try/catch 内调用且已传 ctx，运行时不会崩，但 changeset 标 `pi-coding-workflow: patch` 声明"no runtime change"——签名契约收紧。若未来有其他扩展省略 ctx 调用会静默失败。 | (a) 保留 ctx 可选签名维持向后兼容；或 (b) 省略 ctx 时 `throw new Error("__goalInit requires ctx")` 而非静默 `return false`。同时修正 changeset 措辞。 |
| SUGGESTION | `extensions/goal/src/projection/result.ts` | 23-28 | details-type | `GoalManagerDetails` 删除了旧版（tool-handler.ts:102-108）的 `_render?: { type; summary?; data }` 字段。新 renderResult(index.ts:186-234) 改读 `details.tasks` 直接渲染，逻辑等价且无外部消费者。但 details 形状变更属契约变更，应在 changeset 显式说明。 | changeset 补一句"details._render 字段移除，改用 details.tasks 直接渲染"。 |
| SUGGESTION | `extensions/goal/src/adapters/event-adapter.ts` | 418-462 | command-schema | `handleAgentEnd` 在 `isProcessing` 重入时**早退但未释放锁**——正常路径靠 `finally` 释放，但入口 `if (!session.state || session.isProcessing) return;`(423) 在 `isProcessing=true` 时直接 return，依赖隐式不变量。若未来 isProcessing 在非 agent_end 路径被置 true 而未释放，会导致 agent_end 永久哑火。 | 加注释明确"`isProcessing` 仅由本函数 finally 释放"，或把锁的 acquire/release 收敛到一个 helper。 |
| SUGGESTION | `extensions/goal/src/adapters/command-adapter.ts` | 50-65 | command-schema | `handleGoalCommand` 的 switch 覆盖 8 个 action，但无 `default` 分支。`parseGoalArgs` 保证只返回这 8 个值，但 TS 下若枚举扩展未更新会无声漏过。 | 加 `default: return;` 或 `return assertNever(parsed.action)`（穷尽检查）。 |
| INFO | `extensions/goal/package.json` | 24-28 | pi-manifest | `peerDependencies` 声明 `@earendil-works/pi-ai` / `@earendil-works/pi-tui`，但 src 实际 import 的是 `@mariozechner/pi-ai` / `@mariozechner/pi-tui`。**这是 pre-existing 问题（main 分支同样），非本 PR 引入**。 | 把 peerDependencies 改为 `@mariozechner/pi-ai` / `@mariozechner/pi-tui`。 |
| INFO | `extensions/goal/package.json` | 20-23 | resource-containment | `files` 为 `["src/", "index.ts"]`，根 `index.ts` 实际内容是 `export { default } from "./src/index.ts"`，`pi.extensions` 指向 `["./index.ts"]`。自包含 OK。无 skills 目录。 | 无需修改。 |
| INFO | `extensions/goal/src/adapters/event-adapter.ts` | 237-267 | command-schema | `before_agent_start` 返回 `{ message: { customType, content, display } }`，与 SDK `BeforeAgentStartEventResult.message`（types.d.ts:735-739）形状一致。index.ts:249-251 正确把 handler 返回值透传给 `pi.on`。契约正确。 | 无需修改。 |
| INFO | `extensions/goal/src/index.ts` | 103-147 | tool-schema | `goal_manager` tool schema 与 main 分支逐字段对比一致（10 个 action，全部 `Type.Optional`），StringEnum 来自 `@mariozechner/pi-ai`。`execute` 返回 `{ content, isError?, details? }` 符合 SDK `AgentToolResult`。schema 契约稳定。 | 无需修改。 |

## 维度逐项结论

1. **Tool/Command Schema（通过）** — `GoalManagerParams` 用 `Type.Object()` + `StringEnum()` 定义，与 main 逐字段一致；`execute` 返回 `{ content:[...], details:{...} }`，`details` 有明确 `GoalManagerDetails` 接口。
2. **Pi Manifest（基本通过，1 INFO）** — `pi.extensions: ["./index.ts"]` ✓、`type: "module"` ✓、`keywords: ["pi-package", ...]` ✓。peerDependencies 名称与实际 import 不符（pre-existing，INFO）。
3. **SDK 接口契约（通过）** — 所有 6 个 `pi.on(event, (event, ctx) => ...)` handler 签名符合 `ExtensionHandler<E,R>`；`ExtensionContext` 上正确访问各字段。
4. **向后兼容性（2 MUST_FIX）** — tool schema 兼容 ✓，details 接口有删字段（SUGGESTION），deserializeState 严格化破坏旧格式读取（MUST_FIX），__goalInit ctx 收紧（MUST_FIX）。
5. **资源自包含（通过）** — 未发现引用自身目录外绝对路径；`files` 字段包含 `src/` 与 `index.ts`。
