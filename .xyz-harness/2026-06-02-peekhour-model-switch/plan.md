---
verdict: pass
complexity: L1
---

# PeekHour-Aware Model Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the recommendation engine with data+rules injection, letting AI self-decide model switching based on injected time, quota, stickiness info, and behavioral rules.

**Architecture:** Delete `computeRecommendation`/`detectScene`/`budgetDecision` from advisor.ts. Rewrite prompt.ts to produce a `[Model Context]` injection block (data + rules, no `>>> Recommended:`). Extend types.ts and config.ts with new PlanConfig fields (backward-compatible). Update index.ts data flow: readCache → snapshot → stickiness → formatContextPrompt → inject.

**Tech Stack:** TypeScript, Pi Extension API, typebox, quota-providers

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `packages/model-switch/src/types.ts` | modify | BG1 | Add PlanConfig fields, expand QuotaSnapshot, delete Recommendation |
| `packages/model-switch/src/config.ts` | modify | BG1 | Add backward-compatible defaults for new fields |
| `packages/model-switch/src/advisor.ts` | rewrite | BG1 | Delete recommendation engine; keep only stickiness + snapshot |
| `packages/model-switch/src/prompt.ts` | rewrite | BG1 | New `[Model Context]` injection format (data + rules) |
| `packages/model-switch/src/index.ts` | modify | BG1 | Update before_agent_start flow, recommend action |
| `packages/model-switch/src/setup.ts` | modify | BG1 | Generate new plan config fields |

---

## Task List

### Task 1: types.ts — 扩展类型定义

**Type:** backend

**Files:**
- Modify: `packages/model-switch/src/types.ts`

**Changes:**
1. Add to `PlanConfig`: `peakStrategy?: "conserve" | "normal"` (default `"conserve"`), `rollingWindowHours?: number` (default `5`), `thresholds?: { rollingLimitPct?: number; weeklyLimitPct?: number }` (default `{ rollingLimitPct: 80, weeklyLimitPct: 80 }`)
2. Expand `QuotaSnapshot.ocg`: add `monthlyPct: number`, `monthlyResetSec: number`, `weeklyResetSec: number`, rename `resetSec` → `rollingResetSec`
3. Delete `Recommendation` interface entirely
4. Delete `SetupResult` is fine (keep it — setup still generates config)

**Interface Contracts:**

#### Module: types

| Method/Type | Signature | Returns | Edge Cases | Spec Ref |
|-------------|-----------|---------|------------|----------|
| PlanConfig.peakStrategy | `peakStrategy?: "conserve" \| "normal"` | string | undefined → "conserve" | AC-5 |
| PlanConfig.rollingWindowHours | `rollingWindowHours?: number` | number | undefined → 5 | AC-5 |
| PlanConfig.thresholds | `thresholds?: { rollingLimitPct?: number; weeklyLimitPct?: number }` | object | undefined → { rollingLimitPct: 80, weeklyLimitPct: 80 } | AC-5 |
| QuotaSnapshot.ocg | expanded with `monthlyPct`, `monthlyResetSec`, `weeklyResetSec` | — | — | AC-2 |

---

### Task 2: config.ts — 向后兼容默认值

**Type:** backend

**Files:**
- Modify: `packages/model-switch/src/config.ts`

**Changes:**
1. After `return config as unknown as ModelPolicy;`, apply defaults: iterate `config.plans`, fill missing `peakStrategy`, `rollingWindowHours`, `thresholds` with defaults
2. No schema validation changes needed (new fields are optional)

**Interface Contracts:**

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| loadConfig | `() => ModelPolicy \| null` | config or null | missing fields → defaults filled | AC-5 |

---

### Task 3: advisor.ts — 删除推荐引擎，保留数据提取

**Type:** backend

**Files:**
- Rewrite: `packages/model-switch/src/advisor.ts`

**Changes:**
1. **Delete**: `computeRecommendation`, `detectScene`, `budgetDecision`, `isHardScene`, `computeQuotaSnapshotFromCache`, `makeRec`, `budgetReason`, `findPrimaryPlan`, `findFallbackPlanKey`, `findAliasForModel`, `findFirstModel`
2. **Keep**: `computeQuotaSnapshot` (expand ocg with monthly data), `computeStickiness` (refine to return `justCompacted`), `parseZaiResetTime`
3. **Rename `StickinessInfo`** → exported as part of public API, add `justCompacted: boolean`
4. **Expand `computeQuotaSnapshot`**: add `ocg.monthlyPct`, `ocg.monthlyResetSec`, `ocg.weeklyResetSec` from cache

**Interface Contracts:**

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| computeQuotaSnapshot | `(cache: CacheData) => QuotaSnapshot` | QuotaSnapshot | cache.updatedAt === 0 → all null | AC-2 |
| computeStickiness | `(entries: SessionEntries, config?: ModelPolicy) => StickinessInfo` | `{ turns, inputTokens, justCompacted }` | empty entries → {0, 0, false} | AC-3 |
| parseZaiResetTime | `(label: string) => number` | seconds | empty string → 0 | AC-2 |

**StickinessInfo:**

| Field | Type | Description |
|-------|------|-------------|
| turns | number | assistant turns since last model_change or compaction |
| inputTokens | number | cumulative input tokens since same anchor |
| justCompacted | boolean | compaction event found and ≤1 assistant turn after it |

---

### Task 4: prompt.ts — 重写注入格式

**Type:** backend

**Files:**
- Rewrite: `packages/model-switch/src/prompt.ts`

**Changes:**
1. **Delete**: `formatAdvisorPrompt`, `formatStatusLine`, `formatQuotaLine`, `formatSceneGuide`, `findPrimaryPlanPeak`
2. **New**: `formatContextPrompt` function with signature:

```typescript
interface ContextPromptData {
  currentModel: string;
  stickiness: StickinessInfo;
  snapshot: QuotaSnapshot;
  config: ModelPolicy;
  now: Date;
}

function formatContextPrompt(data: ContextPromptData): string
```

3. **Output format** (matches spec 附录 A):
```
[Model Context]
Current: {provider/modelId} ({turns} turns, ~{inputTokens}k input)
Stickiness: prefer staying. Free switch after compaction.
Time: HH:MM | {Peak hours (14-18, 3x Z.ai) | Off-peak}
Z.ai: {pct}% [5h, reset {resetStr} | no week/month limit]
ocg: rolling {pct}% [reset {resetStr}], weekly {pct}% [reset {resetStr}], monthly {pct}% [reset {resetStr}]
Rule: {dynamic rule based on peak status}
Scene: {from config.scenes}
Switch: use switch_model tool.
```

4. **Rule generation**:
   - Non-peak: `"Off-peak: prefer zai (1x cost, no week/month limit). Switch to ocg only when zai rolling ≥95%. Switch takes effect next turn."`
   - Peak: `"Peak (3x zai cost). Prefer ocg unless: ocg near limit (≥{thresholds.rollingLimitPct}%), or zai resetting soon (<1h), or zai underutilized (<20%). Switch takes effect next turn."`

5. **Stickiness line**:
   - `justCompacted` → `"Free switch (just compacted)."`
   - `turns >= 3 && inputTokens >= 20k` → `"Prefer staying (warm cache)."`
   - Otherwise → `"Switch OK (cold cache)."`

6. **Cache empty**: skip Z.ai and ocg lines entirely

7. **Keep**: `formatResetSec` (reuse for all reset values)

**Interface Contracts:**

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| formatContextPrompt | `(data: ContextPromptData) => string` | injection text | snapshot all null → skip quota lines | AC-1, AC-4 |

---

### Task 5: index.ts — 更新数据流和 recommend action

**Type:** backend

**Files:**
- Modify: `packages/model-switch/src/index.ts`

**Changes:**
1. **Update imports**: remove `computeRecommendation`, `detectScene`; import `computeStickiness` and new type `StickinessInfo`; import `formatContextPrompt` instead of `formatAdvisorPrompt`
2. **Rewrite `before_agent_start`**:
   ```typescript
   const entries = asSessionEntries(ctx.sessionManager.getBranch());
   const cache = readCache();
   const snapshot = computeQuotaSnapshot(cache);
   const stickiness = computeStickiness(entries, state.config);
   const currentModel = getCurrentModelId(ctx);
   const injection = formatContextPrompt({ currentModel, stickiness, snapshot, config: state.config, now: new Date() });
   return { systemPrompt: `\n${injection}` };
   ```
3. **Rewrite `handleRecommend`**: instead of calling `computeRecommendation`, show the same `formatContextPrompt` output that AI sees (data snapshot + rules)
4. **Keep unchanged**: `handleList`, `handleSearch`, `handleSwitch`, `handleSetup`, `switchToModel`

**Interface Contracts:**

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| before_agent_start | hook | `{ systemPrompt: string }` | config null → return void | AC-1 |

---

### Task 6: setup.ts — 新增配置字段

**Type:** backend

**Files:**
- Modify: `packages/model-switch/src/setup.ts`

**Changes:**
1. **In `inferPlans`**: add `peakStrategy`, `rollingWindowHours`, `thresholds` to each plan entry
2. For zai plan: `peakStrategy: "conserve"`, `rollingWindowHours: 5`, `thresholds: { rollingLimitPct: 80, weeklyLimitPct: 80 }`
3. For other plans: same defaults
4. **In `buildSummary`**: display new fields in the summary output

**Interface Contracts:**

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| generatePolicyConfig | `(registry, enabledModels?) => SetupResult` | `{ json, summary }` | — | AC-7 |

---

## Execution Groups

#### BG1: Model Switch Core

**Description:** All 6 tasks are tightly coupled backend changes to the same extension. They modify interdependent types and functions. Single group keeps context coherent.

**Tasks:** Task 1, Task 2, Task 3, Task 4, Task 5, Task 6

**Files (预估):** 6 个文件（0 create + 6 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | 按 taskComplexity 自动选择 |
| 注入上下文 | spec 全文、plan 全文、CLAUDE.md 编码规范 |
| 读取文件 | `packages/model-switch/src/*.ts`, `packages/quota-providers/src/cache.ts` |
| 修改/创建文件 | `packages/model-switch/src/{types,config,advisor,prompt,index,setup}.ts` |

**Execution Flow (BG1 内部):** 串行执行，依赖链：Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6

  Task 1 (types):
    1. general-purpose → 修改 types.ts

  Task 2 (config, depends on Task 1):
    1. general-purpose → 修改 config.ts

  Task 3 (advisor, depends on Task 1):
    1. general-purpose → 重写 advisor.ts

  Task 4 (prompt, depends on Task 1, Task 3):
    1. general-purpose → 重写 prompt.ts

  Task 5 (index, depends on Task 3, Task 4):
    1. general-purpose → 修改 index.ts

  Task 6 (setup, depends on Task 1):
    1. general-purpose → 修改 setup.ts

**Dependencies:** 无（BG1 是唯一的 Group）

**设计细节:** 见各 Task 描述。L1 无子文档。

---

## Dependency Graph & Wave Schedule

```
BG1 (all tasks)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | 所有后端改动，串行执行 |

---

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1 (完整注入) | formatContextPrompt | readCache→snapshot + getBranch→stickiness → format | Task 4, Task 5 |
| AC-2 (真实 cache) | computeQuotaSnapshot | readCache → extract zhipu/opencodeGo fields | Task 3 |
| AC-3 (粘性提取) | computeStickiness | getBranch → walk entries → count turns/tokens | Task 3 |
| AC-4 (高峰期规则) | formatContextPrompt (rule branch) | now.getHours() + plan.peak → rule text | Task 4 |
| AC-5 (向后兼容) | loadConfig | JSON.parse → fill defaults | Task 2 |
| AC-6 (删除推荐引擎) | N/A (deletion) | advisor.ts rewrite | Task 3 |
| AC-7 (setup 新字段) | generatePolicyConfig | inferPlans → add new fields | Task 6 |

No `[GAP]` entries.

---

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 每 turn 注入完整信息 | adopted | Task 4, Task 5 |
| AC-2 用量数据来自真实 cache | adopted | Task 3 |
| AC-3 粘性信息正确提取 | adopted | Task 3 |
| AC-4 高峰期规则正确 | adopted | Task 4 |
| AC-5 向后兼容 | adopted | Task 1, Task 2 |
| AC-6 推荐引擎移除 | adopted | Task 3 |
| AC-7 setup 命令更新 | adopted | Task 6 |
| FR-1 数据+规则注入 | adopted | Task 4 |
| FR-2 粘性信息提取 | adopted | Task 3 |
| FR-3 用量快照构建 | adopted | Task 3 |
| FR-4 高峰期规则注入 | adopted | Task 4 |
| FR-5 model-policy.json 扩展 | adopted | Task 1, Task 2 |
| FR-6 switch_model 工具保留 | adopted | Task 5 |
| FR-7 setup 命令更新 | adopted | Task 6 |
| 注入 ≤200 tokens | adopted | Task 4 (formatContextPrompt 输出验证) |
| 无 model-policy.json 静默跳过 | adopted | Task 5 (existing guard `if (!state.config) return`) |
