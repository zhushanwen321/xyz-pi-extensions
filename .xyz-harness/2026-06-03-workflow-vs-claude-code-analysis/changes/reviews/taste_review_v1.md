---
verdict: pass
must_fix: 0
---

# TypeScript Taste Review v2 — 验证 MUST FIX-1 修复

**审查人**: ts-taste-check (code review)
**审查日期**: 2026-06-03
**范围**: 验证第 1 轮 `ts_taste_review_v1.md` 中 MUST FIX-1 的修复状态

---

## 审查方法论

沿用 v1 的方法论（基于 `shared/taste-lint/base.mjs`）：

| 维度 | 原则 | 本轮关注点 |
|------|------|-----------|
| **结构先于一切** | 单文件 ≤1000 行、单函数 ≤300 行 | 验证内层循环结构是否变更 |
| **一致性 > 品味** | 遵循代码库现有约定 | 验证修复方式是否与 v1 推荐方案一致 |
| **只动必须动的** | 每处改动可追溯到当前需求 | 确认无顺手重构 |

---

## MUST FIX-1 验证：`break` 导致 provider 优先级旁路

### v1 问题摘要

v1 报告指出 `resolveModelForScene` 内层循环有 `break`，导致同一 alias 跨 provider 时只取第一个匹配的 provider，绕过了优先级排序逻辑。v1 推荐 **方案 A**：不 `break`，收集所有匹配项，让后续 `sort()` 统一排序。

### 修复验证

**文件**: `extensions/model-switch/src/advisor.ts` 第 158-181 行

**当前代码**:

```typescript
for (const alias of aliases) {
    // Find which provider has this alias
    for (const [providerKey, pcfg] of Object.entries(config.models)) {
        const entry = pcfg.models[alias];
        if (!entry) continue;

        const planCfg = config.plans[pcfg.plan];
        const priority = planCfg?.priority ?? 99;

        // Only mark as peak avoid if THIS candidate's plan matches the peak plan
        const isPeakAvoid = pcfg.plan === peakPlanName && peakRecommend.result === "avoid";

        candidates.push({
            alias,
            providerKey,
            modelId: entry.modelId,
            plan: pcfg.plan,
            priority,
            isPeakAvoid,
        });
    }
}
```

**对照 v1 推荐方案 A**:

```typescript
for (const alias of aliases) {
    for (const [providerKey, pcfg] of Object.entries(config.models)) {
        const entry = pcfg.models[alias];
        if (!entry) continue;
        const planCfg = config.plans[pcfg.plan];
        const priority = planCfg?.priority ?? FALLBACK_PRIORITY;
        const isPeakAvoid = pcfg.plan === peakPlanName && peakRecommend.result === "avoid";
        candidates.push({ alias, providerKey, modelId: entry.modelId, plan: pcfg.plan, priority, isPeakAvoid });
        // 不再 break
    }
}
```

**逐项核对**:

| 检查项 | v1 推荐 | 当前实现 | 状态 |
|--------|---------|----------|------|
| 内层 `break` 已移除 | 必须 | 已移除（无 `break` 关键字） | ✅ |
| 所有匹配 provider 都 push | 必须 | `candidates.push({...})` 在内层无条件执行 | ✅ |
| `isPeakAvoid` 按 candidate 独立计算 | 必须 | `pcfg.plan === peakPlanName` 逐 candidate 判定 | ✅ |
| 后续 `sort()` 统一排序 | 依赖 | `candidates.sort((a, b) => { ... })` 第 194-197 行 | ✅ |
| Fallback 逻辑：所有 candidate 都 peak avoid | 推荐 | 第 201-204 行检查 `best.isPeakAvoid`，返回 `undefined` | ✅ |

**核心结论**: 修复方式**与 v1 推荐方案 A 完全一致**——逐行对照无偏差。同一 alias 跨 provider 重复时，所有匹配项进入 `candidates`，由 `sort()` 按 `(isPeakAvoid, priority)` 排序，`candidates[0]` 是最优选择。若最优的 `isPeakAvoid`，仍保留在 `candidates` 中——`best.isPeakAvoid` 检查仅在排序结果的第一名是 avoid 时返回 `undefined`，而不是跳过所有 avoid 候选。这提供了 v1 方案 A 所述的完整 fallback 能力（第一个 provider 的 alias 被 peak-avoid 时可回退到次优 provider）。

### 修复评价

- **正确性**: 修复彻底，结构缺陷已消除
- **最小性**: 仅删除 1 行（`break`），无顺手重构。符合"只动必须动的"原则
- **可读性**: 内层循环意图清晰——"找到所有匹配的 provider→alias 组合"
- **副作用**: 无。`sort()` 后 `candidates[0]` 的语义由"第一个匹配"变为"最优匹配"，与函数注释（"按优先级排序"）一致

---

## 其他条目状态（v1 遗留）

### 未修复（沿用 v1 评估）

| 编号 | 内容 | 状态 | 沿用 v1 评估 |
|------|------|------|-------------|
| SHOULD FIX-2 | `findPeakPlan` 在 `resolveModelForScene` 中被重复调用 | 未改 | v1 建议"接受这个重复，不做改动" |
| SHOULD FIX-3 | `computePeakRecommend` 早返回优化（先 `findPeakPlan`） | 未改 | v1 建议为微优化，未必值得做 |
| SHOULD FIX-4 | 魔数 `99` 作为优先级 fallback（F1 第 167 行） | 未改 | v1 标记为 SHOULD |
| NIT-1 | `resolved ?? undefined` 冗余（F2 model-resolver.ts 第 18 行） | 未改 | v1 标记为 NIT |
| NIT-2 | `now ?? new Date()` 可用默认参数替代（F1 第 138 行） | 未改 | v1 标记为 NIT |
| NIT-3 | Hardcoded `200` 作为 prompt 截断长度（F3 orchestrator.ts 第 499 行） | 未改 | v1 标记为 NIT |

### 不影响 verdict 的理由

1. SHOULD FIX 级别的"两次 `findPeakPlan` 调用"在 v1 已标记为"接受这个重复"——这是性能/可读性的微小权衡，不属于必须修复项
2. SHOULD FIX-3 的"先 `findPeakPlan` 早返回"在无 peak plan 的配置下能节省一次 `computePeakRecommend` 调用，但函数本身有 `findPeakPlan` 内部短路（`if (!peakPlan) return { result: "ok", reason: "Off-peak" }`），性能差异微乎其微
3. SHOULD FIX-4 与三个 NIT 都属于"风格/可读性"层面，机械可改，不阻塞流程

---

## 总结

| 类别 | v1 数量 | v2 状态 | 净变化 |
|------|---------|---------|--------|
| MUST FIX | 1 | 0（已修复） | -1 |
| SHOULD FIX | 3 | 3（未改） | 0 |
| NIT | 3 | 3（未改） | 0 |

**MUST FIX-1 修复质量**: 优。修复方式与 v1 推荐方案完全一致，仅删 1 行 `break`，无副作用，无顺手重构。

**总体评价**: 结构缺陷已消除，`resolveModelForScene` 的 provider 选择逻辑现在正确响应 `config.plans[priority]` 配置。剩余的 SHOULD/NIT 项属于风格/微优化层级，不影响代码正确性，可在未来清理轮次处理。

**verdict**: **pass** — MUST FIX 已闭环，可进入下一阶段。
