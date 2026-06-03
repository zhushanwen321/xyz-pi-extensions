# 02. Claude Code Dynamic Workflows 逆向拆解

> 目标:从公开材料(官方博客 + 官方文档 + v2.1.147 早期逆向)还原 Claude Code dynamic workflows 的**用例、核心领域设计、整体架构、领域模型**。
>
> 注意:Claude Code 是闭源,无法读源码。本节是基于**官方公开文档 + 早期 v2.1.147/148 逆向发现**做的合理推断。一些细节(如 schema 校验、内部消息协议、runtime 实现)是推断,需要标注。

---

## 一、典型用例

来源:[官方博客](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code) 第三段 "Dynamic workflows in action"。

### 1.1 三类官方用例

| 用例 | 描述 | 价值点 |
|------|------|--------|
| **Codebase-wide bug hunt / profiler-guided optimization / security audit** | 整个 service/repo 并行搜索,每个发现独立验证 | 找到真实问题,过滤误报 |
| **Large migrations and modernization** | 跨千文件的框架替换、API 弃用、语言移植 | 端到端完成,无需人工分阶段 |
| **Critical work you need checked twice** | 独立尝试 + 对抗 agent 校验,迭代到收敛 | 高代价答案的可信度 |

### 1.2 三个反向用例(子用例)

从大类可以拆出更具体的形态:

- **Hardening passes**:鉴权检查、输入校验、不安全模式全代码库扫(同 bug hunt 形态)
- **Plan stress-testing**:从多个独立角度起草方案,在 commit 前对比
- **Plan from several angles**:同一问题用不同方法做,然后加权对比

### 1.3 标杆案例:Bun 从 Zig 到 Rust(逆向推理)

这个案例完美展现了 dynamic workflows 的能力上限:

| 阶段 | 编排形态 | Agent 数 | 关键设计 |
|------|---------|---------|---------|
| 1. Lifetime 映射 | pipeline 第一阶段 | 数百个 | 每个 Zig struct 字段的 Rust lifetime 独立决定 |
| 2. 文件移植 | parallel 写 + parallel 审 | 数百个 + 数百个 | **每个 .rs 文件 = 1 writer + 2 reviewer** |
| 3. Fix loop | pipeline + 循环 | 数十到数百 | build/test 不通过就不停迭代 |
| 4. Cleanup | 多个 workflow 串行 | 数百个 | 每个 .rs 文件的不必要拷贝单独 PR |

**可推断的形态**:
- 大规模 parallel:每个文件一个 agent
- 写+审的对抗(implement + adversarial verify):同一工件被两个独立 agent 评估
- 客观 oracle(测试套件)作为收敛信号
- 跨多个 workflow 的串行编排(每个阶段单独成一个 workflow)

### 1.4 6 种编排模式(来自 v2.1.147 逆向)

虽然官方文档没明说,但 v2.1.147 逆向发现的 6 种编排模式应该仍然适用:

| 模式 | 说明 | 典型场景 |
|------|------|----------|
| **Pipeline(流水线)** | 顺序阶段,前一阶段输出是下一阶段输入 | Review → Fix → Verify |
| **Fan-out(并行展开)** | 多个子 agent 并行执行相同任务 | 批量处理 issue |
| **Adversarial(对抗验证)** | 实现 agent vs 审查 agent 对抗 | 代码安全审查 |
| **Judge Panel(评委模式)** | 多个 agent 独立评判,汇总结论 | 设计方案评估 |
| **Accumulate(累积模式)** | 循环执行直到预算耗尽或条件满足 | 死代码清理(最多 8 轮) |
| **Nested(嵌套)** | Workflow 内嵌套子 workflow | 复杂多阶段任务 |

### 1.5 内置 workflow: `/deep-research`

- 命令:`/deep-research <question>`
- 流程:多角度 web 搜索 → 抓取+交叉验证来源 → 对每个声明投票 → 返回带引用报告
- 特征:未通过交叉验证的声明被**过滤**(不是简单聚合)
- 依赖:WebSearch 工具可用

### 1.6 触发场景

- **关键词触发**:prompt 中包含 `workflow`,Claude 自动为该任务写一个 workflow
- **ultracode 模式**:`/effort ultracode` 后,Claude 自动为每个实质任务规划 workflow

---

## 二、核心领域设计

### 2.1 设计哲学

> **用代码控制代码擅长的事(控制流),用模型控制模型擅长的事(判断力)。**
> — 来自 v2.1.147 早期逆向报告

具体落实为三条原则:

1. **Plan in code**:编排计划(plan)从 LLM 上下文移到脚本(代码)。
2. **Resumable in same session**:失败可恢复,不丢已完成 agent 的结果。
3. **Adversarial review by default**:agent 之间互相校验,而不是单 agent 单 pass。

### 2.2 核心领域概念

| 概念 | 定义 | 谁拥有 | 生命周期 |
|------|------|--------|---------|
| **Workflow** | JavaScript 脚本,描述一个完整任务 | 用户(写) / Claude(动态生成) | 文件存盘,持久 |
| **Meta block** | 脚本头部的 `const meta = { name, description, phases }` | workflow 内 | 静态 |
| **Phase** | meta 块声明的逻辑阶段,UI 显示用 | workflow | 静态声明 + 运行时实际进度 |
| **Agent call** | `await agent({ prompt, schema, model })` 的一次调用 | workflow 运行时 | 单次 |
| **Schema** | 子 agent 结构化输出的 JSON Schema 约束 | workflow | 静态 |
| **$ARGS** | 用户传给 workflow 的参数对象 | workflow | 单次运行 |
| **Result variable** | agent 调用的返回值,存在脚本变量中 | workflow | 一次运行 |
| **Run record** | 一次 workflow 执行的完整记录 | runtime | 运行中 → 完成,保存到 progress view |

### 2.3 领域边界(谁负责什么)

```
┌─────────────────────────────────────────────────┐
│ 用户 (User)                                     │
│  - 写 workflow 脚本(也包括改、保存、删)          │
│  - 提供 prompt + $ARGS                          │
│  - 决定何时启用 workflow / ultracode            │
└─────────────────────────────────────────────────┘
              ↓ 触发
┌─────────────────────────────────────────────────┐
│ Claude (主会话)                                 │
│  - 决定要不要为这个 task 写一个 workflow         │
│  - (ultracode 时)决定 effort 级别               │
│  - 收到最终报告并展示给用户                      │
│  - **不参与**中间编排                            │
└─────────────────────────────────────────────────┘
              ↓ 启动
┌─────────────────────────────────────────────────┐
│ Workflow Runtime (独立执行环境)                  │
│  - 解析 workflow 脚本                           │
│  - 隔离执行:中间结果不回流到主会话                │
│  - 调度 subagent                                │
│  - 实施 budget(16 并发 / 1000 agent/run)       │
│  - 提供 /workflows 进度面板                      │
│  - 处理 pause/resume/abort                      │
└─────────────────────────────────────────────────┘
              ↓ 调用
┌─────────────────────────────────────────────────┐
│ Subagent                                       │
│  - 独立上下文窗口(隔离主会话)                    │
│  - 总是 acceptEdits 模式                       │
│  - 继承 tool allowlist                         │
│  - 通过 schema 返回结构化输出                    │
└─────────────────────────────────────────────────┘
```

**关键边界**:
- 主会话**不持有**中间结果 → context 不膨胀
- Runtime 持有**完整**的脚本执行状态(变量、循环计数器、parallel pool)
- Subagent 之间**不直接通信** → 通过 runtime 中转(或通过 schema 输出 + 下游 prompt 输入)

### 2.4 核心领域服务

| 服务 | 职责 | 实现推断 |
|------|------|----------|
| **ScriptParser** | 解析 workflow JS 脚本,提取 meta | ESM/CJS loader,提取 export const meta |
| **AgentDispatcher** | 调度 agent() 调用到 subagent | 内部消息队列,与 runtime 隔离 |
| **ResultCache** | 缓存已完成 agent 的结果(callCache) | 内存 Map,run 结束清空 |
| **SchemaValidator** | 校验 subagent 输出是否匹配 schema | 推测使用 Zod/JSON Schema |
| **BudgetEnforcer** | 跟踪 token 数,超过限制终止 run | 内部 counter |
| **ApprovalGate** | 第一次运行时弹"是否运行" | 按权限模式决定 |
| **ProgressPanel** | `/workflows` 视图 | TUI 实时更新 |
| **WorkflowStore** | workflow 文件的发现与持久化 | `.claude/workflows/` / `~/.claude/workflows/` |

### 2.5 设计决策的边界

| 决策 | 选择 | 原因(推断) |
|------|------|------------|
| 编排语言 | JavaScript | 与 Claude Code 自身技术栈一致,无需引入新运行时 |
| 用户层 | 写 JS 脚本,而非 DSL | 灵活,允许任意控制流;门槛在"能写 JS" |
| 触发方式 | 关键词 + ultracode | 关键词零成本,ultracode 是 power user 模式 |
| 中间结果存储 | 脚本变量 | 不进主会话上下文,主会话不膨胀 |
| 子 agent 模式 | 强制 acceptEdits | workflow 模式不打断人 |
| 持久化粒度 | workflow 脚本存盘,运行记录在内存 | 简单;运行记录仅供 progress view,不要求可回放 |
| 跨会话恢复 | 不支持(只同会话) | run 记录是内存态,exit Claude Code 即丢失 |
| 持久化路径 | `.claude/workflows/` + `~/.claude/workflows/` | 与 skills/commands 路径一致 |

---

## 三、整体架构

### 3.1 三层模型

```
┌────────────────────────────────────────────┐
│ Layer 1: User Interface / Approval         │
│  - Claude 主会话                           │
│  - /workflows 面板                        │
│  - 第一次运行的 plan 审批 UI              │
└────────────────────────────────────────────┘
                  ↓
┌────────────────────────────────────────────┐
│ Layer 2: Workflow Runtime (独立进程)        │
│  - 加载并执行 workflow 脚本                │
│  - 管理 agent 调用生命周期                │
│  - 维护 callCache                          │
│  - 实施 budget                            │
│  - 提供 pause/resume/abort                │
│  - 进度事件推送                            │
└────────────────────────────────────────────┘
                  ↓
┌────────────────────────────────────────────┐
│ Layer 3: Subagent (Claude 子代理)          │
│  - 独立上下文窗口                          │
│  - 总是 acceptEdits 模式                 │
│  - 继承 tool allowlist                   │
│  - 通过 schema 返回结构化输出             │
└────────────────────────────────────────────┘
```

### 3.2 消息流(单次 agent 调用)

```
[Script]                    [Runtime]                    [Subagent]
   │                            │                            │
   │ await agent({...})         │                            │
   ├───────────────────────────>│                            │
   │                            │ check callCache            │
   │                            │ cache miss                 │
   │                            │ dispatch (parentPort/msg)  │
   │                            ├───────────────────────────>│
   │                            │                            │ run with schema
   │                            │                            │ isolated context
   │                            │                            │ tool calls...
   │                            │                            │ return JSON
   │                            │ <───────────────────────────┤
   │                            │ validate schema            │
   │                            │ cache result               │
   │                            │ check budget               │
   │ <───────────────────────────┤                            │
   │ resolve(value)             │                            │
   │                            │                            │
   │ next JS statement          │                            │
```

### 3.3 持久化与恢复

```
                ┌──────────────────┐
                │ .claude/workflows/│
                │  - triage.js     │  ← 静态 workflow 脚本
                │  - audit.js      │     (用户写 / Claude 生成)
                │  + ...           │
                └──────────────────┘
                          ↑ ↓
                  /workflow save    (保存为命令)
                          ↓
                ┌──────────────────┐
                │ ~/.claude/        │
                │   workflows/      │  ← 个人级脚本
                └──────────────────┘
                          ↓
              [加载]  → [执行]  → [内存 run 记录]
                                       ↓
                            [在 /workflows 面板显示]
                                       ↓
                          [结束 / 关闭 Claude Code]
                                       ↓
                                 记录丢失
```

**注意**:
- workflow **脚本**持久化(版本控制友好)
- workflow **运行记录**不持久化(同会话内存态)
- 这与 pi-workflow 形成对比 — pi-workflow 把 run 记录 append 到 session JSONL

### 3.4 隔离与安全

| 边界 | 隔离方式 | 原因 |
|------|---------|------|
| Workflow ↔ 主会话 | **Runtime 在独立环境**,主会话只看最终结果 | 主会话 context 不膨胀 |
| Subagent ↔ 主会话 | 独立上下文窗口 | 隔离每个 subagent 的工作 |
| Subagent ↔ Subagent | 不直接通信,通过 runtime 中转 | 防止环状依赖,简化状态 |
| 用户 ↔ 运行时 | 通过 ApprovalGate,默认权限模式每次都问 | 防止意外消耗 token |
| Workflow 脚本 ↔ FS/Shell | **不直接**(推断,与 pi-workflow 一致) | 脚本只协调 agent,所有 IO 由 agent 做 |

### 3.5 可观测性

| 维度 | 实现 |
|------|------|
| 进度 | `/workflows` 面板,显示每个 run 的 phase 进度 |
| Token 消耗 | 内置在进度面板每个 phase 旁 |
| 单个 agent | drill into phase → drill into agent → 看 prompt / 工具调用 / result |
| 跨 run | 进度面板列出所有 running/completed run |

### 3.6 失败处理

| 失败类型 | 行为 |
|---------|------|
| Agent 错误 | 推断:retry(未确认次数),失败后跳过该 phase |
| Budget 超限 | run 终止,标记 budget-limited(推断) |
| Schema 校验失败 | 推断:retry,失败后 phase 标记失败 |
| Workflow 脚本错误 | 弹错,不进入 run |
| 权限被拒 | 弹"是否 allow" |
| 用户中断 | run 标记 aborted,缓存保留(同会话可恢复) |

---

## 四、重要领域模型

### 4.1 Workflow 脚本模型

```typescript
// 伪 TS,基于 v2.1.147 逆向 + 官方文档
interface WorkflowScript {
  /** 静态元信息 */
  meta: {
    name: string;          // workflow 唯一标识
    description: string;   // 一句话描述
    phases: string[];      // 逻辑阶段名(UI 显示)
  };

  /** 运行入口:脚本顶层就是 IIFE 入口 */
  execute: async () => any;
}
```

**最小可工作文件**:

```javascript
const meta = {
  name: "triage-sentry",
  description: "Triage Sentry issues above threshold, fix and verify",
  phases: ["load-issues", "fix-issues", "verify-fixes"]
};

const issues = await agent({
  prompt: "List unresolved Sentry issues",
  schema: { type: "array", items: {...} }
});

// 完整 JS 控制流可用
const big = issues.filter(i => i.userCount > 20);
if (big.length === 0) return { fixed: 0 };

await pipeline([
  parallel(big.map(i => agent({ prompt: `Fix ${i.id}`, schema }))),
  parallel(results => results.map(r => agent({ prompt: `Verify ${r.notes}`, schema })))
]);
```

### 4.2 Meta block 模型

| 字段 | 类型 | 必填 | 用途 |
|------|------|------|------|
| `name` | string | ✅ | 标识,出现在 /workflows 列表 |
| `description` | string | 推荐 | 列表里的副标题,作为 prompt snippet 来源 |
| `phases` | string[] | 推荐 | 进度面板的"逻辑阶段"标签 |

### 4.3 Agent 调用模型

```typescript
interface AgentCall {
  /** 必填 */
  prompt: string;

  /** 可选:结构化输出 schema(推测支持 JSON Schema 语法) */
  schema?: JSONSchema;

  /** 可选:指定模型 */
  model?: "opus" | "sonnet" | "haiku" | string;

  /** 可选:进度面板显示的描述 */
  description?: string;
}
```

### 4.4 Schema 模型(结构化输出)

```javascript
// 示例 1:对象 schema
const verdictSchema = {
  type: "object",
  properties: {
    fixed: { type: "boolean" },
    notes: { type: "string" },
    confidence: { type: "number" }
  }
};

// 示例 2:数组 schema
const issuesSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      userCount: { type: "number" }
    }
  }
};
```

**关键**:
- schema 强制 agent 输出可被 `JSON.parse` 解析
- 否则该 agent 返回值无法被下游使用(典型用 `parsedOutput ?? content`)

### 4.5 编排原语

```typescript
/** 单个 agent 调用(最基础) */
declare function agent(opts: AgentCall | string): Promise<any>;

/** 并发:多个 agent 同时跑(无序) */
declare function parallel(calls: AgentCall[] | (() => Promise<any>)): Promise<any[]>;

/** 顺序:每阶段可包含 parallel(强顺序) */
declare function pipeline(stages: Array<(prevResult: any) => Promise<any>>): Promise<any>;

/** 命名阶段(仅用于 UI 分组,不改变控制流) */
declare function phase(name: string): void;

/** 共享参数(来自 /workflow run --args) */
declare const $ARGS: Record<string, any>;
```

### 4.6 Run 状态模型(推断)

| 状态 | 触发 | 终态? |
|------|------|-------|
| `pending` | workflow 被选定,等待用户确认 | ✗ |
| `running` | 已确认,开始执行 | ✗ |
| `paused` | 用户主动按 `p` 暂停 | ✗ |
| `completed` | 脚本 return 或 IIFE 自然结束 | ✅ |
| `failed` | 不可恢复错误(budget 超限 / 脚本错误) | ✅ |
| `aborted` | 用户主动 `x` 终止 | ✅ |
| `budget_limited` | token/cost 超限 | ✅(推断) |
| `time_limited` | 时间超限(若有此机制,推断) | ✅(推断) |

> 注意:Claude Code 官方未公开精确状态机。这里基于 pi-workflow 的 7 态模型 + 通用 best practice 推断。

### 4.7 持久化模型

```
.claude/workflows/<name>.js         # 项目级 workflow 脚本
~/.claude/workflows/<name>.js       # 全局级 workflow 脚本
                                  # (项目级优先,同名覆盖)
```

**没有**:
- run 历史的 JSONL(只在内存,exit 即丢)
- agent result 的磁盘 cache(callCache 是内存 Map)
- token 使用的历史记录

**推断原因**:Claude Code 整体架构是"单 session 内存态"为主,持久化偏向"配置和文件"而非"运行时状态"。

### 4.8 Budget 模型(推断)

基于"16 并发 / 1000 agent per run"的硬限制:

```typescript
interface Budget {
  maxConcurrentAgents: 16;       // 硬限制
  maxAgentsPerRun: 1000;         // 硬限制,防 runaway
  maxTokens?: number;            // 可选,用户设
  maxCost?: number;              // 可选,用户设
  maxTimeMs?: number;            // 可选,用户设(不确定官方是否支持)
}
```

**已知确定的硬限制**:
- 16 并发(从 CPU 角度)
- 1000 agent/run(防 runaway)

**未公开但可能存在**:
- token budget(因为 ultracode 模式会消耗大量 token)
- cost budget(因为 Anthropic 计费,大概率有)
- time budget(不确定)

### 4.9 集成点

| 集成点 | 行为 |
|--------|------|
| Subagent | workflow 的 agent() 调用本质就是 spawn subagent |
| Skill | workflow 脚本可以调用任何已注册的 skill |
| Hook | 不直接集成(workflow 是独立 runtime,hook 在主会话触发) |
| MCP | subagent 继承 MCP 配置,可以调用 MCP 工具 |
| GitHub Actions | 通过 Claude Code GitHub Action 间接集成 |
| /commands | /deep-research 是内置 command,等同 /workflow run deep-research |

---

## 五、能力边界

### 5.1 强项

- **可重放**:workflow 脚本可保存、可重跑、可分享
- **可审查**:代码即文档,review 时读 JS 就能理解行为
- **可恢复**:同会话内可从中断点恢复
- **可扩展**:任意 JS 控制流,无 DSL 限制
- **强结构化输出**:schema 约束让 agent 输出可被下游消费
- **实战验证**:Bun 75万行迁移,99.8% 测试通过

### 5.2 弱项/限制

- **跨会话不可恢复**:退出 Claude Code 后 run 记录丢失
- **高 token 消耗**:每个 agent 是独立 subagent,无 token 复用
- **复杂调试**:agent 内部状态对 workflow 不可见,只能看 schema 输出
- **无团队共享运行记录**:没有 run history 持久化层
- **缺乏细粒度 cost 控制**:不能按 phase 设不同 budget
- **Subagent 总是 acceptEdits**:不能为某些 phase 设更严的权限
- **不能直接调用子 agent 之间通信**:只能通过 schema 显式传递

### 5.3 不擅长

- **真正的交互**:workflow 跑起来后主会话无法插话(只能整体 abort)
- **需要用户判断的步骤**:如 "请选择方案 A 还是 B",没法在 workflow 中间停
- **长时间在线协作**:Workflow 是 fire-and-forget,不是长会话

---

## 六、与官方其他原语的对比

来源:[官方文档 - Run agents in parallel](https://code.claude.com/docs/en/agents)

| 原语 | 本质 | 谁编排 | 规模 | 中断恢复 |
|------|------|--------|------|---------|
| **Subagent** | worker | Claude 主会话 | 几个/轮 | 否 |
| **Skill** | 指令集 | Claude 遵循 | 同 subagent | 否 |
| **Workflow** | 脚本 | runtime 协调 | 几十到几百/run | 同会话可恢复 |
| **Agent view** | 多个 subagent 共享主视图 | Claude + 用户 | 同 subagent | 否 |
| **Agent teams** | 多 worktree 协作 | Claude + 用户 + git | 几个 | 是(git) |

> "用代码控制代码擅长的事(控制流),用模型控制模型擅长的事(判断力)" — workflow 用 JS 取代 Claude 当编排器,得到确定性和可观测性。
