---
verdict: pass
---

# Use Cases — fix-dual-compact-trigger

无业务用例（纯技术性 bug 修复）。

## UC-1: 正常压缩流程（tree-compact 通过 session_before_compact 执行）

- **Actor**: Pi 自动 compact 系统
- **Preconditions**: 对话上下文超过阈值，segments ≥ 3
- **Main Flow**:
  1. Pi `_checkCompaction` 检测到 usage 超过阈值
  2. Pi 调用 `_runAutoCompaction` → emit `session_before_compact`
  3. 扩展 handler 调用 `compressForCompaction()`（async spawn）
  4. 压缩成功，handler 返回 `{ compaction: { summary, firstKeptEntryId, tokensBefore } }`
  5. Pi 写入 compaction entry（`fromExtension=true`）
  6. Pi 更新 `agent.state.messages`
  7. 下次 `_checkCompaction` 时 timestamp 保护生效，不重复触发
- **Alternative Path 4a**: 压缩失败（fallback + errorReason）→ handler 返回 `{ cancel: false }` → Pi 执行原生 compact
- **Alternative Path 4b**: spawn 超时 → `triggerCompressionAsync` 返回 fallback → handler 返回 `{ cancel: false }` → Pi 执行原生 compact
- **Postconditions**: compaction entry 已写入，tree 已更新，timestamp 防重入保护生效
- **Module Boundaries**: infinite-context extension handler → compression-runner → tree-compactor → Pi agent-session

## UC-2: Segments 不足时的原生 fallback

- **Actor**: Pi 自动 compact 系统
- **Preconditions**: 对话上下文超过阈值，segments < 3
- **Main Flow**:
  1. Pi emit `session_before_compact`
  2. 扩展 handler 检测 segments.length < 3
  3. 返回 `{ cancel: false }`
  4. Pi 执行原生 LLM compact
  5. Pi 写入 compaction entry（`fromExtension=false`）
- **Postconditions**: compaction entry 已写入，上下文被原生方式压缩

## AC 覆盖映射

| UC | 覆盖的 AC |
|----|----------|
| UC-1 | AC-1, AC-2, AC-3, AC-5, AC-6 |
| UC-2 | AC-6 |
