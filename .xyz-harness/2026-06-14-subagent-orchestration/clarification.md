# Clarification — Subagent Background 回注 + 编排模式

## 已确认的决策

| ID | 决策 | 来源 |
|----|------|------|
| D-1 | in-process 架构不变（ADR-025），不引入 spawn | ADR-025 |
| D-2 | 不做跨进程恢复（L3），进程死=任务死 | ADR-027 + 用户确认 |
| D-3 | background 完成应回注主进程（Q2 答案=是） | 用户原始问题 + 参考实现 notify.ts |
| D-4 | 编排与 background 是正交组合（Q4 答案） | 用户原始问题 |
| D-5 | `sendMessage({triggerTurn:true})` 是回注的实现手段 | shared/types/mariozechner/index.d.ts:129 + notify.ts:97 |

## 代码验证记录（Assumption Audit）

| 假设 | 验证 | 结果 |
|------|------|------|
| `pi.sendMessage` 存在且支持 triggerTurn | grep ExtensionAPI | ✅ `shared/types/mariozechner/index.d.ts:129` |
| `pi.events "subagents:bg:done"` 无订阅者 | grep 全 src | ✅ 只有 emit（runtime.ts:435/471），无 on |
| `DefaultConcurrencyPool.acquire(priority)` 已支持但未被调用 | 读 concurrency-pool.ts:21 | ✅ 支持，调用方都传默认 Infinity |
| `AgentConfig` 无 defaultBackground 字段 | 读 types.ts:281-305 | ✅ 需新增 |
| `subagent-tool.ts` 只有 single sync/bg/query 三模式 | 读全文 | ✅ 无 tasks/chain 字段 |
| `appendCustomMessageEntry` 可用于注入展示消息 | grep ExtensionAPI | ✅ index.d.ts:65，但 sendMessage+triggerTurn 更适合（触发 turn） |

## 参考实现移植映射

| 参考（pi-subagents） | 本 spec FR | 移植方式 |
|---------------------|-----------|----------|
| `runs/shared/parallel-utils.ts:76 mapConcurrent` | FR-O3.2 | 直接移植，spawn→runAgent |
| `runs/shared/parallel-utils.ts:110 aggregateParallelOutputs` | FR-O3.2 | 直接移植 |
| `runs/shared/chain-outputs.ts:70 resolveOutputReferences` | FR-O3.3 | 直接移植 |
| `runs/shared/chain-outputs.ts:24 validateChainOutputBindings` | FR-O3.3 | 直接移植 |
| `runs/shared/dynamic-fanout.ts:215 resolveDynamicFanoutItems` | FR-O3.4 | 直接移植 |
| `runs/shared/workflow-graph.ts buildWorkflowGraphSnapshot` | （TUI 展示，后续） | 可选移植供 list 视图 |
| `runs/background/notify.ts:97 sendMessage+triggerTurn` | FR-O1 | 模式移植（in-process 无需 fs watcher） |
| `runs/background/completion-dedupe.ts` | FR-O1.3 | 移植去重逻辑 |
| `runs/background/result-watcher.ts` | ❌ 不移植 | 子进程 IPC 机制，in-process 不需要 |
| `runs/background/async-execution.ts spawn` | ❌ 不移植 | spawn 子进程，ADR-025 禁止 |

## Step 3 追踪后的用户决策记录

| Gap | 决策 | 推理 |
|-----|------|------|
| G-013 编排入口 | 独立 orchestrate 工具 | 职责分离，params 无歧义，避免 task+tasks 路由复杂度 |
| G-011 cancel 编排 | abort 整个 DAG | 简单可预测，已完成 step 结果保留供排查 |
| G-014 chain failFast | 默认开 | "一步错步步错"的流水线语义，LLM 默认得到安全行为 |
| G-015 多 bg 合并 | 合并窗口（2000ms） | 防止 N 个 turn 刷屏，单个 background 不增延迟 |
| G-017 runId 模型 | 单 BgRecord 聚合 | 与现有 backgroundId 语义一致，简单 |
| G-010 编排 steer | 支持（P2 阶段） | 提升灵活性，但需 ManagedSession 生命周期管理，复杂度高，延后 |
| G-012 大输出 | 超阈值（4000 tokens）自动落盘 | 安全网，平衡 context 保护与信息保留 |
| G-001/G-006 并发池 | 修正 priority 方向（单池） | 改动小，sync 传 0 / bg 传 1000 |
| G-023 TUI 展示 | 已闭合：1 个聚合 block + DAG 骨架 + phase 进度 | FR-O6（压缩视图极简，展开看各 step eventLog，list 视图编排行下钻 DAG） |

## 编排 TUI 设计决策（FR-O6，Step 6 后补充）

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 对话流 block 归属 | 1 个聚合 block（DAG 内嵌） | orchestrate 是一个 tool call → 一个 block；与 FR-O5.4"单 BgRecord 聚合"一致 |
| 压缩视图布局 | 骨架 + phase 进度 | 压缩视图极简（总进度），alt+o 展开看各 step eventLog |
| chain 进度指示 | 简化：`step N/total: {agent}`（不用进度条） | 顺序执行的进度条不直观，步数计数器更清晰 |
| async 编排 block 刷新 | 决策 A：block 持续刷新（视口内） | 与单个 background 行为一致，用户滚走后状态仍更新 |
| list 视图编排详情 | 照搬 WorkflowsView 三级模型 | Level 0 列表 → Level 1 DAG 概要（左右分栏）→ Level 2 step eventLog |

### FR-O6.6 复用映射（WorkflowsView → orchestration-view）

| WorkflowsView 概念 | subagents 编排对应 | 复用 |
|-------------------|-------------------|------|
| `WorkflowInstance` | `OrchestrationToolDetails` | 数据源替换 |
| `ExecutionTraceNode` | `OrchestrationGraphNode` | 结构几乎一致 |
| `buildPhaseGroups` / `PhaseGroup` / `formatPhaseLine` | 同名，入参改类型 | 直接移植 format.ts |
| 三级 ViewState `level: 0\|1\|2` | 同结构 | 直接复用 |
| `renderLevel0/1/2` + SIDEBAR_WIDTH=24 左右分栏 | 同布局 | 移植渲染逻辑 |
| `processNavigation`（j/k/Enter/Esc） | 同交互 | 直接移植 |
| `ctx.ui.custom()` + requestRender + onChange 总线 | 已有（subagent-tui FR-3.4） | 复用 |
| saveMode / handleRestart / handlePauseResume | ❌ 不移植 | workflow 特有，subagents 用 cancelBackground 替代 |

## 仍开放的 gap

| Gap | 问题 | 处理时机 |
|-----|------|----------|
| G-005 (B1) | eventLog 竞态（runtime.ts:431 startsWith("run-")） | 编排前置依赖，需先修（独立 bug）。验证确认 bug 存在，修复方向正确（onEvent 闭包直接写 record.eventLog） |

## Pi SDK 源码验证（G-016/025/033/047 已闭合）

查 `~/Code/pi-mono-fix-workspace/main/packages/` 源码，4 个 gap 全部闭合：

### G-016：triggerTurn 时序 ✅ 闭合

| 场景 | 行为 | 代码证据 |
|------|------|----------|
| 空闲 + triggerTurn:true | 触发新 LLM turn | `agent-session.ts:1321` `_runAgentPrompt` |
| 执行中（isStreaming）+ triggerTurn:true | **triggerTurn 被忽略**，进 steering 队列（当前 turn 下一轮注入） | `agent-session.ts:1315` `isStreaming` 分支先于 `triggerTurn` |
| customType 支持 | 必填字段，`{customType:"subagent-bg-notify",...}` 合法 | `messages.ts:46-53` |

**结论**：FR-O1 的 background 回注在两种状态下都能让主 agent 看到结果（空闲→新 turn；执行中→steering 注入）。无需额外处理。

### G-025：sendMessage 失败兜底 ✅ 闭合

| 失败场景 | 行为 | 扩展可感知？ |
|---------|------|------------|
| stale runtime（session 替换） | `assertActive()` 同步抛错 | ✅ try/catch 可捕获 |
| 异步投递失败（session 关闭） | Pi 内部 `.catch` 吞掉 + emitError | ❌ 不能（返回 void） |
| 队列满 | **不存在**（无界 push） | n/a |

**结论**：stale runtime 抛错必须 try/catch（否则 background 误标 failed）。异步失败接受限制（概率低 + getBackground 可查）。FR-O1.7 新增 try/catch 包装。

### G-047：block 内 j/k 滚动 ✅ 闭合（不支持）

- **展开键是 `Ctrl+O` 不是 `Alt+O`**（`keybindings.ts:85`）——spec 已全文修正
- `ToolExecutionComponent` 不实现 `handleInput`，展开 = 全量 inline 渲染，无 viewport/scrollOffset
- focus 永远在 editor，从不 focus 工具 block（`interactive-mode.ts:692`）
- **结论**：FR-O6.4 展开视图不依赖 block 内滚动，按终端高度截断，完整详情走 list Level 2

### G-033：steer 入口 ✅ 闭合（slash command 可行）

- `registerCommand(name, { handler: async (args: string, ctx) => {} })`——args 是原始字符串，扩展自行 split
- steer 投递用 `pi.sendUserMessage(message, {deliverAs:"steer"})`（`types.ts:1196`）
- **结论**：`/subagents steer <runId> <step> <message>` 可行，FR-O5.7 P2 实现

### G-005：eventLog 竞态 ✅ 确认 bug 存在

- `runtime.ts:431/467` 的 `widget.listAgents().find(a => a.id.startsWith("run-"))` 在并发 background 时会命中错误 widget（`agent-widget.ts:156` listAgents 无过滤）
- **修复方向正确**：在 startBackground 包装 onEvent 时通过闭包直接写 `record.eventLog`，绕过 widget 反查

## Round 2 追踪结果（Step 5 收敛复核）

独立 subagent 重跑 5 视角，发现 8 个新 gap（全部源自 Round 1 后新增 FR 的实现细节层）：

| Gap | Type | 处理 |
|-----|------|------|
| G-028 | D | 合并窗口延迟语义：首个立即发送 + 窗口合并后续（FR-O1.5 决策） |
| G-029 | F | 定时器 unref + dispose 清理（FR-O1.5） |
| G-030 | F | abort 监听器 { once: true } + removeEventListener（FR-O5.5） |
| G-031 | F | 临时文件 chain 完成后清理（FR-O3.6） |
| G-032 | F | ChainOutputMap 编排完成后清理（FR-O3.7 新增） |
| G-033 | K | steerBackground 触发入口 P2 定义（FR-O5.7） |
| G-034 | F | 前置校验表补全 graceTurns/schema/appendSystemPrompt/output/outputMode（FR-O3.1a） |
| G-035 | F | 落盘失败回退内联截断 + warning（FR-O3.6） |

## Round 3 追踪结果（FR-O6 编排 TUI 审查）

FR-O6 是 Round 2 后新增章节，本轮独立追踪发现 **12 个 gap（4 个结构性）**，核心问题：FR-O6 声称"移植 WorkflowGraphNode + 照搬 WorkflowsView"但**数据模型对不上**——节点缺渲染必需字段，union 类型需跨 spec 修改，onUpdate 路由未实现。

### 结构性问题（4 个，已在 spec 修正）

| Gap | 问题 | 修正 |
|-----|------|------|
| G-037 | kind 丢失 dynamic-parallel-group | FR-O6.2 补全 4 种 kind |
| G-039/040 | 节点缺 model/usage/timestamps/result | FR-O6.2 补全 5 个渲染字段 + FR-O6.6 字段映射表 |
| G-038 | AnyToolDetails union 需 SubagentToolDetails 加 kind | FR-O6.2 列出 4 处跨 spec 改动点 |
| G-042/043 | onUpdate 路由未实现 | FR-O6.5 sync 用闭包捕获 node；async 新增 runOrchestrationDetached |

### 细节 gap（8 个，已修正）

G-036 recentEvents 数据源 / G-041 skipped 聚合规则 / G-044 BgRecord type 字段 / G-045 独立 TState / G-046 按模式截断 / G-047 block 内滚动（开放）/ G-048 删除合并 params / G-049 折叠状态存储。

### 收敛判定

Round 3 的 gap 全部在 spec 中修正（11 个 F/D 类直接改，1 个 K 类 G-047 标注为开放——P1 实现前验证 Pi SDK）。FR-O6 的数据模型已重写完整（OrchestrationGraphNode 补全 10 个字段），onUpdate 路由机制明确（sync 闭包 + async runOrchestrationDetached）。预计 Round 4 收敛。

## 用户补充需求（Step 4 后）

**参数前置校验（FR-O3.1a）**：用户强调无论编排还是单个模式，都要在工具入口提前校验所有参数（agent.md 存在性、model 可用性、thinkingLevel 合法性等），防止执行到一半才暴露参数错误。这是 API Contract 视角的强制检查项，追踪 subagent 漏报（已在 spec 补充为新 FR-O3.1a，并更新 tracing-round-1 备注）。

## 待追踪视角预判（Step 3 会深入）

- **State Machine**: background 从 running→done/failed/cancelled 的状态转换 + 去重，cancel 与 abort catch 的竞态
- **Failure Path**: 整链 async 时中间步骤失败的语义（failFast vs continue），notification 发送失败的重试
- **API Contract**: `sendMessage` 在主 agent 正在执行时的行为（Q-A），编排工具的 params 路由逻辑
