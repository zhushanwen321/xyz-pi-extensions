# Qwen Code 上下文管理分析报告

## 1. 概览

Qwen Code 是一个基于 Gemini API 的 AI coding agent，采用 TypeScript 构建，monorepo 结构。其上下文管理涉及 7 个关键子系统，涵盖 token 预算控制、自动/手动压缩、会话持久化、工具输出截断、循环检测、思考链清理和长期记忆。

| 子系统 | 负责模块 | 核心文件 |
|--------|---------|---------|
| Token 限额 | tokenLimits.ts | `packages/core/src/core/tokenLimits.ts` |
| 聊天压缩 | ChatCompressionService | `packages/core/src/services/chatCompressionService.ts` |
| 工具输出截断 | truncation.ts | `packages/core/src/utils/truncation.ts` |
| 会话录制/恢复 | ChatRecordingService + SessionService | `packages/core/src/services/` |
| 循环检测 | LoopDetectionService | `packages/core/src/services/loopDetectionService.ts` |
| 思考链清理 | GeminiChat 内联方法 | `packages/core/src/core/geminiChat.ts` |
| 长期记忆 | MemoryTool | `packages/core/src/tools/memoryTool.ts` |

---

## 2. Token 限额系统

### 模型 -> Token 限额映射

`tokenLimits.ts` 定义了完整的模型到 token 限额的映射表，覆盖 10+ 模型系列：

```typescript
const LIMITS = {
  '32k': 32_768,    '64k': 65_536,
  '128k': 131_072,  '200k': 200_000,  // OpenAI/Anthropic
  '256k': 262_144,  '1m': 1_000_000,  // Qwen/Gemini
} as const;
```

模型名称通过 `normalize()` 函数规范化（去前缀、去版本号、去量化标记），然后用正则匹配查找限额。

### 输入/输出限额分离

```typescript
export type TokenLimitType = 'input' | 'output';
```

- **输入限额**：用于上下文窗口大小，默认 128K
- **输出限额**：用于单次生成上限，默认 32K（cap 为 8K，遇 MAX_TOKENS 自动升级到 64K）

### Capped Default + 自动升级策略

为避免每次请求都预留 32K 输出 slot（99% 的输出 < 5K），使用 8K capped default。当模型返回 MAX_TOKENS finish reason 时，自动用 64K 重试一次——这个重试独立于普通重试循环。

---

## 3. 聊天压缩系统（核心上下文管理）

### 3.1 架构

聊天压缩是 Qwen Code 最核心的上下文管理手段。设计为四层：

```
用户输入 → [session turn limit 检查] → [自动压缩] → [session token limit 检查] → [IDE 上下文注入] → [Turn 执行]
```

### 3.2 触发机制

**自动压缩**：在 `client.ts` 的 `sendMessage()` 中，每次用户消息发送前触发（非 force 模式）。

**手动压缩**：用户输入 `/compress` 或 `/summarize` 命令触发（force 模式）。

### 3.3 三阈值判断

```typescript
COMPRESSION_TOKEN_THRESHOLD = 0.7      // 超过 70% token 限额才触发
COMPRESSION_PRESERVE_THRESHOLD = 0.3   // 保留最后 30% 的历史
MIN_COMPRESSION_FRACTION = 0.05        // 可压缩部分必须 > 5%，防止无效调用
```

### 3.4 分段策略

`findCompressSplitPoint()` 按字符数比例计算分割点：

1. 从历史中计算每个 Content 的 JSON.stringify 长度
2. 累积字符数，找到首个用户消息位置达到 `1 - COMPRESSION_PRESERVE_THRESHOLD`（70%）处
3. 分割为 `historyToCompress`（旧的 70%）和 `historyToKeep`（最近的 30%）

Edge case 处理：
- 如果最后一条是 model 且不含 functionCall，允许压缩全部
- 如果最后一条是 user 且包含 functionResponse（完整的工具调用序列结束），也允许压缩全部
- 否则回退到空压缩（splitPoint = 0）

### 3.5 压缩执行

将 `historyToCompress` + 一条指令 prompt 发给 LLM，要求生成 `<state_snapshot>` XML：

```xml
<state_snapshot>
    <overall_goal>...<overall_goal>
    <key_knowledge>...</key_knowledge>
    <file_system_state>...</file_system_state>
    <recent_actions>...</recent_actions>
    <current_plan>...</current_plan>
</state_snapshot>
```

### 3.6 压缩后替换

成功压缩后，替换 chat history 为：

```
[summary user turn] + [model确认回复] + [原来保留的 30% 历史]
```

### 3.7 失败处理

三种失败模式，各有处理策略：
- **COMPRESSION_FAILED_EMPTY_SUMMARY**：LLM 返回空
- **COMPRESSION_FAILED_TOKEN_COUNT_ERROR**：无法计算 token 数
- **COMPRESSION_FAILED_INFLATED_TOKEN_COUNT**：压缩后 token 反而增加

非 force 模式下，首次失败后 `hasFailedCompressionAttempt = true`，后续自动压缩跳过（直到用户手动 /compress）。

### 3.8 Hook 集成

- 压缩前触发 `PreCompact` hook（区分 Manual / Auto 来源）
- 压缩成功后触发 `SessionStart` hook（来源为 Compact）

### 3.9 Orphaned Function Call 处理

手动压缩时，如果历史末尾有孤立的 model functionCall（agent 中断/崩溃导致），先 strip 掉再计算分割点。自动压缩不做此处理，因为此时 functionCall 仍在活跃状态。

---

## 4. 工具输出截断

### 4.1 触发条件

工具执行结果超出阈值时自动截断：
- 字符阈值：默认 25,000 字符
- 行数阈值：默认 1,000 行

### 4.2 截断策略

保留 head（前 20%）+ tail（后 80%）：

```
head_lines
--- [CONTENT TRUNCATED] ---
tail_lines
```

截断时同时考虑字符预算和行数预算：head 占 1/5 字符预算，tail 占剩余 4/5 - separator 长度。超长的单行会被截断并追加 `...`。

### 4.3 完整内容保存

完整内容写入随机命名的临时文件，在截断后的消息中提示可用 `read-file` 工具读取。

### 4.4 日志

通过 `ToolOutputTruncatedEvent` 记录 truncation 事件到 telemetry。

---

## 5. 会话录制与恢复

### 5.1 存储格式

JSONL 文件，每条记录（`ChatRecord`）包含：

```typescript
interface ChatRecord {
  uuid: string;                // 唯一 ID
  parentUuid: string | null;   // 树结构：指向父消息
  sessionId: string;           // 会话 ID
  type: 'user' | 'assistant' | 'tool_result' | 'system';
  message?: Content;           // 原始 API Content 对象
  usageMetadata?: GenerateContentResponseUsageMetadata;
  model?: string;
  toolCallResult?: Partial<ToolCallResponseInfo>;
  systemPayload?: ...;
}
```

### 5.2 树结构设计

通过 `uuid` / `parentUuid` 形成树结构，天然支持：
- **Append-only 写入**：崩溃安全
- **Checkpoint 恢复**：可以从任何历史节点分支
- **压缩 checkpoint 记录**：system 类型 + subtype='chat_compression' 记录压缩快照

### 5.3 恢复策略

`buildApiHistoryFromConversation()` 的恢复策略：

1. **查找最新的 compression checkpoint**：从 messages 中找到最后一个 `subtype === 'chat_compression'` 的记录
2. **使用 checkpoin 的 compressedHistory 作为基础历史**
3. **追加 checkpoint 之后的所有新消息**（跳过 system 记录）
4. **无 checkpoint 时**：返回完整的线性消息列表

### 5.4 会话限制

- **Max Session Turns**：最大对话轮次（默认 -1 = 无限制），超过时发出 `MaxSessionTurns` 事件
- **Session Token Limit**：会话 token 总量上限（默认 -1 = 无限制），检查在压缩之后（避免压缩后越限的假阳性）

---

## 6. 思考链清理

### 6.1 Idle 触发

配置 `thinkingIdleThresholdMinutes`（默认 5 分钟）。当两次 API 调用间隔超过阈值时，自动清除历史中的思考（thought）部分。

### 6.2 双模式

```typescript
stripThoughtsFromHistory()           // 清除所有 thought parts
stripThoughtsFromHistoryKeepRecent(1) // 保留最近 1 个含思考的 model turn
```

Idle 清理使用 `keepRecent(1)` 模式，保留最近的推理链。

### 6.3 Latch 机制

`thinkingClearLatched` 标记：空闲超时后仅标记，下次 API 调用前才实际执行清理，避免在空闲期间做无用功。

---

## 7. 循环检测

### 7.1 Tool Call 循环检测

检测连续 5 次相同的 tool call（name + args SHA256 哈希相同）。

### 7.2 文本内容循环检测

滑动窗口哈希：50 字符 chunk、10 次重复、间距 ≤ 75 字符时判定为循环。

### 7.3 防护

- 代码块内不检测（避免 false positive）
- 列表、表格、标题、引用、分割线切换时重置
- 可对会话级禁用（`disableForSession()`）

---

## 8. 长期记忆

通过 `save_memory` tool 实现，支持两种 scope：

- **global**：保存到 `~/.qwen/QWEN.md`
- **project**：保存到项目 `QWEN.md`

在会话启动时，memory 内容作为 system prompt 的一部分注入到 LLM 上下文。`/context` 命令会单独统计 memory 的 token 占用。

---

## 9. /context 命令

提供上下文窗口使用情况的详细诊断：

```
/context          ← 按分类概览
/context detail   ← 逐项详细信息
```

### 9.1 六大分类

| 分类 | 内容 | 估算策略 |
|------|------|---------|
| System Prompt | 系统提示词 | 字符估算 |
| Built-in Tools | 内置工具声明 | JSON 序列化 + 估算 |
| MCP Tools | MCP 工具声明 | JSON 序列化 + 估算 |
| Memory Files | QWEN.md 内容 | 解析文件块 + 估算 |
| Skills | Skill 列表+已加载 body | 估算 |
| Messages | 对话历史 | API 返回的 totalTokenCount - 估算的开销 |

### 9.2 显示模式

- **无 API 数据时**：仅显示估算的 overhead，不显示历史消息
- **有 API 数据时**：用 API 返回的 `totalTokenCount` 作为真实参考，按比例缩放各分类显示
- **缓存感知**：DashScope prefix caching 场景下，用 cachedContentTokenCount 得到更准确的消息 token 数

### 9.3 Autocompact Buffer

显示压缩触发余量（contextWindowSize × (1 - threshold)），告诉用户还有多少空间到自动压缩。

---

## 10. 配置项汇总

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `maxSessionTurns` | number | -1（无限制） | 最大对话轮次 |
| `sessionTokenLimit` | number | -1（无限制） | 会话 token 上限 |
| `chatCompression.contextPercentageThreshold` | number | 0.7 | 压缩触发阈值（占 context window 比例） |
| `thinkingIdleThresholdMinutes` | number | 5 | 思考链清理空闲时间 |
| `truncateToolOutputThreshold` | number | 25000 | 工具输出截断字符阈值 |
| `truncateToolOutputLines` | number | 1000 | 工具输出截断行数阈值 |

---

## 11. 关键设计决策分析

### 优势

1. **分层防御**：turn 限制 → 自动压缩 → token 限制 → 输出截断 → 循环检测，多层防护确保上下文不失控
2. **LLM 压缩而非简单截断**：使用 LLM 生成结构化摘要，保留语义信息而非简单丢弃 token
3. **Checkpoint 式恢复**：压缩 checkpoint + 后续增量消息的组合，无需重新压缩即可恢复
4. **估算 + 精确双模式**：`/context` 命令先显示估算，收到 API token 数据后自动切换为精确
5. **Capped default + auto-escalate**：输出 token 的 8K/64K 双级策略减少 slot 浪费

### 局限

1. **LLM 压缩开销**：每次压缩需要额外 API 调用，压缩 prompt + 待压缩历史本身消耗 token
2. **无滑动窗口**：只有压缩或截断两种模式，没有基于 token 数的滑动窗口丢弃
3. **无增量压缩**：每次压缩都会重新处理整个旧历史，而不是增量增量式的
4. **无选择性保留**：无法按重要性选择保留哪些历史消息——是简单的比例分割
5. **估算精度**：字符估算与真实 token 数有偏差，依赖 API 返回校准

### 与 Pi 的上下文管理对比启示

- Qwen Code 的 **LLM 压缩 + checkpoint 恢复** 模式值得参考
- SessionService 的 `buildApiHistoryFromConversation` 提供的 checkpoint 重建逻辑是核心亮点
- `/context` 命令的上下文诊断 UI 对用户透明
- 思考链 idle 清理是对无限上下文的有益补充（不再需要的 reasoning 及时清理）
