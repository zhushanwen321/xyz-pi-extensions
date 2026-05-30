---
verdict: pass
---

# Non-Functional Design — Context Engineering Plugin

## 1. 稳定性

插件通过 C-5 配对校验 + 安全降级机制保障稳定性：每次压缩后校验 toolCall/toolResult 配对完整性，校验失败时放弃本次压缩返回原始消息。这意味着即使压缩逻辑有 bug，最坏结果是不压缩（等价于插件未安装），不会破坏 Pi 的正常消息流。`context` 事件中任何异常均被 try-catch 包裹，错误只记录日志不传播。

## 2. 数据一致性

不适用。插件不写入任何持久化存储（C-2 不修改 session entries，C-3 原始内容不持久化）。所有状态都在内存闭包变量中，随 session 存活。config 通过 `settings.jsonl` 读取，但读取是幂等的且使用硬编码默认值兜底。

## 3. 性能

`context` 事件在每次 LLM 调用前同步触发。L0/L2 是 O(n) 线性扫描 + 字符串替换，L1 是正则匹配 + 字符串拼接，所有操作不涉及 I/O 和网络。Pi 的 `emitContext` 已对 messages 做了 `structuredClone`，插件操作的是副本。性能瓶颈可能在 messages 数组很大时的遍历，但典型 session < 100 条消息，遍历 < 1ms。recall store 的 Map 查询是 O(1)。

## 4. 业务安全

压缩替换后的文本内容会发送给 LLM，需要确保不引入注入风险。替换格式以 `[` 开头、`]` 结尾，明确标记为系统消息，LLM 不会将其误认为用户指令。压缩 ID 使用 UUID，不可预测。recall 工具只返回存储的原始内容，不执行任何代码。配置通过 `/context-engineering` 命令修改，命令仅限当前 session 生效，不影响全局。

## 5. 数据安全

插件处理的 tool_result 和 bash 输出可能包含敏感信息（API key、密码、文件内容）。这些信息在 Pi 原始消息流中已经存在，插件不增加新的泄露面。原始内容存储在进程内存中（与 Pi 自身的消息存储相同生命周期），不写入磁盘。recall 工具的返回内容仅对当前 session 的 LLM 可见。
