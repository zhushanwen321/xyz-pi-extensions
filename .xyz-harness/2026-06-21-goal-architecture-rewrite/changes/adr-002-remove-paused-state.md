# ADR-002: 删除 `paused` 状态与 `/goal pause` 命令

**状态**：Accepted
**日期**：2026-06-22
**决策者**：用户（产品决策）
**关联**：supersedes 部分 FR-6.7 / D-18 的 pause 语义；修正 ADR 隐含的 7 态假设

---

## 背景

`paused` 状态在旧架构（main 分支）有三个触发源：

1. **`/goal pause` 命令**（用户显式暂停，"我暂时去做别的"）
2. **ESC 中断**（`signal.aborted` → `pendingPause` → `paused`，agent_end-handler.ts:258-265）
3. **context 使用率 > 85%**（资源保护，before-agent-start-handler.ts）

重构 spec（FR-6.7 / D-18）已基于 Pi abort 实测时序**确认触发源 #2 是多余的**：

> ESC → `AbortController.abort()` → `runLoop` return → **整个 run 结束，等用户下一条消息**。
> before_agent_start 在用户发新消息前不会触发。
> —— clarification.md:215-216

即：ESC 一按，AI 天然停止、等用户输入，与 goal 是 `active` 还是 `paused` 无关。旧代码的 ESC→paused 是"多此一举 + 反而要求用户 `/goal resume` 才能继续"。spec D-18 已删除 `pendingPause` 字段，把 ESC 改为纯打断（goal 保持 active）。

**但 spec 仍保留了 `paused` 状态本身**（spec:25 "保持 7 态枚举"），仅删除了 ESC 这一个触发源。剩余两个触发源（`/goal pause` 命令 + context>85%）继续使用 `paused`。

## 决策

本 ADR 进一步**删除 `paused` 状态本身**及所有剩余触发源：

| 项 | 决策 | 理由 |
|---|---|---|
| `paused` 状态 | ❌ **删除** | 唯一的运行时价值（ESC 后挂起 goal）已被 Pi runtime 原生 abort 机制取代。剩余用途（用户显式暂停）在实际使用中几乎不用，且新增状态复杂度 |
| `/goal pause` 命令 | ❌ **删除** | `paused` 状态不存在了，命令无目标状态可转 |
| context 使用率 > 85% | ✅ **保持 `active`，只注入 wrap-up 提示** | 不转任何中间态。AI 收到提示后自行收尾（complete_goal/cancel_goal）。资源保护通过"提示"而非"状态机"实现 |
| `blocked` 状态 | ✅ **保留**（不变）| AI 求助机制（report_blocked action）+ stall 超限自动阻塞。与 ESC/pause 无关，是独立能力 |
| `report_blocked` action | ✅ **保留**（不变）| main 既有能力 |
| `/goal resume` 命令 | ✅ **保留，语义收窄** | 原：`paused|blocked → active`。现：**仅 `blocked → active`**。仍负责重启 AI loop（FR-8.12）+ budget 重检（G-014）+ 重置 stallCount |

### 新状态枚举

```
GoalStatus = "active" | "blocked" | "complete" | "budget_limited" | "time_limited" | "cancelled"
```

- **可执行**：`active`
- **可逆中间态**（仅 1 个）：`blocked`
- **终态**（4 个）：`complete` / `cancelled` / `budget_limited` / `time_limited`

### 新命令集

```
/goal <objective> [flags]   set（创建/覆盖）
/goal status                查看状态
/goal resume                仅 blocked → active（恢复 + 重启 AI）
/goal clear                 清除（强制 cancelled）
/goal abort                 中止（检查未完成后 cancelled）
/goal update <new-obj>      更新目标
/goal history               查看历史
```
（删除 `/goal pause`）

## 考虑过的替代方案

1. **保留 paused，仅删命令**（最保守）：`paused` 状态保留但只能由 context>85% 内部触发。否决——context>85% 决策改为保持 active，则 paused 无任何触发源，成了死状态。
2. **context>85% 转 blocked**：把资源阻塞也归入 blocked 语义。否决——blocked 的语义是"AI 卡住需人介入"（report_blocked + lastBlockerReason 注入），context 不满是另一回事，混在一起会让 blocked 的恢复路径（注入 lastBlockerReason 提示）行为错乱。
3. **连 blocked 一起删**（最激进）：状态机只剩 active + 4 终态。否决——丢失 main 既有的 AI 求助机制 + stall 自保，属功能回退。

## 影响范围

- **engine/types.ts**：`GoalStatus` 去 `paused`
- **engine/goal.ts**：无逻辑变化（transitionStatus 本就宽松，paused 不在终态集）
- **commands.ts**：`GoalCommandArgs.action` 去 `pause`；`parseGoalArgs` 去 pause 分支
- **command-adapter.ts**：删 `handlePause`；`handleResume` 守卫从 `paused|blocked` 收窄为 `blocked`
- **event-adapter.ts**：`checkContextUsage` 不转 paused（保持 active + 注入提示）；注释清理
- **session.ts**：`reconstructGoalState` 的 G-015 非对称激活逻辑简化（无 paused 特判）
- **projection/widget.ts**：`renderStatusLine` 删 `case "paused"`
- **index.ts**：命令描述去 `/goal pause`
- **全部测试**：删 paused 相关用例；状态机矩阵从 7 态调整为 6 态

## 验收标准

- [ ] `GoalStatus` 不含 `paused`（grep 零结果于生产代码）
- [ ] `/goal pause` 命令不可达（parseGoalArgs 不识别，handlePause 已删）
- [ ] context>85% 时 goal 保持 active，仍注入 wrap-up 提示
- [ ] `/goal resume` 仅对 blocked 生效；对 active 提示 "no need to resume"
- [ ] `blocked` 状态、`report_blocked` action、stall 自动阻塞全部正常
- [ ] 6 态状态机测试全绿
- [ ] typecheck + lint + test 全绿
