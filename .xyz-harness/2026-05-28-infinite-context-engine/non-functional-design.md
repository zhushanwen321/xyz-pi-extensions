---
verdict: pass
---

# Non-Functional Design — Infinite Context Engine

## 1. 稳定性

Extension 的核心稳定性依赖三个机制：**异步子进程隔离**、**降级策略**、**并发守卫**。树压缩通过 `child_process.spawn` 在独立进程中执行——subagent 崩溃不影响主 Pi 进程。任何失败路径（校验失败、超时、spawn 异常）都有规则 fallback 兜底，确保 context handler 永远能返回有效的 messages。`isCompressing` 守卫防止压缩重入导致的树结构不一致。

**风险缓解：** 最坏情况下（subagent 完全不可用），规则 fallback 将所有历史段压缩为单行摘要，功能不丢失只是精度降低。用户通过 TUI 降级警告知晓。

## 2. 数据一致性

两条独立的数据通道——session entries（JSONL）和文件系统（`seg_N.json`）——通过段的 `filePath` 字段关联。entries 是权威数据源（段索引、树结构），文件系统是衍生数据（可从 entries 重建）。写入顺序保证先写文件再 appendEntry，确保 entries 引用的文件一定存在。

**并发控制：** 只有一个 writer（turn_end handler 顺序执行），无并发写入风险。异步压缩只追加新 entry（`ic-compact-tree`），不修改已有 entries。

## 3. 性能

Context handler 是热点路径——每次 LLM 调用都执行。设计为纯同步内存操作：遍历段列表（O(n)）、BFS 展平（O(nodes)）、token 估算（O(total_chars/4)）。预估 <50ms。不触发 I/O（recall 提示注入只是拼接字符串）。

树压缩是冷路径——只在 tree-context ≥70% 时触发。30 秒超时确保不会无限等待。subagent 输出量控制在几 KB（JSON 树结构 + 摘要）。

## 4. 业务安全

不适用。Extension 不处理用户输入的敏感数据，不暴露 API，不接受外部请求。所有数据都在用户本地的 session JSONL 和文件系统中。

## 5. 数据安全

段原始数据文件（`seg_N.json`）是 session JSONL 的副本提取，包含用户对话的完整内容。文件存储在 `.pi/infinite-context/<sessionId>/`，继承 Pi session 目录的权限（用户级别）。不执行额外的权限控制。MVP 阶段不实现文件 GC（Out of Scope），用户可通过删除 `.pi/infinite-context/` 目录手动清理。
