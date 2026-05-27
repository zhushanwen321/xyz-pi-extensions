# Draft: Pi Extensions → OpenCode 迁移分析

## 需求
- 将 Pi 的 **goal** 和 **workflow** 两个扩展移植为 OpenCode 插件

---

## 一、OpenCode Plugin API 能力全景

### 可用的插件 API

| 能力 | API | 备注 |
|------|-----|------|
| 自定义工具 | `tool({ description, args, execute })` | Zod schema 定义参数，返回字符串或结构化数据 |
| Session 事件 | `session.created`, `session.updated`, `session.deleted`, `session.compacted` | 无 agent_start/end 或 turn_end |
| Tool 事件 | `tool.execute.before`, `tool.execute.after` | 可拦截/修改工具调用 |
| 自定义命令 | `/command` | **只支持 prompt template**，不支持可编程 handler |
| 消息注入 | `client.session.prompt({ noReply: true })` | 注入上下文但不触发 AI 回复 |
| 文件持久化 | 自由使用 `Bun.$` / fs | 无内置 key-value 存储 |
| 状态栏/TUI | `tui.toast.show()`, `tui.appendPrompt()` | **无** renderCall/renderResult/setStatus/setWidget |
| 自定义 agent | `.opencode/agents/*.md` | 可定义 subagent 系统提示 + 权限 |
| 子 agent 调用 | `@agent` 或 `task` 工具 | 内建支持，有权限控制 |
| Compaction 钩子 | `experimental.session.compacting` | 可注入自定义上下文到 compaction 摘要 |
| SDK | `client.session.prompt()`, `client.session.create()`, etc | 完整 session 管理 |

### Pi 有但 OpenCode 没有的能力

| 缺失能力 | 影响 | 替代方案 |
|----------|------|----------|
| `renderCall`/`renderResult` | 自定义 TUI 显示 | 放弃 TUI 定制，纯文本输出 |
| `setStatus`/`setWidget` | 状态栏/小部件显示 | 放弃 |
| `sendUserMessage({ deliverAs: "steer" })` | 消息优先级/steering | `session.prompt({ noReply: true })` 近似替代 |
| `pi.appendEntry()` | 内置状态持久化 | 手工文件持久化 |
| `pi.registerCommand()` handler | 可编程命令 | 用 `tool` + SKILL.md 替代 |
| agent_start/end/turn_end 事件 | 回合级别生命周期 | 无直接替代 |
| `worker_threads` | 工作线程隔离 | 不可用（插件跑在 Bun 进程） |
| `child_process.spawn` | 子进程隔离 | 受限（可通过 Bun.$ 近似但非设计目标） |

### 社区已验证的可行模式

| 参考插件 | 相关性 | 关键模式 |
|----------|--------|----------|
| **opencode-supermemory** (1.2k★) | goal 持久化 | `session.created` 加载状态 → 自定义 `supermemory` tool(6 modes) → 文件持久化 → compaction 时注入上下文 |
| **opencode-background-agents** (264★) | workflow 委派 | 自定义 `delegate()`/`delegation_read()`/`delegation_list()` 工具 → markdown 文件持久化 → 异步 background agent 执行 |
| **opencode-conductor** (103★) | workflow 编排 | 自定义 `@conductor` agent → 命令 `/conductor:*` → spec→plan→implement 三阶段生命周期 → 文件 artifact(spec.md/plan.md) |
| **@openspoon/subtask2** | workflow 控制 | 自定义命令扩展为编排系统，细粒度流程控制 |
| **micode** | workflow 连续性 | Brainstorm→Plan→Implement 流程，session 连续性 |
| **oh-my-opencode** | 多 agent | Background agents, pre-built tools, hooks |

---

## 二、goal 移植可行性分析：高

### 功能映射矩阵

| Pi goal 功能 | OpenCode 等价 | 难度 | 说明 |
|-------------|---------------|------|------|
| 7态状态机 | 纯 TS 实现 | **低** | 完全在插件代码中实现，无平台依赖 |
| `goal_manager` tool (10 actions) | `tool({ name: "goal" })` | **低** | 1:1 映射，action 作为参数 |
| `/goal status` 命令 | 不可编程的命令 | **中** | OC 命令是 prompt template。方案：1) tool action "status" 2) agent SKILL.md 指导 AI 何时使用 goal 工具 |
| 跨 session 持久化 | 文件 JSON | **中** | supermemory 已验证模式：`session.created` 钩子加载，执行中写文件 |
| Evidence-based completion | 工具逻辑 | **低** | 纯工具侧逻辑 |
| Token/time budget 追踪 | 无 turn_end 事件 | **高** | 需要变通：1) 用 `session.updated` 估算 2) 用 `tool.execute.after` 累计 token 3) 接受不精确 |
| Stall 检测（连续无进展） | 无 agent_end | **高** | 同上，无法精确检测 AI 是否"空转" |
| Steering 消息 (deliverAs: steer) | `session.prompt({ noReply: true })` | **中** | 可注入上下文但无优先级概念 |
| Budget 预警 (70%/90%) | 同上 | **中** | 结合 compaction 钩子注入预警 |
| TUI 状态栏/徽章 | 无 | **高** | 完全放弃。用 toast 通知替代 |
| 消息渲染器 (goal-context) | 无 | **高** | 放弃。AI 通过 system prompt + 注入上下文感知 |

### 概要架构图

```
plugin.ts (入口)
├── session.created → loadState()     # 从文件恢复 state
├── session.updated → checkBudget()   # 近似跟踪 token
├── session.compacted → injectGoalContext()  # compaction 时注入
├── tool: goal_manager(10 actions)    # 核心状态管理
└── agent: goal-agent.md              # SKILL.md 指导 AI 使用 goal 工具

data/ (文件持久化)
└── goal-state-{sessionId}.json       # 7态 + tasks + budget
```

### 关键决策

1. **放弃 `/goal` 命令**：OC 不支持可编程命令，改用 `goal_manager` tool + subagent 模式
2. **放弃 TUI 渲染**：不移植 renderCall/renderResult/setStatus。改用 `tui.showToast()` 做关键通知
3. **预算追踪降级**：无 turn_end 事件，只能通过 tool 调用间的时间差 + 手动 token 累加做近似计算
4. **状态持久化走文件**：参考 supermemory 的 `~/.local/share/opencode/` 模式

---

## 三、workflow 移植可行性分析：中-低

### 核心架构差异

| Pi workflow | OpenCode | 差异本质 |
|------------|----------|----------|
| `worker_threads` 执行 | 无 | **致命**：workflow 依赖线程隔离独立执行 |
| `agent()`/`parallel()`/`pipeline()` API | 无 | OpenCode 只有单个 `task` 工具 |
| Worker 生命周期控制 | 无 | 无法暂停/恢复/中止一个执行中的流程 |
| callCache 持久化 | 无 | 但可以用文件实现类似效果 |
| 跨 session 恢复 | 无 | 同 callCache，可文件实现 |
| 用户编写 JS 脚本 | plugin 开发者 | 实际上 workflow 用户脚本可以转为 plugin 配置 |

### 功能映射矩阵

| Pi workflow 功能 | OpenCode 等价 | 难度 | 说明 |
|----------------|---------------|------|------|
| 8态状态机 | 纯 TS 实现 | **低** | 同 goal，无平台依赖 |
| `workflow` tool | `tool()` | **低** | 可映射 |
| `workflow-run` tool | `tool()` | **低** | 可映射 |
| worker_threads 执行 | **无** | **极高** | 无替代品 |
| `agent()` 调用 | `task` 工具 | **中** | 功能不等价（无隔离、无超时控制） |
| `parallel()` | `Promise.all(task1, task2)` | **中** | 无 worker 隔离，在主进程执行 |
| `pipeline()` | 链式 `task` | **中** | 顺序调用，无暂停/恢复 |
| 暂停/恢复 | **无** | **极高** | 除非放弃线程隔离 |
| 跨 session 恢复 | **无** | **高** | 理论上可用 callCache + 文件持久化实现，但 worker 状态不可保存 |
| 自动重试 (3次 exp backoff) | 工具侧实现 | **低** | apply 调用方逻辑 |
| 预算监控 | 同 goal 问题 | **高** | 无 turn_end |
| Workflow 脚本 JS | **需要改造** | **高** | 无法直接注入 agent() API 到用户 JS 作用域 |

### 可行性结论

**完整移植不可行**。`worker_threads` 是架构层缺失，OpenCode 插件模型无法提供：

- 线程隔离的执行沙箱
- Worker 生命周期控制（启动/暂停/恢复/中止）
- 用户编写 JS 脚本 + 注入 API 的能力

### 替代方案 LITE 版

放弃 Pi workflow 的核心架构，用 OpenCode 原生能力重构一个**轻量级编排 DSL**：

```
模式: "轻量编排"
核心: 插件定义 DAG + 用 task 工具顺序/并行执行
持久化: 文件记录执行进度，崩溃后从断点重放
放弃: 线程隔离、暂停/恢复、用户脚本
```

**参考社区已有工作**：
- **opencode-conductor** 已实现 `spec→plan→implement` 三阶段生命周期
- **opencode-background-agents** 实现异步 `delegate()` + 结果持久化
- **@openspoon/subtask2** 实现细粒度流程控制

建议：**优先复用 opencode-conductor + background-agents 的能力**，而不是从零移植。

---

## 四、整体路线图建议

```
Phase 1: goal 移植 (优先级高)
├── 新建 goal 插件工程 (.opencode/plugins/goal/)
├── 实现 7态状态机
├── 注册 goal_manager tool (10 actions)
├── 文件持久化 (session.created 加载 / 执行中写)
├── session.compacted 钩子注入 goal 上下文
└── 创建 goal-agent SKILL.md 指导 AI 使用

Phase 2: 评估 workflow 替代方案 (优先级中)
├── 调研 opencode-conductor 能否满足需求
├── 调研 opencode-background-agents 的 delegate 模式
├── 如有缺口，开发轻量编排插件
└── 放弃完整移植

Phase 3: 其他扩展 (可选)
├── usage-tracker -> supermemory 的持久化模式参考
├── todo -> OpenCode 内置 todo，无需移植
└── subagent .parallel/.chain/.vision -> 按需增强
```

---

## 已确定的决策

- [x] goal 移植可行性：**高**，核心功能可映射
- [x] workflow 移植可行性：**中-低**，建议放弃完整移植，采用轻量替代方案
- [x] OpenCode 已经内置 todo，不需要移植
- [x] Subagent 已有基础 task 工具，高级模式可后续增强
- [x] 社区存在可直接参考的成熟插件（supermemory, background-agents, conductor）

## 待讨论

- [ ] goal 的 budget 追踪精度要求：是否需要精确 token 计数，还是近似即可？
- [ ] workflow 替代方案接受度：是否接受轻量编排版（无 worker 隔离）？
- [ ] OpenCode 插件发布方式：npm vs 直接文件
