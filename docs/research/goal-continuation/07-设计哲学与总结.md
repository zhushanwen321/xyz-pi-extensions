# 设计哲学与总结

## 两套系统的设计根源

### Pi 的设计根源

Pi 的 goal/todo 系统设计围绕 **"用户始终在循环中"** 这一假设：

```
用户 -> 设定目标 -> 模型执行 -> 报告进度 -> 用户决策 -> ...
                               ↑_____________________________|
```

**关键假设**：
1. 用户是**主动决策者**：模型完成任务需要用户确认
2. 任务是**显式的**：必须拆分为可验证的步骤
3. 证据是**必须的**：不能无证据地声称完成
4. 扩展是**事件驱动的**：通过钩子嵌入 Agent 循环

**这解释了为什么 Pi 的 goal_manager 需要**：
- 强制 task 分解（create_tasks 第一步）
- 强制证据（completed 必须带 evidence）
- 提供 task 粒度状态追踪
- 详细的 prompt guidelines 告诉模型怎么用

### Codex 的设计根源

Codex 的 goal/plan 系统围绕 **"模型是自主执行者"** 这一假设：

```
用户 -> 设定目标 -> [系统自动续跑] -> 模型持续工作 -> 完成/阻塞
```

**关键假设**：
1. 模型是**自主执行者**：不需要用户每轮确认
2. 目标是**陈述性的**：给一个高层次描述，模型自己规划
3. 系统是**保障者**：负责预算、续跑、收尾
4. 完成是**验证性的**：prompt 指令要求模型自我验证

**这解释了为什么 Codex 的 Thread Goal 需要**：
- 自动 continuation（系统级新 turn）
- SQLite 持久化（跨 session）
- Token 会计（自动 budget 管理）
- 严格的 completion/blocked audit 指令（在 prompt 中而非代码中）

## 组件关系对比

### Pi 的组件关系

```
                   ┌────────────┐
                   │   用户      │
                   └─────┬──────┘
                         │ /goal set /goal pause /goal resume
                         ↓
              ┌─────────────────────┐
              │    /goal command     │
              │  (命令解析器)         │
              └──────────┬──────────┘
                         │ createInitialState
                         ↓
    ┌──────────────────────────────────────────┐
    │        Goal Extension Runtime             │
    │                                            │
    │  ┌────────────────┐  ┌────────────────┐   │
    │  │  goal_manager   │  │  生命周期钩子    │   │
    │  │  (model tool)   │  │                │   │
    │  │                 │  │ before_agent   │   │
    │  │ create_tasks    │  │ → context inj  │   │
    │  │ update_tasks    │  │ agent_end      │   │
    │  │ complete_goal   │  │ → budget check │   │
    │  │ cancel_goal     │  │ → progress     │   │
    │  │ report_blocked  │  │ → continuation │   │
    │  │ add_subtasks    │  │ message_end    │   │
    │  │ ...             │  │ → token acctg  │   │
    │  └────────────────┘  └────────────────┘   │
    └──────────────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              ↓                     ↓
        ┌────────────┐      ┌───────────────┐
        │ TUI Widget  │      │ Session Entry │
        │ (status+    │      │ (persistence) │
        │  sidebar)   │      │               │
        └─────────────┘      └───────────────┘

    ┌──────────────────┐
    │   todo 工具       │ ← 轻量级、与 goal 互斥
    │  (add/update/    │
    │   delete/clear/  │
    │   list)          │
    └──────────────────┘
```

### Codex 的组件关系

```
                    ┌────────────┐
                    │   用户      │
                    └─────┬──────┘
                          │ 消息 / create_goal
                          ↓
              ┌─────────────────────────┐
              │     Session (内核)       │
              │                          │
              │  ┌──────────────────┐   │
              │  │   GoalRuntime    │   │
              │  │                  │   │
              │  │  ┌────────────┐  │   │
              │  │  │ Accounting  │  │   │
              │  │  │ (token+     │  │   │
              │  │  │  wallclock) │  │   │
              │  │  └────────────┘  │   │
              │  │                  │   │
              │  │  ┌────────────┐  │   │
              │  │  │ Continuation│  │   │
              │  │  │ (auto-turn) │  │   │
              │  │  └────────────┘  │   │
              │  └──────────────────┘   │
              │                          │
              │  ┌──────────────────┐   │
              │  │  Event Dispatch  │   │
              │  │  (RuntimeEvent)  │   │
              │  └──────────────────┘   │
              │                          │
              │  ┌──────────────────┐   │
              │  │  Tool Registry   │   │
              │  │  (create_goal,   │   │
              │  │   update_goal,   │   │
              │  │   get_goal,      │   │
              │  │   update_plan)   │   │
              │  └──────────────────┘   │
              └─────────────────────────┘
                          │
              ┌───────────┴───────────┐
              ↓                       ↓
        ┌────────────┐          ┌──────────┐
        │   SQLite   │          │   App    │
        │  (state_db) │          │  Server  │
        │            │          │  (SSE)   │
        │ thread_    │          │          │
        │ goals 表   │          │ EventMsg │
        └────────────┘          └──────────┘
```

## 关键设计决策对比总结

### 1. 谁负责"继续工作"？

| 系统 | 决策 | 理由 |
|---|---|---|
| Pi | 用户 | 用户每轮确认"继续否"，防止 AI 消耗过多 token |
| Codex | 系统 | 系统自动 continuation，用户设定目标后可离开 |

### 2. 谁负责"验证完成"？

| 系统 | 决策 | 理由 |
|---|---|---|
| Pi | 工具层强制 | evidence 是必需参数，代码层验证 |
| Codex | Prompt 指令 | completion audit 是 prompt 指令，模型自我验证 |

### 3. 谁负责"任务分解"？

| 系统 | 决策 | 理由 |
|---|---|---|
| Pi | 模型 | create_tasks 强制模型分解，subtask 进一步细化 |
| Codex | 模型（隐含） | 没有显式 task 分解工具，模型在 prompt 里自己规划 |

### 4. 状态持久化在哪里？

| 系统 | 决策 | 理由 |
|---|---|---|
| Pi | Session entry | 轻量级、无外部依赖、事件溯源 |
| Codex | SQLite | 可靠、ACID、跨 session、复杂查询 |

### 5. Budget 怎么管理？

| 系统 | 决策 | 理由 |
|---|---|---|
| Pi | 软 limit + 预警 | 给用户控制权，提醒后由模型/用户决定 |
| Codex | 硬 limit + 系统 | 系统自动控制，超出后 steer/terminate |

## 结论（修正版）

> 参考 `08-修正与补充.md`。最初的分析过度简化了两者的差异，认为 Pi goal_manager 是"检查清单"、Codex 是"自治循环"。
> 实际两者在核心能力上高度重合——都具备 auto-continuation、token 会计、预算管理、状态机、持久化。

### 两者是同一类系统

Pi goal extension 和 Codex Thread Goal **不是不同层次的东西**。两者都是：

- 跨 turn 自动 continuation ✓
- Token/时间预算管理 ✓
- Stall/blocked 检测 ✓
- 持久化跨 session ✓
- 状态机 + 用户控制 pause/resume ✓

### 真正的差异是设计决策偏好

| 决策点 | Pi 的选择 | Codex 的选择 |
|---|---|---|
| **任务分解** | 强制结构化（显式 task + evidence） | 自由意志（只有 objective） |
| **验证机制** | 工具层强制（代码验证） | Prompt 层引导（指令约束） |
| **Continuation** | 用户可见的消息 | 系统级新 turn |
| **取消能力** | 允许模型 cancel_goal | 不允许 |
| **时间预算** | 有 + 硬限制 | 无 |
| **上下文保护** | 有（85% 自动暂停） | 无 |
| **状态集** | 7 态（含 cancelled / time_limited） | 6 态（含 usage_limited） |
| **持久化** | Session entry（轻量） | SQLite（可靠） |

### 核心差异：结构化约束 vs 自由自治

这个差异才是两种设计哲学的本质：

**Pi 选择了"被约束的自治"**——模型可以自主工作，但必须遵循结构化流程：create_tasks 分解 → update_tasks 验证 → complete_goal 完成。所有关键节点有门禁。用户始终可以监督进度，随时介入。

**Codex 选择了"自由的自治"**——模型自主规划、自主验证、自主判断完成。系统只提供运行时保障（budget + continuation），不干预模型怎么工作。用户设定目标后交给模型。

### 同一种思维方式的两条实现路径

有意思的是，这两套系统更像是**同一种思维方式的两条实现路径**：

- 如果放在一起，它们可以互相补充——Pi 的任务分解 + evidence 门禁 可以嵌入 Codex 的 auto-continuation 循环中
- 反之，Codex 的 SQLite 持久化 + 内核级 continuation 也可以强化 Pi 的 extension 架构

两者不是对立的选择，而是在同一光谱上的不同偏好位置。
