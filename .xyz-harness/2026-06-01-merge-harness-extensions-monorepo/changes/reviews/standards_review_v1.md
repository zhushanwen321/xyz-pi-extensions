---
verdict: fail
must_fix: 6
linter_passed: false
typecheck_passed: false
review_metrics:
  files_reviewed: 18
  issues_found: 10
  must_fix_count: 6
  low_count: 2
  info_count: 2
  duration_estimate: "5"
---

# Standards Review v1

## 审查记录
- 审查时间：2026-06-01 21:00
- 项目路径：/Users/zhushanwen/Code/xyz-pi-extensions-workspace/main
- Phase A（自动检查）：已执行
- Phase B（AI 规范对比）：已执行
- 审查范围：git diff HEAD~7..HEAD（monorepo 重构 + coding-workflow 新增 + claude-rules-loader 新增）

## Phase A: 自动化检查结果

### Lint

| 项目 | 结果 |
|------|------|
| 检测到的命令 | `npx eslint packages/coding-workflow/` |
| 退出码 | 1（失败） |
| Errors | 1（模块解析失败） |
| Warnings | 0 |
| 状态 | ❌ 未通过 |

**错误详情**：`taste-lint/base.mjs` 已从根目录移至 `packages/taste-lint/base.mjs`，但根目录 `eslint.config.mjs` 仍引用 `./taste-lint/base.mjs`，导致 ESLint 完全无法启动。这是 monorepo 重构引入的回归。

### Typecheck

| 项目 | 结果 |
|------|------|
| 检测到的命令 | `npx tsc --noEmit` |
| 退出码 | 1（失败） |
| Errors | 6 |
| Warnings | 0 |
| 状态 | ❌ 未通过 |

**错误详情**：
- `packages/workflow/src/tool-generate.ts:185` — 4 个 implicit `any` 类型（参数 result, _options, _theme, _context）
- `packages/workflow/src/widget.ts:15` — Module `'@mariozechner/pi-tui'` has no exported member `'Component'`

**注意**：以上 typecheck 错误位于 `workflow/` 包，而该包在此 diff 中仅做了目录重命名（根目录 → `packages/`），代码内容无变更。这些是 **pre-existing** 问题，非本次 diff 引入，不计入 MUST_FIX。但 typecheck 整体状态为未通过。

## Phase B: CLAUDE.md 规范对比

### 规范检查矩阵

| # | 规范条目 | 适用范围 | 检查结果 | 违规位置 |
|---|---------|---------|---------|---------|
| 1 | 禁止 `any` 类型 | TypeScript 文件 | ❌ 不符合 | 见下方问题清单 |
| 2 | 单文件不超过 1000 行 | 全部 TS 文件 | ❌ 不符合 | `coding-workflow/index.ts` (1257 行) |
| 3 | `(entry as any)` 改为类型守卫 | TypeScript 文件 | ❌ 不符合 | `coding-workflow/index.ts:L229,L231` |
| 4 | ESLint 配置正确 | 根配置文件 | ❌ 不符合 | `eslint.config.mjs` 引用已移动的路径 |
| 5 | description 必须用双引号包裹 | SKILL.md | ❌ 不符合 | 13 个新 SKILL.md 使用 `>-` |
| 6 | import 顺序：Node 内置 → npm → 内部 | TypeScript 文件 | ✅ 符合 | — |
| 7 | 函数不超过 80 行 | TypeScript 文件 | ➖ 不适用 | 未发现超限函数 |
| 8 | 扩展入口命名 `xxxExtension` | TypeScript 文件 | ✅ 符合 | `codingWorkflowExtension` |
| 9 | 命名规范 XxxRuntimeState / XxxParams / XxxDetails | TypeScript 文件 | ✅ 符合 | — |
| 10 | 错误用 throw new Error() | TypeScript 文件 | ✅ 符合 | gate-runner/skill-resolver 正确 throw |
| 11 | 状态存储在闭包或 sessionManager | 扩展代码 | ➖ 不适用 | coding-workflow 使用闭包 state + persistState |
| 12 | 分支命名 feat/fix/refactor/chore | Git | ➖ 不适用 | 非代码规范 |

## 问题清单

| # | 严重度 | Phase | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|-------|------|------|------|---------|
| 1 | MUST_FIX | A | ESLint 配置引用已移动的 taste-lint 路径 | `eslint.config.mjs` | L1 | 改为 `import tasteConfig from './packages/taste-lint/base.mjs'` 或更新 pnpm workspace 映射 |
| 2 | MUST_FIX | B | `any` 类型用于 gate check JSON 解析回调 | `packages/coding-workflow/lib/gate-runner.ts` | L63-64 | 定义 `GateCheckJson` 接口，用 `(c: GateCheckJson)` 替代 `(c: any)` |
| 3 | MUST_FIX | B | `any` 类型用于 onUpdate 回调参数 | `packages/coding-workflow/lib/review-dispatcher.ts` | L126 | 定义 `ReviewUpdatePayload` 接口替代 `any` |
| 4 | MUST_FIX | B | `any[]` 用于 stdio 联合类型 | `packages/coding-workflow/lib/process-manager.ts` | L28 | 使用 `Array<"pipe" \| "ignore" \| "inherit" \| number \| null \| stream.Writable \| stream.Readable>` 或引入 Node.js `StdioOptions` 类型 |
| 5 | MUST_FIX | B | `(entry as any).customType` 和 `(entry as any).data` | `packages/coding-workflow/index.ts` | L229, L231 | 实现类型守卫函数 `isCodingWorkflowEntry(entry)` 替代 `as any` |
| 6 | MUST_FIX | B | 单文件 1257 行，超过 1000 行上限 | `packages/coding-workflow/index.ts` | 全文件 | 将 command handlers（/coding-workflow, /status, /abort）提取到 `commands.ts`，将 checkProjectProtection 提取到独立工具文件 |
| 7 | LOW | B | 13 个新 SKILL.md 使用 `>-` 块标量而非双引号包裹 description | `packages/coding-workflow/skills/*/SKILL.md` | frontmatter | 改为 `description: "具体描述内容"`，参照 CLAUDE.md YAML 规范 |
| 8 | LOW | A | workflow 包 pre-existing typecheck 错误（非本次 diff 引入） | `packages/workflow/src/tool-generate.ts` | L185 | 后续修复：为 render 回调参数添加具体类型 |
| 9 | INFO | B | `m.slice(0, 500)` 和 `content.slice(0, 4000)` 魔法截断值 | `packages/coding-workflow/index.ts` | L955, L505 | 提取为命名常量如 `MAX_MESSAGE_PREVIEW_LENGTH = 500` |
| 10 | INFO | B | 魔法数字 5000（SIGKILL 延迟） | `packages/coding-workflow/lib/process-manager.ts` | L98, L138 | 提取为 `GRACEFUL_SHUTDOWN_MS = 5000` |

## 结论

需修改。6 条 MUST_FIX 需修复后重审。

核心问题集中在两方面：
1. **Monorepo 重构不完整**：`eslint.config.mjs` 未同步更新 taste-lint 路径，导致全项目 lint 失效
2. **新增代码 `any` 泛滥**：5 处 `any` 使用违反项目核心规范（"禁止 any，用 unknown 或具体类型"），3 个文件涉及
3. **文件过长**：`coding-workflow/index.ts` 1257 行超出 1000 行限制，需按职责拆分

建议优先修复 MUST_FIX #1（ESLint 配置），否则后续 lint 驱动的质量门禁全部失效。
