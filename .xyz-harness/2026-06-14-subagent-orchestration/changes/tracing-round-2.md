# Tracing Round 2

## CONVERGED 状态

**未收敛** — 发现 8 个新 gap（6 F + 1 K + 1 D），集中在本轮新增 FR 的实现细节遗漏：
- 合并窗口定时器/abort 监听器的资源清理（FR-O1.5、FR-O5.5）
- FR-O3.1a 前置校验表遗漏 `graceTurns`/`schema`/`appendSystemPrompt` 等 RunAgentOptions 字段
- FR-O5.7 steer 的触发入口（API）未定义
- 临时落盘文件 + ChainOutputMap 的清理策略缺失
- 单个 background 在合并窗口下的延迟语义未决

## 追踪范围

- spec 初稿版本：Step 4 后（含 FR-O3.1a / FR-O1.5 / FR-O5.5 / FR-O5.7 / FR-O3.6 / FR-O4.1）
- 追踪视角：全部 5 视角
- 验证源码：runtime.ts / subagent-tool.ts / types.ts / concurrency-pool.ts / run-agent.ts / model-resolver.ts / 参考实现

## 新 Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G-028 | D | State Machine | FR-O1.5 | 合并窗口对"单个 background"的延迟语义未决：首个事件立即发送 + 后续 2000ms 入队，还是首个事件启动定时器、到期统一 flush（首个 background 被延迟 2s）？ |
| G-029 | F | Failure Path | FR-O1.5 | 合并窗口的 flush 定时器在 runtime 卸载/session 结束时如何清理？未清理会导致 pending 通知丢失。 |
| G-030 | F | Failure Path | FR-O5.5 | AbortController 树的 `signal.addEventListener("abort")` 监听器在 step 完成/取消后是否移除？长期运行编排不移除会内存泄漏。 |
| G-031 | F | Data Lifecycle | FR-O3.6 | FR-O3.6 落盘临时文件 `{tmpdir}/chain-{runId}/` 何时清理？tmpdir 不自动清理。 |
| G-032 | F | Data Lifecycle | FR-O3.3 | ChainOutputMap 在 chain 编排完成后何时清理？FR-O5.9 只覆盖 _bgRecords Map。 |
| G-033 | K | User Journey | FR-O5.7 | `steerBackground(runId, stepIndex, message)` 的触发入口是什么？LLM 工具？slash command？TUI 快捷键？没有入口则 FR 无法被触发。 |
| G-034 | F | API Contract | FR-O3.1a | 前置校验表遗漏 `graceTurns`（正整数？）、`schema`（合法 JSON Schema？）、`appendSystemPrompt`（字符串数组？）、`output`（合法路径？）、`outputMode`（枚举？）等可静态校验字段。 |
| G-035 | F | Failure Path | FR-O3.6 | FR-O3.6 落盘失败（磁盘满/权限拒绝/路径非法）的兜底行为未定义。回退内联注入还是报错终止 chain？ |

## 详细追踪

（追踪路径已记录，关键结论：所有 gap 源自 Round 1 后新增 FR 的实现细节层——主 agent 在 Round 1 补齐了语义层 gap，但实现层的资源管理和 API 入口需要进一步明确。）

## 备注

- 已开放的 G-016（triggerTurn 时序）和 G-025（sendMessage 兜底）本轮不重复，保持开放。
- FR-O4.1 priority 方向（sync=0 / bg=1000）经核实 concurrency-pool.ts:33-38 代码事实正确，无新 gap。
