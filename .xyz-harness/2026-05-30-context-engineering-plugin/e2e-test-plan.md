---
verdict: pass
---

# E2E Test Plan — Context Engineering Plugin

## Test Scenarios

### TS-1: Tool Result 过期清理端到端验证 (AC-1, AC-5)
1. 安装 context-engineering 插件，启动 Pi
2. 执行一次 `read` 读取文件，确认 tool_result 正常存在
3. 等待 31 分钟（或 mock 时间）
4. 执行任意操作触发 context 事件
5. 验证旧 tool_result 的 content 被替换为 `[Tool result expired. ID: ctx-xxx...]` 格式
6. 验证 LLM 可以调用 `recall_context(ctx-xxx)` 获取原始内容

### TS-2: Bash 输出截断端到端验证 (AC-2, AC-5)
1. 执行一个产生大量输出的 bash 命令（如 `cat large-file.txt`）
2. 触发 context 事件
3. 验证 bash 输出被截断为首 2000 + 标记 + 尾 2000 字符
4. 验证可通过 recall 获取完整输出

### TS-3: Thinking 清理端到端验证 (AC-3)
1. 触发一次带 thinking 的 assistant 消息
2. 等待 6 分钟无 user 消息
3. 触发 context 事件
4. 验证 thinking 内容被替换为 `[thinking expired]`

### TS-4: L1 规则化摘要端到端验证 (AC-7)
1. 读取一个大型 TypeScript 文件（>8000 字符，含 import/function/class/export）
2. 触发 context 事件
3. 验证 tool_result 被替换为 `[Condensed (ID: ctx-xxx): ...]` 格式
4. 验证摘要保留了 import 行、函数定义行、首尾行
5. 验证摘要长度在原始的 20-40%

### TS-5: 配对完整性端到端验证 (AC-4)
1. 在长 session 中执行多个工具调用
2. 触发压缩
3. 验证所有 assistant toolCall 仍有对应 toolResult
4. 验证无孤儿 toolResult 或 toolCall

### TS-6: 原生 Compact 不受干扰 (AC-6)
1. 启用 context-engineering 插件
2. 在长 session 中让上下文增长到触发原生 compact
3. 验证原生 compact 正常执行，不报错

### TS-7: 紧急压缩端到端验证 (AC-8)
1. 在 session 中大量调用工具，让上下文增长到 90%+
2. 触发 context 事件
3. 验证最近 3 轮以外的 toolResult 被强制过期

### TS-8: 统计命令端到端验证 (AC-9)
1. 执行若干操作产生压缩事件
2. 执行 `/context-stats` 命令
3. 验证输出包含各项统计数据

### TS-9: 配置启停端到端验证 (AC-10)
1. 执行 `/context-engineering` 查看配置
2. 执行 `/context-engineering l1 off` 禁用 L1
3. 触发 context 事件，验证 L1 不执行
4. 执行 `/context-engineering on` 恢复全局
5. 执行 `/context-engineering off` 禁用全局
6. 触发 context 事件，验证无任何压缩

## Test Environment

- Pi coding agent 最新版本
- Node.js >= 18
- vitest 运行单元测试
- 手动端到端测试：在本地 Pi session 中执行操作验证
