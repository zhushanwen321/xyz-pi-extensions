# ADR-030 骨架 — subagents-workflow 合并架构（UC-5 / #2）

> 内容骨架（可校验）：标注每节必含字段 + 来源引用。实现时填充 `{占位}`。
> 关联：code-architecture.md §3.B ADR-030 契约 + §6 T5.x 测试。

---

## 实现文件路径

`docs/adr/030-subagents-workflow-merge.md`

## frontmatter

```yaml
---
# ADR 无强制 frontmatter（项目 ADR 约定用正文 Status 节），保持与 ADR-026/029 一致
---
```

## 正文骨架

```markdown
# ADR-030: subagents + workflow 合并为 pi-subagents-workflow（单包 + 统一执行链 + 分层配额 + 删sync通知合并）

## Status

Accepted

> 本 ADR 承接并 supersede ADR-026（两包架构，完全 superseded）与 ADR-029（全流程 workflow 接管，部分 superseded——仅 worktree 编排决策被取代）。
> 见本文 Consequences 段「被取代的 ADR」。

## Context

### 背景：三主题拆分合并

{T1/T2/T3 三 topic 拆分背景：原 pi-subagents + pi-workflow 两包合并为 pi-subagents-workflow。
T1 完成包结构合并 + 执行链统一（SAR 委托 SS，executeAndAwait）+ workflow() 函数；
T2 完成删 sync 模式 + 并发池分层配额 + 通知合并（pending:unregister EventBus）；
T3（本 ADR 所属）完成预制脚本 + 文档/ADR 收尾。}

### 动机

{两包合并动机：(1) 消除两条独立执行链（SAR spawn pi + SS 进程内 createAgentSession）的重复与割裂；
(2) 统一执行模型让 workflow 嵌套（workflow() 调 workflow()）走同一执行链；
(3) 单包交付降低用户安装/版本同步成本。}

### 执行链统一需求

{pi-workflow 的 SubprocessAgentRunner 原独立 spawn pi 子进程；合并后委托 pi-subagents 的 SubagentService.executeAndAwait，
单执行链 + 嵌套护栏（MAX_FORK_DEPTH）+ 分层配额。详见 T1 code-architecture.md §4 UC-3 时序图。}

## Decision

### 决策 1：合并为一包 `@zhushanwen/pi-subagents-workflow`

{两包源码合并为单包，三层架构（Interface/Orchestration/Execution）。
旧两包（pi-subagents/pi-workflow）原样保留，标记 deprecated + 迁移指引（D-004）。
承接 ADR-026 Decision 段放弃的 L3A 立场：L3A 交互式编排能力合并进单包（workflow() 嵌套 + agent() 即席编排共存），
不做独立 L3A 包。}

### 决策 2：统一执行链（SAR 委托 SS）

{SubprocessAgentRunner（原 workflow 侧）改造为委托 SubagentService.executeAndAwait（原 subagents 侧），
消除第二条 spawn 路径。onEvent 签名升级 raw→AgentEvent，删 jsonl-to-agent-event 中间层。
详见 T1 code-architecture.md §3 SAR/SS 签名表 + §5 Deep Module。}

### 决策 3：分层配额 + workflow 嵌套

{ConcurrencyPool 默认 maxConcurrent=6（来源：T2 system-architecture §并发池分层配额）。
嵌套时按 depth 分层：acquire(priority, effectiveMaxConcurrent=max(1, maxConcurrent-depth))，
depth=N 的子层可用配额 = max(1, 6-N)，保底 1 槽防饿死。
workflow() 函数支持 workflow 嵌套编排（顺序/并行/scatter-gather/map-reduce）。
详见 T2 code-architecture.md §2.1 ConcurrencyPool 改造。}

### 决策 4：删 sync 模式 + 通知合并

{删除 subagent tool 的 sync（wait:true）模式，只保留 background。
BgNotifier 删除，通知统一为 pending:unregister EventBus 事件（payload 扩展 result/error/patchFile）。
pending-notifications 扩展消费该事件，替代 BgNotifier 职责。
详见 T2 code-architecture.md §2.3 emitPendingUnregister + §4 删除清单。}

## Consequences

### 正面

- **单包交付**：用户只需安装 @zhushanwen/pi-subagents-workflow，无需版本同步两包
- **执行链单一**：SAR 委托 SS，消除重复 spawn 路径，嵌套调用走同一执行链 + 护栏
- **嵌套能力**：workflow() 支持 workflow 嵌套编排，预制模板（chain/parallel/scatter-gather/map-reduce）降低使用门槛
- **通知统一**：EventBus 单一机制，pending-notifications 集中消费

### 负面

- **旧包迁移成本**：已安装 pi-subagents/pi-workflow 的用户需迁移到新包（deprecated 指引 + CHANGELOG 迁移路径）
- **包体积增大**：两包合并后单包体积 > 原单包（但 < 两包之和，去重后净增有限）

### 被取代的 ADR

| ADR | supersede 范围 | 说明 |
|-----|---------------|------|
| ADR-026 | 完全 superseded | 两包架构 → 单包合并；L3A 能力合并进单包（决策 1 承接） |
| ADR-029 | 部分 superseded | 仅 worktree 编排（决策 2）被取代——worktree 生命周期知识转移到 coding-execute skill（T3 UC-11）；
per-call cwd（决策 1）已实现且仍活跃（types.ts:417/subagent-service.ts:302）；
cw 调用（决策 3）/plan.json schema（决策 4）/砍 pending-env（决策 5）/SQLite WAL（决策 6）与合并正交，逐决策标注仍有效 |
```

## §6 测试校验点（实现后自查）

- [ ] T5.1：grep `## Status`/`## Context`/`## Decision`/`## Consequences` 四节齐全
- [ ] T5.2：Status 行含 `Accepted`
- [ ] T5.3：Decision 含 4 项决策关键词（合并/执行链/配额/sync+通知）
- [ ] T5.4：并发上限 `maxConcurrent=6` + 来源标注（T2 system-architecture §并发池分层配额）
- [ ] T5.5：引用 `ADR-026` + `ADR-029`
- [ ] T5.6：含 `L3A` 承接说明

---

# 附：ADR-026/029 superseded 标记模板（UC-6 / #3，D-033R）

> 实现 #3 时，在 ADR-026/029 顶部改 Status + 加说明段，**正文保留不动**（append-only）。

## ADR-026 标记模板（完全 superseded）

```markdown
# ADR-026: 两包架构——Agent Runtime + Workflow（不做 L3A 交互式编排）

## Status

Superseded by ADR-030

> **Superseded by [ADR-030](./030-subagents-workflow-merge.md)**（2026-07）。
> 本 ADR 的两包架构（pi-subagents + pi-workflow）已被合并为单包 `@zhushanwen/pi-subagents-workflow`。
> Decision 段（不做 L3A）的 L3A 能力由 ADR-030 决策 1 承接——合并进单包（workflow() 嵌套 + agent() 即席编排共存），
> 不做独立 L3A 包的立场保留。以下正文为历史记录，保留不动。
>
> 注：record 生命周期统一（WorkflowRun + ExecutionRecord 双重记账一致性，T1 D-009 划归 T2 落地）在合并后由单包统一管理。

## Context
{...原文保留不动...}
```

## ADR-029 标记模板（部分 superseded，D-033R 精确逐决策标注）

```markdown
# ADR-029: 全流程 Workflow 接管 coding-execute（dev+test）+ per-call cwd + worktree 编排

## Status

Partially superseded by ADR-030

> **Partially superseded by [ADR-030](./030-subagents-workflow-merge.md)**（2026-07）。
> 合并架构（ADR-030）取代了本 ADR 的**部分决策**，其余决策仍有效。逐决策标注：
>
> | 决策 | 状态 | 说明 |
> |------|------|------|
> | 决策 1：per-call cwd 改造（两条链） | ✅ **仍有效** | 已实现且仍活跃（types.ts:417 `ExecuteOptions.cwd`、subagent-service.ts:302 `buildSessionRunnerContext`、pi-runner.ts:89 spawn cwd）。合并后单执行链仍保留 per-call cwd 能力 |
> | 决策 2：worktree 生命周期归 workflow 内建 | ❌ **被取代** | worktree 编排知识转移到 `coding-execute` skill（T3 UC-11，内容来自本决策原文：4 phase + 原生 `git worktree add/remove` + finally cleanup）。workflow 脚本（execute-full-workflow.js）仍内建 worktree，但权威文档转移 |
> | 决策 3：workflow 内 agent 渐进式调 cw | ✅ **仍有效** | 与合并正交，cw 渐进式 API 调用不变 |
> | 决策 4：test 调度字段进 plan.json | ✅ **仍有效** | 与合并正交 |
> | 决策 5：砍除 pending-env 状态 | ✅ **仍有效** | 与合并正交 |
> | 决策 6：store 加 WAL + busy_timeout | ✅ **仍有效** | 与合并正交 |
>
> 以下正文为历史记录，保留不动。

## Context
{...原文保留不动...}
```

## §6 测试校验点（实现后自查）

- [ ] T6.1：ADR-026 Status 含 `Superseded` + `ADR-030`
- [ ] T6.2：ADR-029 Status 含 `Partially superseded` + `ADR-030`
- [ ] T6.3：ADR-029 说明段含「决策 2」+「worktree」+「仍有效」（决策 1/3-6）
- [ ] T6.4：git diff 只含 Status 行 + 说明段新增，正文无删改（append-only）
