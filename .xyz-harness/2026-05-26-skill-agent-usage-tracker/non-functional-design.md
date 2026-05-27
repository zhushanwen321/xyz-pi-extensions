---
verdict: pass
---

# Non-Functional Design — Skill & Agent Usage Tracker

## 1. 稳定性

Extension 使用纯事件监听模式，不修改 Pi 的任何状态。所有操作都在 try-catch 中，写入失败只记录日志不抛异常。扩展崩溃（理论上不可能，因为无异步操作）不会影响 Pi 主流程——Pi 的事件分发机制会捕获 handler 异常。

## 2. 数据一致性

单进程内 Node.js 单线程 + `fs.writeFileSync` 保证 read-modify-write 的串行性，无竞争条件。跨 Pi 进程的极端并发窗口期约在微秒级（read + write 之间），实际发生概率极低。即使发生，最多丢失一次计数，不会导致数据损坏（JSON 始终完整写入）。

## 3. 性能

每次 skill/agent 计数触发一次 `readFileSync` + `writeFileSync`。数据文件极小（通常 < 2KB，即使 100 个 skill/agent 也不超过 5KB）。磁盘 I/O 延迟在微秒级（SSD）到毫秒级（HDD），对 Pi 的交互响应时间（秒级）无可感知影响。

## 4. 业务安全

不适用。扩展只记录使用计数（name → number），不记录 skill 内容、用户输入、对话历史或任何敏感信息。Skill 名称和 agent 名称本身不是敏感数据。

## 5. 数据安全

数据文件存储在 `~/.pi/agent/` 目录下，遵循 Pi 的标准数据目录权限。文件仅包含名称和计数，不包含路径、参数或任何可利用的信息。写入使用原子性 `writeFileSync`（大多数 OS 上是原子替换），不会出现半写状态。
