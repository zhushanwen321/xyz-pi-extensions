---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 4
  v1_must_fix_verified: 3
  v1_must_fix_resolved: 3
  v1_must_fix_unresolved: 0
  new_violations: 0
  remaining_low_issues: 5
created: 2026-05-27
---

# Standards Review v2 — evolution-engine Extension（第二轮审查）

## Overview

验证 `standards_review_v1.md` 中 3 个 MUST FIX 的修复情况，并检查修复是否引入新的规范违反。

审查文件：
- `evolution-engine/src/index.ts`
- `evolution-engine/src/widget.ts`
- `evolution-engine/src/commands.ts`
- `evolution-engine/src/monitor.ts`

---

## MUST FIX 验证结果

### MF1: Import 使用 @earendil-works/* 而非 @mariozechner/*

**状态：✅ 已修复**

| 位置 | v1 错误代码 | 当前代码 | 结果 |
|------|-----------|---------|------|
| `src/index.ts:18` | `@earendil-works/pi-tui` | `@mariozechner/pi-tui` | ✅ |
| `src/index.ts:20` | `@earendil-works/pi-ai` | `@mariozechner/pi-ai` | ✅ |
| `src/widget.ts:8` | `@earendil-works/pi-tui` | `@mariozechner/pi-tui` | ✅ |

全项目 grep 确认无残留 `@earendil-works` 引用。所有 import 统一使用 `@mariozechner/*` 公约。

**修复方式**：精确文本替换，无副作用。

---

### MF2: 错误作为成功消息返回而非 throw

**状态：✅ 已修复**

`errorResult()` 函数已彻底移除。所有 14 处错误路径替换为 `throw new Error(...)`：

| Handler | v1 错误路径数 | 当前状态 |
|---------|------------|---------|
| `handleEvolve` | 4 | 全部 `throw new Error()` |
| `handleEvolveApply` | 2 | 全部 `throw new Error()` |
| `handleEvolveStats` | 1 | 全部 `throw new Error()` |
| `handleEvolveRollback` | 6 | 全部 `throw new Error()` |

`successResult()` 保留（正确用于成功路径），无错误成功模式残留。

**修复方式**：将 `return errorResult(...)` 替换为 `throw new Error(...)`，移除函数定义。外层 try/catch 统一使用 `err instanceof Error ? err.message : String(err)` 模式。

---

### MF3: 魔数 86_400_000 未定义命名常量

**状态：✅ 已修复**

`commands.ts` 新增命名常量：

```typescript
const MS_PER_DAY = 86_400_000;
```

两处内联魔数已替换：

| v1 位置 | v1 代码 | 当前代码 |
|---------|--------|---------|
| `findRecentReport` | `sinceDays * 86_400_000` | `sinceDays * MS_PER_DAY` |
| `handleEvolveStats` | `7 * 86_400_000` | `7 * MS_PER_DAY` |

注：`monitor.ts` 已自 v1 起拥有同名常量，`commands.ts` 使用独立定义（不同模块，合理）。

---

## 新规范违反检查

**新引入违反数：0**

逐一检查以下维度，确认修复未引入新问题：

| 维度 | 结果 | 说明 |
|------|------|------|
| `any` 类型 | ✅ 无 | 全部使用 `unknown`、`Record<string, unknown>` 或具体类型 |
| 空 catch 块 | ✅ 无 | 所有 catch 块含 return 或 throw 或注释 |
| Import 顺序 | ✅ 合规 | `node:*` → `@mariozechner/*` → 内部模块 |
| 函数 ≤ 80 行 | ✅ 未引入新超限 | 已有超限函数为 v1 遗留 |
| 模块级 `let` | ✅ 无 | 不涉及 |
| 硬编码 ANSI | ✅ 无 | 全部使用 `theme.fg(...)` |

---

## 遗留 LOW 问题（v1 未修复，本次仍有效）

以下问题在 v1 中标记为 LOW，不在 MUST FIX 范围内，本次复查确认仍存在：

| # | 问题 | 文件 | 说明 |
|---|------|------|------|
| 1 | `handleEvolveStats` > 80 行 | `commands.ts:339` | ~90 行，含大量数据聚合逻辑 |
| 2 | `evolutionEngineExtension` > 80 行 | `index.ts:68` | ~416 行，含 4 个 tool + 4 个 command 注册 |
| 3 | 历史文件无 GC | `state.ts` | `history.jsonl` 持续增长无截断 |
| 4 | target 联合类型双重定义 | `commands.ts` + `index.ts` | `"all" | "claude-md" | "skills"` 在两处独立定义 |
| 5 | JSDoc "是什么"注释 | 多处 | `types.ts` 字段注释偏描述性 |

**新增观察**：`handleEvolve`（`commands.ts:105-193`，~88 行）同样超过 80 行限制，v1 未标记。与 `handleEvolveStats` 性质相同，建议同步拆分。

---

## 修复质量评估

| 维度 | 评价 |
|------|------|
| **精确度** | 三处修复均精准命中目标，未引入无关变更 |
| **完整性** | MF1 和 MF2 的 grep 零残留，MF3 两处魔数全部替换 |
| **风格一致性** | `throw new Error(...)` 模式与代码库其他部分一致 |
| **边缘情况** | `err instanceof Error ? err.message : String(err)` 模式正确覆盖非 Error 类型 throw |

---

## 统计汇总

| Metric | Value |
|--------|-------|
| 审查文件数 | 4 |
| v1 MUST FIX 总数 | 3 |
| 已修复 | 3 |
| 未修复 | 0 |
| 新引入违反 | 0 |
| 遗留 LOW 问题 | 5 |
| **Verdict** | **pass** |
