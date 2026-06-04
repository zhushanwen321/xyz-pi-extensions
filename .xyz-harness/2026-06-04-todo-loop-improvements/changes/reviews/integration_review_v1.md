---
verdict: pass
must_fix: 0
---

# Integration Review v1

## 审查范围

基于 BLR v1 的模拟数据路径，验证 todo 扩展各模块边界的正确性。

## 模块边界分析

### 1. model.ts ↔ index.ts

| 边界 | 调用点 | 正确性 |
|------|--------|--------|
| `addTodos()` | executeTodoAction `case "add"` | ✅ 参数传递正确, error 处理正确 |
| `updateTodos()` | executeTodoAction `case "update"` batch path | ✅ status 校验, duplicate/not-found 处理 |
| `migrateTodo()` | reconstructState / getDisplayStatus | ✅ 新旧格式转换 |
| `formatTodoLine()` | executeTodoAction `case "list"` | ✅ verifyText 后缀输出 |
| `buildRender()` | executeTodoAction 所有 action | ✅ _render 描述符构建 |
| `VALID_STATUSES` | TodoParams schema, migrateTodo, updateTodos | ✅ 三处引用, 类型一致 |

### 2. 事件 ←→ 函数调用

| 事件 | 调用的函数 | 副作用 | 正确性 |
|------|-----------|--------|--------|
| `session_start` | `reconstructState` + `refreshDisplay` | load from entries | ✅ |
| `session_tree` | `reconstructState` + `refreshDisplay` | restore state | ✅ |
| `agent_start` | `userMessageCount++` | count increment | ✅ (仅此一处) |
| `before_agent_start` | todo_context injection + status bar | display:false inject | ✅ |
| `agent_end` | verify-failed → needs-verify → auto-clear → stall → reminder | inject, modify state | ✅ |

### 3. Pi SDK 边界

| SDK API | 用途 | 正确性 |
|---------|------|--------|
| `pi.registerTool()` | todo tool | ✅ |
| `pi.registerCommand()` | /todos | ✅ |
| `pi.on()` | event handlers | ✅ |
| `pi.deliver()` | steer injection | ✅ (display: false) |
| `pi.registerMessageRenderer()` | todo-context rendering | ✅ |
| `ctx.ui.setStatus()` | status bar | ✅ |
| `ctx.ui.setWidget()` | widget lines | ✅ |
| `ctx.sessionManager.getEntries()` | state restore | ✅ |
| `pi.appendEntry()` | state persistence | ✅ (via execute flow) |

### 4. 数据流完整性

```
Tool call → executeTodoAction → addTodos/updateTodos → refreshDisplay → appendEntry
                                                                         ↓
                                                                   reconstructState
                                                                         ↓
                                                                next agent_end/agent_start
```

路径完整, 无数据丢失风险。

## 结论

**pass** — 模块边界清晰, model.ts 与 index.ts 的职责分离正确, Pi SDK 边界使用符合文档规范, 数据流完整无断裂。
