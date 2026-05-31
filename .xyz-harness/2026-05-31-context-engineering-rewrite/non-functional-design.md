---
verdict: pass
---

# Context-Engineering v2 — 非功能性设计

## 1. 稳定性

`context` 事件在每次 LLM 调用前触发，是 Pi 主循环的关键路径。任何压缩逻辑的异常都不能阻塞 LLM 调用，否则整个 agent 循环会中断。因此 `compressContext` 整体用 try-catch 包裹，捕获所有异常后返回原始消息列表，确保主流程零中断。每层压缩（Microcompact / Budget / L0 / L1 / L2）也独立 try-catch，单层失败不影响其他层执行。

## 2. 数据一致性

Frozen/Fresh 状态存储在扩展闭包变量（`seenIds: Set`、`replacements: Map`）中，`session_start` 时重建为空。这避免了多 session 共享模块级变量导致的状态污染问题。Compact Boundary 感知依赖 Pi 内部的 `compactionSummary` 消息类型字段进行检测，这是 Pi 原生 compact 产出的标准格式——只要 Pi 不改变该消息类型命名，检测逻辑就稳定可靠。

## 3. 性能

所有压缩操作都是纯字符串处理（遍历、计数、截断、正则提取），不调用 LLM，不涉及网络 I/O。这保证了 `context` 事件的响应时间可预测：Microcompact 仅做时间比较和数组切片（< 5ms），Budget 做 per-message 字符计数和排序（< 10ms），L0/L1/L2 做规则匹配和替换（< 15ms）。三层合计不超过 45ms，对 LLM 调用延迟的影响可忽略。

## 4. 业务安全

扩展只读取消息列表的副本，不修改 Pi 的原始 session entries（约束 C-2）。所有压缩操作只在 `context` 事件的返回值中生效——返回的是修改后的消息数组，Pi 用这个数组调用 LLM，但原始 session 数据保持不变。这意味着压缩决策是"软应用"的：如果扩展被禁用或卸载，下一轮 `context` 事件会看到原始消息，不会留下残留副作用。

## 5. 数据安全

被压缩的原始内容（recall_store）仅存储在进程内存中（`Map<string, StoredContent>`），不写入磁盘，不发送到网络（约束 C-3）。Session 重载后 recall_store 丢失，已压缩的 toolResult 无法恢复——这是有意的取舍：可恢复性换取零 I/O 和零持久化复杂度。对于 Microcompact 清理的内容，连内存都不存储（不可恢复），因为清理的依据正是 prompt cache 已冷（> 60 分钟），保留原始内容无意义。
