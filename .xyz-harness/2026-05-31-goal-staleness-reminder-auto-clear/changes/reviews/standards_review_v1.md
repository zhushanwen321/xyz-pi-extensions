---
verdict: fail
must_fix: 1
linter_passed: true
typecheck_passed: true
review_metrics:
  files_reviewed: 7
  issues_found: 2
  must_fix_count: 1
  low_count: 1
  info_count: 0
  duration_estimate: "5"
---

# Standards Review v1

## 审查记录
- 审查时间：2026-05-31 22:30
- 项目路径：`/Users/zhushanwen/Code/xyz-pi-extensions-workspace/main`
- Phase A（自动检查）：已执行
- Phase B（AI 规范对比）：已执行

## Phase A: 自动化检查结果

### Lint

| 项目 | 结果 |
|------|------|
| 检测到的命令 | `npx eslint goal/src/` |
| 退出码 | 1 (有 warnings) |
| Errors | 0 |
| Warnings | 2 |
| 状态 | ⚠️ 有 warnings（无 errors） |

**Warning 明细：**
1. `max-lines` — `goal/src/index.ts` 文件行数 1141 行，超过上限 1000
2. `no-magic-numbers` — `goal/src/index.ts:L1195` magic number `2`

### Typecheck

| 项目 | 结果 |
|------|------|
| 检测到的命令 | `npx tsc --noEmit` |
| 退出码 | 0 |
| Errors | 0 |
| 状态 | ✅ 通过 |

## Phase B: CLAUDE.md 规范对比

### 规范检查矩阵

| # | 规范条目 | 适用范围 | 检查结果 | 违规位置 |
|---|---------|---------|---------|---------|
| 1 | 禁止 `any` 类型 | TypeScript 文件 | ✅ 符合 | — |
| 2 | `(entry as any)` → 类型守卫 | TypeScript 文件 | ✅ 符合 | — |
| 3 | Import 顺序：Node 内置 → npm → 项目内部 | 全部文件 | ✅ 符合 | — |
| 4 | 单文件不超过 1000 行 | 全部文件 | ❌ 不符合 | `goal/src/index.ts` (1340 行) |
| 5 | 函数不超过 80 行 | 全部文件 | ⚠️ 见注 | `goal/src/index.ts` 多个函数超过 80 行 |
| 6 | 命名规范（入口/接口/参数/详情） | 全部文件 | ✅ 符合 | — |
| 7 | `index.ts` 只做注册胶水 | 扩展架构 | ⚠️ 见注 | `goal/src/index.ts` 含大量业务逻辑 |
| 8 | Session 隔离（闭包/session_start 重建） | 运行时 | ✅ 符合 | — |
| 9 | 状态持久化 appendEntry + GC | 运行时 | ✅ 符合 | — |
| 10 | deserializeState 向后兼容 | state.ts | ✅ 符合 | — |
| 11 | Tool execute 返回 content+details | index.ts | ✅ 符合 | — |
| 12 | 错误用 throw new Error() | index.ts | ✅ 符合 | — |
| 13 | TUI 渲染用 theme.fg() 语义 token | widget.ts | ✅ 符合 | — |
| 14 | `_render` 协议（可选、声明式） | index.ts | ✅ 符合 | — |
| 15 | no-silent-catch | 全部文件 | ✅ 符合 | — |
| 16 | no-magic-numbers（语义化命名） | 全部文件 | ❌ 不符合 | `goal/src/index.ts:L1195` |

**注 #5（函数行数）**：CLAUDE.md 编码规范写"函数不超过 80 行"，但 taste-lint 配置的 `max-lines-per-function` 阈值为 300。ESLint 未触发任何函数行数 warning。以下函数超过 80 行但在 300 行内：

| 函数 | 行范围 | 行数 |
|------|--------|------|
| `executeGoalAction` | L316–L587 | ~272 |
| `handleGoalCommand` | L589–L819 | ~231 |
| `handleAgentEnd` | L943–L1137 | ~195 |
| `handleBeforeAgentStart` | L821–L941 | ~121 |
| `goalExtension` | L1141–L1340 | ~200 |

鉴于 lint 配置与编码规范不一致（80 vs 300），且 ESLint 未报告函数行数违规，此处不计入 MUST_FIX，仅记录差异。

**注 #7（index.ts 职责）**：CLAUDE.md 架构约束要求 `index.ts`（工厂）只做注册胶水。当前 `goal/src/index.ts` 包含 `executeGoalAction`、`handleGoalCommand`、`handleBeforeAgentStart`、`handleAgentEnd` 等大量业务逻辑。这是 #4 的根因——1000 行内无法容纳工厂+业务逻辑。修复 #4（拆分文件）自然解决此问题。

## 问题清单

| # | 严重度 | Phase | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|-------|------|------|------|---------|
| 1 | MUST_FIX | A+B | 文件行数超过 1000 行上限 | `goal/src/index.ts` | 全文 (1340 行) | 拆分业务函数到独立模块。建议：`handleGoalCommand` → `commands.ts`（已有框架）；`executeGoalAction` → `tool-handler.ts`；`handleBeforeAgentStart` + `handleAgentEnd` → `event-handlers.ts`。`index.ts` 仅保留工厂注册 |
| 2 | LOW | A | magic number `2`（JSON.stringify 缩进） | `goal/src/index.ts` | L1195 | 提取为常量 `const JSON_INDENT = 2;` 放入 `constants.ts` |

## 结论

**需修改**。1 条 MUST_FIX：`goal/src/index.ts` 1340 行，远超 CLAUDE.md 规定的 1000 行上限。tsc 和 ESLint error 均通过，但文件行数违反项目规范且 ESLint 已报告 warning。需将业务逻辑从 `index.ts` 拆分到 `src/` 下的独立模块。
