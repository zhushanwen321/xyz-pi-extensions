---
verdict: pass
must_fix: 0
---

# Robustness Review: Todo Extension v3 Loop Improvements

**日期**: 2026-06-04
**审查范围**: `2cf17bc..HEAD` — `extensions/todo/`
**审查文件**: `src/index.ts`, `src/model.ts`, `src/__tests__/todo.test.ts`

---

## Verdict: **pass**

| 指标 | 值 |
|------|------|
| must_fix | 0 |
| should_fix | 3 |
| nit | 3 |

---

## 六维度审查结果

### 1. 错误处理 ✅ 良好

| # | 严重度 | 位置 | 问题 | 建议 |
|---|--------|------|------|------|
| E-1 | nit | `model.ts:85-86` `migrateTodo` | `record.id as number` / `record.text as string` 无运行时校验——若旧 entry 的 id 是 string，会产生静默的类型不一致 | 可在 reconstructState 调用方加 `console.warn` 防御，但当前数据源完全可控（仅 todo tool 写入），风险极低 |
| E-2 | should | `index.ts:319` `executeTodoAction` | `params.status` 在 batch `updates[]` 路径中未校验合法值——`updateTodos()` 将 `u.status` 直接 `as Todo["status"]` 而不检查是否在 VALID_STATUSES 内 | 单条 update 路径有完整校验，batch 路径缺失。应在 `updateTodos` 或调用方增加 status 合法性检查 |

### 2. 异常管理 ✅ 良好

| # | 严重度 | 位置 | 问题 | 建议 |
|---|--------|------|------|------|
| A-1 | should | `index.ts` agent_end / before_agent_start | `catch {}` 完全静默吞异常，无任何日志。若 `refreshDisplay(ctx)` 抛出（如 ctx 已失效），完全无法诊断 | 至少加 `console.error("[todo]", e)` 再 return。注意 Pi 扩展内 console 会写到进程日志 |
| A-2 | nit | `index.ts:368` `addResult.resultText!` | `resultText!` 非空断言——虽然逻辑上 error 路径一定有 resultText，但 `addTodos` 的 error 返回中 `resultText` 字段类型是 `string | undefined` | 将 `AddResult.resultText` 在 error 场景改为 `resultText: string`，或使用 `resultText ?? "Unknown error"` |

### 3. 日志 ✅ 可接受

| # | 严重度 | 位置 | 问题 | 建议 |
|---|--------|------|------|------|
| L-1 | nit | `index.ts` 全文 | 无任何日志输出。调试 agent_end 循环行为（stall/reminder/verify 触发）只能靠断点或加临时 log | 建议在关键决策点加 `console.debug("[todo] stall detected, ...")` 级别的日志。Pi 扩展的 console 输出在开发时可追踪 |

### 4. Fail-fast ✅ 良好

| # | 严重度 | 位置 | 问题 | 建议 |
|---|--------|------|------|------|
| F-1 | should | `index.ts:316-319` `executeTodoAction` | `userMessageCount++` 在所有 action 之前执行（含 list），意味着每次 list 调用都推进轮数计数器。若 AI 频繁调用 list 查看进度，会加速触发 stall/reminder | 考虑仅在 mutating action（add/update/delete/clear）时推进 `userMessageCount`，或在 list 时仅更新 `lastTodoCallCount` 而不推进 `userMessageCount` |

### 5. 测试友好 ✅ 优秀

| # | 严重度 | 位置 | 问题 | 建议 |
|---|--------|------|------|------|
| T-1 | — | `model.ts` | 业务逻辑（add/update/migrate/format）已完全提取为纯函数，无 Pi 运行时依赖，测试覆盖充分（532 行测试） | 无需改进 |
| T-2 | — | `todo.test.ts` | 覆盖了 migrate、add、update batch、format、agent_end 纯数据逻辑 | 无需改进 |

### 6. 调试友好 ✅ 良好

| # | 严重度 | 位置 | 问题 | 建议 |
|---|--------|------|------|------|
| D-1 | — | `index.ts` execute | error 结果附带 `Input: ${JSON.stringify(params)}` 用于调试 | 设计良好 |
| D-2 | — | `model.ts` | 所有 error 返回都有明确字符串标识（`"texts required"`, `"duplicate ids"`, `"id 999 not found"`） | 设计良好 |

---

## 总结

### 亮点

1. **纯函数提取**：`model.ts` 将核心业务逻辑完全脱离 Pi 运行时，测试友好度极高
2. **All-or-nothing 语义**：`updateTodos` 批量更新失败时原数组不变，数据一致性有保障
3. **向后兼容**：`migrateTodo` 同时处理 done→status、缺失 verifyText/verifyAttempts、无效 status 三种旧格式
4. **error 返回附带 Input**：调试时可以直接看到触发错误的参数
5. **测试覆盖全面**：532 行测试覆盖数据模型、批量操作、verify 循环、stall/reminder 判定

### Must Fix (0)

无阻塞性问题。

### Should Fix (3)

| # | 位置 | 建议 |
|---|------|------|
| E-2 | `model.ts` updateTodos | batch 路径增加 `status` 合法性校验 |
| A-1 | `index.ts` agent_end/before_agent_start | `catch {}` 改为 `catch (e) { console.error("[todo]", e); }` |
| F-1 | `index.ts` executeTodoAction | `list` action 不应推进 `userMessageCount`，仅更新 `lastTodoCallCount` |

### Nit (3)

| # | 位置 | 建议 |
|---|------|------|
| E-1 | model.ts migrateTodo | record.id/text 可加类型防御 |
| A-2 | index.ts addResult.resultText! | 避免非空断言，使用 fallback |
| L-1 | index.ts 全文 | 关键决策点增加 debug 日志 |
