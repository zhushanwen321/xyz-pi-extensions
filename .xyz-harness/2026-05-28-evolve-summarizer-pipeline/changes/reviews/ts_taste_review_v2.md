---
verdict: fail
must_fix: 8
---

# TypeScript 代码品味审查报告 · 第 2 轮

**审查范围**：`summarizer.ts` · `gc.ts` · `effect-tracker.ts` · `commands.ts` · `judge.ts`

**审查日期**：2026-05-28

**检查依据**：第 1 轮审查（`ts_taste_review_v1.md`）列出的 6 个 MUST FIX

---

## v1 MUST FIX 逐项验证

| # | 问题 | 涉及文件 | 状态 | 说明 |
|---|------|----------|------|------|
| 1 | 清理未使用的导入和变量 (6 处) | 4 文件 | ⚠️ **部分修复** | 2/6 已修复，4 处残留（见下方详情） |
| 2 | 空 catch 块需添加日志 (3 处) | commands.ts, gc.ts | ⚠️ **部分修复** | 1/3 已修复（gc.ts 已加 console.warn），2 处残留 |
| 3 | `never[]` 返回类型错误 | summarizer.ts | ✅ **已修复** | `buildEffectReviewPlaceholder` 函数已删除 |
| 4 | unsafe `as` 类型断言 | judge.ts | ❌ **未修复** | `extractAssistantText` 中的 `event.message as {...}` 断言仍在 |
| 5 | 提取 `safeNum` 消除 20 次 typeof 重复 | summarizer.ts | ✅ **已修复** | 提取了 `safeNum()` 工具函数，monolithic 函数拆分为 4 个子函数 |
| 6 | `handleEvolveApply` 按 action 拆分 | commands.ts | ❌ **未修复** | 仍为单一大函数（~95 行），list/apply/skip 三路混合 |

### #1 详情：4 处残留的未使用变量

| 文件 | 行 | 符号 | 说明 | ESLint |
|------|-----|------|------|--------|
| `commands.ts` | 22 | `HistoryEntry` | `import type` 导入了但在文件中无任何类型引用 | error |
| `judge.ts` | 13 | `randomUUID` | `import { randomUUID }` 从未被调用 | error |
| `judge.ts` | 93 | `templateFileName` | 赋值后未读取，后续用了硬编码的 `judge-prompt-${timestamp}.txt` | error |
| `judge.ts` | 222 | `parseErr` | catch 绑定变量未使用，应改为 `_parseErr` | error |

**已修复的 2 处**：
- `summarizer.ts:20` `loadMetricsHistory` — 导入已删除 ✅
- `effect-tracker.ts:55` `SEVEN_DAYS_MS` — 未使用常量已删除 ✅

### #2 详情：2 处残留的空 catch

| 文件 | 行 | 上下文 | 问题 |
|------|-----|--------|------|
| `commands.ts` | 67 | `findRecentReport` 文件 stat 失败 | 仍为纯空 catch，连 `// 文件读取失败，跳过` 注释都没改 |
| `commands.ts` | 453 | `handleEvolveStats` JSON 解析失败 | 同上 |

**已修复的 1 处**：
- `gc.ts` `removeFiles` — 已加入 `console.warn` ✅

---

## ESLint 扫描结果对比

| 指标 | v1 | v2 | 变化 |
|------|----|----|------|
| 错误 (`@typescript-eslint/no-unused-vars`) | 6 | **4** | -2 ✅ |
| 警告 (`taste/no-silent-catch`) | 3 | **3** | 0 — 形式上 3 处（gc.ts 加 console 但 taste-lint 认为不够） |
| 警告 (`no-magic-numbers`) | 51 | ~**50** | -1 |
| **合计** | **6 errors, 55 warnings** | **4 errors, 58 warnings** | errors -2 |

错误数减少 2（从 6→4），方向正确但未清零。

---

## 修复质量评估

### ✅ summarizer.ts — 重构质量高

第 1 轮最大的问题（#3 never[]、#5 20 次 typeof 重复）得到了很好的处理：

- **`safeNum()` 提取**：语义正确的类型守卫（`typeof value === "number" && Number.isFinite(value)`），比原版本更安全（NaN/Infinity 被归一化为 0）
- **提取函数的拆分**：`extractMetricsSnapshot` 从单体 ~80 行拆分为 4 个命名清晰的小函数（`extractMetaInfo`, `extractToolMetrics`, `extractTokenAndSatisfactionMetrics`, `extractUserAndSkillMetrics`），每个 10-15 行
- **`COMPARABLE_FIELDS`** 提取为命名常量，消除了 `computeTrends` 中的散落配置
- **`buildEffectReviewPlaceholder` 已删除**，effect review 现在直接内联

**小问题**：
- `extractToolFailureRates` 中的 `typeof data.error_rate === "number"` 仍用旧模式，未用 `safeNum`（统一性欠缺）
- 魔法数字仍散落（`0.05`, `0.3`, `0.5`, `5_000_000`, `20_000_000`, `10`），第 1 轮建议的语义常量未提取

### ✅ gc.ts — 关键修复到位

`removeFiles` 的空 catch 已加入 `console.warn`，包含错误消息和上下文前缀 `[evolve-gc]`，可辅助 long-running debug。`listJsonByMtime` 的空 catch（返回 `[]`）是合理的静默降级行为。

### ✅ effect-tracker.ts — 清理到位

`SEVEN_DAYS_MS` 未使用常量的删除是唯一需要改的地方。冗余百分比计算（`*10000/100` → `*100`）未改（属建议项，非 blocker）。

### ❌ commands.ts — 两个问题未改

`findRecentReport` 和 `handleEvolveStats` 中的两个空 catch 仍然是纯静默忽略模式。`handleEvolveApply` 未按 action 拆分。

### ❌ judge.ts — 4 个问题未改

第 1 轮指出的所有问题原样残留：
1. `randomUUID` 未使用导入
2. `templateFileName` 赋值未读
3. `parseErr` catch 未用
4. `event.message as {...}` unsafe 断言

其中第 4 点（unsafe as）值得说明：虽然运行时行为上 `as` cast 不影响执行，但结构无运行时校验。若 pi 输出格式变化（JSONL message 结构变更），会静默返回空字符串而不会报错，debug 困难。

---

## 新发现的修复引入问题

1. **`summarizer.ts:extractToolFailureRates`** — 仍使用 `typeof data.error_rate === "number"` 旧模式，未统一到 `safeNum`。`safeNum` 已经存在，这里不统一是遗漏。

2. **`gc.ts` taste-lint 对 console-only catch 的升级警告** — `removeFiles` 的 catch 虽已加 `console.warn`，但 taste-lint 规则 `taste/no-silent-catch` 仍给出警告（"catch 块只有 console 调用 —— 底层错误未传播给调用方或用户"）。这属于品味层级的判断——当前行为（记录日志后继续执行后续删除）对 GC 场景是合理的，但 taste-lint 期望更高标准。

3. **`buildJudgeInput` 返回的 `promptFilePath` 未被消费** — pre-existing 问题，非本次引入，但值得标记。`runJudge` 直接从 `reportPath` 读取数据构造用户消息，`promptFilePath` 字段在整个数据流中无人读取。

---

## 综合评分

| 维度 | 评价 | 等级 |
|------|------|------|
| v1 MUST FIX 整体修复率 | 6 项中 2 项完全修复 + 2 项部分修复 | C- |
| 修复质量（已修复项） | `safeNum` 提取和函数拆分质量高；gc catch 修复到位 | A- |
| 修复覆盖（未动项） | 4 处 ESLint error 残留 + 2 处空 catch + 未拆分 + unsafe as | D |
| 是否引入新问题 | 无严重新问题；`extractToolFailureRates` 不统一使用 safeNum 属一致性遗漏 | B |

**总体 verdict: fail**

当前还剩 4 个 ESLint error，2 处纯空 catch，`handleEvolveApply` 未拆分，unsafe `as` 未处理。未达到清零标准。

---

## 新 MUST FIX（新增 + v1 残留）

| # | 严重级别 | 问题 | 涉及文件 | 改法 |
|---|----------|------|----------|------|
| 1 | 🔴 | `HistoryEntry` 未使用导入 | `commands.ts:22` | 从 `import type { ... }` 中删除 |
| 2 | 🔴 | `randomUUID` 未使用导入 | `judge.ts:13` | 删除 `import { randomUUID }` |
| 3 | 🔴 | `templateFileName` 赋值未用 | `judge.ts:93` | 删除或使用 |
| 4 | 🔴 | `parseErr` catch 未用 | `judge.ts:222` | 改为 `_parseErr` |
| 5 | 🟠 | `findRecentReport` 空 catch | `commands.ts:67` | 添加 `console.warn` |
| 6 | 🟠 | `handleEvolveStats` 空 catch | `commands.ts:453` | 添加 `console.warn` |
| 7 | 🟠 | unsafe `as` 类型断言在 `extractAssistantText` | `judge.ts:124-128` | 使用类型守卫函数替代 cast |
| 8 | 🟠 | `handleEvolveApply` 仍为单一大函数 | `commands.ts:253-352` | 按 list/apply/skip 拆分为 3 个内部函数 |

**建议（非 blocker）**：
- `extractToolFailureRates` 统一使用 `safeNum` 替代 inline typeof
- 提取 summarizer.ts 中散落的魔法数字为语义常量（`TOOL_FAILURE_THRESHOLD`, `DORMANT_SKILL_THRESHOLD` 等）
- `buildJudgeInput` 中删除未使用的 `templateFileName` 变量
- `effect-tracker.ts` 简化冗余百分比计算（`*10000/100` → `*100`）
