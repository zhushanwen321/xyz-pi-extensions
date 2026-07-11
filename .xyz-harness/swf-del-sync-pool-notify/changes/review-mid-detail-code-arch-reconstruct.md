---
review_type: mid-detail-code-arch-reconstruct
reviewer: independent-reviewer
date: 2026-07-10
verdict: CHANGES_REQUESTED
machine_check: N/A（文件不存在）
---

# 审查报告：§6 测试矩阵独立重建 + diff

## 审查范围

- code-architecture.md §1-5（除 §6 外）
- non-functional-design.md 缓解项回灌登记表（M-1 ~ M-13）
- concurrency-pool.ts 源码（当前状态）
- subagent-service.ts 源码（当前状态）

**禁止读**：code-architecture.md §6 测试策略

## Step 0：Machine Check

machine-check-code-arch.md 不存在。跳过硬阻断，直接进入认知帧审查。

---

## 1. 独立重建测试用例

### 来源 A：§3 时序图 alt/else 路径

#### §3.1 background 完成通知 — alt/else 路径

| # | 路径 | 触发条件 | 测试用例 | 层 |
|---|------|---------|---------|-----|
| A-1 | success → done | `result.success === true` | background 完成 → status="done" → emitPendingUnregister(reason="done", result=..., patchFile=...) | integration |
| A-2 | fail → failed | `result.success === false && !signal.aborted` | background 失败 → status="failed" → emitPendingUnregister(reason="failed", error=...) | integration |
| A-3 | abort → cancelled | `signal.aborted === true` | background 被 abort → status="cancelled" → emitPendingUnregister(reason="cancelled") | integration |
| A-4 | CAS 抢锁失败 | `tryTransition` 返回 false（cancel 已先设 cancelled） | runAndFinalize 正常完成但跳过 finalizeRecord → 不重复 emit | integration |
| A-5 | finalizeRecord B9 兜底 | `completeRecord` 抛错 | B9 兜底：archive/finalized/cleanup/aliveMarker 仍执行 | integration |
| A-6 | finalizeRecord B9 兜底 | `store.archive` 抛错 | B9 兜底：finalized/cleanup/aliveMarker 仍执行 | integration |
| A-7 | run 创建期异常 | `runSpawn` 抛错（catch 路径） | finalizeFailed → CAS 抢锁 → finalizeRecord → 合成 failed result | integration |

#### §3.2 并发池分层配额 — alt/else 路径

| # | 路径 | 触发条件 | 测试用例 | 层 |
|---|------|---------|---------|-----|
| A-8 | 即时放行 | `_active < effective` | depth=1, maxConcurrent=4 → effective=3, active=2 → 放行 | unit |
| A-9 | 入队排队 | `_active >= effective` | depth=1, maxConcurrent=4 → effective=3, active=3 → 入队 | unit |
| A-10 | pool 满 + release 解锁 | 排队中 → 前序 release | acquire 排队 → release → 排队的 acquire 被 resolve | unit |
| A-11 | acquire 失败（cancel 前置） | 已终态 | record 已 cancelled → runAndFinalize 的 acquire 不被调用（detach 已吞） | integration |

### 来源 B：NFR 回灌登记表（M-1 ~ M-13）

| # | NFR 编号 | 缓解措施 | 测试用例 | 层 |
|---|---------|---------|---------|-----|
| B-1 | M-1 | 全量搜索无遗漏 sync 依赖 | sync 删除后 `resolveMode` 不存在 / `SyncResponse` 不存在 | unit |
| B-2 | M-2 | session.jsonl replay 兼容 | tool call payload 含 `wait` 字段时忽略不报错 | integration |
| B-3 | M-3 | agent .md prompts 清理 | prompt 中无 `wait` 参数描述 | static |
| B-4 | M-4 | acquire debug 日志 | acquire 入口记录 depth/effectiveMaxConcurrent/queueLength | unit |
| B-5 | M-5 | 保底 1 槽位 | depth >= maxConcurrent → effective=1 → 不饿死 | unit |
| B-6 | M-6 | 排队超时 warn 日志 | 队列等待 > 5s 时输出 warn | unit |
| B-7 | M-7 | emitPendingUnregister payload 扩展 | payload 含 result/error/patchFile 字段 | integration |
| B-8 | M-9 | 容忍额外字段 | 旧消费方忽略新字段不报错 | integration |
| B-9 | M-10 | WorkflowRun 同步在 finalizeRecord 内 | 状态转换同步更新两侧 | integration |
| B-10 | M-11 | WorkflowRun 同步不走异步回调 | 避免竞态窗口 | integration |
| B-11 | M-12 | dispose() WorkflowRun 终态化 | 进程退出时两侧一致 | integration |
| B-12 | M-13 | finalizeRecord 入口 debug 日志 | recordId/status/hasWorkflowRun | unit |

### 合并去重后：独立重建共 24 个测试用例

---

## 2. §6 diff 分析

### 2.1 §6 实际内容（读取后回溯）

§6 包含 2 个子节：

**§6.1 回归测试**（2 项）：
- 删除 sync 后现有 background 测试全绿
- 删除 notifier.ts 后现有通知测试被移除或改为 EventBus

**§6.2 新增测试**：

来源 A（功能用例，7 项）：

| 测试 | 文件 |
|------|------|
| 分层配额 - 顶层 | concurrency-pool.test.ts |
| 分层配额 - 嵌套 | concurrency-pool.test.ts |
| 分层配额 - 保底 | concurrency-pool.test.ts |
| 分层配额 - FIFO | concurrency-pool.test.ts |
| 通知合并 - pending:unregister | subagent-service.test.ts |
| sync 删除 - wait 参数删除 | subagent-tool.test.ts |
| sync 删除 - mode 固定 | subagent-service.test.ts |

来源 B（NFR 风险→用例映射，9 项）：

| 用例 ID | NFR 来源 | 文件 |
|---------|---------|------|
| T-NFR-1 | M-4 | concurrency-pool.test.ts |
| T-NFR-2 | M-5 | concurrency-pool.test.ts |
| T-NFR-3 | M-6 | concurrency-pool.test.ts |
| T-NFR-4 | M-7 | subagent-service.test.ts |
| T-NFR-5 | M-9 | subagent-service.test.ts |
| T-NFR-6 | M-10 | subagent-service.test.ts |
| T-NFR-7 | M-11 | subagent-service.test.ts |
| T-NFR-8 | M-12 | subagent-service.test.ts |
| T-NFR-9 | M-13 | subagent-service.test.ts |

---

### 2.2 MISSING：独立重建有、§6 无

| # | 独立用例 | 来源 | 严重度 |
|---|---------|------|--------|
| M-1 | **A-1 success → done 路径** | §3.1 alt | **高** — 核心 happy path，§6 的「通知合并 - pending:unregister」仅测 payload 字段，不测 status=done 触发路径 |
| M-2 | **A-2 fail → failed 路径** | §3.1 alt | **高** — 失败分支是三个终态之一 |
| M-3 | **A-3 abort → cancelled 路径** | §3.1 alt | **高** — cancel 是独立终态，§6 未覆盖 runAndFinalize 内 signal.aborted → cancelled 路径 |
| M-4 | **A-4 CAS 抢锁失败（cancel 抢先）** | §3.1 alt | **中** — 并发正确性关键路径，cancel 和 runAndFinalize 竞态 |
| M-5 | **A-5/A-6 B9 兜底** | §3.1 alt | **中** — finalizeRecord 内部异常容错 |
| M-6 | **A-7 run 创建期异常** | §3.1 alt | **中** — finalizeFailed 路径 |
| M-7 | **A-8 即时放行** | §3.2 alt | **低** — 被 §6「分层配额 - 顶层/嵌套」隐含覆盖（未显式写） |
| M-8 | **A-9 入队排队** | §3.2 alt | **低** — 被 §6「分层配额 - 嵌套」隐含覆盖（未显式写） |
| M-9 | **A-10 release 解锁排队** | §3.2 alt | **中** — §6 未测 acquire→release→acquire 时序 |
| M-10 | **B-2 session.jsonl replay 兼容** | M-2 | **中** — 兼容性保证，wait 字段忽略 |
| M-11 | **B-3 agent .md prompts 清理** | M-3 | **低** — 静态检查，非运行时 |
| M-12 | **B-8 容忍额外字段** | M-9 | **低** — additive 兼容性验证 |

**结论**：§6 遗漏了 §3.1 的 3 个核心终态路径（done/failed/cancelled）和 CAS 竞态路径。这些是时序图的显式 alt/else 分支，不应遗漏。

### 2.3 PHANTOM：§6 有、独立重建无

| # | §6 用例 | 问题 |
|---|---------|------|
| — | 无 | §6 的所有用例在独立重建中均有对应（被 B-4~B-12 覆盖） |

**结论**：无 PHANTOM。

### 2.4 MISMATCH：用例描述与源码不一致

| # | §6 用例 | 不一致描述 | 严重度 |
|---|---------|-----------|--------|
| X-1 | **分层配额 - FIFO** | §6 声称「删除 priority 后纯 FIFO 出队」。**源码 `release()` 仍按 priority 升序 + seq 排序**（L63-67 的 for 循环），`acquire(priority)` 参数名仍为 `priority`（L51）。§2.1 设计指定改为 `acquire(depth)` + 纯 FIFO，但**源码未实现**。此测试如果写成验证 FIFO 行为，会在当前源码上失败 | **高** |
| X-2 | **分层配额 - 顶层/嵌套/保底** | §6 假设 `acquire(depth)` 内部计算 `effective = max(1, maxConcurrent - depth)`。**源码 `acquire(priority)` 完全不看 depth**——它只比较 `_active < maxConcurrent`，无分层逻辑。这 3 个测试如果写成验证分层配额行为，会在当前源码上失败 | **高** |
| X-3 | **T-NFR-4 emitPendingUnregister payload 扩展** | §6 假设 payload 含 `result`/`error`/`patchFile` 字段。**源码 `emitPendingUnregister` 只传 `{id, reason}`**（L75-79）。此测试验证字段存在性会在当前源码上失败 | **高** |
| X-4 | **T-NFR-1 acquire debug 日志** | §6 假设 acquire 入口记录 depth/effectiveMaxConcurrent/queueLength。**源码无任何日志输出**。此测试如果验证日志存在会在当前源码上失败 | **中** |
| X-5 | **T-NFR-3 排队超时 warn 日志** | §6 假设队列等待 > 5s 时输出 warn。**源码无超时检测或 warn 日志**。此测试如果验证 warn 输出会在当前源码上失败 | **中** |
| X-6 | **T-NFR-9 finalizeRecord debug 日志** | §6 假设 finalizeRecord 入口记录 recordId/status/hasWorkflowRun。**源码 finalizeRecord 无任何入口日志**。此测试如果验证日志存在会在当前源码上失败 | **中** |

**结论**：6 处 MISMATCH。核心原因是 §6 测试矩阵描述的是 **T2 目标状态**（设计文档中的改造后行为），而非当前源码状态。这本身不是错误（测试矩阵是为待实现功能准备的），但 §6 **未标注哪些测试是「改造后才可执行」的 forward-looking 用例**，容易误导执行者以为可以立即编写并通过这些测试。

---

## 3. 判定

### verdict: CHANGES_REQUESTED

**理由**：

1. **§6 遗漏 3 个核心终态路径（MISSING × 高严重度）**：§3.1 时序图明确画了 `result.success ? "done" : "failed"` 和 `signal?.aborted ? "cancelled"` 三个 alt 分支，§6 仅覆盖了 `pending:unregister` payload 字段测试，未覆盖 done/failed/cancelled 三个终态的触发路径和 payload 内容验证。这是功能性遗漏。

2. **§6 遗漏 CAS 竞态路径（MISSING × 中严重度）**：cancel 和 runAndFinalize 的 CAS 抢锁是并发正确性的核心机制（A-4），§6 未覆盖。

3. **§6 未区分「当前可执行」与「T2 实现后可执行」的测试（MISMATCH × 6 处）**：分层配额（4 项）、emitPendingUnregister payload（1 项）、日志（3 项）的测试假设 T2 已实现，但 §6 无标注。建议 §6 明确标记每个测试用例的依赖 Wave，或区分「§6.2 来源 A/B」的实现前置条件。

### 建议修改

1. **补充终态路径测试**到 §6.2 来源 A：

```markdown
| 测试 | 覆盖点 | 层 | 文件 |
|------|---------|-----|------|
| bg 完成 - done | result.success=true → status=done → emitPendingUnregister(reason, result, patchFile) | integration | subagent-service.test.ts |
| bg 完成 - failed | result.success=false → status=failed → emitPendingUnregister(reason, error) | integration | subagent-service.test.ts |
| bg 完成 - cancelled | signal.aborted=true → status=cancelled（runAndFinalize 内） | integration | subagent-service.test.ts |
| CAS 抢锁 - cancel 抢先 | cancel 先设 cancelled → runAndFinalize 的 tryTransition 返回 false → 跳过 finalize | integration | subagent-service.test.ts |
```

2. **标注 T2 实现依赖**：在 §6.2 表格中增加「依赖 Wave」列，区分哪些测试需要 Wave #2（concurrency-pool 改造）、Wave #3（emitPendingUnregister 扩展）等先完成。

---

## 4. 审查覆盖度

| 维度 | 覆盖 |
|------|------|
| §3.1 alt/else 路径 | 7/7（A-1 ~ A-7） |
| §3.2 alt/else 路径 | 4/4（A-8 ~ A-11） |
| NFR M-1 ~ M-13 | 12/13（M-8 未独立建用例，其内容与 M-7 重叠） |
| §6 交叉比对 | 完成（MISSING 12 / PHANTOM 0 / MISMATCH 6） |
