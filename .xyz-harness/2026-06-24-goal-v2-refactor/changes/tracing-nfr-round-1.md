---
verdict: needs_revision
tracer: independent subagent (context-isolated)
upstream: non-functional-design.md ← issues.md ← system-architecture.md
method: 2 视角追踪（副作用覆盖性 + 缓解可行性），gap 分类 F/K/D
code_evidence: grep 验证 extensions/goal + extensions/coding-workflow + extensions/plan
---

# NFR 追踪报告 — Round 1

## 追踪范围与方法

对 NFR 初稿的 12 个 issue 决策，按 7 维度（安全/数据/性能/并发/稳定性/兼容性/可观测）审计：
1. **副作用覆盖性** — 每个 N/A 是否有理由？有没有漏掉的真实副作用？
2. **缓解可行性** — ⚠️ 的缓解方案能否落地？残余风险是否可接受？有没有需回 Step 3 的 ❌？

所有 gap 用代码 grep 取证，不依赖文档自述。

## 结论速览

- **无 ❌（不可接受）项**。所有残余风险当前标注为可接受。
- **但 #5 的可接受性是条件性的**——依赖两个未验证假设（F1/F2）。若 persistState 触发链未正确接线，#6「budget 兜底保证最终终态」连锁失效，#5/#6 需回 Step 3 重选。
- **最严重漏项是 M2**：`__goalInit` 的 tasks 参数废弃影响 plan **和 coding-workflow**。代码取证显示 coding-workflow Phase 2/3 传真实 taskList，是受影响最大的调用方，NFR #9 完全漏掉。这会在进入 code-architecture 前埋下破坏 coding-workflow goal 初始化的雷。
- 共 **10 个 gap**：2 个 F（关键）、1 个 K、4 个 D、3 个 Missing。

---

## 视角一：副作用覆盖性审计

### 维度 N/A 判定的整体评估

NFR 开篇「运行时上下文」给出的全局 N/A 理由（进程内/单线程/无网络/无多用户/跨扩展同进程调用）方向正确，但有三处过度宽泛：

| 全局 N/A | 评估 | 问题 |
|---|---|---|
| 安全全 N/A | ✅ 成立 | tool/command 参数经 Pi schema 校验，单用户本地工具，evidence/reason 来自可信 agent，无外部注入面 |
| 并发「单线程无真并发」 | ⚠️ 仅单 session 成立 | 见 K1：跨 session 闭包共享未分析 |
| 性能多数 N/A | ✅ 成立 | goal 低频（每 turn ≤1 次 budget check），无 QPS 压力 |

### 逐 issue × 7 维度覆盖核对

| Issue | 覆盖完整度 | 备注 |
|---|---|---|
| #1 删 goal_manager+task | ⚠️ 漏项 | 漏 /goal abort 删除的兼容性（M4）；可观测— 略过 task 可观测性丢失（D4） |
| #2 paused+TRANSITIONS | ⚠️ 矩阵矛盾 | 矩阵标 ⚠️ 但正文自述无风险（D1） |
| #3 goal_control | ✅ 基本完整 | complete evidence 收紧已记 |
| #4 拆 event-adapter | ⚠️ 缺回归分析 | 只分析并发，未分析 737 行拆分的回归风险（行为等价只在 issue checklist，未进 NFR） |
| #5 budget 单一检查点 | ❌ 关键假设未验证 | F1+F2，见下 |
| #6 删 maxTurns/stall | ✅ 完整 | 残余风险记录充分，但依赖 #5（见连锁） |
| #7 todo API+ProgressInput | ⚠️ 矩阵错位+漏项 | D2 矩阵复制 #5；M1 漏 todo 包修改 |
| #8 agent_end 重构 | ✅ 完整 | — |
| #9 plan↔goal 联动 | ❌ 漏主力调用方 | M2+M3，见下 |
| #10 completion audit prompt | ⚠️ 交叉场景缺失 | D3，prompt 假设 todo 存在 |
| #11 /goal set 拒绝 | ✅ 完整 | — |
| #12 widget 显示 | ✅ 全 N/A 合理 | 纯渲染 |

---

## 视角二：缓解可行性评估

逐个 ⚠️ 核对缓解方案能否落地。结论：**全部可落地，但 #5 的落地路径未在代码层面验证**。

| Issue/维度 | 缓解方案 | 可行性 | 取证 |
|---|---|---|---|
| #1 数据 | deserializeState 忽略旧字段 | ✅ | 标准迁移，service.ts 已有 deserialize |
| #2 兼容性 | 枚举所有合法转换 | ✅ | architecture §5 已给完整表 |
| #3 兼容性 | evidence 必填收紧 | ✅ | 有意行为变更 |
| #4 并发 | handler 末尾调 persistState | ⚠️ **非现状** | 见 F2：event-adapter 现用 persistAndUpdate + 直接 appendEntry，不走 service.persistState |
| #5 并发 | 单一检查点消除 race | ⚠️ **依赖 F1/F2** | persistState 触发链未定义 |
| #5 可观测 | persistState 内 notify | ✅ | UiPort 已有 |
| #6 稳定性 | budget 兜底+followUp+手动 clear | ⚠️ **连锁** | 兜底依赖 #5 persistState 可靠触发 |
| #7 稳定性 | __todoGetList undefined 降级 | ✅ | 降级路径完整 |
| #8 可观测 | notify+updateWidget | ✅ | — |
| #9 兼容性 | __goalInit 忽略 tasks | ⚠️ **漏调用方** | 见 M2：coding-workflow 未计入 |
| #10 性能 | prompt 分层注入 | ✅ | 字符串拼接，无技术风险 |
| #11 兼容性 | 错误提示先 resume/clear | ✅ | — |

**无可接受性 ❌ 项。** 唯一的升级路径：若 F1/F2 验证失败 → #5 单一检查点无法保证 → #6 budget 兜底失效 → 需回 Step 3 考虑 #5 方案 B（双检查点）或显式接线 persistState 到每个事件。

---

## Gap 目录（F/K/D + Missing）

### F — 事实性缺口（假设被当事实陈述，未验证或与代码不符）

#### F1 [#5] 事件时序「已确认」与正文「需确认」自相矛盾，且 persistState 非 Pi 事件

**位置**: NFR #5 并发控制 + Prototype 验证记录

**问题**:
- 正文 #5：「事件时序由 Pi 保证（agent_end 在 message_end 之后？**需确认** Pi 事件顺序）」
- Prototype 章节：「不确定性最高的 budget 单一检查点时序**已通过分析确认** Pi 事件顺序保证一致」

两处直接矛盾。更严重的是：序列写作「message_end → agent_end → **persistState**」，但 persistState 是 goal extension 自己的函数，**不是 Pi 事件**。代码取证（`extensions/goal/src/index.ts:249-269`）：Pi 实际只注册 6 个事件（before_agent_start / agent_start / turn_end / message_end / agent_end / session_start），无 persistState 事件。把扩展函数混进 Pi 事件序列是维度错误——Pi 不保证一个扩展函数的触发时序。

**影响**: budget 预警准确性（agent_end 读 tokensUsed 是否含本 turn 累加值）依赖此顺序，未验证。
**需补**: 从 SDK types 确认 message_end / agent_end / turn_end 的真实触发顺序；明确 persistState 由哪个事件 handler 触发。

#### F2 [#4/#5] 「persistState 单一检查点」与现状代码不符

**位置**: NFR #4 缓解（「每个 handler 结束时调用 persistState()」）+ #5 数据（「persistState 是唯一终态落盘点，必须保证被调用」）

**问题**: 代码取证显示 event-adapter 当前**不走 service.persistState**：
- `event-adapter.ts:193` 注释自述：「与 service.persistState 的差异：adapter 层 event handler 需要在 persist 后再 updateWidget」——存在独立的 `persistAndUpdate` 路径
- `event-adapter.ts:207`、`712` 直接调 `pi.appendEntry("goal-state", ...)`，绕过 service 层
- service.persistState 的实际调用方只有 command-adapter（用户命令）和 service 内部，**事件路径不经过它**

NFR 把 budget 终态检查放进 persistState，但事件路径（message_end 累加 token）若不改走 persistState，则 budget 兜底检查永远不触发。#4 的「每个 handler 末尾调 persistState」是**设想，非现状**，且未列为要做的改造工作。

**影响**: 这是整个单一检查点设计的可行性根基。若 persistState 触发链未显式接线，#5 方案 A 不成立。
**需补**: 在 NFR 或 code-architecture 显式定义「message_end 累加后必须调用 persistState（或 persistState 的检查逻辑必须挂在 message_end/turn_end 路径上）」，并列为 #4 的改造项而非既成事实。

---

### K — 知识性缺口（已知平台约束未被纳入）

#### K1 [全局] 多 session 隔离未分析

**位置**: NFR #2/#4/#5 所有并发判定

**问题**: NFR 反复用「JS 单线程，pi.on handler 串行执行，无真并发」dismiss 并发风险。这在**单 session 内**成立。但 CLAUDE.md（项目硬约束）明确：「同一进程可能有多个 session。模块级 `let` 变量会被所有 session 共享，必须用闭包或 session_start 重建」。

多 session 下，不同 session 的 handler 在事件循环上**可交错**，若 GoalRuntimeState 是模块级闭包而非 per-session，则状态会串。NFR 全程未提 GoalSession 的隔离边界，#4「共享同一个 GoalRuntimeState 闭包变量」的论述在多 session 下不严谨。

**影响**: 当前 goal 是否支持多 session 未知。若支持，并发 dismiss 不完整；若不支持，应显式声明假设。
**需补**: NFR 应声明「假设单 session」或分析 GoalSession 闭包的 per-session 重建机制。

---

### D — 文档性缺口（矩阵/正文不一致）

#### D1 [#2] 矩阵与正文矛盾

矩阵标 #2 数据⚠️、并发⚠️，但正文 #2 写「迁移方案：无需迁移」「竞态场景：无竞态风险」。矩阵的 ⚠️ 没有对应的风险描述。要么矩阵虚高，要么正文漏写。需对齐。

#### D2 [#7] 矩阵疑似从 #5 复制，与正文不符

矩阵 #7 行 `—|⚠️|—|⚠️|—|—|⚠️`（数据/并发/可观测⚠️）与 #5 完全一致，但正文 #7 实际分析的是**性能影响**（low freq）和**稳定性影响**（todo 缺失降级），**无并发章节**。矩阵列错位，未反映真实风险面。需重排：性能✅、稳定性⚠️ 才是 #7 的真实维度。

#### D3 [#10] prompt 假设 todo 存在，与 #7 降级交叉场景未定义

#10 completion audit prompt 强制要求 agent「先建 todo（含 isVerification 验证任务）」。但 #7 明确允许 todo extension 未安装（__todoGetList undefined → 降级）。当 todo 缺失时：
- prompt 仍指示 agent 用 todo，但 todo tool 不存在 → agent 困惑
- goal_control.complete 无法验证（#7 已说）→ complete 被拒

NFR 未定义「todo 缺失时 completion audit prompt 的降级形态」。这是 #7×#10 的交叉副作用。

#### D4 [#1] 可观测— 略过 goal 自有 task 可观测性丢失

删 GoalRuntimeState.tasks 后，goal 不再独立持有/观测任务进度。todo 替代，但 #1 可观测标 — 未提此替换。严格说不是 N/A，而是「可观测性来源迁移到 todo」。影响低（#7/#12 概念上覆盖），但 #1 应注明。

---

### Missing — 漏掉的真实副作用

#### M1 [#7] todo extension 新增 `pi.__todoGetList` 导出，副作用未分析

代码取证：`grep -rn "__todoGetList" extensions/` **零命中**——当前 todo extension 不暴露此 API。#7 要求 todo 包新增导出，这是对 `extensions/todo/` 的**代码修改**（新公共 API 面、测试、版本 bump）。NFR 只分析 goal 的消费侧，未分析 todo 的生产侧改动及其发布/兼容影响。

#### M2 [#9] `__goalInit` tasks 废弃漏掉主力调用方 coding-workflow【最严重】

代码取证（`extensions/goal/src/index.ts:310` + 调用方）：
- `__goalInit` 现有 **2 个调用方**：plan（`extensions/plan/src/compact.ts:90`）和 **coding-workflow**（`extensions/coding-workflow/lib/tool-handlers.ts:505, 529`）
- NFR #9 只提 plan，**完全漏掉 coding-workflow**
- coding-workflow 是受影响**最大**的调用方：
  - Phase 2 传 5 项硬编码 taskList（tool-handlers.ts:510-518）
  - Phase 3 传 `buildDevGoalTasks(planPath)` 动态 taskList（:530）
  - tasks 废弃后，coding-workflow 的 goal 初始化不再创建任何任务跟踪 → Phase 2/3 工作流失去任务驱动
- **静默 drift 风险**：goal index.ts:337 注释要求消费者 `import type { GoalInitFn }`，但 coding-workflow 用 **inline alias**（`type GoalInitFn = (objective, tasks, ...) => ...`，:507）。签名变更（tasks 移除）**编译期不报错**，coding-workflow 继续传 tasks 被 goal 静默忽略，行为漂移无告警。

**影响**: 这是跨 3 个 extension 的契约变更，NFR 把它当 goal↔plan 双边问题处理，实际是 goal↔{plan, coding-workflow} 三边。必须在进入 code-architecture 前补 coding-workflow 的迁移方案。

#### M3 [#9 连带] `GoalInitBudget` 含 maxTurns，#6 删 maxTurns 后类型未同步清理

代码取证（`extensions/goal/src/index.ts:333`）：`GoalInitBudget { tokenBudget?; timeBudgetMinutes?; maxTurns? }` 暴露 maxTurns。#6 删 BudgetConfig.maxTurns 后，此对外类型仍保留 maxTurns 字段；coding-workflow 的 inline alias（:507）也仍引用 maxTurns。NFR 未提 GoalInitBudget 的清理，留下死字段 + 类型 drift。

#### M4 [#1] 删除 `/goal abort` 的兼容性影响未记录

代码取证：`commands.ts:9`（action 联合类型含 "abort"）、`:28-29`（解析）、`command-adapter.ts:57`（case "abort"）——/goal abort 是现存用户命令。#1 验收标准提到删 handleAbort，但 NFR #1 兼容性章节**只列 goal_manager tool 删除**，未列 /goal abort 命令删除对用户/脚本/历史 context prompt 的兼容影响。

---

## 连锁风险图

```
F2 (persistState 触发链未定义)
 └─► #5 单一检查点不成立
      └─► #6「budget 兜底保证最终终态」失效
           └─► #6 残余风险（goal 永不终态）从「可接受」升级为「不可接受」
                └─► 需回 Step 3：#5 重选方案 B 或显式接线

M2 (coding-workflow 漏算)
 └─► __goalInit tasks 废弃破坏 coding-workflow Phase 2/3
      └─► 静默 drift（inline alias 编译期不报错）
           └─► 需在 code-architecture 前补三方契约迁移方案
```

---

## 给下游（code-architecture / 回 Step 3）的建议

**进入 code-architecture 前必须先闭合的（否则设计建立在错误假设上）**:
1. **F1/F2**：用 SDK types 取证 Pi 事件真实顺序；在 NFR 显式定义 persistState 的触发事件 + 把「事件路径改走 persistState」列为 #4 改造项。若取证后发现 persistState 无法挂到 token 累加之后 → #5 回 Step 3。
2. **M2/M3**：补 coding-workflow 对 __goalInit tasks 废弃的迁移方案（Phase 2/3 改为 plan complete 后 prompt 驱动 agent 建 todo）；同步清理 GoalInitBudget.maxTurns + 推动 coding-workflow 改 import 类型替代 inline alias。

**可在 code-architecture 顺带修正的（不阻塞）**:
3. K1：声明单 session 假设或分析 GoalSession 闭包边界。
4. D1/D2：重排 #2、#7 矩阵使其与正文一致。
5. D3：定义 todo 缺失时 completion audit prompt 的降级形态。
6. D4/M1/M4：补 #1（abort 兼容性、task 可观测性迁移）、#7（todo 包改动）的副作用记录。

**无需回 Step 3 的判定**：除 F1/F2 外，其余 gap 均为补充分析或文档修正，不改变已选方案。F1/F2 若取证通过则维持方案 A。
