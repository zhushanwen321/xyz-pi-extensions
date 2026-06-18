# Subagents 执行流程

> sync / background / poll 三条路径的统一执行流，以及 background detached 的时序与竞态处理。
> 状态对象定义见 [data-model.md](./data-model.md)，分层见 [architecture.md](./architecture.md)。

---

## 1. 三路径的物理语义

| 路径 | 调用方行为 | 结果交付 | 典型触发 |
|---|---|---|---|
| **sync** | `await`，阻塞调用方 turn | execute 返回时同步拿 record | `subagent({task})` 默认 |
| **background** | 不 await，立即拿 backgroundId | 完成后回注主对话（notifier） | `subagent({task, wait:false})` 或 agent 配 `defaultBackground` |
| **poll** | 查询既有 background | 返回当前 record 快照 | `subagent({backgroundId})` |

三条路径的差异**只有交付方式**，执行本体完全相同。poll 不创建新 record，只读既有 record 的 snapshot。

## 2. 统一执行流

`executor.execute(opts, hub, modelHub, ctx)` 是 sync/bg 共用的唯一入口。分七步，mode 分叉集中在第 3 步。executor 经 SubagentHub 的行为方法（acquireSlot/finalizeRecord/notifyComplete 等）操作组件，不越级访问 pool/store/notifier/history。

```mermaid
flowchart TD
    S0[0. 确认<br/>modelHub.ensureConfirmed<br/>经 onConfirmCategory 回调]
    S1[1. IDENTITY 解析<br/>modelHub.resolveModel<br/>5级 fallback]
    S2[2. RECORD 创建+注册<br/>createRecord + hub.registerRecord]
    S3{3. MODE 分叉<br/>仅 4 处差异}
    S4[4. 执行 SessionRunner.run<br/>hub.acquireSlot → run → hub.releaseSlot]
    S5[5. FINALIZE<br/>status 判定 + tryTransition CAS<br/>hub.finalizeRecord]
    S6{6. background 回注?}
    S7[7. 返回 handle]

    S0 --> S1 --> S2 --> S3
    S3 -->|sync| S4a[signal = opts.signal<br/>priority = 0<br/>await]
    S3 -->|background| S4b[signal = ctrl.signal<br/>priority = 1000<br/>detached]
    S4a --> S4
    S4b --> S4
    S4 --> S5 --> S6
    S6 -->|sync| S7a[返回 sync handle<br/>含 record]
    S6 -->|background| S7b[立即返回<br/>backgroundId]
```

### 4 处 mode 差异（仅此 4 处，其余完全共用）

| # | sync | background | 根因 |
|---|---|---|---|
| ① 返回 | await，返回 `{mode:"sync", record}` | 不 await，立即返回 `{mode:"background", backgroundId}` | 调用语义定义 |
| ② priority | 0（高，抢占） | 1000（低，让步） | sync 需快速响应 |
| ③ signal | `opts.signal`（Pi tool 框架传入） | `controller.signal`（runtime 自建） | background 需 runtime 持有 controller 供 cancel |
| ④ notifier | 无（调用方还在 await） | `notifier.notify`（调用方已 return，靠事件回流） | 结果交付方式不同 |

`SessionRunner.run` **完全不感知 mode**——它只负责跑一次 session + 更新 record。这是重构的核心收敛点：旧实现的 `runAgent`（sync）与 `startBackground`（bg）两份近似逻辑，统一为一份。

## 3. SessionRunner.run（mode 无关）

SessionRunner 是 sync/bg 共用的执行核心。流程细化见 [session-runner.md](./session-runner.md)，此处只列职责边界：

```
SessionRunner.run(record, task, opts, ctx)
  ├─ pool.acquire(priority)          ← 外层（executor）已传入 priority
  ├─ isolation:worktree? → createWorktree
  ├─ createAndConfigureSession(model, tools, skills)
  ├─ EventBridge.subscribe → updateFromEvent(record)   ← record 唯一更新点
  ├─ turnLimiter + signal 监听
  ├─ schema enforcement（漏调 structured-output 则 steer）
  ├─ session.prompt(task)
  ├─ collectResult → AgentResult
  └─ session.dispose()
  finally: pool.release()
```

关键：record 在此函数内被 `updateFromEvent` 实时更新，但**不被 `completeRecord`**——完成态由 executor 统一写，保证 status 判定逻辑单点。

## 4. background detached 时序

background 的步骤 4-6 不在 `execute` 内 await，而是包进 detached promise。`execute` 在注册 record 后立即返回 backgroundId，完成回调异步触发。

```mermaid
sequenceDiagram
    participant Tool as subagent-tool
    participant Exec as executor.execute
    participant Run as SessionRunner.run
    participant Notifier
    participant Main as 主对话

    Tool->>Exec: execute({mode:"background"})
    Exec->>Exec: createRecord + store.register
    Exec-->>Tool: backgroundId（立即返回）
    Note over Tool: 调用方 turn 结束

    par detached promise
        Exec->>Run: run(record, ...)
        Run-->>Exec: AgentResult
        Exec->>Exec: completeRecord + archive + history.append
        Exec->>Notifier: notify(snapshot)
        Notifier->>Main: sendMessage({triggerTurn:true})
        Note over Main: 唤醒父 agent 下一 turn
    end
```

### 与 cancelBackground 的竞态

用户可能在 background 执行中通过 `/subagents list` 按 x 取消。`cancelBackground` 与 detached promise 的 `.then`/`.catch` 存在竞态，**用 status 状态机本身做 CAS 互斥**——`running` 是唯一可转出的状态，且只能转一次（终态不可逆）。先抢到 `tryTransition` 的一方赢收尾权，后来者闭嘴。

```mermaid
sequenceDiagram
    participant Cancel as cancelBackground
    participant Record as ExecutionRecord
    participant Then as detached .then/.catch

    Cancel->>Record: controller.abort()
    Cancel->>Record: tryTransition("cancelled")
    Record-->>Cancel: CAS 成功（status was "running"）
    Cancel->>Record: completeRecord + archive + notify(cancelled)
    Note over Cancel: 不写 history（用户意图）

    Then->>Record: .then/.catch 触发
    Then->>Record: tryTransition(...)
    Record-->>Then: CAS 失败（status 已是 "cancelled"，非 running）
    Note over Then: 什么都不做——status 状态机已锁
```

`tryTransition(record, target)` 是唯一的 CAS 入口：仅当 `record.status === "running"` 时改为 target 并返回 true，否则返回 false。**status 状态机本身就是互斥锁**——不需要额外的 `_settled` 字段。谁先把 status 从 running 转走，谁负责完整收尾（completeRecord + archive + history + notify）；后来的 `tryTransition` 必然失败，自然跳过所有副作用。

**为何不用 `_settled` 字段**：`_settled` 是早期防御性设计，把"收尾互斥"和"业务 status"拆成两个字段，增加理解成本。但两者本质是同一个锁——status 终态本就不可逆（done/failed/cancelled 都是终态），用它当锁更简单自洽：被锁的字段（status）自身不可逆，check-then-set 在 JS 单线程事件循环里天然原子。

### notifier 合并窗口与去重

- **合并窗口**：2000ms 内多个 background 完成，合并为一条通知注入主对话
- **去重 TTL**：同 id 短时间内不重复通知（cancel 已 notify 并抢到 CAS，detached 的 tryTransition 失败不 notify）

## 5. cancelled 路径一致性

旧实现 cancelled 状态在 4 处分别判定，导致 Mode 3（poll）丢 turns/tokens/误显示 failed。新设计收敛为单点：

| 触发点 | 旧实现 | 新设计 |
|---|---|---|
| `execute` finalize | `signal.aborted ? cancelled : failed` | 同（经 `tryTransition` 抢锁） |
| bg `.then` | `controller.signal.aborted ? cancelled : ...` | 删除——交由 execute finalize |
| bg `.catch` | `record.controller?.signal.aborted ?? signal.aborted` | 删除——交由 execute finalize |
| `cancelBackground` | 设 status + notify | `tryTransition("cancelled")` 抢锁 + notify |

`completeRecord` 由抢到 CAS 的一方唯一调用，status 参数已确定。`project()` 读取 record 的 turns/totalTokens（updateFromEvent 累积值，completeRecord 不清零），三路径（sync 返回 / bg poll / list 显示）字段完全一致。

## 6. history 单点写入

旧实现 sync 路径在 `runAgent` 写一条、background 在 `.then`/`.catch` 各写一条，且 cancel 会产生同 id 双写（cancelled + failed）。新设计：

- **唯一写入点**：`hub.finalizeRecord`（抢到 CAS 的一方调用），内部完成 completeRecord + store.archive + history.append 三步。mode 字段区分 sync/background
- **cancel 不写 history**：cancel 是用户意图不计入执行记录（cancel 抢到 CAS 后直接 completeRecord + notify，不走 finalizeRecord）
- **去重**：`history-store.recent()` 仍保留同 id merge 逻辑（endedAt 最新 + cancelled 优先），作为历史数据的防御性处理

## 相关文档

- [architecture.md](./architecture.md) — 双 Hub 在 Runtime 层的位置
- [data-model.md](./data-model.md) — ExecutionRecord 的状态机与 completeRecord
- [session-runner.md](./session-runner.md) — SessionRunner.run 的 EventBridge 契约与 collectResult 细节
