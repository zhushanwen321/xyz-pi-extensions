---
verdict: pass
---

# Non-Functional Design — fix-dual-compact-trigger

## 1. 稳定性

改动是**简化为主**：移除 `needsCompressionRef` 双轨机制，统一到 Pi 原生 compact 流程。Pi 的 `_runAutoCompaction` 已经过充分测试（entry 写入、timestamp 保护、overflow recovery），复用此路径比自建触发机制更稳定。风险点在于 `session_before_compact` handler 的执行时间（spawn 子进程 ~30s），但 Pi 已对此有超时处理（`AbortController`），handler 内部的 `triggerCompressionAsync` 也有 60s 超时，双重保障。

## 2. 数据一致性

compaction entry 由 Pi 写入（`sessionManager.appendCompaction`），与 Pi 原生 compact 路径完全一致。`CompactTree` 仍由扩展通过 `pi.appendEntry` 写入 custom entry（不变）。两种 entry 在 session 文件中独立存储，无交叉依赖。`firstKeptEntryId` 直接从 `event.preparation` 获取，由 Pi 计算而非扩展自行推导，避免不一致。

## 3. 性能

无性能影响。压缩执行逻辑（spawn pi 子进程）完全不变，只是触发时机从 `turn_end`（fire-and-forget）改为 `session_before_compact`（await）。TUI 渲染不受影响：`spawn` 不阻塞事件循环，`beforeCompressionUI`/`afterCompressionUI` 中的 `sendMessage` 和 `setStatus` 正常工作。

## 4. 业务安全

不适用。本改动不涉及用户数据、权限、或业务逻辑。

## 5. 数据安全

不适用。无新的数据存储、无敏感信息处理。`summary` 文本由 tree 节点摘要拼接而成，不包含新的用户数据。
