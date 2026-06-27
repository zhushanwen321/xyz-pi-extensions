# goal

持久目标驱动自主循环 — Codex `/goal` 风格。支持任务分解、证据验证、任务验证（verification）、子任务、三重预算（Token/时间/轮次）、阻塞检测、停滞提醒、上下文空间保护。

## 功能

- **自主循环**：`/goal <目标>` 启动后，AI 通过 `goal_manager` 工具拆分任务并持续执行
- **证据验证（evidence）**：完成任务必须提供具体证据，不能空口完成
- **任务验证（verification）**：可为任务配置验证命令（method/expected），completed 后须运行验证并回填 actual，状态转为 verified
- **子任务（subtask）**：每个任务可挂载子任务（add/update/delete subtasks），Goal 模式下替代 todo 工具
- **三重预算**：Token / 时间 / 轮次，70% 提醒、80% 紧张、90% 收尾、100% 终止
- **阻塞检测**：连续无进展（默认 5 turn）自动 blocked，用户可 resume
- **停滞提醒**：任务/subtask 超过 10 turn 无更新自动注入 staleness 提醒
- **上下文保护**：context 使用率达 85% 时自动暂停并强制收尾
- **持久化**：状态通过 session entries 保存，重启后自动恢复（终态保留审计痕迹）

## 安装

```bash
pi install npm:@zhushanwen/pi-goal
```

> 仅 dev 调试可 symlink（**禁止日常使用**，会掩盖 pi manifest 缺失问题）：
> `ln -s /path/to/xyz-pi-extensions-workspace/<worktree>/extensions/goal ~/.pi/agent/extensions/goal`

## 使用

```
# 启动目标（--timeout 单位为分钟）
/goal 修复项目中所有失败的测试
/goal 实现用户认证功能 --tokens 500000 --timeout 30 --max-turns 40 --max-stall 8

/goal status               # 查看进度
/goal pause                # 暂停
/goal resume               # 恢复
/goal clear                # 清除（强制）
/goal abort                # 终止（仅当无非 cancelled 任务时）
/goal update <新目标>       # 运行中更换目标
/goal history              # 查看历史 goal 记录
```

默认预算：`maxTurns=50`、`maxStallTurns=5`；上限 `maxTurns≤100`、`maxStallTurns≤20`。

## goal_manager 工具

Goal 激活后 AI 通过 `goal_manager` 工具管理任务，共 10 个 action：`create_tasks` / `add_tasks` / `update_tasks` / `list_tasks` / `complete_goal` / `cancel_goal` / `report_blocked` / `add_subtasks` / `update_subtasks` / `delete_subtasks`。

任务状态流：`pending → in_progress → completed → verified`（verified 仅当配置了 verification）；任一态可转 `cancelled`。完整约束见工具的 `promptGuidelines`。

## 外部 API

其他扩展（如 coding-workflow）可通过 `pi.__goalInit` 编程式初始化 goal，跳过 `/goal` 命令流：

```typescript
pi.__goalInit(objective, tasks, { tokenBudget?, timeBudgetMinutes?, maxTurns? }, ctx?)
// 返回 true 表示已初始化，false 表示已有活跃 goal
```

类型见 `src/state.ts` 的 `GoalExternalInit` / `GoalExternalBudget`。

## 运行模型

goal 的心脏是 **事件驱动的自主循环**——区别于普通 todo，它通过 Pi 的 6 个事件钩子织成一个 turn 级的闭环。

### 事件驱动循环（一个 turn 的时序）

```
before_agent_start ─→ 注入 context prompt（目标/进度/预算）+ staleness 检测 + 85% context 保护
        │
   agent 执行 + 调 goal_manager（create_tasks/update_tasks/...）
        │
   message_end ─────→ 累加 token 用量
        │
   turn_end ────────→ currentTurnIndex++ + widget 刷新
        │
   agent_end（编排器）─→ 续跑决策（见下「自主循环续跑」）
```

`session_start` 时 `reconstructGoalState` 回读最新 entry 恢复状态，使 goal 跨重启续跑。事件注册见 `src/index.ts`。

### 三层护栏体系

三层分别在 turn 的不同步骤触发，共同保证「不失控、不空转、不虚报」：

| 护栏 | 触发点 | 作用 | 实现 |
|------|--------|------|------|
| **预算** | `agent_end` + `before_agent_start` | token/时间/轮次超阈值时提醒、收尾、终止 | `budget.ts` |
| **stall** | `agent_end` | 连续无进展 turn 数超限 → blocked，需用户 resume | `agent-end-handler.ts` |
| **证据** | tool 层（`goal_manager` action） | 状态机强制 + evidence/verification，防止虚报完成 | `action-handlers.ts` |

为什么是三层而非一层：预算管「资源安全」、stall 管「行为有效性」、证据管「结果真实性」——三个正交维度，缺一都会留下单一故障点。

### 自主循环续跑（`agent_end` 编排顺序）

`handleAgentEnd` 按以下顺序短路判断，任一分支命中即返回：

1. **终态处理** — goal 已 complete/blocked，记录历史并通知
2. **预算检查** — 70% 提醒 / 90% 收尾 steering / 100% 转终态（`budget_limited`/`time_limited`）
3. **进展评估** — 全部完成→提示 `complete_goal`；无任务→催促 `create_tasks`；达 `maxTurns`→cancelled
4. **stall + continuation** — 计 stall；超限→blocked；否则注入 continuation prompt 续跑

顺序语义：**资源安全 > 进展判断 > 行为纠正**。预算优先于 stall，因为预算耗尽是不可逆的硬终止，而 stall 是可恢复的软暂停。

### Goal 状态机（7 态）

```
                         ┌───────── resume / clear ─────────┐
                         ▼                                   │
  active ──pause──→ paused     active ──stall──→ blocked ────┘
    │                                                 │
    │ ├──complete──────────────────────────────────→ complete*  （目标达成）
    │ ├──预算耗尽──────────────────────────────────→ budget_limited* （token 用尽）
    │ ├──时间耗尽──────────────────────────────────→ time_limited* （时间用尽）
    │ └──/goal clear──────────────────────────────→ cancelled* （用户清除，保留审计）
    │
    └── * 终态（不可被任何状态覆盖）
```

终态 4 个（complete / budget_limited / time_limited / cancelled）保留审计痕迹——因 entry-based 持久化无法删除已写入 entry，故用显式状态标记。详见 [ADR-002](../../docs/adr/002-goal-7-state-machine.md)。

（Task 级状态流 `pending→in_progress→completed→verified` 见「goal_manager 工具」节。）

### 持久化与健壮性

- **Entry-based 持久化**：`appendEntry` 追加而非删除；`deserializeState` 向后兼容旧字段；非终态恢复时自动转回 `active` 续跑
- **防重入**：`isProcessing` 标志防止 `agent_end` 重入
- **目标快照**：`goalId snapshot` 防止旧回调操作被新 goal 覆盖后的状态
- **中断处理**：`pendingPause` 捕获 ESC/abort，下个 `agent_end` 转 paused
- **Stale context**：compact 后旧 context 失效，静默吞错防止误报

这些 defensive 机制是应对「自主循环跨多 turn + 跨 compact + 可被随时中断」的复杂场景而设——缺任一都会产生时序竞态。

## 文件结构

```
goal/
├── index.ts
└── src/
    ├── index.ts                       # 入口 — tool/command/event 注册 + 外部 API
    ├── state.ts                       # 7 态状态机 + 持久化数据结构
    ├── constants.ts                   # 语义常量
    ├── commands.ts                    # /goal 命令参数解析
    ├── command-handler.ts             # /goal 命令分发（8 个子命令）
    ├── tool-handler.ts                # 共享 helpers + executeGoalAction 调度
    ├── action-handlers.ts             # goal_manager 的 10 个 action 处理器
    ├── agent-end-handler.ts           # agent_end 编排：预算检查/stall/continuation
    ├── before-agent-start-handler.ts  # before_agent_start：context 注入/staleness/85% 保护
    ├── budget.ts                      # 预算阈值与检查
    ├── templates.ts                   # Steering prompt 模板
    └── widget.ts                      # TUI 状态栏与侧边栏渲染
```

## 设计文档

- [ADR-002: Goal 7 态状态机](../../docs/adr/002-goal-7-state-machine.md) — 为什么 7 态（多 time_limited/cancelled）
- [ADR-003: 证据驱动完成](../../docs/adr/003-evidence-based-completion.md) — 为什么强制任务分解 + evidence
- [ADR-023: GoalRuntimeState 混合频率技术债](../../docs/adr/023-goal-runtimestate-mixed-frequency.md) — state 字段未分层
