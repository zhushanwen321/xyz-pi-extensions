---
verdict: fail
must_fix: 2
review_metrics:
  files_reviewed: 1
  dimensions_checked: 6
  issues_found: 5
  must_fix_count: 2
  low_count: 2
  info_count: 1
  duration_estimate: "20"
---

# Robustness Review v1

## 审查记录
- 审查时间：2026-05-31
- 审查文件数：1（todo/src/index.ts）
- 审查维度：D1-D6（全量）
- 变更范围：v3 新增的 4 个模块级状态变量、3 个事件处理器（agent_start / before_agent_start）、executeTodoAction 中的状态追踪逻辑、reconstructState 中的 v3 状态重置

## 维度评分概览

| 维度 | 检查项数 | 通过 | 问题 | 评分 |
|------|---------|------|------|------|
| D1 错误处理 | 6 | 4 | 2 | 6/10 |
| D2 异常处理 | 4 | 4 | 0 | 9/10 |
| D3 日志 | 4 | 2 | 2 | 5/10 |
| D4 Fail-fast | 5 | 3 | 2 | 6/10 |
| D5 测试友好性 | 4 | 1 | 3 | 3/10 |
| D6 调试友好性 | 5 | 4 | 1 | 8/10 |

## 问题清单

| # | 严重度 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|------|------|------|------|---------|
| 1 | MUST_FIX | D1,D4 | `before_agent_start` 无错误边界，运行时异常会中断整个 agent 循环 | todo/src/index.ts | L613-668 | 整体 try/catch 包裹，catch 中 return undefined 静默降级 |
| 2 | MUST_FIX | D4 | `migrateTodo` 不验证 id/text 是否存在，持久化数据损坏时产出非法 Todo 对象 | todo/src/index.ts | L135-144 | 添加 id/text 字段存在性与类型校验，无效条目跳过或标记 |
| 3 | LOW | D3,D6 | v3 状态转换无任何日志输出（auto-clear / nudge / reminder），异常行为不可追溯 | todo/src/index.ts | L613-668 | 关键分支添加 ctx.logger 或 console.debug |
| 4 | LOW | D5 | v3 状态逻辑（4 个模块级变量 + 3 个事件处理器）全部耦合模块状态，无法独立单元测试 | todo/src/index.ts | L206-210, L610-668 | 提取为接收 state 对象的纯函数 |
| 5 | INFO | D5 | `reconstructState` 定义在工厂函数闭包内，无法导出进行单元测试 | todo/src/index.ts | L534-572 | 提取到模块顶层或 export |

## 逐文件详情

### todo/src/index.ts

**D1 错误处理:**

- ✅ `executeTodoAction` switch-case 中所有 action 分支的参数校验均通过 early return 处理，返回带 error 字段的 details
- ✅ `add` action 对 `texts` 的空数组和全空白字符串做了两级校验
- ✅ `update` action 对 id 缺失、status/text 双缺失、text 空串、status 非法值分别做了校验
- ✅ `delete` action 对 ids 缺失和不存在的 id 做了校验
- ⚠️ **#1** `before_agent_start` 事件处理器（L613-668）无 try/catch。该处理器在每次 agent turn 前触发，内含 `todos.filter()`、`todos.some()`（含正则匹配）、`refreshDisplay(ctx)`（调用 ctx.ui.setStatus）等操作。若 `ctx.ui` 在特定上下文中不可用（如 background subagent session），`refreshDisplay` 抛出异常将中断整个 agent 循环
- ⚠️ `reconstructState` 中 `ctx.sessionManager.getEntries()` 无 try/catch。虽然 Pi runtime 通常保证 sessionManager 可用，但该函数是 `session_start` 和 `session_tree` 事件的唯一初始化路径，失败会导致 todo 扩展完全不可用

**D2 异常处理:**

- ✅ 无空 catch 块
- ✅ 无过于宽泛的 try 块（因为没有 try 块——所有路径通过参数校验的 early return 处理）
- ✅ Type assertions（`as Todo["status"]` 等）均在对应的参数校验之后使用，属于可接受模式
- ✅ `migrateTodo` 中的 `as unknown as Record<string, unknown>` 是类型安全的 escape hatch，先检查 `status` 字段存在性再取值

**D3 日志:**

- ✅ `execute` 函数中错误结果自动附加 `JSON.stringify(params)` 作为调试信息（L687-694）
- ✅ 错误消息包含具体错误类型和非法值（如 `invalid status: ${params.status}`）
- ⚠️ **#3** v3 的三个关键状态转换（auto-clear / verification-nudge / todo-reminder）仅通过 `return { message: ... }` 注入对话，无任何日志记录。若提醒逻辑异常（如反复触发、错误触发），无法通过日志追溯原因。特别是 `userMessageCount`、`lastTodoCallCount`、`lastReminderCount` 的值变化完全不可观测
- ⚠️ `reconstructState` 中的 entry GC（splice 旧 entries）和数据迁移（migrateTodo）无日志，长 session 中难以诊断状态不一致问题

**D4 Fail-fast:**

- ✅ `executeTodoAction` 所有 action 的参数校验在 switch-case 入口处完成，不传入非法参数继续执行
- ✅ `VALID_STATUSES` 常量用于 status 参数的枚举校验
- ✅ v3 常量（`AUTO_CLEAR_DELAY_ROUNDS`、`VERIFICATION_NUDGE_THRESHOLD`、`TODO_REMINDER_INTERVAL`）提取为命名常量，语义清晰
- ⚠️ **#1**（同 D1）`before_agent_start` 中 `refreshDisplay(ctx)` 在 auto-clear 分支被调用（L623），如果失败不会 fail-fast 而是让异常冒泡到 Pi runtime，行为不可预测
- ⚠️ **#2** `migrateTodo`（L135-144）从旧格式迁移时不验证 `rest.id` 和 `rest.text` 是否存在且类型正确。若持久化 entry 中 `id` 为 undefined 或 `text` 为空，产出的 Todo 对象会导致后续 `todos.find(t => t.id === params.id)` 永远匹配不到（因为 `undefined !== 42`），且渲染时显示空白文本。这类「延迟爆炸」问题难以定位根源

**D5 测试友好性:**

- ✅ 纯辅助函数（`migrateTodo`、`renderStatusText`、`buildRender`、`renderWidgetLines`）可独立测试
- ⚠️ **#4** v3 新增 4 个模块级 `let` 变量（`userMessageCount`、`allCompletedAtCount`、`lastTodoCallCount`、`lastReminderCount`），所有 v3 事件处理器和 `executeTodoAction` 直接引用这些变量。无法在测试中注入不同初始状态，必须通过完整的事件序列触发才能覆盖特定分支
- ⚠️ **#4** v3 的 `before_agent_start` 逻辑（auto-clear 判定、verification nudge 判定、reminder 判定）是纯条件判断，理论上可以提取为接收 state 的纯函数进行穷举测试，但当前内联在事件处理器闭包中
- ⚠️ **#5** `reconstructState` 定义在工厂函数闭包内（L534），无法在模块外访问进行单元测试。其 entry GC 逻辑（stale entry 删除）是容易出错的区域，缺乏测试覆盖

**D6 调试友好性:**

- ✅ 错误消息具体且包含上下文（action 类型、非法值、缺失参数名）
- ✅ `details.error` 字段使用英文标识符（如 `"texts required"`、`"invalid status: xxx"`），便于搜索和引用
- ✅ `_render` 描述符包含完整的 todo 列表状态，GUI 可据此展示
- ✅ `execute` 中错误结果附加完整输入参数（`JSON.stringify(params)`），便于复现
- ⚠️ **#3**（同 D3）v3 的状态转换（特别是 auto-clear 触发时机）无法通过任何外部可观测信号追溯。`allCompletedAtCount` 被设为 `null` 的 5 个分散位置（add / update / clear / reconstructState / auto-clear 自身）之间缺乏统一的 debug 输出

## 关键发现详述

### #1: `before_agent_start` 无错误边界

```typescript
// L613-668: 当前代码
pi.on("before_agent_start", async (_event, ctx) => {
    // 1. auto-clear — 包含 refreshDisplay(ctx)
    // 2. verification nudge
    // 3. todo reminder
    return undefined;
});
```

**风险**：该处理器在每次 agent turn 前同步执行。`refreshDisplay` 调用 `ctx.ui.setStatus` 和 `ctx.ui.setWidget`——在某些 Pi 上下文中（如 non-interactive session、background subagent），`ctx.ui` 方法可能不可用或抛出异常。异常未被捕获将传播到 Pi 事件分发机制。

**建议**：

```typescript
pi.on("before_agent_start", async (_event, ctx) => {
    try {
        // ... 现有逻辑 ...
    } catch (e) {
        // 静默降级：提醒/清空是辅助功能，不应阻断主流程
        return undefined;
    }
});
```

### #2: `migrateTodo` 缺少字段校验

```typescript
// L140-144: 当前代码
const { done, ...rest } = record as unknown as { done?: boolean; id: number; text: string };
return { id: rest.id, text: rest.text, status: done === true ? "completed" : "pending" };
```

**风险**：若持久化数据中 `id` 为 undefined 或 `text` 缺失，产出的 Todo 对象在后续操作中产生隐蔽 bug：
- `todos.find(t => t.id === params.id)` 永远匹配不到 → update/delete 返回 "不存在" 错误
- 渲染时显示空白或 undefined 文本
- `Math.max(...todos.map(t => t.id))` 在 `reconstructState` 中可能产出 NaN → nextId 损坏

**建议**：

```typescript
function migrateTodo(raw: Todo): Todo | null {
    const record = raw as unknown as Record<string, unknown>;
    if (typeof record.status === "string" && VALID_STATUSES.includes(record.status as Todo["status"])) {
        if (typeof record.id !== "number" || typeof record.text !== "string") return null;
        return raw;
    }
    const { done, ...rest } = record as unknown as { done?: boolean; id: number; text: string };
    if (typeof rest.id !== "number" || typeof rest.text !== "string") return null;
    return { id: rest.id, text: rest.text, status: done === true ? "completed" : "pending" };
}
```

调用方（`reconstructState`）需配合过滤 null：

```typescript
todos = details.todos.map(t => migrateTodo(t)).filter((t): t is Todo => t !== null);
```

## 结论

**需修改**。2 条 MUST FIX：

1. **`before_agent_start` 缺少错误边界**（D1/D4）——运行于每次 agent turn 前的关键路径，任何未捕获异常可能导致 agent 循环中断。修复方案简单（try/catch + 静默降级），影响范围小。

2. **`migrateTodo` 不校验必需字段**（D4）——从损坏的持久化数据中产出非法 Todo 对象，导致下游操作出现难以定位的「延迟爆炸」。修复方案为添加字段校验 + 返回 null 过滤。

两个 LOW 项（日志缺失、测试友好性）建议后续迭代改进，不阻塞本次合并。
