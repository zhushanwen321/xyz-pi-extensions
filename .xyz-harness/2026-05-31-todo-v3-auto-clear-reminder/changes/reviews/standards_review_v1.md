---
verdict: fail
must_fix: 2
linter_passed: true
typecheck_passed: true
review_metrics:
  files_reviewed: 1
  issues_found: 4
  must_fix_count: 2
  low_count: 2
  info_count: 0
  duration_estimate: "5"
---

# Standards Review v1

## 审查记录
- 审查时间：2026-05-31 23:50
- 项目路径：`/Users/zhushanwen/Code/xyz-pi-extensions-workspace/main`
- Phase A（自动检查）：已执行
- Phase B（AI 规范对比）：已执行

## Phase A: 自动化检查结果

### Lint

| 项目 | 结果 |
|------|------|
| 检测到的命令 | `npx eslint todo/src/index.ts` |
| 退出码 | 0 |
| Errors | 0 |
| Warnings | 0 |
| 状态 | ✅ 通过 |

### Typecheck

| 项目 | 结果 |
|------|------|
| 检测到的命令 | `cd todo && npx tsc --noEmit` |
| 退出码 | 0 |
| Errors | 0 |
| 状态 | ✅ 通过 |

## Phase B: CLAUDE.md 规范对比

### 规范检查矩阵

| # | 规范条目 | 适用范围 | 检查结果 | 违规位置 |
|---|---------|---------|---------|---------|
| 1 | 禁止 `any`，用 `unknown` 或具体类型 | TypeScript 文件 | ✅ 符合 | — |
| 2 | `(entry as any).customType` 改为类型守卫 | TypeScript 文件 | ✅ 符合 | — |
| 3 | import 顺序：Node 内置 → npm 包 → 项目内部 | TypeScript 文件 | ✅ 符合 | L16-L20 |
| 4 | 单文件不超过 1000 行 | 全部 | ✅ 符合（738 行） | — |
| 5 | 函数不超过 80 行 | 全部 | ❌ 不符合 | L235, L560 |
| 6 | 命名：工具详情用 `XxxDetails` | TypeScript 文件 | ✅ 符合（`TodoDetails`） | — |
| 7 | 命名：工具参数用 `XxxParams` | TypeScript 文件 | ✅ 符合（`TodoParams`） | — |
| 8 | `execute` 返回 `{ content, details }` 结构 | Tool 设计 | ✅ 符合 | — |
| 9 | 错误用 `throw new Error()`，不要错误成功模式 | Tool 设计 | ❌ 不符合 | 多处 |
| 10 | 颜色通过 `theme.fg("token", text)` 语义 token | TUI 渲染 | ✅ 符合 | — |
| 11 | `renderCall`/`renderResult` 返回 `new Text(string, 0, 0)` | TUI 渲染 | ✅ 符合 | — |
| 12 | 状态存储在闭包或 `ctx.sessionManager` entries | Session 隔离 | ❌ 不符合 | L197-L214 |
| 13 | `_render` 声明式协议 | GUI 渲染 | ✅ 符合 | — |
| 14 | 参数用 typebox `Type.Object()` + `StringEnum()` | Tool 设计 | ✅ 符合 | — |
| 15 | `details` 是 renderResult 数据来源 | Tool 设计 | ✅ 符合 | — |

## 问题清单

| # | 严重度 | Phase | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|-------|------|------|------|---------|
| 1 | MUST_FIX | B | `executeTodoAction` 函数约 246 行，远超 80 行限制 | todo/src/index.ts | L235 | 拆分为独立 action handler 函数：`handleList`、`handleAdd`、`handleUpdate`、`handleDelete`、`handleClear`，每个保持在 80 行内 |
| 2 | MUST_FIX | B | `export default function` 入口函数约 179 行，远超 80 行限制 | todo/src/index.ts | L560 | 将事件处理器（`session_start`、`session_tree`、`agent_start`、`before_agent_start`）和 tool 注册逻辑提取为独立命名函数 |
| 3 | LOW | B | 错误处理采用返回 `{ content: [{ text: "错误: ..." }] }` 而非 `throw new Error()` | todo/src/index.ts | L259, L270, L282, L290, L307, L316, L337 | CLAUDE.md 要求"错误用 throw new Error()，不要返回错误成功模式"。当前返回 content+error details 的方式虽然有 details 标记，但仍是"成功返回错误"。建议对参数校验类错误改用 throw |
| 4 | LOW | B | 模块级 `let` 变量（`todos`、`nextId`、`userMessageCount` 等）违反 Session 隔离要求 | todo/src/index.ts | L197-L214 | CLAUDE.md 明确指出 `todo` 扩展的 `let todos` 是"已知的违反"。v3 新增了更多模块级状态（`userMessageCount`、`allCompletedAtCount`、`lastTodoCallCount`、`lastReminderCount`），加重了该问题。当前单 session 无碍，但应记录技术债 |

## 结论

**需修改**。Phase A 自动化检查全部通过（lint + typecheck 0 error），但 Phase B 发现 2 条 MUST_FIX 问题：

1. **`executeTodoAction`（246 行）** 和 **入口函数（179 行）** 严重超过 CLAUDE.md 规定的 80 行函数限制。需要按 action 拆分和提取事件处理器。

2 条 LOW 问题（错误成功模式、模块级状态泄漏）是已知技术债，不阻碍本次合并但应排期修复。
