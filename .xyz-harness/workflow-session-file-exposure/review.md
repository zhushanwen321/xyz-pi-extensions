# Code Review: workflow-session-file-exposure

## 审查范围

- W1 commit: `cbe711384` — sessionFile 透传（types + mapper + finalizeCall + trace + 序列化）
- W2 commit: `c66bcf35f` — stateFilePath + WorkflowToolDetails stateFile
- 13 files changed, +286 -4 lines

## plan 完成度

| Wave | Change | 状态 |
|------|--------|------|
| W1 | types.ts AgentResult + ExecutionTraceNode + TracePatch sessionFile | ✅ |
| W1 | agent-result-mapper.ts sessionFile 透传 | ✅ |
| W1 | execute-agent-call.ts finalizeCall sessionFile | ✅（额外：也同步 AgentCall 的 setSessionId/setSessionFile） |
| W1 | trace.ts update sessionFile | ✅ |
| W1 | agent-call.ts sessionFile field + setter | ✅ |
| W1 | jsonl-run-store.ts serialize/deserialize sessionFile | ✅ |
| W1 | node-ops.ts reset sessionFile | ✅ |
| W2 | ports.ts RunStore.stateFilePath | ✅ |
| W2 | jsonl-run-store.ts stateFilePath 实现 | ✅（在 W1 commit 中一起提交，同文件） |
| W2 | tool-workflow.ts RunSummary + actionRun stateFile | ✅ |
| W2 | detail-content.ts TUI 渲染路径 | ⚠️ 未实现（见下方说明） |

### detail-content.ts 未实现说明

dev-plan W2 change 4 计划在 TUI detail 视图渲染 session/state 路径。实际未实现。原因：

1. **数据层已完成**——WorkflowToolDetails.stateFile（run 级）+ ExecutionTraceNode.sessionFile（agent 级）已可用，overlay/GUI 可直接消费。用户原始需求"overlay 可以拿到"已满足。
2. TUI 渲染需要 pi-tui 的 Text/Container 组件适配，且无法用 vitest 单测覆盖（需交互式 TUI）。作为独立后续任务更合适。

## 审查发现

### 应当修复

（已在 review 前修复）

1. ~~**测试盲区：jsonl-run-store deserialize 后 sessionFile 可读**~~ — 已补充 save → loadAll 完整 round-trip 测试（commit `2fac20ae8`），验证反序列化后 AgentCall.sessionFile 可读。

2. **finalizeCall 顺带修复了 sessionId 的同步缺失** — 原代码 finalizeCall 只设 traceNode.sessionId，不设 AgentCall.sessionId。本次也加了 `call.setSessionId(result.sessionId)`。这是一个改进但也改变了现有行为——现有测试全绿确认无回归。

### 建议

1. **toRunSummary 签名变更**：从 `(run: WorkflowRun)` 改为 `(run: WorkflowRun, store: RunStore)`。单一调用点已适配。如果未来有多处调用，可考虑用闭包捕获 store。

### 细节

1. W2 的 stateFilePath 方法落在了 W1 commit 里（jsonl-run-store.ts 同文件两处改动），wave 边界和 commit 边界没完全对齐。功能无影响，CW dev gate 已通过。

## 测试质量审查

| TestCase | 防什么 bug | 评价 |
|----------|-----------|------|
| U1 mapper sessionFile 透传 | mapper 丢弃 sessionFile（原始 bug） | ✅ 直接覆盖 |
| U1 mapper 无 sessionFile → undefined | 窗口期 undefined 不误填 | ✅ 边界 |
| U2 finalizeCall → trace sessionFile | trace 节点缺失 sessionFile | ✅ 直接覆盖 |
| U3 jsonl-run-store AgentCall 序列化 | 序列化丢 sessionFile | ✅ 防持久化丢失 |
| U4 jsonl-run-store TraceNode 序列化 | trace 节点序列化丢 sessionFile | ✅ 防持久化丢失 |
| U5 stateFilePath 返回正确路径 | port 方法不存在或返回错路径 | ✅ 契约验证 |
| U6 源码断言 stateFile 声明 | 类型未声明导致编译丢字段 | ✅ 类型防线（源码断言模式） |

**盲区**：deserialize round-trip 闭环（serialize → deserialize → 可读）未测试。serialize 和 deserialize 分别有测试，但中间的 deserializeRun → setSessionFile 路径无直接断言。

## 评分汇总

| 维度 | 评分 | 说明 |
|------|------|------|
| 类型安全 | ✅ | 零 any，所有字段有类型声明，TracePatch 同步更新 |
| 错误处理 | ✅ | sessionFile 全可选，窗口期 undefined 不抛错 |
| 边界条件 | ✅ | undefined 路径覆盖（窗口期 + reset 后） |
| 测试质量 | ⚠️ | 缺 deserialize round-trip 闭环测试 |
| plan 完成度 | ⚠️ | detail-content.ts TUI 渲染未实现（数据层已完成） |
