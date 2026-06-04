---
verdict: pass
---

# Workflow Result Delivery — 出口端结果回传优化

## Background

### 问题

当前 workflow 完成后，调用者（AI 或用户）无法有效获取 agent 级别的执行结果。具体表现：

1. **`workflow-run` 工具立即返回 "Started workflow 'xxx'"**，后台执行结果通过 `sendMessage` 异步送达，但不触发 AI 回复（`triggerTurn` 未使用）。AI 下次交互时上下文中虽有消息，但内容贫乏。

2. **completion notification 只包含 trace 摘要**，每个 agent 的输出截断到 120 字符，且只有 status + label，没有实际内容。

3. **脚本的 `return` 值在 Worker → Main 传递过程中丢失**：`handleWorkerMessage` 的 `"return"` 分支只更新 instance 状态，忽略了 `msg.result`。

### 目标

对齐 Claude Code 的行为：workflow 结果进入 AI 上下文，AI 在下一次交互时能看到完整的执行结果并自然汇报。不主动触发回复，用户可通过 `/workflows` 面板或 `workflow { action: status }` 查看。

## Functional Requirements

### FR-1: 保留 script return 值到 WorkflowInstance

`orchestrator.ts` 的 `handleWorkerMessage` 处理 `"return"` 类型消息时，将 `msg.result` 存入 `instance.scriptResult`。

**行为变更**：
- `WorkflowInstance` 接口新增可选字段 `scriptResult: unknown`
- `serializeInstance` / `deserializeInstance` 处理该字段（向后兼容：缺失时为 `undefined`）
- `instance.scriptResult` 仅在 `"return"` 消息到达时设置；`"error"` 消息不设置

**不变**：
- `"return"` 分支的状态流转逻辑不变（transitionStatus → completed）
- 持久化时机不变（`persistState()` 仍在同一个位置调用）

### FR-2: Completion notification 携带 scriptResult

`sendCompletionNotification` 的消息 `content` 字段包含：

1. **scriptResult 摘要**（如有）：将 `instance.scriptResult` 序列化为人类可读文本（JSON.stringify，缩进 2 空格，截断到 2000 字符）
2. **trace 摘要**（保留现有行为，每个 agent 的 label + status）

**`content` 格式**：

```
Workflow '{name}' completed: {status}

--- Script Result ---
{JSON.stringify(scriptResult, null, 2).slice(0, 2000)}

--- Agent Trace ---
[1] description: status
[2] description: status
...
```

**`scriptResult` 不存在时**（脚本无 return 值或失败终止）：
- 不输出 "--- Script Result ---" 段
- trace 摘要保持现有格式不变

**`sendMessage` 调用参数不变**：不带 `triggerTurn`，不带 `deliverAs`。与当前行为一致，结果进入 AI 上下文但不主动触发回复。

### FR-3: Trace detail 截断放宽

`sendCompletionNotification` 中 trace node 的 `detail` 字段截断长度从 120 字符改为 500 字符。

**改动位置**：`commands.ts` 第 71 行附近：

```typescript
// Before:
detail: node.result?.content?.slice(0, 120),
// After:
detail: node.result?.content?.slice(0, 500),
```

## Acceptance Criteria

### AC-1: scriptResult 持久化与恢复

1. 运行一个带 `return { key: "value" }` 的 workflow
2. workflow completed 后，`workflow { action: status }` 返回的 instance 中 `scriptResult` 为 `{ key: "value" }`
3. session 重启后（session_start rehydrate），`scriptResult` 仍然存在

### AC-2: Completion notification 包含 scriptResult

1. workflow 脚本 `return { tsc: "passed", lint: "passed" }`
2. completion notification 的 `content` 包含 `--- Script Result ---` 段，内容为 `{"tsc":"passed","lint":"passed"}`
3. `content` 也包含 `--- Agent Trace ---` 段（与现有行为一致）

### AC-3: scriptResult 缺失时降级

1. workflow 脚本无 return 值（或 return undefined）
2. completion notification 的 `content` 不包含 `--- Script Result ---` 段
3. trace 摘要正常输出

### AC-4: Trace detail 截断放宽

1. agent 返回长度为 300 字符的内容
2. completion notification 中该 trace node 的 `detail` 包含完整 300 字符（不被截断到 120）

## Constraints

1. **不改 `sendMessage` 的调用方式**：不加 `triggerTurn`，不加 `deliverAs`。对齐 CC 的"结果进入上下文但不主动触发回复"行为
2. **不改 `_render` 描述符**：当前 Pi CLI 没有消费者，不动
3. **向后兼容**：`deserializeInstance` 处理旧数据（无 `scriptResult` 字段）时正常降级为 `undefined`
4. **不改状态机**：7 态和转移规则不变
5. **`scriptResult` 截断上限 2000 字符**：防止巨大 return 值撑爆 JSONL entry

## 业务用例

### UC-1: AI 调用 workflow-run 执行预提交检查

- **Actor**: AI agent（通过 workflow-run 工具）
- **场景**: AI 启动 workflow 执行 tsc + lint + test，然后继续其他工作
- **预期结果**: workflow 完成后，AI 下一次与用户交互时，上下文中已有完整检查结果（scriptResult），AI 能自然汇报"tsc 通过、lint 通过、test 3 个全部通过"

### UC-2: 用户通过 /workflows 面板查看结果

- **Actor**: 用户
- **场景**: 用户在 `/workflows` 面板选择已完成的 workflow instance
- **预期结果**: trace 详情中每个 agent 的输出能显示到 500 字符（而非 120）

## Complexity Assessment

| 维度 | 评估 |
|------|------|
| 涉及文件 | `state.ts`, `orchestrator.ts`, `commands.ts`（3 个文件） |
| 代码改动量 | ~50 行（新增字段 + 序列化 + notification 格式调整） |
| 风险 | 低。纯增量改动，不改现有控制流 |
| 依赖 | 无新增依赖 |
