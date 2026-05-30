---
verdict: pass
---

# E2E Test Plan — fix-dual-compact-trigger

## Test Scenarios

### TS-1: 压缩后无重复 compact 触发（AC-1）

1. 启动 Pi，加载 infinite-context 扩展
2. 持续对话直到上下文超过压缩阈值（180K+/200K）
3. 等待 tree-compact 完成（观察 ic-compact-end 气泡）
4. 发送新消息
5. **验证**: `_checkCompaction` 不再触发 `_runAutoCompaction`（无 compaction_start 事件）
6. 继续对话直到再次超过阈值
7. 发送新消息
8. **验证**: 同上，无重复触发

### TS-2: 对话流同步（AC-2）

1. 对话超过阈值
2. 观察压缩开始（ic-compact-start 气泡）
3. **验证**: 压缩完成前不会发送 LLM 请求（无 assistant response）
4. 压缩完成后（ic-compact-end 气泡），agent 继续正常对话

### TS-3: TUI 正常渲染压缩状态（AC-3）

1. 对话超过阈值
2. **验证**: 看到 ic-compact-start 气泡（⏳ IC Tree Compact）
3. **验证**: footer 显示 "IC compressing N segments..."
4. 压缩完成后
5. **验证**: 看到 ic-compact-end 气泡（✅ IC Tree Compact）

### TS-4: context 事件不判断压缩（AC-4）

1. 代码审查: `createContextHandler` 中不调用 `shouldCompress`
2. 代码审查: 不设置 `needsCompressionRef`

### TS-5: turn_end 不触发压缩（AC-5）

1. 代码审查: `createTurnEndHandler` 中不调用 `compressAsync`
2. 代码审查: `needsCompressionRef` 变量不存在

### TS-6: segments 不足时 Pi 原生 fallback（AC-6）

1. 新建 session（segments < 3）
2. 快速填满上下文（通过长消息或手动设置低阈值）
3. **验证**: Pi 执行原生 LLM compact（非 tree-compact）
4. **验证**: compaction entry 写入，上下文被压缩

## Test Environment

- Pi agent（本地安装，支持 `session_before_compact` 事件 + `CompactionResult` 返回值）
- infinite-context 扩展（修改后的版本）
- 测试用 LLM（任何可用模型，用于 tree-compact spawn 和原生 compact）
