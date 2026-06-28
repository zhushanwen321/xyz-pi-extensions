# Tracing Round 5（收敛复核）

## 追踪范围

- **spec/clarification/domain-models 版本**：含 Round 1-4 全部决策（D-1 ~ D-11、G2-001/002、G3-001、G4-001）
- **追踪的视角**（完整重跑，非增量）：
  - P1 User Journey — 适用（AI/用户/外部扩展三类 actor）
  - P2 Data Lifecycle — 降级（架构重构，非 CRUD；WorkflowRun/WorkflowScript 有生命周期但本需求不变更数据模型，按 spec Out of Scope 仅追踪实体创建/删除边界）
  - P3 API Contract — 适用（tool/action + pi.__workflowRun 是接口契约）
  - P4 State Machine — 强适用（状态机简化是核心需求 FR-3）
  - P5 Failure Path — 适用（worker retry / budget / agent retry / 持久化失败）

## 结论

**未收敛 — 发现 1 个新 gap（G5-001）。**

Round 1-4 处理的 28+2+1+1 = 32 个 gap 均已在 domain-models.md 各节落地（隐式契约保留清单、失败处理矩阵、层归属表、RunRuntime pause/resume 语义）。本轮完整重跑 5 视角后，仅发现 1 个 Round 1-4 未覆盖的语义矛盾。

## Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G5-001 | D | State Machine (+ Failure Path + User Journey) | P4 不变式与操作冲突 | **WorkflowRun.assignRuntime(rt) 在 runtime 已存在时的行为未定义**，导致 retryNode / worker-error-retry 无法与不变式 `status==="running" ⟺ runtime!==undefined` 协调。详见下文。 |

## G5-001 详细分析

### 触发现象

现状代码（已验证）有三条"保持 status=running 同时重建 worker/controller"的路径：

1. **retryNode**（`lifecycle.ts:271-315`）：`terminateWorker(runId)` → `recreateRunAbortController(runId)` → `startWorker(...)`，全程不调 `transitionStatus`，status 保持 running。spec FR-5 明确把 `retry-node` 列为 workflow tool 的 action（保留）。
2. **worker-error-retry**（`error-handlers.ts:160-170`，handleScriptError）：`terminateWorker` → setTimeout 后 `recreateRunAbortController` + `startWorker`，status 保持 running。domain-models 失败处理矩阵明确保留（3 次指数退避）。
3. **resume**（`lifecycle.ts:200-226`）：status 从 paused→running，走 `recreateRunAbortController` + `startWorker` 再 `transitionStatus("running")`。

### 与新模型的冲突

domain-models.md 把这三步重建抽象为 RunRuntime 重建，但 WorkflowRun（第 1 节）只暴露：

```ts
assignRuntime(rt)   — run/resume 时绑定
releaseRuntime()    — pause/done 时解绑（runtime 置 undefined）
```

且 WorkflowRun 不变式（第 1 节）：`state.status === "running" ⟺ runtime !== undefined`。

失败处理矩阵（G3-001 补丁）说"worker error retry 时，assignRuntime 重建新的 RunRuntime"——但：

- **assignRuntime 的语义描述是"run/resume 时绑定"**（使用场景），隐含前置条件 `runtime === undefined`。worker error retry 时 runtime 仍在（旧 worker 已死，但 RunRuntime 对象还在持有 gate/controller 引用），不满足前置条件。
- **若先 releaseRuntime 再 assignRuntime**：中间瞬间 `status==="running" && runtime===undefined`，违反不变式。
- **若直接 assignRuntime 覆盖**：旧 worker 不会被 terminate（资源泄漏），且 assignRuntime 是否支持覆盖未定义。
- **retryNode 更未被失败处理矩阵覆盖**：矩阵只提"pause→resume 或 worker error retry"，retryNode 是用户/AI 手动触发的单节点重试，语义既非 pause/resume 也非 worker-error-retry。

### 为什么 Round 3（G3-001）没覆盖

G3-001 处理的是 pause/resume 路径（status 变化：running→paused→running），runtime 自然经 releaseRuntime→assignRuntime 重建，不变式保持。retryNode 和 worker-error-retry 是"status 不变的原地重建"，G3-001 的 release+assign 模式不适用（会违反不变式）。

### 待决策的选项（D 类）

主 agent 需选一个并写入 domain-models：

- **(A) 扩展 assignRuntime 语义**：允许 runtime 已存在时调用，内部先 release 旧 runtime（terminate worker + abort controller）再赋值新 runtime。原子操作，不变式保持。需改第 1 节 assignRuntime 描述。
- **(B) 引入 replaceRuntime(rt)**：新方法显式表达"原子替换"，assignRuntime 保持"仅从 undefined 赋值"语义。职责清晰但 API 表面变大。
- **(C) retryNode 走 running→paused→running 路径**：复用 release/assign，不变式保持。代价：TUI/AI 会观察到 status 闪烁（paused 中间态），retryNode 语义偏离"原地重试"。
- **(D) 放宽不变式**：允许 retryNode/worker-error-retry 期间瞬间 `runtime===undefined during running`。代价：不变式从强等价降为弱蕴含，下游代码（如读 runtime.worker）需加 null 检查。

## 降级视角记录

| 视角 | 降级理由 | 依据 |
|------|---------|------|
| Data Lifecycle（部分） | 本需求是架构重构（spec："不是功能扩展，是架构重建"）。WorkflowRun/WorkflowScript 的生命周期已在 domain-models 建模，实体创建/读取/更新/删除的语义未变更。仅追踪了"run 删除策略"（restart 废弃后 deleteRun 是否成死代码——属实现清理，非 spec gap）和"持久化 entries GC"（pointer entries 无限积累是现状问题，spec Out of Scope 明确不含新功能）。 | spec Background + Out of Scope；domain-models.md 模型关系图 |

## 已追踪视角小结

- **P1 User Journey**：AI run/pause/resume/abort/retry-node/skip-node、外部 pi.__workflowRun、用户 /workflows、workflow-script generate/lint/save/delete/list 全覆盖。reentry-guard、RPC 降级、confirmation 流程、completion notification 均在隐式契约保留清单登记。retryNode 的"重建失败回滚"关联 G5-001。
- **P3 API Contract**：2 tool + 1 command + pi.__workflowRun 签名（D-8）覆盖。timeoutMs 超时 → reason="aborted"（spec AC-4 reason 枚举无 "timeout"，通过 error message 区分）属 D-8 隐含决策，非新 gap。retry-node/skip-node 的 callId 参数扩展属实现细节。
- **P4 State Machine**：3 态 + doneReason 合法转换全覆盖，无僵尸状态（state_lost 已按 D-4 移出状态机）。**唯一矛盾点：G5-001**。
- **P5 Failure Path**：失败处理矩阵（Worker/Script/Agent/Stale/Budget/Time）全覆盖。retryNode/worker-error-retry 的 runtime 替换失败回滚关联 G5-001。persistState 失败冒泡（terminateInstance 的 await）保留现状语义。
