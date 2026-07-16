# Code Review — prompt-quality-batch-1-2

## 审查范围
- commits: `63bab4dd1` (W1) + `52779bf1b` (W2)
- 16 files changed, +267 / -42

## 发现的问题

| 维度 | 问题 | 严重度 | 位置 |
|------|------|--------|------|
| 业务逻辑 | helpers.ts TERMINAL_REASONS 含 "failed" — failed 是否都是"非正常完成"？done+failed 是状态机终态，但 failed 也可能是脚本 catch 后正常返回 error outcome（非 budget/timeout）。此时追加"NOT task completion"可能误导——脚本的 try-catch 返回 {status:"error"} 本身就是正常完成 | should_fix | helpers.ts TERMINAL_REASONS |
| 业务逻辑 | agent-opts-resolver.ts 的 `agentRegistry.list()` 在 workflow worker 上下文中调用——list() 是否可能返回空（registry 未初始化）？返回 "Available: (none)" 没有退路指引 | nit | agent-opts-resolver.ts:55 |
| 类型安全 | 无 any/as 问题。helpers.ts 的 Set<string> 类型推断正确 | ✅ | — |
| 边界条件 | W2 description 399/400 词，余量极小。后续任何修改都可能超限——测试已内置词数断言保护 | nit | subagent-tool.ts:196 |
| 测试覆盖 | U1-U4 + U5 覆盖了全部 changes。E1 验证全量回归。但 U2 用源码断言验证 notifyDone 逻辑——没运行时测试验证 reason=completed 时确实不追加收尾。可接受（mock notifyDone 的 sendMessage 链较重） | nit | prompt-quality-batch1.test.ts |
| 代码规范 | description 用英文（与现有一致），其他错误消息英文+少量中文混用（如 chain.js 的中文 throw）。本次未引入新的不一致 | ✅ | — |

## plan 覆盖核对

- [x] **W1 changes[0]** SKILL.md 4 处示例修正 — L115/L227/L289/L304 全部改完
- [x] **W1 changes[1]** helpers.ts notifyDone 终止性收尾 — TERMINAL_REASONS + NOT task completion 三步骤
- [x] **W1 changes[2]** tool-workflow.ts 3 处 not-found 对齐 — pause/resume/abort + retry-node + skip-node 均含 action:status
- [x] **W1 changes[3]** tool-workflow-script.ts lint not-found — 追加可用列表
- [x] **W1 changes[4]** subagent-actions.ts cancel not-found — 追加 includeFinished 指引
- [x] **W1 changes[5]** agent-opts-resolver.ts agent not found — 追加 agentRegistry.list()
- [x] **W1 changes[6]** 7 个 agent .md 删除 extensions/category — 全部清除
- [x] **W2 changes[0]** subagent tool description 重构 — When to delegate + Anti-patterns 4条 + You cannot + 注入防御 + 399词
- [x] **W2 changes[1]** subagent-tool-prompt.test.ts — 7 tests 全通过

## should_fix 决策

TERMINAL_REASONS 含 "failed" 的问题：审查后认为保留合理。done+failed 在状态机里表示"脚本执行完毕但结果失败"——即使是 try-catch 正常返回 error outcome，模型看到 "done: failed" 时也应该做收尾总结（而非假装成功）。"NOT task completion" 的语义是"不要把这个当成功汇报"，对 failed 场景同样适用。不改。

## 结论
- must_fix: 0
- should_fix: 1（审查后决定不改，理由如上）
- nit: 3
- 可进入 test
