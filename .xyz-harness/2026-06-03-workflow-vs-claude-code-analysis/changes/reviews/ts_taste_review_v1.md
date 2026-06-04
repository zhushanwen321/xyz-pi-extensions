---
verdict: pass
must_fix: 1
---

# TypeScript Taste Review — resolveModelForScene 及相关集成

**审查人**: ts-taste-check (code review)
**审查日期**: 2026-06-03
**范围**: `resolveModelForScene` 新增函数及其在 workflow 中的调用链路

---

## 审查方法论

基于 [taste-lint base.mjs](../../../shared/taste-lint/base.mjs) 定义的品味规则：

| 维度 | 原则 | 检查要点 |
|------|------|----------|
| **类型即契约** | `no-explicit-any` | 避免 `any`、as 断言合理性、类型收窄完整性 |
| **结构先于一切** | 单文件 ≤1000 行、单函数 ≤300 行 | 函数长度、职责内聚 |
| **语义化命名** | `no-magic-numbers` | 常数命名、阈值提取 |
| **反馈不断裂** | 无空 catch、无静默跳过 | 错误路径处理完整性 |
| **只动必须动的** | 每处改动可追溯到当前需求 | 不要顺手优化/重构无关代码 |
| **一致性 > 品味** | 遵循代码库现有约定 | 模式冲突标记 |
| **不加推测性功能** | 最小代码解决当前问题 | 接口扩展的合理性 |

---

## 受审文件

| # | 文件 | 角色 |
|---|------|------|
| F1 | `extensions/model-switch/src/advisor.ts` | `resolveModelForScene` 实现，`computePeakRecommend` 等辅助函数 |
| F2 | `extensions/workflow/src/model-resolver.ts` | 胶水层：`resolveModel(opts)` 组合场景解析 + 异常处理 |
| F3 | `extensions/workflow/src/orchestrator.ts` | `handleAgentCall` 集成点 |

---

## 审查结果

### [MUST FIX-1] `resolveModelForScene`: 内层 `break` 导致 provider 优先级被忽略

**文件**: F1, 第 157-175 行

```typescript
for (const alias of aliases) {
  for (const [providerKey, pcfg] of Object.entries(config.models)) {
    const entry = pcfg.models[alias];
    if (!entry) continue;
    candidates.push({ ... });
    break; // ←── 问题在这里
  }
}
```

**问题**: 
- `break` 终止了内层 `Object.entries()` 的迭代，只取到 **第一个** 包含该 alias 的 provider
- `Object.entries()` 返回顺序是对象插入顺序，与 provider 优先级无关
- 如果两个 provider 都注册了同一个 alias（如 `"sonnet-claude"` 同时在 Provider A 和 Provider B），优先级低的 provider 可能因为插入顺序靠前而被选中，优先级高的被忽略
- `candidates` 中的 `priority` 字段只记录了选中 provider 的优先级，但从未用于**跨 provider 的同一 alias 的择优**——因为只有一个候选

**影响**: 配置中同一 alias 跨 provider 重复时，选择结果依赖属性枚举顺序而非意图（优先级）。`sort()` 的排序逻辑对于同一 alias 没有意义，因为它只能排序不同 alias 间的优先级。

**修复方案**（二选一）:

方案 A（推荐）：不 `break`，收集所有匹配的 provider→ alias 组合，让后续的 `sort()` 统一排序：

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

方案 B：在外层循环前按优先级给 `config.models` 排序，确保第一个匹配的 provider 就是最优的：

```typescript
const sortedModels = Object.entries(config.models)
  .sort(([, a], [, b]) => (config.plans[a.plan]?.priority ?? 99) - (config.plans[b.plan]?.priority ?? 99));
for (const alias of aliases) {
  for (const [providerKey, pcfg] of sortedModels) {
    // ... 现有逻辑
  }
}
```

方案 B 更轻量，但只选最高优先级的一个 provider，无法在第一个 provider 的 alias 被 peak-avoid 时 fallback 到次优 provider。方案 A 更完整。

---

### [SHOULD FIX-2] `findPeakPlan` 在 `resolveModelForScene` 中被重复调用

**文件**: F1, 第 148-150 行

```typescript
const peakRecommend = computePeakRecommend(now ?? new Date(), config, snapshot);
// computePeakRecommend 内部调用了 findPeakPlan(config)
const peakPlan = findPeakPlan(config); // ←── 重复调用
```

**问题**:
- `computePeakRecommend()` 内部首次调用 `findPeakPlan(config)`
- `resolveModelForScene` 紧接着再次调用
- `findPeakPlan` 执行 `Object.entries + filter + sort`，虽然开销不大，但纯属不必要的重复

**修复**:

方案 A：将 `computePeakRecommend` 的返回值扩展，同时返回 `peakPlan` 信息（违反"只动必须动的"——`RecommendInfo` 接口变更涉及多个文件）。

方案 B（推荐）：在 `resolveModelForScene` 中先调用 `findPeakPlan`，若为 `null` 提前返回，否则将结果传给 `computePeakRecommend`。但 `computePeakRecommend` 是公共 API，不能改签名。

方案 C（最轻量）：改为 `computePeakRecommend` 内部使用缓存（如模块级 `let _cachedPeakPlan: [string, PlanConfig] | null`），但如果 config 在运行时变化，缓存有错。

方案 D（最务实）：接受这个重复，加一个注释说明 `findPeakPlan` 被调用了两次。不值得增加复杂性来消除这个级别的开销。

**建议**: 标记为已知冗余，不做改动。

---

### [SHOULD FIX-3] `computePeakRecommend` 无 peak plan 时不应被调用

**文件**: F1, 第 147-148 行

```typescript
const snapshot = computeQuotaSnapshot(cache, config);
const peakRecommend = computePeakRecommend(now ?? new Date(), config, snapshot);
const peakPlan = findPeakPlan(config); // ←── 在 peakRecommend 之后
```

如果交换顺序：先 `findPeakPlan`，若无 peak plan 则直接跳过 `computePeakRecommend`（所有 candidates 的 `isPeakAvoid` 为 `false`），可避免无 peak plan 时的无效计算。

```typescript
const peakPlan = findPeakPlan(config);
const peakPlanName = peakPlan ? peakPlan[0] : null;
const peakRecommend = peakPlan
  ? computePeakRecommend(now ?? new Date(), config, snapshot)
  : { result: "ok" as const, reason: "No peak plan" };
```

同时消除了 [SHOULD FIX-2] 中的重复。

---

### [SHOULD FIX-4] 魔数 `99` 作为优先级 fallback

**文件**: F1, 第 166 行

```typescript
const priority = planCfg?.priority ?? 99;
```

`99` 是隐式的"最低优先级"常量。提取为命名常量：

```typescript
const FALLBACK_PRIORITY = 99;
```

---

### [NIT-1] `resolved ?? undefined` 冗余表达式

**文件**: F2, 第 23 行

```typescript
return resolved ?? undefined;
```

`resolveModelForScene` 返回类型是 `string | undefined`，`resolved` 已经是 `string | undefined`。`?? undefined` 是恒等变换（identity），可以简化为：

```typescript
return resolved;
```

---

### [NIT-2] `now ?? new Date()` 可用默认参数替代

**文件**: F1, 第 138 行的签名 + 第 148 行的调用：

```typescript
export function resolveModelForScene(scene: string, now?: Date): string | undefined {
  // ...
  const peakRecommend = computePeakRecommend(now ?? new Date(), config, snapshot);
```

可改为默认参数：

```typescript
export function resolveModelForScene(scene: string, now: Date = new Date()): string | undefined {
  // ...
  const peakRecommend = computePeakRecommend(now, config, snapshot);
```

消除调用处的 `??`，语义更清晰。但需注意：默认参数在函数被 `export` 时，每次调用都会 `new Date()`，行为与当前一致。

---

### [NIT-3] Hardcoded `200` 作为 prompt 截断长度

**文件**: F3, orchestrator.ts, `handleAgentCall` 中：

```typescript
task: opts.prompt.slice(0, 200),
```

应提取为命名常量 `TRACE_PROMPT_TRUNCATE_LEN = 200`。虽然这是 trivial 的格式限制，但符合 `no-magic-numbers` 品味规则。

---

## 集成评审：`handleAgentCall` 中的 `resolveModel` 调用

### 正面的设计决策

1. **优先级正确**：`resolveModel(opts)` 先检查 `opts.model`（用户显式指定），再回退到 `scene` 解析。用户显式 > 场景推荐 > Pi 默认。符合 F2 的文档注释约定。

2. **防御性编程充分**：
   - `resolveModel` 内有 `try/catch` 包裹 `resolveModelForScene` 调用，异常时不中断 workflow
   - `enrichedOpts` fallback 到原始 `opts`，不影响下游逻辑
   - `executeWithRetry` 中的 `// P0-2: Stale state check` 模式正确

3. **最小改动**：`handleAgentCall` 只增加了 2 行（`resolveModel` 调用 + `enrichedOpts` 构造），没有顺手重构周围的代码。符合"只动必须动的"原则。

4. **无类型泄漏**：`resolveModel` 返回 `string | undefined`，`AgentCallOpts.model` 也是 `string | undefined`，类型匹配。

5. **分离可测试**：`resolveModel` 是纯函数，与 `WorkflowOrchestrator` 类解耦。测试时可直接 mock `@zhushanwen/pi-model-switch`。

### 无遗漏的边界

| 场景 | resolveModel 返回 | enrichedOpts | 行为 |
|------|-------------------|-------------|------|
| `opts.model` 已设置 | `opts.model` | `{ ...opts, model: opts.model }` | 同原有 `model` |
| `opts.scene` 有效，解析成功 | `"provider/modelId"` | `{ ...opts, model: "provider/modelId" }` | 模型被替换为推荐值 |
| `opts.scene` 有效，解析失败 | `undefined` | `opts`（不变） | 使用 Pi 默认模型 |
| `opts.scene` 未设置 | `undefined` | `opts`（不变） | 使用 Pi 默认模型 |
| `resolveModelForScene` 抛出异常 | `undefined`（catch） | `opts`（不变） | 降级，不阻塞 workflow |

所有路径都是安全的降级场景，没有漏处理的异常路径。

---

## 总结

| 类别 | 数量 | 说明 |
|------|------|------|
| MUST FIX | 1 | 内层 `break` 导致 provider 优先级旁路 |
| SHOULD FIX | 3 | 冗余计算、逻辑顺序优化、魔数命名 |
| NIT | 3 | 冗余表达式、默认参数风格、截断长度常量 |

**详细条目**: MUST FIX-1（结构缺陷）> SHOULD FIX-3（微优化）> NIT-1/2/3（风格）。

**总体评价**: 代码质量良好。`resolveModelForScene` 职责清晰，`resolveModel` 胶水层简洁，`handleAgentCall` 集成克制。MUST FIX-1 是唯一的真实缺陷——当前仅在 alias 不跨 provider 的场景下工作正常。如果配置设计确保 alias 在 provider 间唯一（如通过 `provider/alias` 命名约定），则此问题不会触发。
