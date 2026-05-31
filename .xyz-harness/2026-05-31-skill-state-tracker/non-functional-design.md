---
verdict: pass
---

# Non-Functional Design — skill-state-tracker

## 1. 稳定性

扩展在 Pi 进程内运行，异常会直接影响 Pi 稳定性。所有事件处理器使用 try-catch 包裹，捕获异常后 console.error 记录但不 throw。状态机转换验证（canTransition）在 tool execute 入口处执行，防止非法状态污染持久化数据。`sendMessage` 失败不阻塞主流程。

## 2. 数据一致性

通过 `appendEntry` 单写者模式保证一致性——每次状态变更时写入完整快照，不做增量更新。GC 策略保留最新 entry、删除旧 entry，避免 entries 无限积累（与 goal 扩展一致）。`deserializeState` 向后兼容：字段缺失时给默认值（errorCount 默认 0，lastRemindAtTurn 默认 -1），旧格式数据不会导致崩溃。

## 3. 性能

`tool_call` 事件处理器只做字符串匹配（path.endsWith("SKILL.md")）+ 数组遍历（O(n)，n = 活跃 TrackedItem 数量，通常 < 10）。`turn_end` 同样是 O(n) 遍历。无文件 I/O（状态通过 sessionManager 内存管理）、无网络请求。性能影响可忽略。

## 4. 业务安全

不适用。本扩展不处理用户输入、不修改文件、不暴露 API。唯一的外部交互是通过 `sendMessage` 注入 steering 消息到 AI 上下文——这些消息是只读的提示词，不包含用户数据。

## 5. 数据安全

TrackedItem 只存储 skill 名称和 SKILL.md 路径，不包含用户敏感信息。持久化数据通过 Pi 的 `sessionManager.getEntries()` 管理，遵循 Pi 平台的数据生命周期（session 结束时 entries 可能被清理）。不创建额外的文件系统存储。
