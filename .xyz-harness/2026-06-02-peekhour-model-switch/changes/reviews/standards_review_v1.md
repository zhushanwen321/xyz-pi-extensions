---
verdict: fail
must_fix: 2
reviewer: standards-review-agent
date: 2026-06-03
scope: packages/model-switch/src/*.ts
base_commit: HEAD~1
---

# Standards Review — model-switch (peekhour refactor)

## 审查范围

对 `packages/model-switch/src/` 下 6 个文件（types.ts, config.ts, advisor.ts, prompt.ts, index.ts, setup.ts）逐项检查 CLAUDE.md 编码规范。

## 检查结果汇总

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 禁止 `any` | ✅ PASS | 未发现 `any` 类型使用（包括 `as any`、`: any`），`_onUpdate` 参数已用 `unknown` |
| 单文件 ≤ 1000 行 | ✅ PASS | 最长文件 `setup.ts` 298 行，`index.ts` 286 行 |
| 函数 ≤ 80 行 | ❌ FAIL | `index.ts:41` `modelSwitchExtension()` 84 行（超标 4 行） |
| 注释解释"为什么" | ✅ PASS | JSDoc 注释如「向后兼容：为旧配置填充新字段默认值」解释了原因而非行为 |
| import 顺序 | ✅ PASS | 所有文件遵循 Node 内置 → npm 包 → 项目内部顺序 |
| 不加推测性功能 | ✅ PASS | 所有变更可追溯到架构重构（推荐引擎 → 上下文注入），无额外功能 |
| 命名规范 | ✅ PASS | 入口 `modelSwitchExtension`，类型 `ModelPolicy`、`QuotaSnapshot` 等命名一致 |

## Must-Fix 问题

### MF-1: `modelSwitchExtension` 函数 84 行，超出 80 行上限

**文件**: `index.ts:41-124`
**当前**: 84 行
**上限**: 80 行

该函数注册了 `session_start`、`before_agent_start` 两个事件 + `registerCommand` + `registerTool`，所有逻辑内联。超标不多（4 行），可通过以下任一方式修正：

- **方案 A**: 将 `registerTool` 的 `execute` 回调体提取为独立函数 `handleToolAction(state, pi, ctx, params)`，该回调当前占约 20 行。
- **方案 B**: 将 `pi.registerTool({...})` 整体提取为 `registerSwitchTool(pi, state)` 函数。

推荐方案 B，职责更清晰。

### MF-2: `setup.ts` 中 Plan 类型内联重复 4 次

**文件**: `setup.ts:179, 235, 236, 243`
**问题**: `{ priority: number; peak?: { start: number; end: number; multiplier: number }; budgetTarget?: number; peakStrategy?: "conserve" | "normal"; rollingWindowHours?: number; thresholds?: { rollingLimitPct?: number; weeklyLimitPct?: number } }` 这个类型字面量在 `buildSummary` 参数、`inferPlans` 返回值、`plans` 变量声明、`plan` 变量声明中重复了 4 次。

这虽然是"顺手优化"的边界情况，但违反了 DRY 原则，且 `PlanConfig` 已在 `types.ts` 中定义（含所有这些字段），完全可以直接复用 `PlanConfig` 或提取一个 `type SetupPlan = Pick<PlanConfig, ...> & { priority: number }`。

**修复方案**: 将该类型提取为 type alias，放到 `setup.ts` 顶部或 `types.ts` 中。

> 注：此问题虽非本次 diff 引入（重构前就存在），但本次 diff 扩展了该类型（新增 `peakStrategy`、`rollingWindowHours`、`thresholds`），使重复更加严重。按 CLAUDE.md "全量修复"原则，应一并处理。

## 建议项（非阻塞）

### S-1: `advisor.ts` 中 `computeQuotaSnapshot` 大量 `as` 断言

`advisor.ts:21-44` 对 `CacheData` 的嵌套字段使用了约 10 处 `as Record<string, unknown>` 和 `as number` 类型断言。这是 `@zhushanwen/pi-quota-providers` 的 `CacheData` 类型不够具体导致的。当前写法可接受，但长期应推动上游改善类型定义。

### S-2: `prompt.ts` 硬编码的规则文本

`formatRuleLine` 中 `"Off-peak: prefer zai (1x cost, no week/month limit). Switch to ocg only when zai rolling ≥95%"` 和 `"Peak (3x zai cost). Prefer ocg unless..."` 是硬编码的策略规则。这些规则理论上应该从配置中 derive（如 `peakStrategy`、`thresholds`）。当前只有 `rollingLimitPct` 参数化了，其余仍硬编码。这是架构选择（规则由代码而非配置驱动），可接受，但需注意后续维护。

## 变更摘要

本次 diff 将 model-switch 从"推荐引擎"架构重构为"上下文注入"架构：

1. **删除推荐逻辑**: `advisor.ts` 移除了 `computeRecommendation`、`budgetDecision`、`detectScene` 等函数（净减 ~170 行）
2. **改为数据注入**: `prompt.ts` 从格式化推荐结果改为格式化用量数据+粘性信息+行为规则，由 AI 自主决策
3. **扩展 QuotaSnapshot**: `ocg` 类型新增 `rollingResetSec`、`weeklyResetSec`、`monthlyPct`、`monthlyResetSec` 字段
4. **新增 PlanConfig 字段**: `peakStrategy`、`rollingWindowHours`、`thresholds`
5. **新增 StickinessInfo 类型**: 替代原内联 `isSticky` boolean，增加 `justCompacted` 标记
6. **config.ts 新增 `applyDefaults`**: 向后兼容旧配置

架构方向正确：将决策权从代码转给 AI，扩展只负责提供上下文数据。
