---
verdict: pass
---

# 非功能性设计 — workflow-cc-compat-v2

## 1. 稳定性

改动集中在 5 个文件的局部函数修改，不引入新的子系统。**主要风险**是 `spawnAndParse` 的重试逻辑增加了进程生命周期复杂度——单次 agent 调用可能 spawn 两个子进程。缓解措施：重试仅在特定条件下触发（`!parsedOutput && !hasToolCall`），不影响正常路径。临时文件写入使用同步 `writeFileSync`，在 agent 调用前完成，不与子进程并行。

## 2. 数据一致性

临时文件按 `<sessionDir>/workflow-tmp/so-<callId>.txt` 命名，callId 包含 8 位 UUID，冲突概率极低。workflow 完成或中止时主动清理临时文件。`ExecutionTraceNode.phase` 是新增可选字段，旧数据 `phase: undefined` 自动兼容。`WorkflowMeta.phases` 联合类型扩展向后兼容——现有 `string[]` 脚本的 phases 仍然被 `typeof p === "string"` 接受。

## 3. 性能

临时文件写入是同步 I/O 但数据量小（< 2KB schema JSON），延迟可忽略。重试场景增加一个完整的子进程 spawn 周期（模型推理时间为主，进程开销 ~200ms）。`budget-update` 消息通过 `postMessage` 传递，频率为每 agent 完成一次，不构成瓶颈。pipeline 笛卡尔积的并行度受 AgentPool 的 maxConcurrency 限制，不会无限扩张。

## 4. 业务安全

不适用。本次改动不涉及用户数据、权限控制或业务逻辑。workflow 脚本由开发者编写，schema 由脚本定义，不引入新的信任边界。

## 5. 数据安全

临时文件包含 schema JSON（开发者定义的结构定义），不含用户敏感数据。文件存放在 `~/.pi/agent/sessions/<project>/workflow-tmp/` 目录下，权限继承 session 目录。workflow 完成后清理。不涉及网络传输或外部存储。
