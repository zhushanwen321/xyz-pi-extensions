---
verdict: pass
---

# Use Cases — Context Engineering Plugin

## UC-1: 长时间编码会话的上下文保持

- **Actor**: 开发者使用 Pi 进行多天编码
- **Preconditions**: Pi 运行中，context-engineering 插件已安装并启用
- **Main Flow**:
  1. 开发者开始编码 session，正常使用 read/bash/edit 等工具
  2. 插件在每次 `context` 事件中扫描消息列表
  3. 超过 30 分钟的 tool_result 被替换为过期标记（含压缩 ID）
  4. 超过 4000 字符的 bash 输出被截断
  5. 超过 5 分钟空闲的 thinking 块被清空
  6. LLM 通过压缩 ID 提示可 recall 原始内容
  7. 开发者 2 小时后仍在正常编码，上下文窗口未溢出
- **Alternative Paths**:
  - A1: 开发者需要查看旧 tool_result → LLM 调用 `recall_context(ctx-xxx)` → 返回原始内容
  - A2: Session reload → recall store 清空 → `recall_context` 返回 not found 错误文本
- **Postconditions**: 上下文窗口使用率保持在合理范围，原生 compact 触发更晚或不需要触发
- **Module Boundaries**: 压缩逻辑在 `compressor.ts`，recall 存储在 `recall-store.ts`，配置在 `config.ts`
- **AC Coverage**: AC-1, AC-2, AC-3, AC-5, AC-6

## UC-2: 大文件读取后的上下文释放

- **Actor**: 开发者用 Pi 分析一个大文件
- **Preconditions**: Pi 运行中，context-engineering 插件已启用，L0 和 L1 均开启
- **Main Flow**:
  1. Agent 调用 `read` 读取一个 500 行的 TypeScript 文件（~12000 字符）
  2. 插件检测到 tool_result 超过 L1 阈值（8000 字符）
  3. 插件提取 import 行、函数/类定义行、首 10 行、尾 5 行
  4. 生成规则化摘要：`[Condensed (ID: ctx-abc123): ...]`
  5. 原始 12000 字符保存到 recall store
  6. 30 分钟后，如果该 tool_result 仍超过过期时间，L0 将其标记为过期
- **Alternative Paths**:
  - A1: 文件内容是非代码（JSON/YAML/Markdown）→ 正则匹配函数定义无结果 → 只保留首 10 行 + 尾 5 行 → 长度仍超 40% → fallback 到 L0 截断
  - A2: L1 未启用 → 直接走 L0 过期逻辑
- **Postconditions**: 大文件 tool_result 在 L1 阶段被压缩到 20-40%，30 分钟后被 L0 完全过期
- **Module Boundaries**: L1 摘要逻辑在 `compressor.ts` 的 `condenseToolResult()` 方法
- **AC Coverage**: AC-1, AC-5, AC-7

## UC-3: 紧急上下文溢出防护

- **Actor**: 开发者在复杂任务中触发大量工具调用
- **Preconditions**: Pi 运行中，L2 紧急压缩已启用（emergencyThreshold: 0.90）
- **Main Flow**:
  1. Agent 连续调用 read/bash/grep，上下文快速膨胀
  2. `context` 事件触发时，`ctx.getContextUsage()` 返回 percent = 0.91
  3. L2 紧急压缩激活：扫描所有 tool_result 消息
  4. 最近 3 轮以外的 tool_result 全部标记为过期（无视 30 分钟过期时间）
  5. 配对校验通过，返回压缩后的消息列表
  6. 上下文使用率降到安全水位
- **Alternative Paths**:
  - A1: `getContextUsage()` 返回 null → fallback 到 chars/4 估算 → 仍超过 90% → 触发 L2
  - A2: L2 触发后配对校验失败 → 安全降级，返回原始消息 → 原生 compact 接管
- **Postconditions**: 上下文使用率降低，LLM 请求正常发送，不溢出
- **Module Boundaries**: L2 逻辑在 `compressor.ts` 的 `emergencyCompress()` 方法
- **AC Coverage**: AC-4, AC-8

## UC-4: 插件配置与监控

- **Actor**: 开发者想了解或调整压缩策略
- **Preconditions**: context-engineering 插件已安装
- **Main Flow**:
  1. 开发者执行 `/context-engineering` 查看当前配置和统计
  2. 命令输出包含 L0/L1/L2 各级配置、启用状态、累计统计
  3. 开发者执行 `/context-engineering l1 off` 禁用 L1
  4. 后续 context 事件只执行 L0 和 L2
  5. 开发者执行 `/context-stats` 查看累计统计
- **Alternative Paths**:
  - A1: 开发者执行 `/context-engineering off` → 全局禁用 → 所有 context 事件跳过压缩
  - A2: 开发者传入无效参数 → 命令输出使用帮助
- **Postconditions**: 配置修改立即生效（下次 context 事件使用新配置）
- **Module Boundaries**: 命令解析在 `commands.ts`，配置存储在 `config.ts`
- **AC Coverage**: AC-9, AC-10

## 覆盖映射表

| UC | 覆盖 AC |
|----|---------|
| UC-1 | AC-1, AC-2, AC-3, AC-5, AC-6 |
| UC-2 | AC-1, AC-5, AC-7 |
| UC-3 | AC-4, AC-8 |
| UC-4 | AC-9, AC-10 |

| AC | 覆盖 UC |
|----|---------|
| AC-1 | UC-1, UC-2 |
| AC-2 | UC-1 |
| AC-3 | UC-1 |
| AC-4 | UC-3 |
| AC-5 | UC-1, UC-2 |
| AC-6 | UC-1 |
| AC-7 | UC-2 |
| AC-8 | UC-3 |
| AC-9 | UC-4 |
| AC-10 | UC-4 |
