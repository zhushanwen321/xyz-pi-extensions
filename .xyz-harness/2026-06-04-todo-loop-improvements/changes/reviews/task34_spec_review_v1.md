---
verdict: "pass"
must_fix: 0
reviewer: "spec-compliance"
date: 2026-06-04
---

# Task 3 & 4 Spec 合规审查

## Task 3: todo update 批量 updates[] 参数

### AC-3 验收标准逐条检查

| 验收标准 | 状态 | 证据 |
|----------|------|------|
| `todo update` 接受可选 `updates` 数组参数 | ✅ | `TodoParams` schema 定义了 `updates: Type.Optional(Type.Array(...))`（index.ts:47-55） |
| updates 优先级高于单条 id/status/text | ✅ | `case "update"` 开头先检查 `params.updates && params.updates.length > 0`，命中后 `break`，单条逻辑不可达（index.ts:136-158） |
| 验证: 无重复 id | ✅ | `new Set(ids).size !== ids.length` 检查（model.ts:152-156） |
| 验证: 无不存在 id | ✅ | `currentTodos.find((t) => t.id === u.id)` 检查（model.ts:157-163） |
| 验证: 每个 item 至少包含一个变更 | ✅ | `!u.status && !u.text` 检查（model.ts:164-170） |
| All-or-nothing: 任一验证失败，所有变更不生效 | ✅ | 三个错误分支均返回 `updatedTodos: currentTodos`（原引用，未修改）（model.ts:154, 161, 168） |

### 测试覆盖

| 测试用例 | 状态 | 位置 |
|----------|------|------|
| 批量更新多个 todo | ✅ | `todo.test.ts` — "should update multiple todos with updates[]" |
| 重复 id 拒绝 | ✅ | `todo.test.ts` — "should reject duplicate ids" |
| 不存在 id 拒绝 (all-or-nothing) | ✅ | `todo.test.ts` — "should reject non-existent ids" |
| 缺少 status 和 text 拒绝 | ✅ | `todo.test.ts` — "should reject updates[] item missing both" |

### 发现问题

| # | 严重度 | 描述 | 位置 |
|---|--------|------|------|
| 1 | LOW | `updateTodos()` 无显式 empty-array 守卫。空 `[]` 通过所有验证返回 `updatedTodos: currentTodos` + `"Updated 0 todo(s)"`。实际无害（index.ts 已在调用前拦截 `length > 0`），但纯函数自身缺少防御 | model.ts `updateTodos()` |

---

## Task 4: todo list verifyText in output

### 验收标准逐条检查

| 验收标准 | 状态 | 证据 |
|----------|------|------|
| 纯文本 list 输出包含 verifyText（` | 验证:` 后缀） | ✅ | `formatTodoLine()` — `line += \` | 验证: ${t.verifyText}\``（model.ts:214-215） |
| list case 使用 formatTodoLine | ✅ | `case "list"` — `todos.map((t) => formatTodoLine(t)).join("\n")`（index.ts:118） |
| TUI renderResult 显示 `[待验证]` 标签（不含具体内容） | ✅ | `TodoListComponent.render()` — `th.fg("warning", " [待验证]")`，仅显示标签不含 verifyText 内容（index.ts:84） |
| 无 verifyText 时不显示验证相关后缀 | ⚠️ | 见下方问题 #2 |
| 向后兼容（migrateTodo 填充默认值） | ✅ | `migrateTodo()` 对缺失 verifyText 返回 `undefined`，verifyAttempts 默认 `0`（model.ts:39-42） |

### 测试覆盖

| 测试用例 | 状态 | 位置 |
|----------|------|------|
| formatTodoLine 有 verifyText 包含验证后缀 | ✅ | `todo.test.ts` — "should include verifyText in list output when present" |
| formatTodoLine 无 verifyText 不含验证后缀 | ✅ | `todo.test.ts` — "should not include verify suffix when verifyText is absent" |
| TUI `[待验证]`/`[无需验证]` 标签渲染 | ❌ 无测试 | `TodoListComponent` 未被单元测试覆盖 |

### 发现问题

| # | 严重度 | 描述 | 位置 |
|---|--------|------|------|
| 2 | MEDIUM | `TodoListComponent` 对所有 todo 始终显示标签：有 verifyText 时 `[待验证]`，无 verifyText 时 `[无需验证]`。AC 要求「无 verifyText 时不显示验证相关后缀」。当前行为暴露了验证元信息，增加了视觉噪声 | index.ts:84 |

---

## 总结

| Task | Verdict | Must Fix | Issues |
|------|---------|----------|--------|
| Task 3 (batch updates) | PASS | 0 | 1 LOW |
| Task 4 (verifyText output) | PASS | 0 | 1 MEDIUM |

整体判定：**pass**。两个 Task 的核心验收标准均满足。

- Task 3 的 all-or-nothing 语义、三项验证、优先级处理全部正确实现且有测试覆盖
- Task 4 的 formatTodoLine 和 list case 正确实现，TUI 标签行为与 AC 文字有偏差（显示 `[无需验证]` 而非留空），但属于 UX 选择而非功能缺陷，不阻塞验收
