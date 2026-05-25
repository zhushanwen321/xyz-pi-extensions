# ADR-005: Extension Composability Protocol（扩展可组合性协议）

> 状态：proposed
> 日期：2026-05-25

## 背景

当前 `xyz-pi-extensions` 项目中有多个编排型（orchestrator）扩展：

- **goal** — 持久化目标驱动自主循环，7 态状态机，evidence-based 完成
- **coding-workflow** — 5 阶段编码工作流编排，gate → review → retrospect → compact
- **subagent** — 任务委派与进程隔离执行（capability provider，非 orchestrator）

当用户希望在一个 orchestrator 内部嵌套使用另一个 orchestrator 时（例如在 goal 的某个 task 中启动 coding-workflow，或在 coding-workflow 的某个 phase 中使用 goal 管理子任务），三个层次的冲突会阻碍组合：

1. **Steering message 竞发** — 两个扩展各自在 `agent_end` 中独立调用 `pi.sendUserMessage()`，LLM 收到方向矛盾的指令
2. **Context injection 争夺** — 两个扩展各自在 `before_agent_start` 中注入上下文消息，LLM 的 context window 被双重指令占用
3. **状态机互不可见** — 两个扩展的 state machine 各自演进，没有父子/嵌套关系，没有协调机制

本 ADR 提出一套扩展可组合性协议，让未来设计的 orchestrator 扩展能够安全嵌套。

## 角色分类

每个扩展必须在注册时声明自己的角色：

```
角色分类
├── orchestrator（编排器）：驱动 agent 行为、管理状态机、发送 steering
│   └─ 约束：最多一个活跃（active），或显式嵌套（nested stack）
│
├── capability（能力提供者）：注册工具、不驱动循环、不发 steering
│   └─ 约束：无限制共存
│
└── observer（观察者）：监听事件、不修改行为
    └─ 约束：无限制共存
```

**在当前项目中的映射：**

| 扩展 | 角色 | 当前是否可嵌套 |
|------|------|--------------|
| goal | orchestrator | 否 — 需要适配协议 |
| coding-workflow | orchestrator | 否 — 需要适配协议 |
| subagent | capability | 是 — 无自治循环 |
| todo | capability | 是 — 无自治循环 |
| statusline | observer | 是 — 不修改行为 |

## Orchestrator 生命周期接口

每个 orchestrator 扩展必须实现以下生命周期钩子：

```typescript
interface OrchestratorLifecycle {
  /** 唯一标识 */
  readonly id: string;
  /** 优先级（数字越大越高），用于 resolve 冲突 */
  readonly priority: number;

  /**
   * 激活：接管 agent 循环的控制权。
   * 调用时，扩展应恢复其 event handler 的正常行为
   * （注入 context、发送 steering、更新 widget）。
   */
  activate(context: OrchestratorContext): void;

  /**
   * 挂起：交出控制权给子 orchestrator。
   * 挂起后，扩展不应再：
   *   - 在 agent_end 中发送 steering
   *   - 在 before_agent_start 中注入主力 context
   * 可以保持 widget 显示（状态信息不应丢失）。
   */
  suspend(): void;

  /**
   * 恢复：子 orchestrator 完成，重新接管控制权。
   * 恢复后，扩展应重新激活完整行为。
   * 可能需要根据子 orchestrator 的结果调整状态。
   */
  resume(result?: OrchestratorResult): void;

  /**
   * 中止：被父级强制取消。
   * 扩展应清理内部状态，恢复到激活前的状态。
   * 不等同于"完成"——父级 orchestrator 可能不会重新恢复它。
   */
  abort(reason: string): void;

  /**
   * 声明是否可以接受指定子 orchestrator 的嵌套。
   * 允许 orchestrator 拒绝不被支持的嵌套类型。
   */
  canNestChild?(child: OrchestratorLifecycle): boolean;

  /**
   * 子 orchestrator 完成回调。
   * result 包含子 orchestrator 的完成状态和产出摘要。
   */
  onChildCompleted?(childId: string, result: OrchestratorResult): void;

  /**
   * 获取当前待发送的 steering 消息。
   * 返回 null 表示无 steering。
   * 由 composer 决定何时投递，orchestrator 不应自行调用 pi.sendUserMessage()。
   */
  getSteering(): SteeringMessage | null;

  /**
   * 获取当前上下文注入内容。
   * 由 composer 在 before_agent_start 中调用并注入。
   * orchestrator 不应通过 before_agent_start 的 message: { ... } 返回值注入。
   */
  getContextInjection(): ContextInjection | null;
}
```

## Steering Bus 协议

所有 orchestrator 的 steering 消息必须通过 **steering bus** 投递，而非直接调用 `pi.sendUserMessage()`。Steering bus 负责：

1. **优先级排序** — 按 orchestrator priority 排序
2. **去重丢弃** — 如果栈顶已有同优先级的 steering 待投递，丢弃新的
3. **上下文感知** — 只有当前栈顶的 orchestrator 的 steering 会被投递

```typescript
interface SteeringMessage {
  /** 来源 orchestrator ID */
  sourceId: string;
  /** 消息文本 */
  text: string;
  /** 投递方式 */
  deliverAs: "steer" | "followUp";
  /** 优先级（拷贝自 orchestrator.priority） */
  priority: number;
}

interface ContextInjection {
  /** 来源 orchestrator ID */
  sourceId: string;
  /** 注入内容 */
  content: string;
  /** 显示方式（false = 对用户折叠） */
  display: boolean;
  /** customType 用于 TUI 渲染 */
  customType: string;
}
```

## Composer Extension（编排管理器）

一个独立的 `composer` 扩展，不注册用户 tool/command，负责维护一个 orchestrator 栈，管理每轮的 context injection 和 steering 分配。

### 栈模型

```
                  ┌──────────────┐
栈顶 → 活跃的     │ coding-wf    │ ← 当前驱动 agent 循环
                  ├──────────────┤
                  │ goal         │ ← 挂起，不驱动
                  ├──────────────┤
                  │ (栈底)       │
                  └──────────────┘
```

**规则**：
- 栈顶 orchestrator 是当前唯一的"活跃"orchestrator
- 栈中其他 orchestrator 处于"挂起"状态
- 新 orchestrator 入栈时，当前栈顶自动挂起
- 栈顶 orchestrator 完成时，自动出栈，下一个 orchestrator 恢复

### Event Handler 集成

```
before_agent_start:
  1. composer 检查栈
  2. 调用栈顶的 getContextInjection() → 注入为主要上下文
  3. 调用挂起中 orchestrator 的 getContextInjection() → 注入为背景信息（可选）
  4. 调用所有 capability/observer 的正常 context

agent_end:
  1. composer 检查栈
  2. 调用栈顶的 getSteering() → 如果有，投递
  3. 栈顶无 steering → 不做任何事（不 fallback 到父级）
  4. 栈空 → 不做任何事

turn_end:
  1. composer 更新所有 orchestrator 的 widget/status
```

## 状态归约（State Reduction）

当子 orchestrator 完成时，它需要产出**状态归约摘要**让父 orchestrator 理解发生了什么事，而不需要知道内部细节：

```typescript
interface OrchestratorResult {
  /** 完成状态 */
  status: "completed" | "aborted" | "failed";
  /** 子 orchestrator 的 ID */
  childId: string;
  /**
   * 产出摘要：子 orchestrator 的关键产出物（文件路径、结果摘要等）。
   * 父 orchestrator 根据这些信息决定如何使用子任务的成果。
   */
  deliverables: Array<{
    type: string;      // "file" | "evidence" | "summary"
    path?: string;     // 文件路径（如果是 file 类型）
    description: string;
  }>;
  /** 资源消耗摘要 */
  resourceUsage?: {
    tokens: number;
    turns: number;
    durationSeconds: number;
  };
  /**
   * 关键数据的结构化合并信息。
   * 父 orchestrator 可以读取此字段将子 orchestrator 的状态合并到自己的状态中。
   * 例如：子 coding-workflow 的生成了 5 个 issue comments，
   *       父 goal 可以将 "5 comments added" 记录为 task evidence。
   */
  evidence?: string;
}
```

## 嵌套启动触发

通过 `pi.events` 事件总线提供通用的"启动子 orchestrator"触发通道：

```typescript
// pi.events channel: "composer"

// 请求启动子 orchestrator
pi.events.emit("composer:launch-child", {
  type: "goal" | "coding-workflow",
  config: {
    objective: "...",
    budget: { ... },
  },
});

// 子 orchestrator 入栈/出栈通知
pi.events.emit("composer:child-started", { parentId: "goal", childId: "coding-wf" });
pi.events.emit("composer:child-completed", { parentId: "goal", childId: "coding-wf", result });
```

## 迁移路径

### 阶段零：约定（当前可落地）

不修改代码，仅在 task prompt / skill 中约定行为规则：

- "当你有一个活跃的 goal 时，不要启动 coding-workflow"
- "在 coding-workflow 的 Phase 3 (Dev) 中，你可以使用 goal_manager 创建子任务，但完成后必须清除 goal 状态"

**代价**：纯靠 LLM 遵守，不可靠。

### 阶段一：Event Bridge（约 200 行）

在两个 orchestrator 中各自添加 `pi.events` 监听：

```typescript
// goal 监听 coding-workflow 的 phase 事件
pi.events.on("coding-wf:phase-started", () => { suspendGoal(); });
pi.events.on("coding-wf:phase-completed", (result) => { resumeGoal(result); });

// coding-workflow 监听 goal 的事件
pi.events.on("goal:task-started", () => { /* 不冲突 */ });
```

**代价**：点对点耦合，每新增一个 orchestrator 就要改配对代码。

### 阶段二：Composer Extension（约 500 行）

创建独立的 `composer` 扩展，并重构现有 orchestrator 适配生命周期接口：

```
xyz-pi-extensions/
  composer/
    index.ts       ← 工厂函数：注册 composer 事件 + 管理 orchestrator 栈
    src/
      index.ts     ← 扩展入口
      protocol.ts  ← OrchestratorLifecycle 等类型定义
      stack.ts     ← 栈管理逻辑
      steers.ts    ← Steering bus 逻辑
      context.ts   ← Context injection 逻辑
```

适配步骤：
1. `goal/src/index.ts`：提取出 `activate/suspend/resume/abort/getSteering/getContextInjection` 方法
2. `coding-workflow/src/index.ts`：同样提取
3. `composer/src/index.ts`：管理栈，在事件中分发

### 阶段三：标准化注入 Pi Core（长期）

需要 Pi 框架支持：
- **`pi.sendUserMessage()` 优先级参数** — 允许低优先级 steering 被高优先级覆盖
- **`before_agent_start` 可停止传播** — handler 返回 `{ stopPropagation: true }` 时跳过后续 handlers
- **`before_steering_send` 事件** — 允许扩展拦截、修改、丢弃 steering 消息
- **Context injection 分层排序** — 按优先级排列注入顺序，高优先级靠前

## 被认为可行的替代方案

### 方案 A：合并为统一扩展

将 goal 和 coding-workflow 合并为一个大型扩展，内部管理两级状态机。

**优点**：没有跨扩展协调问题。

**缺点**：耦合度高，不可复用。新增第三种编排模式（如 plan-mode）需要再次合并或 fork。

### 方案 B：只用 subagent 做嵌套

不嵌套 orchestrator，而是在 goal 的 task 中通过 subagent 派发独立子任务。

**优点**：进程隔离，天然无冲突。

**缺点**：subagent 没有主 session 的完整上下文，task prompt 需要携带全部信息；subagent 不能使用主 session 的 extension tools。

### 方案 C：全局互斥锁

通过 `pi.events` 实现"同一时间只有一个 orchestrator 可以活跃"的全局锁。

**优点**：实现简单，约 100 行。

**缺点**：锁粒度太粗，无法实现真正的嵌套（父 orchestrator 等待子 orchestrator 完成后继续）。

## 决策

**采用阶段二（Composer Extension）作为目标态。** 原因：

1. 阶段一（Event Bridge）是点对点耦合，每新增一个 orchestrator 都要改所有已有扩展——不可扩展
2. 阶段三依赖 Pi 核心改动，不受项目控制
3. Composer Extension 是独立扩展，可以在 `xyz-pi-extensions` 内闭环实现
4. 与 subagent 的关系清晰：subagent 是 **capability provider**（进程隔离），composer 是 **orchestrator manager**（同进程编排）

## 决策代价

1. **性能开销**：每一轮 event loop 中 composer 需要查询所有 orchestrator 的 steering/context，额外 O(n) 开销
2. **Orchestrator 重构工作**：goal 和 coding-workflow 需要提取生命周期方法，涉及内部状态的可见性调整
3. **学习曲线**：新扩展必须遵循协议，增加了开发复杂度
4. **调试难度**：多个 orchestrator 的状态栈增加了 bug 排查的复杂度

## 未解决的问题

1. Token 预算在嵌套场景的归属：如果 goal 有 50000 token 预算，coding-workflow 嵌套时消耗了 10000，这 10000 应该算 goal 的还是 coding-workflow 的？
2. Stall 检测的嵌套语义：coding-workflow 的一个 gate 阶段可能自然停留很多轮，这算 goal 的 stall 还是不算？
3. Widget/Status 的显示策略：栈中有 3 个 orchestrator 时，footer 的 status line 如何展示？
