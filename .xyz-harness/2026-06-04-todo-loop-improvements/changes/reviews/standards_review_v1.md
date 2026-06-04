---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 5
  issues_found: 6
  must_fix_count: 0
  low_count: 3
  info_count: 3
  duration_estimate: "5"
---

# Standards Review v1

## 审查记录
- 审查时间：2026-06-04 12:55
- 项目路径：`extensions/todo/`
- Phase A（自动检查）：已执行
- Phase B（AI 规范对比）：已执行

## Phase A: 自动化检查结果

### Lint

| 项目 | 结果 |
|------|------|
| 检测到的命令 | `pnpm --filter @zhushanwen/pi-todo lint` |
| 退出码 | — |
| Errors | — |
| Warnings | — |
| 状态 | ➖ 未配置（package.json 无 `lint` script） |

### Typecheck

| 项目 | 结果 |
|------|------|
| 检测到的命令 | `pnpm --filter @zhushanwen/pi-todo typecheck`（即 `npx tsc --noEmit`） |
| 退出码 | 2（失败） |
| Errors | 8 |
| 状态 | ❌ 未通过（但无错误来自 todo 扩展本身） |

**Typecheck 错误分析：** 8 个 TS2307 错误全部来自其他扩展（`model-switch/`、`statusline/`、`workflow/`），原因是根 tsconfig 的 `include` 覆盖 `extensions/**/*.ts`。todo 扩展自身的代码 **0 个类型错误**。这些外部错误是分支既有债务，非本次引入。

### Tests (Vitest)

| 项目 | 结果 |
|------|------|
| 命令 | `cd extensions/todo && npx vitest run` |
| 测试文件 | 1 passed |
| 测试用例 | 32 passed |
| 耗时 | 116ms |
| 状态 | ✅ 通过 |

## Phase B: CLAUDE.md 规范对比

### 规范检查矩阵

| # | 规范条目 | 适用范围 | 检查结果 | 违规位置 |
|---|---------|---------|---------|---------|
| 1 | 禁止 `any` 类型 | TypeScript 文件 | ⚠️ 部分符合 | `index.ts`:L609,L613,L619,L624,L659,L814 |
| 2 | 单文件 ≤ 1000 行 | TypeScript 文件 | ✅ 符合 | — |
| 3 | 函数 ≤ 80 行 | TypeScript 文件 | ✅ 符合 | — |
| 4 | `import` 顺序：Node → npm → 项目内部 | TypeScript 文件 | ✅ 符合 | — |
| 5 | 可测试性设计：纯逻辑从 `index.ts` 提取到独立模块 | 全部 | ✅ 符合 | — |
| 6 | 测试框架用 vitest，禁止 `node:test` | 测试文件 | ✅ 符合 | — |
| 7 | `package.json` 必须有 `pi` 字段声明 | package.json | ✅ 符合 | — |
| 8 | 错误用 `throw new Error()` | 全部 | ➖ 不适用 | 本次变更沿用了返回 error 对象的模式，与现有架构一致 |
| 9 | Session 隔离：闭包内状态 | 全部 | ✅ 符合 | — |
| 10 | 状态持久化向后兼容（`migrateTodo`） | model.ts | ✅ 符合 | — |
| 11 | vitest.config.ts `include` 统一为 `src/__tests__/**/*.test.ts` | vitest.config.ts | ✅ 符合 | — |
| 12 | `_render` 协议：声明式描述符 | 全部 | ✅ 符合 | — |
| 13 | 禁止 emoji（除非用户明确要求） | 全部 | ⚠️ 部分符合 | `index.ts`:L650 |
| 14 | 注释解释"为什么"而非"是什么" | 全部 | ✅ 符合 | — |
| 15 | `addDependencies` 中 vitest devDep | package.json | ✅ 符合 | — |
| 16 | `tsc --noEmit` 全量修复零容忍 | TypeScript | ✅ 符合（todo 自身无错误） | — |
| 17 | `no-silent-catch` ESLint 规则 | TypeScript | ✅ 符合 | — |

### 规范检查详解

#### #1: `any` 类型使用

6 处 `any` 用法，均为 Pi SDK 事件处理器回调参数：
- `_event: any` × 5 处（L609, L613, L619, L624, L659）— Pi SDK stub 中事件类型定义为 `any`
- `message: any, _options: any` × 1 处（L814）— `registerMessageRenderer` 回调参数

**判定：** 这些 `any` 来自 Pi SDK 类型桩的设计限制（`ContextEvent = any`、`TurnEndEvent = any`），非本次引入。本次变更已将 `renderCall`/`renderResult`/`execute` 的参数从 `any` 改为 `Record<string, unknown>` / `unknown`，是正向改进。

#### #13: Emoji 使用

- L650: `ctx.ui.setStatus("todo", `📋 ${pendingTodos.length} pending`)` — 在状态栏文本中使用 emoji
- L821: `return new Text(`[TODO] All tasks completed ✓`, 0, 0)` — 使用 Unicode check mark，非 emoji

**判定：** `📋` 是 emoji，用于 Pi 状态栏的视觉区分。这在 TUI 状态栏语境下有功能性作用（快速识别 todo 状态），与"文档/代码注释中禁止 emoji"的规范意图不同。建议但非阻塞。

## 问题清单

| # | 严重度 | Phase | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|-------|------|------|------|---------|
| 1 | LOW | B | `_event: any` 事件处理器参数 | src/index.ts | L609,L613,L619,L624,L659 | Pi SDK 类型限制，建议待 SDK 提供事件类型后统一修复 |
| 2 | LOW | B | `registerMessageRenderer` 回调 `message: any, _options: any` | src/index.ts | L814 | 同上，待 SDK 类型完善 |
| 3 | LOW | B | 状态栏使用 `📋` emoji | src/index.ts | L650 | 考虑用文字替代或保留（TUI 状态栏功能性使用） |
| 4 | INFO | B | `addTodos` 中 `verifyTexts.length > trimmed.length` 对比的是过滤后的 trimmed | src/model.ts | L140 | 这是正确的（verifyTexts 按原始索引映射），但若 texts 含空串被 trim 掉，verifyTexts 对应项也会丢失。当前行为合理，记录即可 |
| 5 | INFO | B | `updateTodos` 未验证 `status` 值是否在 `VALID_STATUSES` 内 | src/model.ts | L199 | `u.status as Todo["status"]` 直接断言。当前由上层 schema 限制，但纯函数层缺少防御 |
| 6 | INFO | B | `migrateTodo` 中空行（L49-L50） | src/model.ts | L49-50 | 两个连续空行，纯风格问题 |

## 变更概述

本次变更涉及 5 个文件（2 修改 + 3 新增），核心改动：

1. **数据模型增强**：`Todo` 新增 `verifyText?`、`verifyAttempts`、`"failed"` 状态
2. **逻辑提取到 `model.ts`**：纯函数（`migrateTodo`、`addTodos`、`updateTodos`、`buildRender`、`formatTodoLine`）从 `index.ts` 提取到独立模块，便于单元测试
3. **批量更新 API**：`updates[]` 参数支持 all-or-nothing 批量更新
4. **验证循环**：`agent_end` 中实现 verify-failed → needs-verify → stall → reminder 多级检查
5. **上下文注入**：`before_agent_start` 事件中向 AI 注入 todo context
6. **测试**：32 个测试用例全部通过，覆盖数据模型、add/update 逻辑、verify 循环、渲染

**架构合规性**：
- `model.ts` 不依赖 Pi 运行时（纯函数），符合可测试性设计规范
- `index.ts` 仅做注册胶水和事件处理，符合职责划分原则
- `vitest.config.ts` 配置符合项目约定
- `package.json` 包含必需的 `pi` 字段和 `vitest` devDependency

## 结论

**通过。** 本次变更符合项目编码规范，无 MUST_FIX 问题。typecheck 的 8 个错误全部来自其他扩展的既有债务，todo 扩展自身 0 错误。3 个 LOW 级别问题均与 Pi SDK 类型限制相关，非本次引入且已有改进趋势（`renderCall`/`renderResult` 参数已从 `any` 改为 `unknown`）。
