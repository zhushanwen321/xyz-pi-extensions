---
verdict: pass
upstream: issues.md
downstream: code-architecture.md
backfed_from: []
---

# 非功能性设计 — Goal V2 Refactor

## 运行时上下文（影响所有维度判定）

本扩展是 Pi extension，运行约束决定多数维度 N/A：
- **进程内执行**（非独立进程），单线程 JS 事件循环
- **无数据库**（状态通过 `pi.appendEntry` 写入 entry，`reconstructGoalState` 从 entries 恢复）
- **无网络/无多用户**（认证、注入、越权、分布式锁均不适用）
- **跨扩展 API 是同进程函数调用**（`pi.__todoGetList()`，非 IPC）

## 分析矩阵

| Issue | 方案 | 安全 | 数据 | 性能 | 并发 | 稳定性 | 兼容性 | 可观测 |
|-------|------|------|------|------|------|--------|--------|--------|
| #1 | A | — | ⚠️ | ✅ | — | — | ⚠️ | ⚠️ |
| #2 | A | — | ✅ | — | ✅ | — | ⚠️ | — |
| #3 | A | — | — | — | — | — | ⚠️ | — |
| #4 | A | — | — | — | ⚠️ | — | — | — |
| #5 | A | — | ⚠️ | — | ⚠️ | — | — | ⚠️ |
| #6 | A | — | ⚠️ | — | — | ⚠️ | ⚠️ | ⚠️ |
| #7 | A | — | — | ✅ | — | ⚠️ | — | — |
| #8 | A | — | — | — | — | ⚠️ | — | ⚠️ |
| #9 | A | — | — | — | — | ⚠️ | ⚠️ | — |
| #10 | A | — | — | ⚠️ | — | — | — | — |
| #11 | A | — | — | — | — | — | ⚠️ | — |
| #12 | A | — | — | — | — | — | — | — |

图例：✅ 无风险 / ⚠️ 有风险已缓解 / — 不适用（本设计无"不可接受需回退"项，见下方残余风险登记）

**维度 N/A 的统一理由**：
- **安全**：全 N/A。Extension 运行在 Pi 进程内，无认证模型、无用户输入注入面（tool 参数由 Pi schema 校验，command 参数由 Pi 解析），无越权场景（单用户本地工具）
- **性能（部分）**：多数 N/A。goal 是低频操作（每 turn 最多 1 次 budget check），无 QPS/吞吐压力

**多 session 假设**：本扩展假设单 session 使用（`GoalSession` 在 `session_start` 重建闭包状态）。若未来支持多 session，模块级 `let` 变量需重构为 per-session 闭包（见 CLAUDE.md 硬约束）。当前并发分析均在单 session 前提下成立。

## 详细分析

### Issue #1: 删除 goal_manager + task CRUD — 方案 A

#### 数据一致性影响
**事务边界**: 无（单进程 entry 追加）
**并发场景**: 无（单线程）
**迁移方案**: **关键** — `deserializeState` 必须容忍旧 entry 中的 `tasks`、`subTodos`、`verification` 字段。策略：反序列化时遇到这些字段直接忽略（不 throw），旧 goal 的 task 数据静默丢失（可接受，因为 task 模型整体废弃）
**回滚策略**: 无需回滚（向前兼容即可）

#### 兼容性影响
**API 变更**: breaking — goal_manager tool 整体删除 + `/goal abort` 命令删除（commands.ts action 联合类型移除 "abort"）+ goal_control tool 新增（tool name 变更）
**数据兼容**: 旧 entry 含 tasks 字段，见上「迁移方案」
**客户端影响**: 旧 agent session 的 context prompt 若引用 goal_manager 的 action 名（如 create_tasks），新 session 找不到该 tool → 报错。缓解：contextInjectionPrompt 不再注入 goal_manager 相关指令（#10 已覆盖）
**灰度/回滚**: 不支持新旧版本共存（单进程 extension，升级即替换）

#### 可观测性影响
**可观测性来源迁移**: 删除 GoalRuntimeState.tasks 后，goal 不再独立持有/观测任务进度，可观测性来源迁移到 todo extension（#7）和 widget（#12）。这是有意的职责转移，非性能损失。
**缓解**: widget（#12）显示从 todo 读取的进度；goal 自身只观测 budget/token/turn 等运行时指标

---

### Issue #2: paused + VALID_TRANSITIONS — 方案 A

#### 数据一致性影响
**事务边界**: 无
**并发场景**: 无
**迁移方案**: GoalStatus 新增 "paused"。旧 entry 的 status 不会是 paused（旧枚举无此值），无需迁移
**回滚策略**: 无需

#### 并发控制
**竞态场景**: `transitionStatus(from, to)` 是 check-then-act，但 JS 单线程，pi.on handler 不会真并发执行（事件队列串行）。**无竞态风险**
**幂等策略**: transitionStatus 本身幂等（同状态转同状态在 VALID_TRANSITIONS 中允许）
**锁策略**: 无锁（单线程不需要）

#### 兼容性影响
**API 变更**: VALID_TRANSITIONS 比旧宽松守卫更严格。旧代码可能依赖某些「非显式表」允许的转换（如 active→cancelled 直接转，不经 paused）。缓解：VALID_TRANSITIONS 必须枚举所有合法转换，包含 active→cancelled、active→complete、active→blocked、active→budget_limited、active→time_limited、active→paused
**数据兼容**: 无（paused 是新值）

---

### Issue #3: 新建 goal_control adapter — 方案 A

#### 兼容性影响
**API 变则**: 新增 tool name `goal_control`（替代 `goal_manager`）。Agent 需通过新 prompt 学习新 tool（#10 覆盖）
**数据兼容**: complete action 的 evidence 字段必填，旧调用方无 evidence → 报错提示。这是**有意的行为收紧**（completion audit 要求）

---

### Issue #4: event-adapter 按事件拆分 — 方案 A

#### 并发控制
**竞态场景**: **关键** — 6 个 handler 拆分后，共享同一个 `GoalRuntimeState` 闭包变量（per-session 重建）。时序依赖：
- `before_agent_start` 读 status（paused/blocked guard）
- `message_end` 写 tokensUsed + 调事件路径 persist
- `agent_end` 读 tokensUsed（budget warning）
- `turn_end` 写 turnIndex
- 事件路径 persist（`persistAndUpdate`）读 tokensUsed（budget 终态检查）

JS 单线程保证这些 handler 串行执行（同一时刻只有一个 handler 运行），**无真并发**。但需保证 state 修改后立即对下一个 handler 可见（闭包变量天然可见，无需特殊处理）

**缓解**: handler 内不持有过期的 state 引用（每次从闭包读最新值）
**残余风险**: 无（单线程 + 闭包可见性保证）

---

### Issue #5: budget 单一检查点 — 方案 A

#### 数据一致性影响
**事务边界**: budget 终态检查必须在事件路径的 persist 函数内（现状为 `persistAndUpdate`，#4 拆分后为其等价函数）。**不是 `service.persistState`**——代码取证确认事件路径走 `persistAndUpdate`（tickState + appendEntry + updateWidget），不走 service.persistState。`persistState` 是 command/tool 路径用的。
**并发场景**: 见 #4（单线程无真并发）

#### 并发控制
**竞态场景**: **关键** — budget 终态检查在事件路径 persist（`persistAndUpdate`）内执行。事件顺序由 Pi 保证：`message_end`（累加 token）→ `agent_end`（预警）→ `turn_end`。每个修改 state 的 handler 调用 `persistAndUpdate` 落盘时，budget 检查读取的是已累加的最新 tokensUsed。
**缓解**: 单一检查点设计（检查在 persist 函数内）消除双检查点的 race（旧设计 agent_end 和 persist 路径都可能转终态，存在重复 notify 风险）
**残余风险**: 无（检查点在 persist 函数内，只要 handler 修改 state 后调 persist 即触发）

#### 可观测性
**日志**: budget 终态通知（budget_limited/time_limited）必须在事件路径 persist 函数内发出，不能因检查点位置变更而丢失通知
**缓解**: persist 函数内转终态时同步调 `notify`（UiPort）+ `updateWidget`

---

### Issue #6: 删除 maxTurns/stall 自动终态 — 方案 A

#### 数据一致性影响
**迁移方案**: `deserializeState` 忽略旧 entry 的 `stallCount` 字段；`BudgetConfig` 忽略旧 entry 的 `maxTurns`/`maxStallTurns` 字段（同 #1 策略）

#### 稳定性影响
**故障场景**: **关键残余风险** — agent 持续工作但不调 `goal_control.complete`（忘记或判断失误）。删除自动终态后，唯一兜底是 budget 耗尽（budget_limited/time_limited）
**降级方案**: `agent_end` 的 `allTasksDone followUp` 提示（#8）是软提醒，非强制
**重试策略**: N/A
**SLA 影响**: goal 可能「永远不终态」直到 budget 耗尽。这是 D21 决策的有意代价（对齐 Codex）
**残余风险接受**: 接受。理由：(1) budget 兜底保证最终终态（persistAndUpdate 内检查）；(2) followUp 提示覆盖常见遗忘场景；(3) 用户可手动 /goal clear

#### 兼容性影响
旧 entry 含 maxTurns/stallCount，见「迁移方案」

#### 可观测性
`stalenessReminderPrompt`（基于 lastUpdatedTurn）保留，提供停滞感知

---

### Issue #7: todo 跨扩展 API + ProgressInput — 方案 A — 【全解耦后已废弃】

> **全解耦后状态**：本节描述的 todo 跨扩展 API 已整体废弃（根因：pi 框架给每个 extension 独立 api 实例，goal 读 `pi.__todoGetList` 跨 ext 失效）。goal 不再依赖 todo——无降级、无前置硬检查。以下内容保留作为决策历史。

#### 性能影响
**预期负载**: `pi.__todoGetList()` 调用频率 — 每次 `before_agent_start`（context 注入）+ `goal_control.complete`（检查）。低频（每 turn 1 次），**无性能压力**
**关键路径延迟**: 同进程函数调用，<1ms
**残余风险**: 无

#### 稳定性影响
**故障场景**: ~~**关键** — todo extension 未安装或未暴露 `__todoGetList`。代码取证：当前 todo extension **未导出** `__todoGetList`（grep 零命中），#7 要求 todo 包新增此导出（属 todo extension 的代码改动 + 版本 bump）~~ **全解耦后此故障场景消失**：goal 不再读 todo，`__todoGetList` 已删除。
**降级方案**: ~~`if (typeof pi.__todoGetList !== "function") return undefined`，goal 降级运行（AC-4.4）~~ **全解耦后无降级概念**：goal 与 todo 完全独立，todo 缺失不影响 goal 任何能力。
**残余风险**: 无（全解耦后 goal 不依赖 todo）

---

### Issue #8: agent_end 重构 — 方案 A

#### 稳定性影响
**故障场景**: 同 #6 — agent 不听 warning/steering 时无自动终态
**降级方案**: warning + steer 是软提醒

#### 可观测性
**日志**: 70%/90% budget 预警 + 90% steering prompt + allTasksDone followUp 需对用户可见
**缓解**: 通过 `notify`（UiPort）+ `updateWidget` 保证可见

---

### Issue #9: plan↔goal 联动 — 方案 A

#### 稳定性影响
**故障场景**: plan extension 未安装。`pi.__planStart` 为 undefined
**降级方案**: 检测 plan 可用性，不可用时 contextInjectionPrompt 不含 plan 建议段落。goal 独立运行

#### 兼容性影响
**API 变更**: breaking — `pi.__goalInit` 的 tasks 参数废弃。**三方调用方受影响**（代码取证）：
- **coding-workflow**（主力）: Phase 2 传 5 项硬编码 taskList（tool-handlers.ts:510-518），Phase 3 传 `buildDevGoalTasks(planPath)` 动态 taskList（:530）。tasks 废弃后需改为 plan complete 后 prompt 驱动 agent 建 todo
- **plan**: `compact.ts:90` 调用，同样需迁移
- **静默 drift 风险**: coding-workflow 和 plan 均用 **inline alias**（非 import type），签名变更编译期不报错 → 继续传 tasks 被 goal 静默忽略，行为漂移无告警

**缓解**: (1) goal 侧 `__goalInit` 忽略 tasks 参数（向后兼容，不 throw）；(2) 同步更新 coding-workflow/plan 的调用（改为不传 tasks，goal 不再创建 task）；(3) 推动 coding-workflow/plan 改用 `import type { GoalInitFn }` 替代 inline alias（消除 drift）

**连带清理**（#6）: `GoalInitBudget` 接口含 `maxTurns?` 字段（index.ts:333），#6 删 BudgetConfig.maxTurns 后此对外类型需同步移除 maxTurns。coding-workflow inline alias 也引用了 maxTurns，需同步清理。

---

### Issue #10: completion audit prompt — 方案 A

#### 性能影响
**预期负载**: contextInjectionPrompt 每 turn 注入，prompt 体积增加约 200-400 token（对标 Codex continuation.md 三约束）
**关键路径延迟**: 无（prompt 是字符串拼接）
**扩展性瓶颈**: prompt 体积直接影响每 turn 的 token 消耗。长期 goal（100+ turn）累计 token 成本上升
**优化方案**: prompt 分层——core 必需段（completion audit）常驻，可选段（plan 建议，#9）按条件注入；todo 缺失时不注入「先建 todo」指令
**残余风险**: 低。token 成本可接受（对齐 Codex 的 prompt 量级）

#### 交叉副作用（#7×#10）
**风险**: completion audit prompt 强制要求 agent「先建 todo（含 isVerification）」。当 todo extension 未安装时（#7 降级），prompt 仍指示用 todo 但 todo tool 不存在 → agent 困惑
**缓解**: contextInjectionPrompt 动态判断 `pi.__todoGetList` 是否存在，缺失时不注入 todo 相关指令，改为「请在目标完成后调 goal_control.complete」

---

### Issue #11: /goal set 非终态拒绝 — 方案 A

#### 兼容性影响
**API 变更**: breaking — 用户行为变更。之前 `/goal set` 可覆盖非终态 goal，现在被拒绝
**客户端影响**: 用户需先 `/goal clear` 或 `/goal resume`（如果 paused）才能 set 新 goal
**缓解**: 错误提示明确告知「先 resume 或 clear」。这是 D25 决策的有意收紧

---

### Issue #12: widget paused/blocked 显示 — 方案 A

全维度 N/A。纯渲染逻辑，无副作用。

---

## 缓解项回灌登记（Mitigation Rollback）

> 每条缓解方案不能只留在本文档——必须落地为下游可执行项。未回灌的缓解 = 设计期发现风险却不修。
> 「验收方式」列决定风险是否进⑤test-matrix 成为代码测试项。

| 缓解项 | 来源 Issue# | 维度 | 回灌去向 | 落地为 | 验收方式 | 状态 |
|--------|------------|------|---------|--------|---------|------|
| deserializeState 容忍旧字段（tasks/stallCount/maxTurns/maxStallTurns，忽略不 throw） | #1, #6 | 数据 | ⑤骨架 | GoalRuntimeState/BudgetConfig 类型 + deserializeState 实现 | 代码测试（NFR-AC-1，UC-3 崩溃重启路径） | 待落 |
| contextInjectionPrompt 不再注入 goal_manager 指令 | #1, #10 | 兼容性 | ⑤契约 | prompts.ts: contextInjectionPrompt 内容 | 代码测试（NFR-AC-2，UC-1） | 待落 |
| VALID_TRANSITIONS 枚举全合法转换（含 active→{cancelled,complete,blocked,budget_limited,time_limited,paused}） | #2 | 兼容性 | ⑤骨架 | VALID_TRANSITIONS 常量 | 骨架约束（枚举存在性 + tsc） | 待落 |
| goal_control.complete 的 evidence 必填校验 | #3 | 兼容性 | ⑤契约 | goal_control tool schema | 代码测试（NFR-AC-3，UC-4） | 待落 |
| event handler 不持有过期 state 引用（每次从闭包读最新值） | #4 | 并发 | ⑤骨架 | event-adapter.ts 拆分实现 | 骨架约束（闭包读取模式） | 待落 |
| budget 终态检查在 persistAndUpdate（事件路径 persist 函数）内发出 | #5 | 数据/可观测 | ⑤时序图 | budget 检查挂载点时序图 | 代码测试（NFR-AC-4，UC-3 单一检查点） | 待落 |
| persist 函数转终态时同步 notify + updateWidget | #5, #8 | 可观测 | ⑤契约 | persistAndUpdate: notify + updateWidget 调用 | 代码测试（NFR-AC-5，UC-3） | 待落 |
| ~~__todoGetList 缺失降级（context 注入照常 / checkProgress 跳过 progress / complete 前置硬拒绝）~~ | ~~#7, #10~~ | ~~稳定性/兼容性~~ | ~~⑤契约~~ | **全解耦后已移除**：goal 不读 todo，无降级路径 | ~~代码测试（NFR-AC-6，AC-4.4）~~ | ~~待落~~ |
| __planStart 缺失降级（context 不含 plan 段落，goal 独立运行） | #9 | 稳定性 | ⑤契约 | contextInjectionPrompt: typeof pi.__planStart 守卫 | 代码测试（NFR-AC-7，UC-1.3） | 待落 |
| __goalInit 忽略 tasks 参数（向后兼容不 throw） | #9 | 兼容性 | ⑤契约 | __goalInit: tasks 参数忽略 | 代码测试（NFR-AC-8，UC-1） | 待落 |
| 迁移 coding-workflow/plan 调用方（不传 tasks）+ 推动改 import type | #9 | 兼容性 | ③新issue | issues.md 已登记（见下方回灌到③的新 issue） | 代码测试（NFR-AC-9） | 待落 |
| 同步清理 GoalInitBudget.maxTurns（index.ts:333）+ 调用方 inline alias | #6 连带 | 兼容性 | ⑤骨架 | index.ts: GoalInitBudget 类型 | 骨架约束（类型移除 + tsc） | 待落 |
| /goal set 非终态拒绝 + 错误提示「先 resume 或 clear」 | #11 | 兼容性 | ⑤契约 | commands.ts: handleSet 守卫 | 代码测试（NFR-AC-10，UC-6.2） | 待落 |
| stalenessReminderPrompt 保留（基于 lastUpdatedTurn） | #6, #8 | 可观测 | ⑤契约 | agent_end handler: staleness 提示注入 | 骨架约束（提示存在性） | 待落 |
| 70%/90% budget 预警 + 90% steering prompt + allTasksDone followUp 对用户可见 | #8 | 可观测 | ⑤契约 | agent_end handler: notify + widget | 代码测试（NFR-AC-11，UC-3.2） | 待落 |

**回灌到 ③的新 issue（已在 issues.md 出现，双向可查）：**

- **issues.md #9 的"三方调用方迁移"子项**（触发来源：本节 #9 兼容性缓解）— coding-workflow Phase 2（tool-handlers.ts:510-518，5 项硬编码 taskList）+ Phase 3（:530，buildDevGoalTasks）+ plan（compact.ts:90）需改为不传 tasks，改为 plan complete 后 prompt 驱动 agent 建 todo；推动 inline alias → import type。**状态：已登记于 issues.md #9「缓解」**。

> **本扩展无安全类风险（全 N/A，见运行时上下文），故无"输入参数化防注入"等安全缓解项。**

## 残余风险登记

| 风险 | 影响 | 接受理由 | 监控方式 |
|------|------|---------|---------|
| agent 不调 complete 导致 goal 不终态 | goal 持续运行直到 budget 耗尽 | budget 兜底（persistAndUpdate 内检查）+ followUp 提示 + 手动 clear | widget 显示 token/turn 消耗 |
| 旧 entry 字段静默丢失 | 用户旧 goal 的 task 数据不可恢复 | task 模型整体废弃，数据无意义 | 无需监控（一次性迁移） |
| context prompt 体积增加 token 成本 | 长 goal 累计 token 成本上升 | 对齐 Codex prompt 量级，可接受 | widget 显示 token 用量 |
| __goalInit inline alias 静默 drift | coding-workflow/plan 继续传 tasks 被 goal 忽略 | goal 侧容忍（不 throw），同步迁移调用方 | 迁移后 grep 验证无 tasks 传参 |

## Prototype 验证记录

无。本阶段副作用均为确定性问题，无需 prototype 验证。

关于 budget 单一检查点时序：代码取证已确认事件路径走 `persistAndUpdate`（非 service.persistState）。Pi 注册 6 个事件（before_agent_start/agent_start/turn_end/message_end/agent_end/session_start），budget 检查挂在事件路径的 persist 函数内，handler 修改 state 后调 persist 即触发检查，时序正确。

## NFR-AC 清单（代码测试类缓解的验收断言）

> 归属 UC 对齐 requirements.md。这些 NFR-AC 进⑤test-matrix「NFR 风险→用例映射表」，与功能 AC 同等进入验收清单。骨架约束类缓解（VALID_TRANSITIONS 枚举、闭包读取模式、staleness 提示存在性、maxTurns 类型移除）由⑤骨架 tsc gate 验证，不在此列。

| NFR-AC | 归属 UC | 断言摘要 |
|--------|---------|---------|
| NFR-AC-1 | UC-3（崩溃重启，AC-2.3/AC-5.4 对称） | 反序列化含旧 entry（tasks/stallCount/maxTurns/maxStallTurns）时不 throw，静默忽略，state 正常重建 |
| NFR-AC-2 | UC-1 | contextInjectionPrompt 不含 goal_manager 相关指令（grep 零命中 create_tasks 等旧 action 名） |
| NFR-AC-3 | UC-4（AC-4.2） | goal_control.complete 缺 evidence → 拒绝完成并提示「需提交完成证据」 |
| NFR-AC-4 | UC-3（AC-3.1 单一检查点） | budget 耗尽时由 persistAndUpdate 内的检查转入终态，不存在第二个检查点路径漏触发 |
| NFR-AC-5 | UC-3（AC-3.2） | persist 转终态时同步触发 notify（UiPort）+ updateWidget，用户能收到终止原因通知 |
| ~~NFR-AC-6~~ | ~~UC-4（AC-4.4 降级）~~ | **全解耦后已移除**：goal 不读 todo，无"__todoGetList undefined 降级"场景。todo 缺失对 goal 无影响。 |
| NFR-AC-7 | UC-1（AC-1.3 边界） | 全解耦后：goal 恒定建议 plan mode（不再探测 pi.__planStart）；goal 可独立启动/续跑 |
| NFR-AC-8 | UC-1 | __goalInit 收到 tasks 参数时忽略（不 throw，不创建 task），goal 正常初始化 |
| NFR-AC-9 | UC-1 | coding-workflow/plan 迁移后调用 __goalInit 不传 tasks（grep 验证 tool-handlers.ts/compact.ts 无 taskList 传参） |
| NFR-AC-10 | UC-6（AC-6.2） | 存在非终态 goal 时 /goal set 被拒绝，错误提示含「先 resume 或 clear」 |
| NFR-AC-11 | UC-3（AC-3.2 替代流程预警） | token 到 70%/90% 时发出预警通知；90% 注入 steering prompt；allTasksDone 时注入 followUp |
