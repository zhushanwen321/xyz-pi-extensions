---
verdict: pass
must_fix: 1
---

# 规范审查报告 — evolution-engine (evolve-summarizer-pipeline)

**审查日期**: 2026-05-28
**审查范围**: evolution-engine/src/ 全部变更文件（summarizer.ts, effect-tracker.ts, gc.ts + 修改文件 commands.ts, judge.ts, state.ts, index.ts, types.ts）
**审查版本**: git diff（evolve-summarizer-pipeline）

---

## Phase A: 自动检查结果

### 1. TypeScript 类型检查 (`npx tsc --noEmit`)

**状态**: ✅ 通过
- 无类型错误
- 所有新文件类型正确

### 2. ESLint 品味检查 (`npm run lint`)

**状态**: ✅ 通过（evolution-engine 0 error）
- 全项目 4 errors（在其他扩展中：goal/unused-vars, subagent/unused-vars），非 evolution-engine 问题
- evolution-engine 无 lint errors
- evolution-engine 无 magic-number warnings（其它扩展中存在 162 warnings）

---

## Phase B: AI 规范对比结果

### B1. `any` 类型使用

**状态**: ✅ 合规
- 未发现 `any` 类型使用
- 动态数据使用 `Record<string, unknown>` 类型安全模式
- 类型断言使用 `as Record<string, unknown>`（安全的下行转型），无 `as any` 模式

### B2. Import scope — `@mariozechner/*`

**状态**: ✅ 合规
- 所有外部 import 使用 `@mariozechner/*` scope
  - `@mariozechner/pi-coding-agent`（index.ts）
  - `@mariozechner/pi-tui`（index.ts, widget.ts）
  - `@mariozechner/pi-ai`（index.ts）
- 未发现 `@earendil-works` 或 `xyz-pi` 导入

### B3. 文件行数上限（≤ 1000 行）

**状态**: ✅ 合规
- 最大文件：commands.ts（549 行）
- 新文件均在阈值内：summarizer.ts（417）、effect-tracker.ts（157）、gc.ts（124）
- 全 project 总计 3234 行

### B4. 函数行数上限（≤ 80 行）

**状态**: ❌ 4 项违反（1 项为新引入，3 项为既有代码）

| 文件 | 行号 | 函数名 | 行数 | 来源 |
|------|------|--------|------|------|
| src/commands.ts | 101 | `handleEvolve` | 125 | 既存（diff 中修改） |
| src/commands.ts | 236 | `handleEvolveApply` | 146 | 既存（diff 中修改） |
| src/commands.ts | 390 | `handleEvolveStats` | 94 | 既存 |
| src/summarizer.ts | 28 | `extractMetricsSnapshot` | 116 | **新引入** |

**结论**: `extractMetricsSnapshot` 是新增函数，需要拆分。既有 3 个函数超出限制，但属技术债、非本次引入。

### B5. FS 操作——同步 API 一致性

**状态**: ✅ 合规
- 全部使用同步 API（`existsSync`, `readFileSync`, `writeFileSync`, `unlinkSync`, `statSync`, `appendFileSync`, `mkdirSync`, `readdirSync`）
- 与既有代码模式一致（整个 project 均使用同步 fs API）

### B6. Import `.js` 后缀

**状态**: ⚠️ 存在既有不一致
- 新代码（summarizer.ts, effect-tracker.ts, gc.ts）统一使用 `.js` 后缀
- commands.ts 中存在混用：既有 import（`from "./state"`, `from "./judge"`, `from "./applier"`）无后缀，新增的 import（`from "./summarizer.js"`, `from "./effect-tracker.js"`, `from "./gc.js"`）有后缀
- 其他文件（state.ts, judge.ts）使用 `.js` 后缀，index.ts 和 widget.ts 无后缀
- **结论**: 是 project 级既有不一致，非本次引入。新代码采用 `.js` 后缀的方向正确。

### B7. 命名一致性

**状态**: ✅ 合规
- 函数使用 camelCase（`extractMetricsSnapshot`, `buildEffectReview`, `summarizeReport` 等）
- 常量使用 UPPER_SNAKE_CASE（`MAX_REPORTS`, `MAX_SIGNALS`, `SEVEN_DAYS_MS` 等）
- 本地变量使用 camelCase
- 与既有代码命名风格完全一致

### B8. 额外检查：`_render` 协议遵循

**状态**: ✅ 不适用
- evolution-engine 不是工具式扩展，无 `execute()` 返回，无 `_render` 协议需求

---

## 汇总

| 检查项 | 状态 | 优先级 |
|--------|------|--------|
| TypeScript 类型检查 | ✅ | — |
| ESLint 品味检查 | ✅ | — |
| 禁止 `any` | ✅ | — |
| `@mariozechner/*` scope | ✅ | — |
| 文件 ≤ 1000 行 | ✅ | — |
| 函数 ≤ 80 行 | ❌ 1 项新违反 | **Must fix** |
| FS 同步 API 一致 | ✅ | — |
| Import `.js` 后缀 | ⚠️ 既有不一致 | 建议清理 |
| 命名风格一致 | ✅ | — |

**Must-fix 建议**: `extractMetricsSnapshot`（summarizer.ts:28）116 行，建议拆分为 `extractSessionMetrics` / `extractTokenMetrics` / `extractSkillMetrics` 3 个子函数（每段 ~40 行）。
