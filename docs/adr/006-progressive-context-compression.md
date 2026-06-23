# ADR-006: 渐进式上下文压缩（Progressive Context Compression）

> 状态：proposed
> 日期：2026-05-31

## 背景

旧 `infinite-context` 插件尝试拦截并替换 Pi 原生 Compaction，用 tree-compact 方案做上下文压缩。实际运行中发现两个根本性问题：

1. **与原生 Compaction 冲突**：原生 Compaction 在 agent loop 外运行，对旧消息做 token 级 LLM 摘要。infinite-context 在 agent loop 内运行，两者对同一批消息的操作顺序和时机不可控，导致消息状态不一致。
2. **不可逆**：tree-compact 的压缩结果无法回溯，LLM 丢失关键上下文后无法恢复。

Pi 的 `context` 事件提供了新的切入点：在每次 LLM 调用前，Extension 可以修改即将发送的消息列表。这个时机在 agent loop 内、LLM 调用前，不与原生 Compaction 冲突。

## 决策：三级渐进式压缩管道

采用 L0 → L1 → L2 三级管道，通过 `context` 事件在 LLM 调用前对消息做规则化处理。

### L0：零成本客户端清理

无条件执行，不调用 LLM，不产生 token 开销：

- 清理过期的 toolResult（不在 Protected Turn 内的）
- 截断过长的 bash output
- 清理 thinking 块（LLM 不需要看到自己的历史推理过程）

### L1：规则化摘要

对 L0 清理后仍然过长的内容做正则提取：

- 保留错误信息和关键输出行
- 移除重复行和空行
- 用 `[... N lines truncated, use recall_context(ctx-xxxxxxxx) to see full content]` 标记被压缩的部分

被压缩的原始内容存入 RecallStore，LLM 可通过 `recall_context` 工具按需取回。

### L2：紧急截断

当 token 预算严重超限时强制执行：

- 强制过期 Protected Turn 外的所有 toolResult
- 这是最后的防线，会丢失最多但保证 LLM 能收到请求

### Recall 机制

- **RecallStore**：内存 Map，key 为 `ctx-{12hex}` 格式的 ID，value 为被压缩前的原始消息内容
- **recall_context 工具**：注册为 Pi Tool，LLM 可按 ID 获取原始内容
- **生命周期**：无持久化，`session_start` 时重建。session 重载后 RecallStore 为空

### Protected Turn 机制

- 以 **Turn Boundary**（user 消息）为分界，将消息分组为 turn
- 最近 N 个 turn 为 Protected Turn，其中的 toolResult 不被 L0/L2 过期或截断
- N 由 `protectRecentTurns` 配置，默认 2

## 替代方案

### 方案 A：LLM 摘要

用 LLM 对旧消息生成摘要，替代原始消息。

**否决原因**：Pi Extension API 不暴露 LLM 调用能力。Extension 无法发起独立的 LLM 请求。即使通过 subagent 绕过，每次摘要的 token 成本和延迟也不可接受。

### 方案 B：纯规则化压缩（当前选择）

只用正则和启发式规则做压缩，不调用 LLM。

**选择原因**：零成本、低延迟、可逆（Recall）。缺点是 L1 对非代码内容（自然语言讨论）的效果有限——没有明确的"关键行"可提取。

### 方案 C：混合方案

L0/L1 规则化 + L2 时调用 LLM 做摘要。

**推迟原因**：需要 Extension API 支持独立 LLM 调用（当前不支持）。可作为未来演进方向，但不应阻塞 MVP。

## 与原生 Compaction 的关系

互补，不冲突：

| 维度 | 原生 Compaction | Context Engineering |
|------|-----------------|---------------------|
| 运行时机 | agent loop 外 | agent loop 内（`context` 事件） |
| 粒度 | token 级 LLM 摘要 | 消息级规则化处理 |
| 可逆性 | 不可逆 | 可逆（Recall） |
| 成本 | LLM 调用成本 | 零 LLM 成本 |
| 触发条件 | token 数超阈值 | 每次 LLM 调用前 |

Compaction 做粗粒度的整体摘要（整段对话 → 一段总结），Context Engineering 做细粒度的消息级优化（单条 toolResult 太长 → 截断 + recall）。两者作用在不同层面，同时启用效果最好。

详见 `docs/research/context-compaction/analysis.md`。

## 后果

### 正面

- **零 LLM 成本**：所有压缩操作都是规则化的，不发起额外的 LLM 请求
- **可逆**：Recall 机制让 LLM 在需要时取回原始内容，避免关键信息永久丢失
- **与原生 Compaction 共存**：不拦截、不替代原生机制，在 `context` 事件中做增量优化
- **渐进式**：L0 无损 → L1 轻损 → L2 重损，按需升级，不一次性丢弃所有细节

### 负面

- **L1 对非代码内容效果有限**：自然语言讨论、设计文档等没有明确的"关键行"可提取，L1 只能做截断
- **RecallStore 无持久化**：session 重载（如 Pi 重启后恢复对话）后 RecallStore 为空，之前被压缩的内容无法 recall。这是当前 Extension API 的限制——没有跨 session 的持久化存储机制
- **Protected Turn 是启发式的**：N 的默认值（2）是经验值，不同任务的最优值可能不同。过小会丢失有用上下文，过大会浪费 token 预算
- **增加 agent turn 中的处理时间**：每次 LLM 调用前都要跑 L0/L1/L2 管道，消息量大时可能有可感知的延迟
