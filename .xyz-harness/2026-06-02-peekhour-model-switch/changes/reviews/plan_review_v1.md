---
review:
  type: plan_review
  round: 1
  timestamp: "2026-06-03T10:30:00"
  target: ".xyz-harness/2026-06-02-peekhour-model-switch/plan.md"
  verdict: pass
  summary: "计划评审完成，第1轮通过，0条MUST FIX，3条LOW，1条INFO"

statistics:
  total_issues: 4
  must_fix: 0
  low: 3
  info: 1

issues:
  - id: 1
    severity: LOW
    location: "plan.md:Task 3 (advisor.ts)"
    title: "parseZaiResetTime 与 quota-providers 中 parseZaiResetSec 重复"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "plan.md:Task 4 (prompt.ts)"
    title: "Stickiness 行文案与 spec 附录 A 有细微差异"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "plan.md:Task 3 (advisor.ts)"
    title: "computeStickiness 返回签名与现有实现的不一致未显式说明迁移路径"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: INFO
    location: "plan.md:Spec Coverage Matrix"
    title: "AC-6 覆盖映射中 'N/A (deletion)' 可更精确"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-06-03 10:30
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-06-02-peekhour-model-switch/plan.md`（含 spec.md、e2e-test-plan.md、use-cases.md、non-functional-design.md）

---

## 1. spec 完整性

### 目标明确性 ✅

spec 用一句话即可概括：**将 model-switch 扩展从「推荐引擎注入推荐结果」改为「数据+规则注入，AI 自主决策」**。目标清晰，不模糊。

### 范围合理性 ✅

改动范围明确限定在 6 个文件（types.ts, config.ts, advisor.ts, prompt.ts, index.ts, setup.ts），属于同一个 Pi extension 内部重构。不涉及跨包 API 变更、不涉及新增依赖。边界清晰。

### 验收标准可量化 ✅

7 条 AC（AC-1 到 AC-7）均可通过具体行为验证：
- AC-1: 注入包含特定字段，≤200 tokens — 可通过检查注入文本验证
- AC-2: 数据来自 cache 的具体字段路径 — 可通过单元测试验证
- AC-3: 粘性信息从 entries 中提取 — 可通过单元测试验证
- AC-4: 14:00-17:59 标记高峰期 — 可通过时间 mock 验证
- AC-5: 旧配置正常加载 — 可通过加载不含新字段的 JSON 验证
- AC-6: 函数删除 — 可通过代码搜索验证
- AC-7: setup 生成新字段 — 可通过运行 setup 命令验证

无模糊描述（如"提升用户体验"）。

### 待决议项 ⚠️

无 `[待决议]` 标记。spec 中有几个固定设计参数（zai 95% 阈值、ocg ≥80% 来自配置、zai <1h 和 <20% 固定），均给出了明确值和理由。

---

## 2. plan 可行性

### 任务拆分合理性 ✅

6 个 task 按"类型先行 → 配置默认值 → 数据提取 → 格式化 → 入口集成 → setup 更新"的依赖链排列。每个 task 粒度适中：
- Task 1 (types): 增删类型定义，~30 行变更
- Task 2 (config): 添加默认值填充逻辑，~15 行变更
- Task 3 (advisor): 删 ~200 行推荐引擎，保留+扩展 ~60 行数据提取
- Task 4 (prompt): 重写格式化函数，~80 行新代码
- Task 5 (index): 更新数据流和 import，~30 行变更
- Task 6 (setup): 添加新字段生成，~20 行变更

每个 task 可由单个 subagent 独立完成，无需跨 task 协调（依赖链是线性的）。

### 依赖关系正确性 ✅

```
Task 1 (types) → Task 2 (config)
                → Task 3 (advisor)
                → Task 6 (setup)
Task 3 (advisor) → Task 4 (prompt)
Task 4 (prompt) → Task 5 (index)
```

被依赖的类型定义（Task 1）排在最前面。advisor（Task 3）依赖 types。prompt（Task 4）依赖 types 和 advisor 的 StickinessInfo/QuotaSnapshot 类型。index（Task 5）依赖 advisor 和 prompt 的导出。setup（Task 6）只依赖 types。依赖关系正确，无循环。

### 工作量估算合理性 ✅

总计 ~450 行变更（删除 ~200 行 + 新增/修改 ~250 行），在 L1 复杂度范围内合理。单个 subagent 可在一个执行周期内完成。

### 遗漏 task 检查 ✅

对照 spec 7 条 FR 和 7 条 AC：
- FR-1/AC-1: 数据+规则注入 → Task 4 + Task 5
- FR-2/AC-3: 粘性提取 → Task 3
- FR-3/AC-2: 用量快照 → Task 3
- FR-4/AC-4: 高峰期规则 → Task 4
- FR-5/AC-5: 配置扩展 → Task 1 + Task 2
- FR-6: switch_model 保留 → Task 5
- FR-7/AC-7: setup 更新 → Task 6
- AC-6: 删除推荐引擎 → Task 3

无遗漏。

---

## 3. spec 与 plan 一致性

### 覆盖完整性 ✅

逐条对照 spec 的 7 条 FR → 7 条 AC，全部在 plan 的 Spec Coverage Matrix 和 Spec Metrics Traceability 中有对应 task。无 `[GAP]` 条目。

### 额外工作检查 ✅

plan 中无 spec 未提及的额外工作。Task 6 (setup) 虽然不是核心功能变更，但 spec FR-7 明确要求更新 setup 命令。

### 验收标准映射 ✅

每条 AC 在 plan 的任务中都有明确的实现步骤和 Interface Contracts 对应。Spec Coverage Matrix 的映射关系正确。

---

## 4. Execution Groups 合理性

### 分组合理性 ✅

L1 复杂度，单个 BG1 group，包含 6 个 task / 6 个文件。符合"每组文件数 ≤ 10、task 数 ≤ 4 为建议"的规范。6 个 task 全部是后端改动，类型一致，功能紧密关联（同属 model-switch 扩展内部重构）。

### Subagent 配置完整性 ✅

BG1 配置表包含：
- Agent: general-purpose ✅
- Model: 按 taskComplexity 自动选择 ✅
- 注入上下文: spec 全文、plan 全文、CLAUDE.md 编码规范 ✅
- 读取文件: `packages/model-switch/src/*.ts`, `packages/quota-providers/src/cache.ts` ✅
- 修改/创建文件: 6 个目标文件 ✅

### Wave 编排 ✅

单 Wave，单 Group，串行执行。无并行需求，无需检查文件冲突。

### 执行流正确性 ✅

依赖链 Task 1 → 2 → 3 → 4 → 5 → 6 为串行。Task 3 和 Task 2 都只依赖 Task 1，理论上可并行，但 plan 选择串行以保持上下文连贯性——这是合理的（总工作量小，串行开销可忽略）。

---

## 5. 接口契约审查

### AC 覆盖矩阵完整性 ✅

Spec Coverage Matrix 中 7 条 AC 全部有对应行，无遗漏。

### plan.md interface contracts 与源码对照

逐条验证 plan 声明的接口是否与现有源码兼容：

| plan 声明 | 源码验证 | 结论 |
|-----------|---------|------|
| `computeQuotaSnapshot(cache: CacheData) => QuotaSnapshot` | advisor.ts 中已有此函数，签名一致 | ✅ |
| `computeStickiness(entries, config?) => StickinessInfo` | advisor.ts 中已有，返回 `{ isSticky, turns, inputTokens }` | ✅ plan 新增 `justCompacted` 字段 |
| `parseZaiResetTime(label: string) => number` | advisor.ts 中已有 | ✅ |
| `formatContextPrompt(data: ContextPromptData) => string` | 新函数，替代 `formatAdvisorPrompt` | ✅ |
| `loadConfig() => ModelPolicy \| null` | config.ts 中已有 | ✅ |
| `generatePolicyConfig(registry, enabledModels?) => SetupResult` | setup.ts 中已有 | ✅ |

plan 中 `StickinessInfo` 新增 `justCompacted` 字段替代现有的 `isSticky`——这是设计意图（从布尔 sticky 变为更细粒度的状态描述），在 Task 3 中有说明。

### 类型传递一致性 ✅

数据流：`readCache()` → `CacheData` → `computeQuotaSnapshot()` → `QuotaSnapshot` → `formatContextPrompt()`。类型传递链完整，无断裂。

`getBranch()` → `SessionEntries` → `computeStickiness()` → `StickinessInfo` → `formatContextPrompt()`。同上。

---

## 6. 后端设计充分性

### 实现理由 ✅

每个 task 都说明了"为什么"（删除推荐引擎是因为 AI 自主决策优于硬编码规则；新增字段是为了可配置性）。

### 存储变更 ✅

新增 3 个 PlanConfig 可选字段，`loadConfig()` 填充默认值。无数据库/表变更（纯文件配置）。

### 边界条件覆盖 ✅

plan 明确处理了：
- cache 为空（`updatedAt === 0`）→ quota 行跳过（Task 3、Task 4）
- config 为 null → `before_agent_start` 提前返回（Task 5）
- 旧配置无新字段 → 默认值填充（Task 2）
- compaction 后 ≤1 turn → justCompacted（Task 3）

### 非功能性要求 ✅

non-functional-design.md 明确覆盖了稳定性、数据一致性、性能、安全。plan 中的实现方式（纯函数、无副作用、≤5ms 延迟、≤200 tokens）与 NFR 一致。

---

## 7. 源码交叉验证

### 数据字段路径验证

对照 plan 和实际源码：

**Z.ai cache 数据**（spec: `cache.zhipu.tokensPct`, `cache.zhipu.resetTime`）：
- 源码 `zhipu.ts` 的 `ZhipuData` 接口确认有 `tokensPct: number` 和 `resetTime: string` ✅
- plan Task 3 `computeQuotaSnapshot` 从 `cacheRec["zhipu"]` 读取，与源码 advisor.ts 现有实现一致 ✅
- `parseZaiResetTime` 解析 "4h39m"/"3d20h" 格式，与 `zhipu.ts` 中 `processZhipu` 生成的格式一致 ✅

**ocg cache 数据**（spec: `cache opencodeGo.rolling/weekly/monthly`）：
- 源码 `opencode-go.ts` 的 `OpenCodeGoData` 确认有 `rolling`, `weekly`, `monthly` 三个 `OpenCodeGoUsage` 对象 ✅
- 每个 `OpenCodeGoUsage` 有 `usagePercent` 和 `resetInSec` ✅
- plan Task 3 扩展 ocg 字段（`monthlyPct`, `monthlyResetSec`, `weeklyResetSec`）——对照现有 `computeQuotaSnapshot` 中只取了 `rollingPct`、`weeklyPct`、`resetSec`，扩展方向正确 ✅

**粘性信息**：
- 现有 `computeStickiness` 遍历 entries 找 `model_change` 和 `compaction`，统计 turns 和 inputTokens ✅
- plan 增加返回 `justCompacted: boolean`（compaction 后 ≤1 turn），现有代码已有 `countTurnsAfter(entries, lastCompactionIdx) <= 1` 的判断逻辑，只需调整返回值结构 ✅

### 删除函数列表验证

plan Task 3 列出的待删函数：
- `computeRecommendation` — advisor.ts:23 ✅ 存在
- `detectScene` — advisor.ts:85 ✅ 存在
- `budgetDecision` — advisor.ts:148 ✅ 存在
- `isHardScene` — advisor.ts:83 ✅ 存在
- `computeQuotaSnapshotFromCache` — advisor.ts:92 ✅ 存在（stub）
- `makeRec` — advisor.ts:172 ✅ 存在
- `budgetReason` — advisor.ts:183 ✅ 存在
- `findPrimaryPlan` — advisor.ts:196 ✅ 存在
- `findFallbackPlanKey` — advisor.ts:211 ✅ 存在
- `findAliasForModel` — advisor.ts:216 ✅ 存在
- `findFirstModel` — advisor.ts:225 ✅ 存在

保留函数：
- `computeQuotaSnapshot` — advisor.ts:52 ✅ 存在
- `computeStickiness` — advisor.ts:104 ✅ 存在（需扩展返回值）
- `parseZaiResetTime` — advisor.ts:96 ✅ 存在

prompt.ts 待删函数：
- `formatAdvisorPrompt` — prompt.ts:17 ✅ 存在
- `formatStatusLine` — prompt.ts:37 ✅ 存在
- `formatQuotaLine` — prompt.ts:56 ✅ 存在
- `formatSceneGuide` — prompt.ts:70 ✅ 存在
- `findPrimaryPlanPeak` — prompt.ts:95 ✅ 存在

保留：
- `formatResetSec` — prompt.ts:103 ✅ 存在

---

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | LOW | plan.md:Task 3 | `parseZaiResetTime` 在 advisor.ts 和 quota-providers 的 `zhipu.ts` 中各有一份（后者叫 `parseZaiResetSec`）。plan 未说明是保留 advisor.ts 中的本地副本还是复用 quota-providers 的。当前 advisor.ts 的版本是本地实现，quota-providers 的版本未导出。保留本地副本是合理的（避免跨包依赖），但建议在 task 说明中显式标注这一设计决策 | 在 Task 3 描述中加一句："保留 advisor.ts 本地 parseZaiResetTime，不复用 quota-providers 的 parseZaiResetSec（该函数未导出且跨包依赖不必要）" |
| 2 | LOW | plan.md:Task 4 | Stickiness 行的三档文案（`Free switch (just compacted)` / `Prefer staying (warm cache)` / `Switch OK (cold cache)`）与 spec 附录 A 示例中的 `prefer staying. Free switch after compaction.` 有细微差异。spec 示例是固定文本，plan 是动态三选一。两者在语义上一致，但措辞不同 | 确认以 plan 的动态三档为准（更精确），或在 spec 中同步更新示例 |
| 3 | LOW | plan.md:Task 3 | `computeStickiness` 现有返回 `{ isSticky, turns, inputTokens }`，plan 新接口返回 `{ turns, inputTokens, justCompacted }`。删除 `isSticky` 字段是设计意图（粘性决策从 advisor 移到 prompt），但 plan 未显式说明这个字段的删除 | 在 Task 3 描述中显式标注：删除 `isSticky` 字段，粘性判断逻辑移至 `formatContextPrompt` |
| 4 | INFO | plan.md:Spec Coverage Matrix | AC-6 (推荐引擎移除) 的 Interface Method 列填 `N/A (deletion)`，Data Flow 列为空。虽然是删除操作，但可以更精确地标为 "advisor.ts: delete 11 functions" 以提高可追溯性 | 可选改进，不影响执行 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

### 结论

通过

### Summary

计划评审完成，第1轮通过，0条MUST FIX。plan 质量高：任务拆分合理、依赖关系正确、spec 覆盖完整、接口契约与源码一致。3 条 LOW 均为文档精确度问题（重复函数的设计决策标注、文案一致性、字段迁移说明），不影响执行正确性。
