# Pi 中是否存在 `start_task` 的等价机制？

## Codex 的 `start_task` 是什么

Codex 中 `Session::start_task()` 是一个**内核级方法**，它：

```rust
// Codex 内核，非工具、非扩展接口
session.start_task(
    turn_context,       // 新创建的 TurnContext（含 sub_id）
    Vec::new(),         // 初始 response items（空）
    RegularTask::new()  // 普通 task 类型
).await;
```

当被 `maybe_start_goal_continuation_turn` 调用时：

1. 创建全新的 `TurnContext`（新的 sub_id）
2. 在 input queue 中注入 `continuation_prompt` 作为 ResponseItem
3. 直接启动模型推理（**不经过用户消息管道**）
4. 用户看不到"xxx 发了一条消息"，turn 是系统级隐式的

**本质**：在当前 session 内创建一个系统级的新 turn，不依赖用户输入。

## Pi 中没有 `start_task` 等价物

Pi 的 `AgentSession`（`agent-session.d.ts`）没有与 `start_task` 直接对应的方法。Pi 的 Agent 循环是**纯响应式的**——只有两种方式可以触发 Agent 运行：

### 方式一：sendUserMessage（用户消息管道）

```typescript
// AgentSession 方法
sendUserMessage(content, options?: {
  deliverAs?: "steer" | "followUp"
})
```

这是 Pi goal extension 实际使用的方式：

```typescript
// goal/index.ts agent_end handler
pi.sendUserMessage(continuationPrompt(state), { deliverAs: "followUp" });
```

**流程**：
```
agent_end
  → sendUserMessage("Continue working...", { deliverAs: "followUp" })
  → 消息进入 followUp 队列
  → Agent loop 从队列拉取 → 当作下一条用户消息 → 新 turn 开始
```

**与 Codex `start_task` 的差异**：
- **用户可见**：消息会出现在聊天历史中（显示为用户消息）
- **需要 approval**：取决于 approval 模式，可能需用户确认
- **走完整用户输入管道**：经过 extension event、skill expansion、prompt template expansion
- **不是直接启动推理**：只是推了一条消息到队列

### 方式二：sendCustomMessage（系统消息管道）

```typescript
// AgentSession 方法
sendCustomMessage(message, options?: {
  triggerTurn?: boolean,     // 是否触发新 turn
  deliverAs?: "steer" | "followUp" | "nextTurn"
})
```

这个离 Codex 的 `start_task` 更近一点：
- `triggerTurn: true`：不流式时直接启动新 LLM turn
- `display: false`：消息不显示给用户
- `deliverAs: "nextTurn"`：在下一次 turn 时传递

但仍然是消息队列机制，不是直接创建 turn 的内核调用。

### 方式三：steer / followUp（流式队列）

```typescript
steer(text)    // 当前 turn 工具调用完成后、下次 LLM 调用前注入
followUp(text) // agent 没有更多工具调用时，作为下轮用户消息

// 扩展 API 封装
pi.sendUserMessage(text, { deliverAs: "steer" })   // = steer()
pi.sendUserMessage(text, { deliverAs: "followUp" }) // = followUp()
```

**steer vs followUp 的区别**：
| | steer | followUp |
|---|---|---|
| 时机 | 当前 turn 工具调用完成后 | 当前 turn 完全结束后 |
| 效果 | 在同一 turn 内继续 | 开启新 turn |
| 用例 | 预算 steering / objective updated | 常规 continuation |

## Pi 的 Subagent 是否等于 `start_task`？

**不等于。** Subagent 是完全不同的机制：

| | `start_task` (Codex) | Subagent (Pi) |
|---|---|---|
| 作用域 | 同一 session 内 | 独立 session（可跨进程） |
| 上下文 | 共享当前 session 的 context | 独立的 model context（fork 或 fresh） |
| 返回 | 与当前 agent 同一响应流 | 子 agent 完成后返回结果 |
| 可见性 | 用户看不到新 turn 的创建 | 子 agent 会话独立可见 |
| 预算 | 共享当前 goal budget | 独立 budget |
| 工具 | 共享当前 tool set | 可配置不同 tool set |

Subagent 是**跨 session 的任务委托**，不是当前 session 内的 turn continuation。

## 架构差异的本质

```
Codex: 内核有完整的 Agent 循环控制权
  Session::start_task()  # 直接创建新 turn，不经过消息管道
  Session::input_queue    # 内核级输入队列，可注入 system items
  Session::active_turn    # 内核可预留 turn slot

Pi: 内核的 Agent 循环只响应外部消息
  AgentSession.prompt()    # 用户消息 → Agent 运行 → 完成
  AgentSession.steer()     # 流式队列（当前 turn 内）
  AgentSession.followUp()  # 队列（下个 turn）
  AgentSession.sendCustomMessage()  # 自定义消息（可 trigger turn）
```

Pi 的扩展架构决定了**内核不暴露 "创建新 turn" 的能力**——扩展只能通过消息队列间接触发 Agent 运行。这就是为什么 Pi 的 goal continuation 必须走 `sendUserMessage` 管道，而 Codex 可以直接调用 `start_task`。

## 对 Goal 系统的影响

由于 Pi 没有 `start_task`，Goal extension 的 continuation 通过 `sendUserMessage` 实现，导致：

1. **用户可见性**：continuation 消息会出现在聊天历史中（"Continue working toward the active thread goal..."），用户可能会感到困惑
2. **消息膨胀**：每个 continuation turn 都会增加一条用户消息 + 一条 assistant 回复，长期 goal 会快速膨胀 session
3. **Approval 依赖**：如果 approval 模式要求确认每条用户消息，continuation 会被打断
4. **无系统级 slot 预留**：Pi 没有 `active_turn` slot 预留机制，可能出现竞态

Codex 的 `start_task` 避免了这些问题——continuation 是系统级操作，对用户透明。

## 架构启示

如果要在 Pi 扩展中实现 Codex 级别的 auto-continuation，可以用的只有 `sendCustomMessage` + `triggerTurn: true` + `display: false`——这是最接近的替代方案。但它仍然绕不过消息队列，无法做到 Codex 那样在内核层面直接创建 turn。
