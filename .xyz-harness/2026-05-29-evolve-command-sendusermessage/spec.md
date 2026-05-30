---
verdict: pass
---

# Evolve Command sendUserMessage 统一

## Background

evolution-engine 有 5 个 command（`/evolve`, `/evolve-apply`, `/evolve-stats`, `/evolve-rollback`, `/evolve-report`）和对应的 5 个 tool。当前 `/evolve-report` 已通过 `sendUserMessage` 委托 AI 调用 tool，但其他 4 个 command 仍然使用手工参数解析（`split(/\s+/)` + 正则匹配），导致：

1. **参数解析 bug**：`/evolve since=1d` 的 `since=1d` 不匹配 `/^\d+d$/`，fallback 到默认 `7d`
2. **脆弱的参数格式**：用户输入 `since=1d`、`--since 1d`、`since:1d` 等变体都无法识别
3. **维护成本**：每个 command 需要独立维护一套解析逻辑，且和 tool schema 不同步

解决方案：所有 command 统一走 `sendUserMessage` 委托给 AI，AI 理解自然语言后调用对应的 tool。Command handler 变成纯代理，不做任何参数解析。

## Functional Requirements

### FR-1: 所有 evolve command 统一 sendUserMessage 委托

5 个 command（`/evolve`, `/evolve-apply`, `/evolve-stats`, `/evolve-rollback`, `/evolve-report`）的 handler 统一改为 `sendUserMessage` 模式：不做参数解析，直接将用户原始输入转发给 AI，由 AI 理解意图后调用对应的 tool。

### FR-2: 删除 index.ts 中的手工参数解析代码

移除 index.ts 中所有 command handler 的 `split(/\s+/)`、正则匹配、`parseInt` 等手工解析逻辑。Command handler 只负责：
1. 可选的 loading 提示（`ctx.ui.notify`）
2. 调用 `pi.sendUserMessage` 转发用户输入
3. 返回结果

### FR-3: 清理 index.ts 中不再需要的 import

统一 sendUserMessage 后，index.ts 中 `/evolve`、`/evolve-apply`、`/evolve-stats` 的 command handler 不再直接调用 commands.ts/state.ts 的函数。需要清理：
- 从 commands.ts 导入但仅被 command handler（非 tool）使用的 import
- 注意：`/evolve-rollback` 无参数时仍需 `loadHistory` + `renderRollbackList`，这两个 import 保留

## Acceptance Criteria

### AC-1: `/evolve since=1d` 正确识别 since 参数
- 输入 `/evolve since=1d`
- AI 调用 `evolve` tool，参数 `{ target: "all", since: "1d" }`
- 输出包含 "from last 1d of data"

### AC-2: `/evolve-apply list` 正确识别 action
- 输入 `/evolve-apply list`
- AI 调用 `evolve-apply` tool，参数 `{ action: "list" }`

### AC-3: `/evolve-stats` 无参数命令正常工作
- 输入 `/evolve-stats`
- AI 调用 `evolve-stats` tool

### AC-4: `/evolve-rollback 3` 正确识别 index
- 输入 `/evolve-rollback 3`
- AI 调用 `evolve-rollback` tool，参数 `{ index: 3 }`

### AC-5: `/evolve-report 2026-05-28` 保持现有行为
- 已走 sendUserMessage，不应被破坏

### AC-6: Tool execute 函数签名和行为不变
- 5 个 tool 的 `execute` 函数、参数 schema、返回格式均不改变
- commands.ts 中 handleEvolve/handleEvolveApply/handleEvolveStats/handleEvolveRollback/handleEvolveReport 函数签名不变（被 tool 调用）

### AC-7: 自然语言变体都能正确处理
- `/evolve 分析最近 3 天的数据` → AI 调用 `{ since: "3d" }`
- `/evolve-apply 跳过第 2 个建议` → AI 调用 `{ action: "skip", index: 2 }`

### AC-8: `/evolve-rollback` 无参数保留现有行为
- 输入 `/evolve-rollback`（无参数）
- 保留现有逻辑：调用 `loadHistory` + `renderRollbackList` 显示历史列表
- 不走 sendUserMessage（tool schema 的 index 是必填参数，AI 无法调用）

### AC-9: 无参数 command 的默认行为
- `/evolve` 无参数 → AI 调用 `{ target: "all", since: "7d" }`（tool schema 默认值）
- `/evolve-apply` 无参数 → AI 调用 `{ action: "list" }`（合理的默认行为）
- `/evolve-stats` 无参数 → AI 调用 `{}`（tool 无参数）

### AC-10: TypeScript 编译通过，ESLint 0 errors

## Constraints

- **不改 Tool 层**：tool 的 schema、execute 函数、renderResult 均不改动
- **不改 commands.ts 业务逻辑**：handleEvolve 等 5 个 handler 的核心逻辑不变，只改 index.ts 中的 command 注册部分
- **不改其他扩展**：只修改 evolution-engine/src/index.ts 中的 command handler 注册代码
- `/evolve-report` 已走 sendUserMessage 模式，保持不变作为参考模板
- **`/evolve-rollback` 无参数路径**：保留现有的 `loadHistory` + `renderRollbackList` 逻辑，不走 sendUserMessage

## 业务用例

### UC-1: 用户使用自然语言触发分析
- **Actor**: Pi 用户
- **场景**: 用户输入 `/evolve 分析最近一周的 skill 使用情况`
- **预期结果**: AI 理解意图，调用 `evolve` tool，参数 `{ target: "skills", since: "7d" }`

### UC-2: 用户使用等号格式传参
- **Actor**: Pi 用户
- **场景**: 用户输入 `/evolve since=1d`
- **预期结果**: AI 理解意图，调用 `evolve` tool，参数 `{ target: "all", since: "1d" }`

## Complexity Assessment

- **Scope**: 1 个文件（index.ts）的 command handler 重写
- **Risk**: 低。sendUserMessage 模式已在 `/evolve-report` 上验证可行
- **Complexity**: L1
