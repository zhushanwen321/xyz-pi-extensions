---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 5
  boundaries_checked: 8
  issues_found: 3
  must_fix_count: 0
  low_count: 2
  info_count: 1
  duration_estimate: "8"
---

# Integration Review v1

## 审查记录
- 审查时间：2026-06-03
- 上游 BLR: business_logic_review_v1.md
- 模块边界点数：8
- 模拟数据验证路径数：6

## 模块边界图

```
index.ts ──── loadConfig() ─────────→ config.ts
       ──── readCache() ──────────→ quota-providers/cache.ts
       ──── getBranch() ─────────→ Pi SDK (sessionManager)
       ──── computeQuotaSnapshot() → advisor.ts
       ──── computeStickiness() ──→ advisor.ts
       ──── formatContextPrompt() ─→ prompt.ts
       ──── pi.setModel() ────────→ Pi SDK (ExtensionAPI)
       ──── setup 生成 ───────────→ setup.ts
```

## 边界检查矩阵

| UC 编号 | 边界点 | D1 格式转换 | D2 错误传播 | D3 契约一致 | 问题 |
|---------|--------|------------|------------|------------|------|
| UC-1 | config.ts→index.ts | ✅ | ✅ | ✅ | — |
| UC-1 | quota-providers→advisor.ts | ✅ | ✅ | ✅ | — |
| UC-1 | advisor.ts→prompt.ts (snapshot) | ✅ | ✅ | ✅ | — |
| UC-1 | advisor.ts→prompt.ts (stickiness) | ✅ | ✅ | ✅ | — |
| UC-2 | prompt.ts→index.ts (systemPrompt) | ✅ | ✅ | ✅ | — |
| UC-5 | quota-providers→advisor.ts (null) | ✅ | ✅ | ✅ | — |
| UC-6 | Pi SDK→advisor.ts (entries) | ✅ | ✅ | ⚠️ | INFO-1: 类型断言绕过 |
| 通用 | config.ts→prompt.ts (config 传递) | ✅ | ✅ | ⚠️ | LOW-1: hardcode plan key |

## 问题清单

| # | 严重度 | UC | 边界点 | 维度 | 描述 | 文件 | 修改建议 |
|---|--------|-----|--------|------|------|------|---------|
| 1 | LOW | UC-2 | config→prompt | D3 | `formatRuleLine` 硬编码取 `config.plans["opencode-go"]`，plan key 变更时阈值读取失败 fallback 到 `?? 80` | prompt.ts L101 | 考虑从 plans 中动态查找非 zai 的 plan |
| 2 | LOW | UC-1 | Pi SDK→advisor | D3 | `asSessionEntries()` 使用 `as` 断言，绕过类型检查。`getBranch()` 返回 `any[]`，entry 的 `type`/`message` 字段无编译时校验 | types.ts L86-87 | 运行时无法改进（Pi SDK 限制），可加 runtime validation 函数 |
| 3 | INFO | UC-5 | quota→advisor | D1 | `CacheData` 是 `[providerId: string]: unknown` 的动态索引签名，advisor.ts 通过 `cacheRec["zhipu"]`/`cacheRec["opencodeGo"]` 硬编码 key 访问，key 名变更时静默返回 null | advisor.ts L23-24 | 可提取为常量集中管理 |

## 模拟数据验证详情

### UC-1: 非高峰期 coding — quota 数据链路

**执行路径**: `readCache()` → `computeQuotaSnapshot(cache)` → `formatContextPrompt(snapshot)` → systemPrompt

**模拟数据 (来自 BLR)**:
```json
{
  "updatedAt": 1748966400000,
  "zhipu": { "tokensPct": 70, "resetTime": "5h" },
  "opencodeGo": {
    "rolling": { "usagePercent": 30, "resetInSec": 18000 },
    "weekly": { "usagePercent": 25, "resetInSec": 432000 },
    "monthly": { "usagePercent": 60, "resetInSec": 1900800 }
  }
}
```

**边界 1: readCache() → computeQuotaSnapshot()**

- `readCache()` 返回 `CacheData`，类型为 `{ updatedAt: number; [key: string]: unknown }`
- `computeQuotaSnapshot(cache)` 内部 `const cacheRec = cache as Record<string, unknown>`
- 访问 `cacheRec["zhipu"]` → 得到 `{ tokensPct: 70, resetTime: "5h" }`
- `zaiData.tokensPct` → `70`（number ✅）
- `zaiData.resetTime` → `"5h"`（string ✅）
- `parseZaiResetTime("5h")` → `5 * 3600 = 18000`（sec ✅）
- 结果 snapshot.zai = `{ pct: 70, resetSec: 18000 }` ✅

**边界 2: computeQuotaSnapshot() → formatContextPrompt()**

- `snapshot.zai` 非空 → truthy → 进入 `formatZaiLine(snapshot.zai)`
- `formatZaiLine({ pct: 70, resetSec: 18000 })`
- `formatResetSec(18000)` → `Math.floor(18000/3600)=5` → `"5h00m"`
- 输出: `"Z.ai: 70% [5h, reset 5h00m | no week/month limit]"` ✅

**结论**: 数据从 cache → snapshot → prompt 完整传递，字段名/类型匹配。✅

---

### UC-2: 高峰期 ocg 充裕 — config 传递链路

**执行路径**: `loadConfig()` → `applyDefaults()` → `state.config` → `formatRuleLine(true, config)`

**模拟数据**:
```json
{
  "plans": {
    "zai": { "priority": 1, "peak": { "start": 14, "end": 18, "multiplier": 3 } },
    "opencode-go": { "priority": 2, "thresholds": { "rollingLimitPct": 80 } }
  }
}
```

**边界 1: loadConfig() → applyDefaults() → 返回**

- `loadConfig()` 解析 JSON → 验证 `version===1`、存在 `models/scenes/plans/stickiness`
- `applyDefaults()` 遍历 plans，为缺失字段填充默认值
- `plan.peakStrategy` → undefined → 填充 `"conserve"`
- `plan.rollingWindowHours` → undefined → 填充 `5`
- `plan.thresholds` → 已存在 → 只填充缺失的 `weeklyLimitPct: 80`
- 返回完整 `ModelPolicy` 对象 ✅

**边界 2: config → formatRuleLine(true, config)**

- `config.plans["opencode-go"]` → `{ priority: 2, thresholds: { rollingLimitPct: 80, weeklyLimitPct: 80 } }`
- `ocgPlan?.thresholds?.rollingLimitPct` → `80`
- 输出: `"Rule: Peak (3x zai cost). Prefer ocg unless: ocg near limit (≥80%)..."` ✅

**边界 3: config → findPrimaryPlanPeak() → formatTimeLine()**

- `findPrimaryPlanPeak()` 过滤 `p.peak` 存在的 plans → `["zai"]`
- 按 `priority` 排序 → `zai` (priority=1)
- 返回 `zai.plan.peak = { start: 14, end: 18, multiplier: 3 }`
- `formatTimeLine(now=15:30, plan)` → `plan.start(14) <= 15 && 15 < plan.end(18)` → isPeak=true
- 输出: `"Time: 15:30 | Peak hours (14-18, 3x Z.ai)"` ✅

**结论**: 配置加载、默认值填充、高峰期判断、规则注入链路完整。✅

---

### UC-3: 高峰期 ocg≥80% — 数据+规则联合验证

**模拟数据**:
- ocg rolling 85%，weekly 30%，monthly 66%

**边界: computeQuotaSnapshot() → formatOcgLine()**

- `cacheRec["opencodeGo"]` → 存在
- `ocgData.rolling.usagePercent` → `85`
- `ocgData.rolling.resetInSec` → 假设 3240 (54m)
- `formatOcgLine()` 输出: `"ocg: rolling 85% [reset 54m], weekly 30% [...], monthly 66% [...]"`
- 与规则 `"Prefer ocg unless: ocg near limit (≥80%)..."` 同时注入
- AI 看到 85% > 80%，自主判断 ocg near limit ✅

**结论**: 数据行和规则行独立注入，语义交叉正确。✅

---

### UC-4: 高峰期 urgent — reset time 解析链路

**模拟数据**:
- Z.ai resetTime: `"45m"`

**边界: readCache() → computeQuotaSnapshot() → formatZaiLine()**

- `zaiData.resetTime` = `"45m"`
- `parseZaiResetTime("45m")`:
  - `dM = null`, `hM = null`, `mM = ["45m", "45"]`
  - `sec = 45 * 60 = 2700`
- `formatResetSec(2700)` → `h=0, m=45` → `"45m"`
- 输出: `"Z.ai: 70% [5h, reset 45m | no week/month limit]"`
- 规则: `"or zai resetting soon (<1h)"`
- 45m < 1h，AI 可判断条件成立 ✅

**结论**: reset time 解析和格式化正确往返。✅

---

### UC-5: cache 为空 — null snapshot 链路

**模拟数据**:
```json
{ "updatedAt": 0 }
```

**边界: readCache() → computeQuotaSnapshot()**

- `cacheRec["zhipu"]` → `undefined` → falsy
- `zai: undefined ? {...} : null` → `null` ✅
- `cacheRec["opencodeGo"]` → `undefined` → falsy
- `ocg: null` ✅

**边界: snapshot → formatContextPrompt()**

- `if (snapshot.zai)` → `null` is falsy → 行跳过 ✅
- `if (snapshot.ocg)` → `null` is falsy → 行跳过 ✅
- 其余行（时间、规则、粘性、场景、switch 指引）正常输出 ✅

**结论**: 空 cache 降级路径正确，不崩溃，其余信息正常注入。✅

---

### UC-6: compaction 后 justCompacted — entries 链路

**模拟数据** (entries):
```
[
  { type: "message", message: { role: "user", ... } },
  { type: "compaction", ... },
  { type: "message", message: { role: "user", ... } },
  { type: "message", message: { role: "assistant", usage: { input: 5000 } } }
]
```

**边界: getBranch() → asSessionEntries() → computeStickiness()**

- `ctx.sessionManager.getBranch()` 返回 `any[]`
- `asSessionEntries(entries)` → 类型断言为 `SessionEntry[]`（实际为 `Array<{ type: string; [key: string]: unknown }>`）
- 反向遍历找 `lastCompactionIdx`:
  - entries[3].type = "message" → 跳过
  - entries[2].type = "compaction" → `lastCompactionIdx = 2` ✅
- `lastModelChangeIdx` 未找到 → 保持 `-1`
- `justCompacted = lastCompactionIdx(2) >= 0 && countTurnsAfter(entries, 2) <= 1`
  - 从 index 3 开始: entries[3].type="message", role="assistant" → count=1
  - `1 <= 1` → `justCompacted = true` ✅
- 返回 `{ turns: 0, inputTokens: 0, justCompacted: true }`

**边界: stickiness → formatStickinessLine()**

- `stickiness.justCompacted === true` → truthy
- 输出: `"Stickiness: Free switch (just compacted)."` ✅

**结论**: entries 类型断言安全（Pi SDK 限制），compaction 检测和粘性判断逻辑正确。✅

---

## 补充边界检查

### B1: switch_model tool → pi.setModel() 链路

- `handleSwitch()` 查找 config.models[query] → 得到 `ModelEntry { provider, modelId }`
- `ctx.modelRegistry.find(provider, modelId)` → 返回 model 对象或 undefined
- `pi.setModel(match)` → 返回 boolean（成功/失败）
- 成功后 `pi.appendEntry("model_change", { provider, modelId, alias, timestamp })` 记录切换
- 下次 `before_agent_start` 时 `computeStickiness()` 可检测到该 `model_change` entry ✅

**契约一致性**: `switchToModel` 使用的 `provider`/`modelId` 与 `ModelEntry` 定义一致。`appendEntry` 的 `"model_change"` type 字符串与 `computeStickiness` 中 `e.type === "model_change"` 匹配。✅

### B2: config null 降级路径

- `loadConfig()` 返回 null 的条件：文件不存在、JSON 解析失败、version 不为 1、缺少必填字段
- `index.ts` 中 `if (!state.config) return` 在 `before_agent_start` 中直接返回，不注入任何 prompt ✅
- `switch_model` tool 的 `handleList/handleSwitch/handleRecommend` 均检查 `!state.config` 并返回友好错误 ✅
- 降级模式下 switch_model tool 仍可用（提供 list/search/setup），只是无数据注入 ✅

### B3: prompt.ts 对 null/undefined 字段的防御

- `findPrimaryPlanPeak()`: 无 plan 有 peak 时返回 `undefined` → `formatTimeLine(now, undefined)` → `if (!plan) return Off-peak` ✅
- `formatRuleLine()`: `ocgPlan?.thresholds?.rollingLimitPct ?? 80` → 安全链式访问 + fallback ✅
- `resolveStickinessThresholds()`: `config.stickiness?.minTurns ?? 3` → 安全链式访问 ✅
- `formatSceneLine()`: `if (aliases.length === 0) continue` → 空 alias 数组跳过 ✅

---

## 结论

所有 8 个模块边界检查通过，6 条模拟数据验证路径数据格式/类型/语义均匹配。

发现 3 个问题，均为 LOW 或 INFO 级别，无 MUST_FIX：

1. **LOW-1**: `formatRuleLine` 中 plan key `"opencode-go"` 硬编码，配置中 plan key 变更时阈值读取失败。实际风险极低（当前约定固定），但违反"从配置动态读取"原则。
2. **LOW-2**: `asSessionEntries()` 使用 `as` 类型断言绕过编译检查。Pi SDK 返回 `any[]` 无法在编译时约束，运行时正确。
3. **INFO-1**: advisor.ts 中 cache provider key (`"zhipu"`/`"opencodeGo"`) 硬编码，与 `CacheData` 的动态索引签名风格不一致。可提取为常量集中管理。

**verdict: pass** — 模块间数据流完整、类型契约一致、null/undefined 防御到位、错误传播正确。
