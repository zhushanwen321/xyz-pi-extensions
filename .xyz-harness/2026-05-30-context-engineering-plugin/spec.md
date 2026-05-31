---
verdict: pass
---

# Context Engineering Plugin

## Background

Pi coding agent 在长会话中上下文窗口会被快速消耗，主要膨胀源是 Tool Result（文件内容、grep 结果）和 Bash Execution（编译输出、测试日志）。Pi 已有原生 compaction 机制（`compaction.ts`），但其触发时机晚（~92%）、摘要质量不可控、且不做预处理。之前的 tree-compact 尝试替代原生 compact 但产生冲突。

本插件不替代原生 compact，而是在 `context` 事件中对消息做**渐进式压缩预处理**，降低上下文消耗速率，让原生 compact 触发更晚甚至不需要触发。

### 前置调研

- `docs/evolution/001-context-compression-redesign.md` — 上下文要素分析、调研综合、压缩方案设计
- `main/docs/research/` — Hermes/OpenClaw/Claude Code/Aider/Qwen Code/OpenCode 调研报告

### 关键设计决策

1. **所有压缩操作都是纯字符串处理，不调用 LLM** — Pi Extension API 未提供 LLM 调用能力，且扩展不能发起网络请求
2. **不替代原生 compact** — 只在 `context` 事件中预处理消息，不拦截 `session_before_compact`
3. **原始内容保留在内存中，通过 ID recall** — 压缩不等于丢弃

## Functional Requirements

### FR-1: Tool Result 过期清理（Level 0）

在 `context` 事件中，将超过可配置过期时间（默认 30 分钟）的 tool_result 消息内容替换为摘要标记。替换内容包含原始消息的压缩 ID，LLM 可通过该 ID recall 原始内容。

- 过期时间可配置（`expireMinutes`，默认 30）
- 替换格式：`[Tool result expired. ID: ctx-xxx. Call recall_context(ctx-xxx) to retrieve]`
- 压缩 ID 格式：`ctx-{uuid8}`
- 不过期条件：tool_result 属于最近 N 轮（`protectRecentTurns`，默认 2）

### FR-2: Bash Execution 输出截断（Level 0）

在 `context` 事件中，将超过可配置长度阈值（默认 4000 字符）的 bash 输出截断，保留尾部。截断内容同样分配压缩 ID，保留原文。

- 截断阈值可配置（`bashTruncateChars`，默认 4000）
- 截断格式：`... [{N} chars truncated, ID: ctx-xxx] ...\n\n{尾部}`
- 保留尾部 `bashTruncateChars` 字符（与 Pi 原生 `truncateTail` 策略一致，bash 输出通常尾部信息密度最高：错误信息、最终结果）

### FR-3: Thinking 块空闲清理（Level 0）

在 `context` 事件中，将超过可配置空闲时间（默认 5 分钟）的 assistant thinking 块清空。

- 空闲时间可配置（`thinkingExpireMinutes`，默认 5）
- 清空格式：`[thinking expired]`
- 清理条件：该 thinking 块所在 assistant 消息的 age（`now - message.timestamp`）超过 `thinkingExpireMinutes` 分钟，且该消息之后没有 user 消息

### FR-4: Tool Result 规则化摘要压缩（Level 1）

在 `context` 事件中，对未过期但超过可配置大小阈值（默认 8000 字符）的 tool_result，用纯规则提取关键信息生成摘要替代原文。保留原始内容用于 recall。

- 大小阈值可配置（`summaryThresholdChars`，默认 8000）
- 摘要格式：`[Condensed (ID: ctx-xxx): {规则提取的摘要}]`
- **规则化摘要策略**（不调用 LLM，纯字符串处理）：
  - 提取文件路径：正则匹配 `path`/`file` 参数中的路径字符串
  - 提取函数/类定义：正则匹配 `(function|class|interface|type|const|let|var)\s+\w+` 行
  - 提取 import/export 行：保留完整行
  - 提取首 N 行 + 尾 M 行（可配置，默认 head=10, tail=5）
  - 中间部分用 `[... {N} lines omitted]` 替代
  - 最终摘要长度不超过原始的 40%
- 摘要失败时（如正则匹配异常）fallback 到 Level 0 截断策略

### FR-5: 原始内容 Recall（L0/L1 通用）

提供一个 `recall_context` 工具，LLM 可通过压缩 ID 获取被压缩的原始内容。

- 工具名：`recall_context`
- 参数：`id`（string，压缩 ID，格式 `ctx-{uuid8}`）
- 返回：原始消息的完整内容
- 存储位置：扩展内部维护的 `Map<string, StoredContent>`（闭包变量）
- 生命周期：随 session 存活，`session_start` 时重建（不跨 session 持久化）
- **错误处理**：ID 不存在（session reload 或 ID 无效）时返回错误文本 `[Content not found. ID: {id}. Session may have been reloaded.]`，不 throw

### FR-6: ToolCall/ToolResult 配对完整性

所有压缩操作必须保证 toolCall 和 toolResult 的配对关系不被破坏。

- 压缩 toolResult 时，保留 toolResult 消息结构，只替换 content 文本
- 不删除 toolResult 消息（即使内容已过期/摘要化）
- 不删除包含 toolCall 的 assistant 消息
- 压缩后在 context 事件返回前，执行配对完整性校验（scan for orphans）

### FR-7: 紧急压缩（Level 2）

当上下文使用率超过可配置阈值（默认 90%）时，执行更激进的清理：只保留最近 3 轮完整消息，更早的 toolResult 全部过期（无视 `expireMinutes`）。

- 触发阈值可配置（`emergencyThreshold`，默认 0.90）
- 上下文使用率估算：优先使用 `ctx.getContextUsage().percent`（精确值），返回 null 时 fallback 到 `chars/4` 启发式
- 执行时更新压缩统计计数器

### FR-8: 压缩动作统计

扩展内部维护累计统计计数器，通过命令展示。

- 统计内容：Level 0 清理数量（按类型分：expired/truncated/thinking）、Level 1 摘要数量、Level 2 紧急触发次数
- 存储方式：扩展闭包变量（`session_start` 时重置）
- 展示方式：`/context-stats` 命令读取闭包变量，返回文本摘要
- `/context-engineering` 命令同时展示配置和累计统计

### FR-9: 配置与启停

通过 `settings.json` 的 `context-engineering` section 配置所有参数，支持运行时通过命令修改。

- 命令：`/context-engineering` — 查看当前配置和统计
- 命令：`/context-engineering global on|off` — 全局启用/禁用
- 命令：`/context-engineering l0 on|off` — 独立控制 L0
- 命令：`/context-engineering l1 on|off` — 独立控制 L1
- 命令：`/context-engineering l2 on|off` — 独立控制 L2
- 每个压缩级别可独立启用/禁用

## Acceptance Criteria

### AC-1: Tool Result 过期清理
- Given 一个 35 分钟前的 read tool_result（内容 5000 字符）
- When context 事件触发
- Then 该 tool_result 的 content 被替换为 `[Tool result expired. ID: ctx-xxx. Call recall_context(ctx-xxx) to retrieve]`
- And 原始 5000 字符内容可通过 `recall_context(ctx-xxx)` 获取

### AC-2: Bash 输出截断
- Given 一个 bash 输出 10000 字符
- When context 事件触发
- Then 输出被截断为前 2000 字符 + 截断标记 + 后 2000 字符
- And 原始 10000 字符可通过 recall 获取

### AC-3: Thinking 清理
- Given 一个 assistant 消息包含 thinking 块，且该消息之后 6 分钟无 user 消息
- When context 事件触发
- Then thinking 内容被替换为 `[thinking expired]`

### AC-4: ToolCall/ToolResult 配对
- Given 消息序列包含 assistant(toolCall) → toolResult
- When 压缩后
- Then toolResult 仍紧随其 toolCall 之后，无孤儿 toolResult 或孤儿 toolCall

### AC-5: Recall 完整性
- Given 所有已压缩的内容（过期/截断/摘要）
- When 调用 `recall_context` 对应 ID
- Then 返回完整的原始内容，无损

### AC-6: 不干扰原生 Compact
- Given context-engineering 插件启用
- When Pi 原生 compact 触发
- Then 原生 compact 正常执行，不报错，不冲突
- And 压缩后的消息格式仍为 Pi 能处理的 AgentMessage 类型

### AC-7: L1 规则化摘要
- Given 一个 12000 字符的 read tool_result（包含 TypeScript 代码，有 import、function 定义、export）
- When L1 压缩执行
- Then 摘要保留文件路径、import 行、函数/类定义行
- And 摘要包含首 10 行和尾 5 行
- And 摘要长度不超过原始的 40%

### AC-8: Level 2 紧急压缩
- Given `ctx.getContextUsage()` 返回 percent = 0.91
- When context 事件触发
- Then 最近 3 轮以外的 toolResult 全部标记为过期
- And L0 过期时间限制被忽略

### AC-9: 压缩统计命令
- Given 插件已运行，处理了 5 次 context 事件，累计清理了 3 个过期 tool_result、2 个截断 bash 输出、1 个 L1 摘要
- When 用户执行 `/context-stats` 命令
- Then 命令输出包含各项统计数据（L0 expired: 3, L0 truncated: 2, L1 condensed: 1, L2 triggered: 0）

### AC-10: 配置与启停
- Given 插件默认配置加载
- When 用户执行 `/context-engineering off`
- Then 后续 context 事件不做任何压缩处理
- And 执行 `/context-engineering on` 后恢复压缩
- And 执行 `/context-engineering l1 off` 只禁用 L1，L0 和 L2 仍生效

## Constraints

### C-1: 不替代原生 Compact
本插件不尝试拦截、替代或取消 Pi 原生 compaction。`session_before_compact` 事件不返回 `{ cancel: true }`。插件只在 `context` 事件中预处理消息。

### C-2: 不修改 Session Entries
插件不在 session entry 层面做任何修改（不 appendEntry、不修改已有 entry）。压缩后的消息仅存在于 `context` 事件的返回值中（深拷贝），不影响磁盘上的 session 数据。原始内容存储在内存中的 `Map` 里。

### C-3: 原始内容不持久化
被压缩的原始内容只保存在进程内存中。session 重载（reload）或切换后丢失。这是有意为之——持久化需要额外的 I/O 和 GC，增加了复杂度。如果未来需要持久化，可以扩展为写入文件。

### C-4: 配置格式
所有配置通过 `settings.json` 的 `context-engineering` key 管理，格式：

```json
{
  "context-engineering": {
    "enabled": true,
    "l0": {
      "enabled": true,
      "expireMinutes": 30,
      "bashTruncateChars": 4000,
      "thinkingExpireMinutes": 5,
      "protectRecentTurns": 2
    },
    "l1": {
      "enabled": true,
      "summaryThresholdChars": 8000,
      "keepHeadLines": 10,
      "keepTailLines": 5
    },
    "l2": {
      "enabled": true,
      "emergencyThreshold": 0.90,
      "protectRecentTurns": 3
    }
  }
}
```

### C-5: ToolCall/ToolResult 配对安全
这是硬约束。所有压缩操作后，必须通过 `_validateToolPairing()` 校验：
- 遍历返回的消息列表
- 每个 toolResult 的 `toolCallId` 必须在前面某个 assistant 消息的 toolCall 中找到对应
- 每个 assistant 的 toolCall 必须在后面有对应的 toolResult
- 校验失败时，放弃本次压缩，返回原始消息（安全降级）

### C-6: 性能约束
`context` 事件在每次 LLM 调用前触发，必须快速返回：
- L0 操作（过期/截断/清理）：纯字符串操作，< 5ms
- L1 操作（规则化摘要）：纯字符串/正则操作，< 10ms
- L2 操作：同 L0，纯字符串操作
- **不调用 LLM**：所有压缩操作都是纯字符串处理，不发起网络请求

### C-7: 不修改消息结构
只修改消息的 `content` 字段（替换文本），不修改 `role`、`toolCallId`、`timestamp` 等元数据字段。不添加新消息，不删除消息，不重排消息顺序。

### C-8: 处理流水线顺序
压缩操作按 L0 → L1 → L2 顺序执行。每级操作独立扫描全部消息：
1. L0 扫描全部消息，执行过期/截断/清理
2. L0 完成后，检查是否需要 L1（配置启用 + 存在未过期但超阈值的内容）
3. L1 完成后，检查是否需要 L2（上下文使用率超阈值）
4. 全部完成后执行配对校验（C-5）

### C-9: 轮 (turn) 的定义
一轮（turn）= 从一条 user/bashExecution 消息到下一条 user/bashExecution 消息之前的所有消息序列。包含中间的 assistant/toolResult/custom 消息。`protectRecentTurns` 保护最近的 N 个这样的 turn。

## 业务用例

### UC-1: 长时间编码会话的上下文保持
- **Actor**: 开发者使用 Pi 进行多天编码
- **场景**: 连续 2 小时的编码 session，read 了大文件、跑了多次测试、执行了多个 bash 命令
- **预期结果**: 上下文窗口不会被旧的 tool result 填满，agent 仍能记住当前任务的上下文。需要查看旧结果时可通过 recall 获取。

### UC-2: 大文件读取后的上下文释放
- **Actor**: 开发者用 Pi 分析一个大文件
- **场景**: agent read 了一个 500 行的文件（~5000 token），处理完后 30 分钟内未再引用
- **预期结果**: 该 tool result 自动过期，释放 ~5000 token。LLM 的压缩 ID 提示它可以 recall。

### UC-3: 紧急上下文溢出防护
- **Actor**: 开发者在复杂任务中触发大量工具调用
- **场景**: agent 连续调用 read/bash/grep，上下文快速膨胀到 90%
- **预期结果**: Level 2 紧急压缩自动触发，释放旧 tool result，防止上下文溢出错误。

## Complexity Assessment

| 维度 | 评估 | 说明 |
|------|------|------|
| 新文件数 | 5-6 | index.ts + src/index.ts + src/compressor.ts + src/recall-store.ts + src/config.ts + src/widget.ts |
| 核心算法复杂度 | 中 | L0/L1/L2 都是线性扫描+字符串替换；配对校验是线性扫描 |
| 外部依赖 | 低 | 无新依赖，使用 Pi Extension API + 当前 session 模型 |
| 风险点 | 低 | 所有操作都是纯字符串处理，无网络调用；L1 规则化摘要的正则可能对非代码内容效果有限 |
| 与现有功能的交互 | 低 | 只读 session entries，只在 context 事件中修改消息副本 |
