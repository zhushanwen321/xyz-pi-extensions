# TypeScript Taste Review — Todo Loop Improvements

**Reviewer**: ts-taste-check (automated)
**Date**: 2026-06-04
**Scope**: `extensions/todo/src/index.ts`, `extensions/todo/src/model.ts`
**Baseline commit**: `2cf17bc`

```yaml
verdict: pass
must_fix: 1
```

## Summary

整体代码质量较高。本次改动将业务逻辑从 index.ts 抽到 model.ts（纯函数可测试），消除了多处 `any`（`renderCall`/`renderResult` 参数改为 `unknown`/`Record<string, unknown>`），常量语义化命名到位。主要问题集中在遗留的 `any` 和一处静默 catch。

## Findings

| # | Severity | File | Line(s) | Category | Description |
|---|----------|------|---------|----------|-------------|
| 1 | **must_fix** | `index.ts` | L453-454, L463-464, L477-478, L488 | `any` usage | 事件处理器回调参数 `_event: any`, `_ctx: ExtensionContext` / `ctx: ExtensionContext`。`_event` 使用了 `any` 类型。Pi SDK 的 event 类型应从 `@mariozechner/pi-coding-agent` 导入具体 event 类型，或至少用 `unknown`。共 4 处：`session_start`, `session_tree`, `agent_start`, `before_agent_start`, `agent_end` |
| 2 | **must_fix** | `index.ts` | L453-454 | `any` usage | `registerMessageRenderer` 回调参数 `(message: any, _options: any, theme: Theme)` — `message` 和 `_options` 都是 `any`。应改为 `unknown` 或具体类型 |
| 3 | **minor** | `index.ts` | L490, L537 | 静默 catch | `catch {}` 块内只有注释或 `return;`，无日志记录。虽然注释说明"非关键路径静默降级"，但 `console.debug` 级别的日志对排查仍有价值。taste-lint `no-silent-catch` 规则应会捕获此处 |
| 4 | **minor** | `model.ts` | L50-51 | 类型断言 | `migrateTodo` 中 `record.id as number`, `record.text as string`, `record.verifyText as string` 等多处 `as` 断言。考虑到函数输入是 `Todo`（已知有 id/text），断言是安全的，但建议用类型守卫代替，使运行时也安全 |
| 5 | **minor** | `index.ts` | L302 | `as` 断言 | `params as Parameters<typeof executeTodoAction>[0]` — params 来自 typebox 的 `Static<typeof TodoParams>`，这个断言实际上绕过了类型检查。`TodoParams` 的 schema 和 `executeTodoAction` 的手动类型声明是两份独立的 truth，可能 drift |
| 6 | **info** | `index.ts` | L267 | 魔法字符串 | 状态标记渲染逻辑（`"completed"`, `"in_progress"`, `"failed"`, `"pending"`）在 `TodoListComponent.render`、`renderWidgetLines`、`buildTodoListText` 三处重复出现。可用 map/函数统一，但每处只有 4 分支，当前可接受 |
| 7 | **info** | `model.ts` | L195 | `as` 断言 | `u.status as Todo["status"]` — updateTodos 中将 string 断言为联合类型。上游已有 VALID_STATUSES 校验（在 index.ts 的 single-update 路径），但 model.ts 的 updateTodos 函数本身未做 status 校验，直接断言。batch updates[] 路径可传入任意 string |
| 8 | **info** | `index.ts` | 全文 | 重复渲染逻辑 | `TodoListComponent.render`、`renderWidgetLines`、`buildTodoListText` 三处渲染 status→mark 映射逻辑高度重复（都处理 ✓/●/✗/○ 四种状态）。可提取为共享的 `getMark(status, theme)` 函数 |

## Positive Observations

1. **`any` → `unknown` 改进**: `renderCall` 参数从 `any` 改为 `Record<string, unknown>`，`renderResult` 从 `any` 改为 `unknown`，`execute` 的 `_onUpdate` 从 `any` 改为 `unknown`。方向正确。
2. **常量语义化**: `AUTO_CLEAR_DELAY_ROUNDS=2`, `STALL_THRESHOLD=5`, `REMINDER_INTERVAL=3`, `MAX_VERIFY_ATTEMPTS=2` — 全部有命名常量，无裸魔法数字。
3. **纯函数提取**: `addTodos`、`updateTodos`、`migrateTodo`、`buildRender`、`formatTodoLine` 从 index.ts 提取到 model.ts，不依赖 Pi 运行时，可独立测试。32 个测试全部通过。
4. **All-or-nothing 语义**: `updateTodos` 先验证所有 id 存在且每项有变更，再统一 apply。失败时不修改原数组。
5. **向后兼容**: `migrateTodo` 同时处理旧 `done: boolean` 格式和新 `status` 格式，以及缺少 `verifyText`/`verifyAttempts` 的情况。

## tsc Result

```
cd extensions/todo && npx tsc --noEmit
```

无 todo 相关类型错误（其他包的 `@zhushanwen/pi-quota-providers` 模块解析错误是已有问题，不在本次审查范围）。

## vitest Result

```
32 tests passed, 0 failed (90ms)
```

## Recommendation

**pass with 1 must_fix**：#1 和 #2 的 `any` 应改为 `unknown`（低风险改动，不影响运行时行为）。#7 的 batch updates[] 缺少 status 校验值得关注，但不阻塞本次合并。
