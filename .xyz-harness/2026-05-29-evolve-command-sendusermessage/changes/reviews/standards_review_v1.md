---
verdict: "pass"
must_fix: 0
reviewer: standards-review
file: evolution-engine/src/index.ts
date: 2026-05-29
---

# Standards Review — evolution-engine/src/index.ts

## 1. tsc / eslint 状态

| 检查 | 结果 |
|------|------|
| `npx tsc --noEmit` | 0 errors |
| `npx eslint evolution-engine/src/index.ts` | 0 errors, 4 warnings |

4 个 warning 均为预存问题（非本次引入）：
- `max-lines-per-function` 319 行（`evolutionEngineExtension`，超 300 阈值）
- `no-magic-numbers` × 3：`.toFixed(2)` 两处 + `loadHistory(..., 20)` 一处

**结论**：通过。本次变更未引入新 error 或新 warning。

## 2. Import 清理

检查目标：`EvolutionSuggestion`、`renderSuggestionSummary`、`renderStatsDashboard` 是否已从 index.ts 移除。

| 导入项 | index.ts 中状态 |
|--------|----------------|
| `EvolutionSuggestion` | 不存在（正确，类型仅在 types.ts 定义，其他模块按需引用） |
| `renderSuggestionSummary` | 不存在（正确，仍保留在 widget.ts 但 index.ts 不再导入） |
| `renderStatsDashboard` | 不存在（正确，同上） |

index.ts 当前导入清单（全部有效、无冗余）：
- Node 内置：`fs`, `os`, `path`, `url`
- npm 包：`@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `typebox`, `@mariozechner/pi-ai`
- 项目内部：`./types`, `./monitor`, `./commands`, `./widget`, `./state`, `./daily-trigger`

导入顺序正确（Node 内置 → npm → 项目内部），符合 CLAUDE.md 规范。

**结论**：清理完整，无残留。

## 3. Command Description 命名规范

与项目内其他扩展（goal）的 command description 风格对比：

| 命令 | description 风格 | 一致性 |
|------|-----------------|--------|
| `/evolve` | 短句摘要 + "Supports natural language: ..." 用法示例 | ✓ 与 goal 的 `"/goal <objective> | /goal pause | ..."` 风格一致 |
| `/evolve-apply` | 同上模式 | ✓ |
| `/evolve-stats` | 短句摘要 | ✓ |
| `/evolve-rollback` | 短句摘要 + "No index to list history..." 补充说明 | ✓ |
| `/evolve-report` | 短句摘要 + "Usage: ..." 格式说明 | ✓ |

所有 command description 的核心信息与对应 tool description 一致，措辞简洁，无冗余。

**结论**：符合项目风格。

## 4. CLAUDE.md 编码规范合规

| 规范项 | 状态 | 说明 |
|--------|------|------|
| 禁止 `any` | ✓ 通过 | `grep -n "as any\|: any"` 无结果 |
| 魔法数字 | ⚠ 预存 | `.toFixed(2)` × 2（标准格式化）+ `loadHistory(..., 20)`。均为 warning，非 error，且非本次引入 |
| 函数行数（≤80） | ⚠ 预存 | `evolutionEngineExtension` 319 行超 300 阈值，但这是工厂函数注册模式（tool + command 声明式代码），拆分收益低，task 已标注为预存问题 |
| 文件行数（≤1000） | ✓ 通过 | 503 行 |
| import 顺序 | ✓ 通过 | Node → npm → 内部 |
| 模块导入 scope | ✓ 通过 | 全部使用 `@mariozechner/*`，未使用 `@earendil-works/*` 或 `xyz-pi` |
| `result.details` 类型处理 | ⚠ 观察 | 4 处 `result.details as {...} | undefined` 结构类型断言。不是 `as any`，不违反显式规则，但可考虑提取共享接口。非阻塞项 |
| Tool 返回结构 | ✓ 通过 | 全部返回 `{ content: [...], details: {...} }` |
| TUI 渲染 | ✓ 通过 | 使用 `theme.fg("token", text)` 语义 token，无硬编码 ANSI |
| 错误处理 | ✓ 通过 | 未发现 `{ content: [{ text: "错误: ..." }] }` 错误成功模式 |

## 总结

本次变更质量良好：
- tsc / eslint 均通过（0 error）
- 目标 import 已完整清理
- Command description 风格与项目一致
- 无 `any`、无新增规范违反
- 4 个 eslint warning 均为预存问题，非本次引入

`must_fix: 0`。
