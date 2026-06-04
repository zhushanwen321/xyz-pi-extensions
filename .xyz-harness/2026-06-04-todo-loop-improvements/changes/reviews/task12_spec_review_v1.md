---
verdict: pass
must_fix: 0
---

# Task 1 & 2 Spec 合规审查

## Task 1: 数据模型增强 + 向后兼容

### AC-1 验收标准逐项对照

| # | AC 要求 | 实现位置 | 结果 |
|---|---------|----------|------|
| 1 | `Todo` 接口包含 `verifyText?: string` | model.ts:9 | PASS — `verifyText?: string` |
| 2 | `Todo` 接口包含 `status: "failed"` 枚举值 | model.ts:13, model.ts:15 | PASS — `VALID_STATUSES` 包含 `"failed"`，status 联合类型含 `"failed"` |
| 3 | `Todo` 接口包含 `verifyAttempts: number` | model.ts:11 | PASS — `verifyAttempts: number`（required，非 optional） |
| 4 | 旧 session 数据反序列化时缺失字段自动补默认值 | model.ts:40-52 | PASS — `migrateTodo` 对 verifyText 返回 `undefined`，verifyAttempts 返回 `0` |

### 检查步骤结果

| # | 检查项 | 结果 | 说明 |
|---|--------|------|------|
| 1 | model.ts — Todo 接口含 verifyText? / verifyAttempts | PASS | 两字段均在接口中，verifyText optional，verifyAttempts required |
| 2 | model.ts — migrateTodo 为旧数据提供默认值 | PASS | verifyText 用 `typeof === "string"` 守卫，verifyAttempts 用 `typeof === "number"` 守卫，均提供合理 fallback |
| 3 | model.ts — VALID_STATUSES 包含 "failed" | PASS | `["pending", "in_progress", "completed", "failed"]` |
| 4 | index.ts — 所有创建 todo 的地方设置了 verifyText/verifyAttempts | PASS | 仅通过 `addTodos()` 创建，该函数统一设置 `verifyText: verifyTexts?.[i]` 和 `verifyAttempts: 0`；`reconstructState` 通过 `migrateTodo` 补全 |
| 5 | todo.test.ts — 测试覆盖向后兼容和 failed status | PASS | 7 个测试用例覆盖：旧数据无 verifyText/verifyAttempts、failed status 接受、done:true/false 迁移、所有 4 种 valid status 验证 |

## Task 2: todo add 支持 verifyTexts 参数

### AC-2 验收标准逐项对照

| # | AC 要求 | 实现位置 | 结果 |
|---|---------|----------|------|
| 1 | `todo add(texts=["A","B"], verifyTexts=["验证A"])` → #1 有 verifyText，#2 无 | model.ts:93 (`verifyTexts?.[i]`) | PASS — 按索引映射，超出部分为 undefined |
| 2 | `verifyTexts` 不传时所有 task 的 verifyText 为 undefined | model.ts:93 | PASS — `verifyTexts?.[i]` 当 verifyTexts 为 undefined 时全部返回 undefined |
| 3 | TUI 显示 `[待验证]` / `[无需验证]` 标签 | — | NOT IN SCOPE — FR-3b/TUI 标签显示属于后续任务范围，不在 Task 2 验收标准内 |

### 检查步骤结果

| # | 检查项 | 结果 | 说明 |
|---|--------|------|------|
| 1 | index.ts — TodoParams 包含 verifyTexts | PASS | `verifyTexts: Type.Optional(Type.Array(Type.String()))` 已定义 |
| 2 | model.ts — addTodos() 处理 verifyTexts 长度验证 | PASS | L79: `verifyTexts.length > trimmed.length` 时返回 error `"verifyTexts too long"` |
| 3 | todo.test.ts — 有相关测试 | PASS | 7 个测试用例：索引映射、超长拒绝、不传兼容、等长映射、空 texts、全空 trim、trim + ID 分配 |

## 审查结论

两个 Task 的实现完全符合各自 AC 验收标准。关键实现要点：

- **向后兼容**：`migrateTodo` 对 `verifyText`（非 string → undefined）和 `verifyAttempts`（非 number → 0）均做了类型守卫 + 默认值填充
- **verifyTexts 映射**：使用 `verifyTexts?.[i]` 按索引映射，超出 texts 长度时在入口校验拒绝
- **数据完整性**：`addTodos` 统一为每个新 todo 设置 `verifyAttempts: 0`，保证非 optional 字段始终有值
- **测试覆盖**：16 个测试全部通过，覆盖正常路径、边界条件和向后兼容场景
