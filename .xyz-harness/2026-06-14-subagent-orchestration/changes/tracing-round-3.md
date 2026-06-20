# Tracing Round 3

## CONVERGED 状态

**NOT CONVERGED** — 发现 12 个新 gap（9 个 F 类、1 个 K 类、2 个 D 类），其中 4 个为结构性问题（影响 FR-O6 的可实现性）。FR-O6 整个章节存在多处代码事实偏差和数据源缺口，尚未达到可实施状态。

## 追踪范围

- spec 版本：含 FR-O1~FR-O5 + FR-O6（FR-O6 为 Round 2 后新增章节，本轮重点）
- 追踪视角：5 视角完整重跑（全部适用，无降级）
- 重点审查区域：FR-O6.1~FR-O6.7 全部 7 个子项

## 新 Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G-036 | F | Data Lifecycle | FR-O6.2 | `OrchestrationGraphNode.recentEvents` 在参考实现 `WorkflowGraphNode` 中不存在（types.ts:35-57 只有 error/acceptanceStatus）。spec 说"移植"但实际是新增字段，数据源未定。 |
| G-037 | F | Data Lifecycle | FR-O6.2 | `kind` 声明为 `"step"\|"parallel-group"\|"agent"`，丢失 `"dynamic-parallel-group"`（FR-O3.4 fanout）。fanout 展开节点在 DAG 中如何表示？ |
| G-038 | F | API Contract | FR-O6.2 | `AnyToolDetails` union 路由按 `kind` 字段，但现有 `SubagentToolDetails` 没有 `kind` 字段。需跨 spec 修改（subagent-render.ts + subagent-tool.ts + subagent-tui FR-1.2）。 |
| G-039 | F | Data Lifecycle | FR-O6.6 | Level 1 右栏 `formatAgentOneLiner` 需要 `node.model`/`node.result.usage`/`node.result.toolCalls`/`node.startedAt`/`node.completedAt`，但 `OrchestrationGraphNode` 没有这些字段。recentEvents 与 toolCalls 结构不同不能替换。 |
| G-040 | F | Data Lifecycle | FR-O6.6 | Level 2 step 详情数据源是 recentEvents + result.text，但 OrchestrationGraphNode 没有 `result` 字段（只有 `error?`）。step 完整结果存哪里？ |
| G-041 | F | State Machine | FR-O6.2 | `status` 新增 `"skipped"`，但参考实现 `WorkflowNodeStatus` 没有 skipped，`normalizeStatus` 和 `summarizeParallelStatuses` 都不认识。skipped 在 parallel-group 聚合状态推导中如何处理？ |
| G-042 | F | Failure Path | FR-O6.5 | async 模式说"复用 startBackground 的 onUpdate"，但 startBackground 是为单个 runAgent 设计的。编排有多个并发 step，如何把 N 个 step 的 onEvent 聚合到一个 onUpdate？ |
| G-043 | F | API Contract | FR-O6.5 | sync 模式 `stepOnEvent = (stepId, event)` 路由未详述。runAgent 的 onEvent 签名是 `(event) => void`，没有 stepId 参数。parallel 模式并发时如何保证 stepId 不串？ |
| G-044 | F | Data Lifecycle | FR-O6.6 | list Level 0 新增 "Type" 列，但 BgRecord 没有 `type` 字段区分 single/orchestration。需新增字段还是从 id 前缀推断？ |
| G-045 | F | State Machine | FR-O6.5 | spinner 定时器：orchestrate 是独立工具有自己的 TState，不能共享 subagent-tui 的 SubagentToolState。需明确"复用常量 + 各自实现定时器"。 |
| G-046 | F | User Journey | FR-O6.3 | 压缩视图"固定 8 行"但 step 数 > 6 时截断策略未详述。chain（顺序，active 在中间）和 parallel（并发）的截断策略应不同。 |
| G-047 | K | User Journey | FR-O6.4 | Pi 对话流 block 的 alt+o 展开是否支持 block 内 j/k 滚动——阻塞型 gap，需 P1 实现前验证 Pi SDK。 |
| G-048 | D | API Contract | FR-O3.1a | spec 内部矛盾：FR-O3.1 说独立工具，FR-O3.1a 代码块（:212-230）的 SubagentParams 仍含 tasks/chain。合并代码块应删除。 |
| G-049 | D | State Machine | FR-O6.4 | 展开 step 折叠状态（▶/▼）存哪里？OrchestrationGraphNode 上？ToolRenderContext.state？还是每次重新计算？ |

## 结构性问题（4 个，影响 FR-O6 可实现性）

1. **G-037**：kind 丢失 dynamic-parallel-group，fanout 无表示
2. **G-039/G-040**：节点字段不足以支撑 Level 1/2 渲染（缺 model/usage/timestamps/result）
3. **G-038**：AnyToolDetails union 需跨 spec 修改 SubagentToolDetails 加 kind
4. **G-042/G-043**：sync/async onUpdate 路由机制未实现，startBackground 不支持编排

## 结论

FR-O6 声称"移植 WorkflowGraphNode + 照搬 WorkflowsView"但前提（数据模型对齐）不成立。需主 agent 重写 OrchestrationGraphNode 完整字段定义 + FR-O6.6 字段映射表后，预计 Round 4 可收敛。
