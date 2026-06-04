---
verdict: pass
---

# Todo Extension v4 — Agent Loop + Verification + Batch Update

## Background

`@zhushanwen/pi-todo` 是 Pi coding agent 的轻量级任务追踪扩展。用户反馈当前版本（v3）存在三个核心问题：

1. **无法自动闭合** — Todo 没有 `agent_end` handler，AI 完成所有任务后无人检查并自动闭合。对比之下，`@zhushanwen/pi-goal` 有完整的 agent loop 支撑。
2. **提醒机制无效** — v3 的 auto-clear / reminder / verification nudge 在 `before_agent_start` 中注入 `display: true` 的消息，这些消息不进 AI 上下文，AI 看不到。
3. **缺少验证机制** — 复杂任务完成后无法自动触发验证，依赖 AI 自觉检查。

此外，todo 的 API 不支持批量更新状态（`update` 只接受单条），导致 AI 在完成多项任务时需要多次工具调用。

## Functional Requirements

### FR-1: Todo 数据模型扩充 [VERIFIED]

现有 `Todo` 接口（`extensions/todo/src/index.ts:19`）扩充：

```typescript
interface Todo {
  id: number;
  text: string;           // 任务描述，TUI 展示
  verifyText?: string;    // 验证描述（可选），AI 读取但 TUI 不展示具体内容
  status: "pending" | "in_progress" | "verifying" | "completed" | "failed";
  verifyAttempts: number;  // 已失败的验证次数
}
```

- `text`：不变，TUI 显示
- `verifyText?`：新增。存在时 TUI 行末显示 `[待验证]`（不含具体内容），不存在时显示 `[无需验证]`。AI 通过 `<todo_context>` 注入读到 `verifyText` 原文，作为验证标准
- `status`：新增 `"failed"` 和 `"verifying"` 状态（验证失败 2 次后进入 `failed`；`verifying` 为验证进行中的过渡态），允许用户手动 override
- `verifyAttempts`：新增。0/1/2，达到 2 后不再自动重试

向后兼容：`verifyText` 缺失视为 `[无需验证]`，`verifyAttempts` 缺失视为 0，旧 `"completed"` 状态保持不变。

### FR-2: `todo add` 新增 `verifyTexts` 参数 [VERIFIED]

```typescript
// 当前 TodoParams (index.ts:42)
action: "add"
texts: string[]           // 不变
verifyTexts?: string[]    // 新增，与 texts 一一对应
```

- `verifyTexts` 长度必须 ≤ `texts` 长度，超出时报错
- 不传则所有 task 的 `verifyText = undefined`（`[无需验证]`）
- AI 使用 `<todo_context>` 中的 verifyText 原文执行验证，不是凭空检查
- API 设计：可选的并行数组，与现有 `texts` 模式一致

### FR-3: `todo update` 新增批量 `updates[]` 参数 [VERIFIED]

```typescript
// 保留旧参数（单条）：
action: "update"
id: number
status?: string
text?: string

// 新增批量参数（优先级高于单条参数）：
updates?: Array<{
  id: number;
  status?: string;
  text?: string;
}>
```

- `updates[]` 存在时优先使用批量，忽略 `id`/`status`/`text`
- 同一 `id` 不能在 `updates[]` 中出现两次
- 每个 item 至少包含 `status` 或 `text` 之一
- 批量中某个 id 不存在 → 整体返回错误（all-or-nothing，避免部分更新导致状态不一致）

### FR-3b: `todo list` 输出包含 verifyText

`list` action 的文本输出（AI 直接读取）中，有 verifyText 的任务追加 `| 验证: <verifyText>` 后缀。TUI 显示不变（`renderResult` 仅显示 `[待验证]` 标签）。

```
[x] #1: 修复登录模块 | 验证: 密码错误时返回正确错误码
[x] #2: 创建目录
```

### FR-4: `agent_end` 循环（核心新增）

在 `pi.on("agent_end")` 中注册新 handler，每个 AI 执行轮次后触发：

1. **自动闭合检查**：所有 todo 均为 `completed` → 从全部完成的 `agent_end` 起算 2 轮后自动 clear
2. **停滞检测**：有 `pending`/`in_progress` 任务且超过 STALL_THRESHOLD（5）轮无 todo 调用 → 注入 `<todo_context>` 提醒
   - REMINDER_INTERVAL（3）用于距上次 todo 调用的常规提醒，STALL_THRESHOLD（5）用于无任何更新的深度停滞标记。两者梯度：REMINDER_INTERVAL 到期先触发轻提醒，STALL_THRESHOLD 到期触发停滞标记
3. **自动验证触发**：有任务被 mark 为 `completed` 且含 `verifyText` → 自动注入验证上下文
4. **验证失败处理**：`verifyAttempts >= 2` → 状态设为 `failed`，通知用户

Context 注入格式（参考 goal 的 `<goal_context>` 模式，下为 `agent_end` 中的示例；`before_agent_start` 注入不包含 Turn X，因事件本身已在轮次起点触发）：

```
<todo_context>
[TODO] Turn X — 3 tasks pending, 2 completed
#1: 修复登录模块 [待验证: 密码错误时返回正确错误码]
#3: 创建目录 [无需验证]

Rules:
- 优先使用 updates[] 批量更新状态，减少工具调用次数
- 有 [待验证] 的任务，verifyText 即是验证标准，必须验证通过后才能标记 completed
- 全部完成后工具自动闭合
</todo_context>
```

verifyText 原文在 `<todo_context>` 中完整暴露，AI 可以根据内容执行验证。TUI 仅显示 `[待验证]` 标签（不含具体内容），保持 UI 简洁。

Context 注入进 AI 上下文但不显示在 TUI 消息中。`before_agent_start` 通过 handler return `{ message: { display: false } }`，`agent_end` 使用 `pi.sendUserMessage(content, { deliverAs: "steer" })` — 两者功能等价，均避免干扰用户视线。

### FR-5: `before_agent_start` 改造

替换现有 v3 的三个 `display: true` 提醒消息（todo-auto-clear、todo-verification-nudge、todo-reminder）：

- **不再使用** `display: true` 的消息注入方式（当前方式不进 AI 上下文）
- 改为 `<todo_context>` 注入（handler return `{ message: { display: false } }`），内容聚焦待完成任务概览，不包含 Turn X 和 completed 计数（因事件在轮次起点触发，agent_end 单独处理完整详情）
- `before_agent_start` 中注入 pending 任务概览，`agent_end` 中做验证/提醒/stall
- 保持 TUI 状态栏和 widget 不变（这部分工作正常）

### FR-6: `registerMessageRenderer`

为 todo 的 custom 消息类型注册 renderer（类似 goal `index.ts:885`）：

- `todo-context` — 注入的 `<todo_context>` 消息，折叠显示 `[TODO] N pending`
- 保持现有 `renderCall`/`renderResult` 不变（`index.ts:718,728`）

### FR-7: 提示词重写

根据 meta-sk-skill-writer 原则全面重写 tool 的三个提示词字段：

**promptSnippet**（已有 `index.ts:697`）：
> "Use todo when breaking multi-step work into trackable items during normal (non-goal) conversation. Not for single-step operations."

**description** 末尾追加：
> "When /goal is active, do NOT use this tool — use goal_manager's add_subtasks instead."

**promptGuidelines**（完整替换）：
```
- [Usage] 多步骤工作（3+步）时使用。AI 自发创建，无需用户触发
- [Goal 冲突] /goal 激活后禁止使用 todo — 改用 add_subtasks
- [批量优先] 完成多项任务时使用 updates[] 批量更新，减少工具调用次数
- [验证] 复杂任务创建时附带 verifyText，定义验证逻辑。有 [待验证] 的任务必须在 completed 前执行验证
- [验证失败] 验证失败 2 次后任务进入 failed 状态，由用户决定
- [自动闭合] 全部完成后工具会在几轮后自动清理，无需手动 clear
- [Not for] 单步操作、简单对话、/goal 已激活时
```

### 常量表

| 常量 | 值 | 说明 |
|------|-----|------|
| `AUTO_CLEAR_DELAY_ROUNDS` | 2 | 全部完成后保留的轮数 |
| `STALL_THRESHOLD` | 5 | 任务无更新的停滞阈值（轮） |
| `REMINDER_INTERVAL` | 3 | 距上次 todo 调用的提醒间隔（轮） |
| `MAX_VERIFY_ATTEMPTS` | 2 | 验证最大重试次数 |

## Acceptance Criteria

### AC-1: 数据模型
- [ ] `Todo` 接口包含 `verifyText?: string` 字段
- [ ] `Todo` 接口包含 `status: "failed"` 和 `status: "verifying"` 枚举值
- [ ] `Todo` 接口包含 `verifyAttempts: number` 字段
- [ ] 旧 session 数据反序列化时，缺失字段自动补默认值

### AC-2: `todo add` 支持 `verifyTexts`
- [ ] `todo add(texts=["A","B"], verifyTexts=["验证A"])` → #1 有 verifyText，#2 无
- [ ] `verifyTexts` 不传时所有 task 的 verifyText 为 undefined
- [ ] TUI 显示 `#1: A [待验证]` 和 `#2: B [无需验证]`

### AC-3: `todo update` 支持批量
- [ ] `todo update(updates=[{id:1,status:completed},{id:2,status:in_progress}])` 一次调用更新两个
- [ ] 保留 `todo update(id=1,status=completed)` 向后兼容
- [ ] 批量中重复 id → 报错
- [ ] 批量中不存在的 id → 整体回滚报错

### AC-4: `agent_end` 自动循环
- [ ] 所有任务完成 → 2 轮后自动 clear（todos = []）
- [ ] 存在未完成任务且超过 REMINDER_INTERVAL 轮未调用 todo → 注入 `<todo_context>` 提醒
- [ ] 任务停滞超过 STALL_THRESHOLD 轮 → 在 context 中标记停滞
- [ ] 任务被标记 completed 且有 verifyText → 自动注入验证上下文

### AC-5: 验证流程
- [ ] 有 verifyText 的任务被标记 completed → agent_end 注入验证提醒
- [ ] AI 执行验证后再次标记 completed → 验证通过，保留状态
- [ ] AI 验证发现有问题 → verifyAttempts +1，提醒修复
- [ ] verifyAttempts >= 2 → 状态设为 failed，通知用户
- [ ] 无 verifyText 的任务直接标记 completed，不触发验证

### AC-6: 提示词
- [ ] tool description 末尾有 "/goal 激活时禁止使用" 说明
- [ ] promptGuidelines 包含所有 FR-7 列出的规则
- [ ] promptSnippet 已被触发条件驱动（"Use when..." 开头）

### AC-7: Context 注入始终使用 `display: false`
- [ ] `before_agent_start` 中的 todo_context 注入使用 display: false
- [ ] `agent_end` 中的验证提醒使用 display: false
- [ ] TUI 状态栏和 widget 显示保持不变

## Constraints

1. **向后兼容**：所有现有 session 的 todo 数据必须在升级后正常加载。旧 `status: "completed"` 和 `done: boolean` 需要和之前一样兼容。（`index.ts:138` 已有 `migrateTodo` 函数模式）
2. **与 goal 共存**：todo 和 goal 是独立扩展，各自注册自己的 event handlers，互不干扰。goal 激活时 AI 应自觉不使用 todo（通过 promptGuidelines 约束，非代码级禁止）
3. **不引入新依赖**：所有改动在现有 `typebox` + Pi SDK 范围内，不新增 npm 依赖
4. **session 持久化不变**：继续使用 `pi.appendEntry` + `ctx.sessionManager.getEntries`，不引入新存储机制。`_render` 协议保持可选（已有实现）
5. **常量可调整**：`AUTO_CLEAR_DELAY_ROUNDS`、`STALL_THRESHOLD`、`REMINDER_INTERVAL`、`MAX_VERIFY_ATTEMPTS` 在模块顶部定义为 `const`，方便后续调参

## 业务用例

### UC-1: AI 自发管理多步骤任务
- **Actor**: AI coding agent
- **场景**: 用户给了一个模糊需求（如"帮我重构这个模块"），AI 自行分解为 5 步
- **预期结果**: AI 创建 5 个 todo，逐项完成，全部完成后 tool 自动闭合，用户无感知

### UC-2: 复杂任务的验证
- **Actor**: AI coding agent
- **场景**: AI 将"修复登录模块"加入 todo 并附带 `verifyText="密码错误时返回正确错误码，不输出敏感信息"`
- **预期结果**: AI 修改完代码后，agent_end 自动注入验证提醒，AI 执行验证后标记 completed 或重新修复

### UC-3: 批量完成
- **Actor**: AI coding agent
- **场景**: AI 并行执行了 3 个独立任务，全部完成后一次性调用 `todo update(updates=[{id:1,status:completed},{id:2,status:completed},{id:3,status:completed}])`
- **预期结果**: 1 次 tool call 更新 3 个任务，节省 context 空间

### UC-4: 验证失败
- **Actor**: AI coding agent + 用户
- **场景**: AI 两次尝试验证均失败，任务进入 `failed` 状态
- **预期结果**: TUI 显示 `✗ [验证失败]`，AI 向用户报告，用户决定是强制通过 (manual update) 还是删除任务

## Complexity Assessment

中等复杂度。涉及：
- 数据模型扩展（向后兼容）
- API 参数扩展（`verifyTexts` + `updates[]`）
- 新增 `agent_end` 事件 handler（核心新增）
- 重构 `before_agent_start` handler（替换 display:true → display:false）
- 提示词重写（无编码变更）
- 新增 `registerMessageRenderer`
