---
verdict: pass
must_fix: 2
reviewer: ts-taste-check (automated + manual)
date: 2026-06-03
files_reviewed: 6
total_lines: 1012
---

# TS Taste Review — model-switch refactor (peekhour)

## ESLint 结果

```
2 errors, 7 warnings (taste-lint)
errors: no-unused-vars × 2 (advisor.ts)
warnings: no-magic-numbers × 7
```

ESLint 未配置 `--max-warnings=0` 时可通过，但 2 个 error 级别问题必须修复。

---

## advisor.ts（118 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|-----|------|------|------|------|
| P0 | 死代码 + 阈值不一致 | L54-55 | `minTurns` 和 `minInputTokens` 从 config 读取后未使用。重构前 `computeStickiness` 用它们计算 `isSticky`，重构后该逻辑移至 `formatStickinessLine`，但 advisor 中残留了两个 dead variable。同时 `formatStickinessLine` 硬编码 `3`/`20_000`，完全绕过了 config 中的 stickiness 配置 | 删除 advisor.ts L54-55 的 dead variables；`formatStickinessLine` 应接收 config 中的阈值参数，或让 `computeStickiness` 继续返回 boolean 判定 |
| P1 | 类型安全 | L20-38 | `computeQuotaSnapshot` 中 8 处 `as Record<string, unknown>` / `as number` / `as string` 链式断言。`CacheData` 是外部库的无类型数据，转换不可避免，但当前实现是 taste.md 定义的 `Record<string, unknown>` + `as` 反模式的典型实例 | 在函数顶部做一次 `as unknown as ConcreteCacheShape` 断言，内部用具体类型操作。或为 CacheData 定义类型守卫函数 |
| P1 | 类型安全 | L76-78 | `e.message as { role?: string; ... }` — session entry 的 message 字段用 inline `as` 断言 | 定义 `SessionMessage` interface 到 types.ts，与 `SessionEntries` 放在一起 |

统计: P0: 1 | P1: 2

---

## prompt.ts（119 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|-----|------|------|------|------|
| P0 | 阈值不一致（续） | L59 | `formatStickinessLine` 硬编码 `turns >= 3 && inputTokens >= 20_000`，与 config 的 `stickiness.minTurns`/`stickiness.minInputTokens` 脱钩。用户修改 config 后 prompt 文本与实际行为不一致 | 接收 config 参数或传入阈值 |
| P3 | 魔法数字 | L53 | `stickiness.inputTokens / 1000` — 1000 是 tokens→k 的转换因子 | 提取常量 `TOKENS_PER_K = 1000` |
| P3 | 硬编码 plan key | L90 | `config.plans["opencode-go"]` — plan key 直接硬编码 | 提取为常量或从 config 结构中动态查找非 zai 的 plan |
| P3 | 魔法数字 | L93 | `"<1h"` — 规则文本中的阈值来自硬编码而非 config | 无直接影响（纯展示文本），但如果希望可配置则需调整 |

统计: P0: 1 | P3: 3

---

## types.ts（109 行）

无问题。类型定义清晰，`getCurrentModelId` 和 `asSessionEntries` 是合理的边界类型转换。`StickinessInfo` 现在只返回原始数据，`justCompacted` flag 比之前的 `isSticky` boolean 更灵活。

统计: P0: 0 | P1: 0

---

## config.ts（82 行）

无问题。`applyDefaults` 向后兼容逻辑清晰，逐步填充嵌套字段。

统计: P0: 0 | P1: 0

---

## index.ts（286 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|-----|------|------|------|------|
| P0 | 反馈断裂 | L54 (before_agent_start catch) | `catch { return; }` 完全吞掉错误。如果 `readCache()` 或 `computeQuotaSnapshot` 抛异常，注入静默失败，零反馈。per essence.md "沉默是最危险的信号" | 至少加 `console.warn("[model-switch] context injection failed:", err)` |
| P1 | 跨函数重复 | L49-61 vs L195-212 | `before_agent_start` 和 `handleRecommend` 中完全相同的数据采集逻辑（5 行：getCurrentModel → asSessionEntries → readCache → computeSnapshot → computeStickiness → formatContextPrompt）。违反"一个关注点一条路径" | 提取 `gatherContextData(state, ctx)` 辅助函数，两处调用 |

统计: P0: 1 | P1: 1

---

## setup.ts（298 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|-----|------|------|------|------|
| P1 | 冗长类型重复 | L231, L232, L234, L241, L170 | 计划内联类型 `{ priority: number; peak?: { start: number; end: number; multiplier: number }; budgetTarget?: number; peakStrategy?: "conserve" \| "normal"; rollingWindowHours?: number; thresholds?: { rollingLimitPct?: number; weeklyLimitPct?: number } }` 在 `inferPlans` 返回类型、局部变量、`buildSummary` 参数中重复出现 3+ 次。per taste.md "冗长类型（>60 字符）出现 >3 次应定义 type alias" | 提取为 `InferredPlanConfig` type alias 到 types.ts 或 setup.ts 顶部 |

统计: P1: 1

---

## 汇总

| 优先级 | 数量 | 说明 |
|--------|------|------|
| P0 | 2 | 死代码+阈值不一致 × 1（跨 advisor/prompt）、静默 catch × 1 |
| P1 | 4 | `as` 链式断言、inline 类型断言、数据采集重复、冗长类型重复 |
| P3 | 3 | 魔法数字、硬编码 plan key |

### 必修项（must_fix）

1. **advisor.ts L54-55 + prompt.ts L59**：删除 dead variables，让 `formatStickinessLine` 的阈值与 config 关联。这是重构遗漏——移走 `isSticky` 逻辑时丢掉了 config 驱动的阈值。
2. **index.ts L54**：`catch { return; }` → `catch (err) { console.warn(...); return; }`。

### 建议修复顺序

1. 修 P0-1（阈值一致性）→ 同时消除 ESLint 的 2 个 error
2. 修 P0-2（静默 catch）
3. 提取数据采集辅助函数（P1 重复）
4. 提取 setup.ts 类型别名（P1 冗长类型）

### 正面评价

- 重构方向正确：推荐引擎逻辑从代码侧移至 AI 侧（prompt 注入数据+规则，由 AI 决策），减少了硬编码决策路径
- 文件职责划分清晰：advisor=数据提取、prompt=格式化、config=加载、index=胶水
- 函数长度控制好：最长 `modelSwitchExtension` ~45 行，所有 handler < 40 行
- 时间常量命名规范（`SECONDS_PER_HOUR` 等）
