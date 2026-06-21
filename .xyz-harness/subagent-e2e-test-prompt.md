# Subagent 端到端测试任务

## 你的角色
你是测试执行者。通过**实际调用 subagent 工具**（不是写代码、不是跑单元测试）来验证 pi-subagents 扩展的端到端行为。每完成一个用例，记录「实际行为 vs 预期」，不符则标记 ❌ 并说明现象。

## 前置说明
- 项目：`xyz-pi-extensions`（feat-subagent-enhance worktree）
- 测试目标是 **subagent 工具的运行时行为**，不是项目代码本身
- **禁止修改项目源码**。所有临时文件写到 `/tmp/subagent-test/`
- 可用 agent：`worker` / `scout` / `researcher` / `planner` / `oracle` / `context-builder`
- 查看运行状态用 `/subagents` 命令；查看工具参数说明看 subagent 工具的 description

---

## 测试用例（按顺序执行）

### T1 基础同步调用（sync 模式）
**命令**：调用 subagent，`task="在 /tmp/subagent-test/hello.ts 写一个返回 hello world 的函数"`，`agent="worker"`，`wait=true`（默认）
**预期**：阻塞直到完成；返回结果含 content/details；TUI 显示完成的 agent block；`/subagents` 历史可见该记录
**验证点**：details.model 字段有值、details.turns ≥ 1

### T2 基础后台调用（background 模式）
**命令**：调用 subagent，`task="统计 /Users/zhushanwen/Code/xyz-pi-extensions-workspace/feat-subagent-enhance 下所有 .ts 文件数量，写入 /tmp/subagent-test/count.txt"`，`agent="worker"`，`wait=false`
**预期**：立即返回 backgroundId（非阻塞）；`/subagents` 可见该任务为 running
**验证点**：记下 backgroundId 供 T3 使用

### T3 后台轮询（query 模式）
**命令**：用 T2 的 backgroundId，调用 subagent 工具仅传 `backgroundId` 参数（不传 task）
**预期**：返回该任务当前状态（running / done / failed）；任务完成后能拿到最终结果
**验证点**：状态流转 running → done，最终结果 content 非空

### T4 指定 model 覆盖
**命令**：调用 subagent，`task="解释什么是 Promise"`，`agent="researcher"`，`model="anthropic/claude-sonnet-4-5"`，`wait=true`
**预期**：details.model 反映为指定的 anthropic/claude-sonnet-4-5（非默认 fallback 模型）
**验证点**：details.model 字段值与传入一致。若该模型未配置 auth，观察是否走 fallback 链并记录降级路径

### T5 指定 thinkingLevel
**命令**：调用 subagent，`task="分析如何优化 subagents runtime.ts 的 dispose 方法"`，`agent="planner"`，`thinkingLevel="high"`，`wait=true`
**预期**：agent 实际启用 reasoning（输出更深入）；不报错
**验证点**：不抛 "thinkingLevel not supported" 错误；输出质量明显高于 thinkingLevel=off 的对照

### T6 schema 结构化输出
**命令**：调用 subagent，`task="读取本项目的 package.json"`，`agent="worker"`，`schema={"type":"object","properties":{"name":{"type":"string"},"depCount":{"type":"number"}},"required":["name","depCount"]}`，`wait=true`
**预期**：返回的 parsedOutput 是结构化对象（{name, depCount}），而非纯文本 content
**验证点**：能直接取 .name 和 .depCount 字段，类型正确

### T7 appendSystemPrompt 注入
**命令**：调用 subagent，`task="什么是闭包"`，`agent="worker"`，`appendSystemPrompt=["必须用中文回答，回答不超过30字"]`，`wait=true`
**预期**：输出遵循注入指令（中文 + 简短）
**验证点**：content 是中文且 ≤30 字。若不符说明 appendSystemPrompt 未生效

### T8 并发后台（并发控制验证）
**命令**：**几乎同时**调用 3 个 background subagent：① worker 写文件 ② scout 扫描 src 目录结构 ③ researcher 搜概念，全部 `wait=false`
**预期**：3 个都返回不同 backgroundId；`/subagents` 同时显示 3 个 running；不互相阻塞；最终全部完成
**验证点**：3 个 backgroundId 互异；并发数符合 maxConcurrency 配置；无死锁

### T9 取消后台任务（状态机验证）
**命令**：启动一个耗时的 background worker 任务（如"详细分析整个 extensions 目录"），拿到 backgroundId 后立即调用取消（参考 /subagents 命令或工具能力取消）
**预期**：任务状态变为 **cancelled**（不是 failed）；history 记录 status=cancelled
**验证点**：状态不是 failed。cancelled vs failed 的区分是 FR-O1.2 的核心要求

### T10 maxTurns 限制
**命令**：调用 subagent，`task="重构整个项目的所有代码"`，`agent="worker"`，`maxTurns=2`，`wait=true`
**预期**：agent 在 2 turn 后停止，不无限循环；返回结果（可能 partial）
**验证点**：details.turns ≤ 2；不超时；有 graceful stop 而非 crash

### T11 多 session dispose/revive（跨 session 通知）
**命令**：
1. 启动一个 background worker 任务（耗时约 30s+）
2. 立即执行 `/new` 开新 session
3. 在新 session 中观察原 background 完成时是否有通知注入
**预期**：runtime 作为进程级单例，revive() 后新 session 能收到 background 完成通知
**验证点**：通知不因 session 切换而丢失。若丢失，标记 ❌（dispose/revive 缺陷）

### T12 错误处理：不存在的 agent
**命令**：调用 subagent，`task="任意任务"`，`agent="ghost-agent-not-exist"`，`wait=true`
**预期**：返回清晰错误 "Agent not found: ghost-agent-not-exist"，**不崩溃**主循环
**验证点**：错误信息可读；主 agent 能继续工作

### T13 错误处理：模型解析失败
**命令**：调用 subagent，`task="简单任务"`，`agent="worker"`，`model="fake-provider/nonexistent-model"`，`wait=true`
**预期**：走 fallback 链（agentConfig.modelCandidates → globalConfig.fallback → env）或报清晰错误列出可用模型
**验证点**：不静默失败；若降级，记录降级到哪个模型；若报错，错误信息含可用模型列表

---

## 验收标准
- **通过**：实际行为符合预期，验证点全部命中
- **部分通过**：主流程正常但有偏差（如 T4 model 降级但降级合理）
- **失败 ❌**：崩溃、静默失败、状态错误（如 cancelled 误报为 failed）、数据丢失

## 输出格式
每个用例完成后，按此格式记录：
```
### T{n} {标题}
- 状态：✅通过 / ⚠️部分 / ❌失败
- 实际行为：（观察到的现象，含关键 details 字段值）
- 偏差：（若部分/失败，说明与预期的差异）
```

最终汇总：通过数/部分数/失败数，列出所有 ❌ 用例的现象。
