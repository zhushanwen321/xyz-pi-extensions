# Clarification — Subagent Background 回注 + 编排模式

## 已确认的决策

| ID | 决策 | 来源 |
|----|------|------|
| D-1 | in-process 架构不变（ADR-022），不引入 spawn | ADR-022 |
| D-2 | 不做跨进程恢复（L3），进程死=任务死 | ADR-024 + 用户确认 |
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
| `runs/background/async-execution.ts spawn` | ❌ 不移植 | spawn 子进程，ADR-022 禁止 |

## 待追踪视角预判（Step 3 会深入）

- **State Machine**: background 从 running→done/failed/cancelled 的状态转换 + 去重，cancel 与 abort catch 的竞态
- **Failure Path**: 整链 async 时中间步骤失败的语义（failFast vs continue），notification 发送失败的重试
- **API Contract**: `sendMessage` 在主 agent 正在执行时的行为（Q-A），编排工具的 params 路由逻辑
