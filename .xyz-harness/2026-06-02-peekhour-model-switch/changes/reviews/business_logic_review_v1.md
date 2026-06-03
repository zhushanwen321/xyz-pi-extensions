---
verdict: pass
must_fix: 0
---

# Business Logic Review v1 — peekhour-model-switch

**Reviewer**: Business Logic Expert (subagent)
**Date**: 2026-06-03
**Scope**: UC-1 ~ UC-6 逐条验证代码实现是否正确对应业务用例

## 逐 UC 审查

### UC-1: 非高峰期 coding — "prefer zai" 规则注入

**预期**: 非高峰期注入包含 `"prefer zai"` 规则，指导 AI 优先使用 glm-5.1。

**代码路径**: `prompt.ts` → `formatRuleLine(isPeak=false, config)`

**实际输出**:
```
Rule: Off-peak: prefer zai (1x cost, no week/month limit). Switch to ocg only when zai rolling ≥95%. Switch takes effect next turn.
```

**判定**: ✅ PASS
- 包含 "prefer zai" + 原因 "1x cost, no week/month limit"
- 包含 95% 安全阀："Switch to ocg only when zai rolling ≥95%"
- 95% 为硬编码固定值（spec 要求：Z.ai 95% 阈值为固定设计决策，不暴露为配置项）

---

### UC-2: 高峰期 ocg 充裕 — "Prefer ocg unless" 规则注入

**预期**: 高峰期注入包含 `"Prefer ocg unless"` 规则。

**代码路径**: `prompt.ts` → `formatRuleLine(isPeak=true, config)`

**实际输出**:
```
Rule: Peak (3x zai cost). Prefer ocg unless: ocg near limit (≥80%), or zai resetting soon (<1h), or zai underutilized (<20%). Switch takes effect next turn.
```

**判定**: ✅ PASS
- "Prefer ocg" 前缀，"unless" 后跟三个例外条件
- ocg 限额阈值从 `config.plans["opencode-go"].thresholds.rollingLimitPct` 动态读取（默认 80%），非硬编码
- zai resetting (<1h) 和 underutilized (<20%) 为固定设计参数，与 spec 一致

---

### UC-3: 高峰期 ocg≥80% — 规则提及 "ocg near limit"

**预期**: 当 ocg rolling ≥80% 时，AI 能从注入数据中看到 ocg 高用量 + 规则中的 "ocg near limit (≥80%)" 条件。

**代码路径**:
- `prompt.ts` → `formatRuleLine()` 输出 "ocg near limit (≥XX%)"（动态读取阈值）
- `prompt.ts` → `formatOcgLine()` 输出 `ocg: rolling 85% [reset ...]`（实际数据）

**综合分析**: 规则和数据是独立注入的两行。AI 会看到：
```
ocg: rolling 85% [reset 54m], weekly 30% [reset 5d], monthly 66% [reset 22d]
Rule: Peak (3x zai cost). Prefer ocg unless: ocg near limit (≥80%), ...
```
85% > 80%，AI 自主判断 ocg near limit 条件成立。

**判定**: ✅ PASS
- 规则明确提及 "ocg near limit (≥N%)" 条件
- 数据行独立显示实际 ocg 百分比，AI 可交叉判断
- 阈值从配置动态读取，不是硬编码 80

---

### UC-4: 高峰期 urgent（reset<1h）— 允许 AI 自主判断

**预期**: 规则包含 "zai resetting soon (<1h)" 条件，reset 时间通过数据行显示，AI 综合判断。

**代码路径**:
- `prompt.ts` → `formatRuleLine()` 输出 "or zai resetting soon (<1h)"
- `prompt.ts` → `formatZaiLine()` 输出 `Z.ai: 70% [5h, reset 45m | no week/month limit]`
- `advisor.ts` → `parseZaiResetTime("45m")` = 2700 秒

**综合分析**: AI 看到数据 `reset 45m` 和规则 `resetting soon (<1h)`，可自主判断 45m < 1h 条件成立。

**关键点**: 旧版代码中 `budgetDecision()` 函数硬编码判断 urgent 并直接决定模型。新版只注入事实+规则，让 AI 自主决策。这符合 FR-1 的设计目标。

**判定**: ✅ PASS
- 规则措辞使用 "unless... or zai resetting soon (<1h)"，是条件性指导，非强制指令
- 重置时间通过 Z.ai 数据行显示，AI 可精确判断
- 不再由代码硬性决定，AI 有自主判断空间

---

### UC-5: cache 为空 — quota 行跳过

**预期**: `snapshot.zai === null` 和 `snapshot.ocg === null` → quota 行不输出。

**代码路径**:
- `advisor.ts` → `computeQuotaSnapshot(cache)`: 当 `cacheRec["zhipu"]` 为 undefined 时 `zai: null`，同理 `ocg: null`
- `prompt.ts` → `formatContextPrompt()`:
  ```typescript
  if (snapshot.zai) lines.push(formatZaiLine(snapshot.zai));
  if (snapshot.ocg) lines.push(formatOcgLine(snapshot.ocg));
  ```

**分析**: `null` 是 falsy，条件不满足时行不添加。注入只包含时间 + 规则 + 粘性 + 场景。

**判定**: ✅ PASS
- null snapshot 正确跳过 quota 行
- 不崩溃，其余信息正常注入
- 与 spec UC-5 postconditions 一致

---

### UC-6: compaction 后 justCompacted=true — "Free switch" 文案

**预期**: `justCompacted === true` → Stickiness 行显示 "Free switch (just compacted)."

**代码路径**:
- `advisor.ts` → `computeStickiness()`:
  ```typescript
  const justCompacted = lastCompactionIdx >= 0 && countTurnsAfter(entries, lastCompactionIdx) <= 1;
  if (justCompacted) {
      return { turns: 0, inputTokens: 0, justCompacted: true };
  }
  ```
- `prompt.ts` → `formatStickinessLine()`:
  ```typescript
  if (stickiness.justCompacted) return "Stickiness: Free switch (just compacted).";
  ```

**判定**: ✅ PASS
- `lastCompactionIdx >= 0`（存在 compaction entry）且后续 assistant turn ≤1 → `justCompacted = true`
- 输出 "Free switch (just compacted)."
- compaction 后 2+ turns → `justCompacted = false`，走正常粘性判断

---

## 补充验证

### AC-4 高峰期时间判断

`formatTimeLine()` 使用 `plan.start <= h && h < plan.end`，即 [14, 18) 半开区间。14:00-17:59 标记为 Peak，与 spec 一致。✅

### AC-5 向后兼容

`config.ts` → `applyDefaults()` 为旧配置填充：
- `peakStrategy = "conserve"`
- `rollingWindowHours = 5`
- `thresholds = { rollingLimitPct: 80, weeklyLimitPct: 80 }`

逻辑正确，字段存在时跳过，不存在时填充默认值。✅

### AC-6 推荐引擎移除

git diff 确认以下函数/类型已删除：
- `computeRecommendation` — 已删除
- `detectScene` — 已删除
- `budgetDecision` — 已删除
- `Recommendation` type — 已删除
- `formatAdvisorPrompt` — 已删除（替换为 `formatContextPrompt`）
✅

### 场景映射格式

`formatSceneLine()` 输出 `Scene: coding→glm-5.1/ds-flash | vision→mimo-v2.5/mimo-v2.5-pro | ...`，使用 alias 列表（非 provider/modelId 全称），与 spec 附录 A 一致。✅

---

## 发现的问题

### 问题 1 (低风险, 非阻塞)

**位置**: `prompt.ts` → `formatSceneLine()`

场景映射输出 alias 名称（如 `glm-5.1`、`ds-flash`），而 spec 附录 A 示例中场景映射使用 `provider/modelId` 格式（如 `glm-5.1/ds-flash`）。实际上两者都展示了场景对应的模型选项，但 alias 格式和示例中的 provider/modelId 格式不一致。

**影响**: 低。AI 看到的 alias 和 `switch_model` 工具的模型列表对应，可以正确切换。但与 spec 附录 A 示例格式有偏差。

**建议**: 确认是有意设计（alias 更简洁，省 tokens）还是需要改为 provider/modelId 格式。

### 问题 2 (信息性)

**位置**: `prompt.ts` → `formatRuleLine()`

高峰期规则的 ocg 阈值从 `config.plans["opencode-go"]` 硬编码取 plan key `"opencode-go"`。如果用户配置使用不同的 plan key 名，阈值读取失败，fallback 到 `?? 80`。

**影响**: 当前约定 plan key 为 `"opencode-go"` 或 `"zai"`，实际风险极低。但违反了从配置动态读取的原则。

**建议**: 未来可考虑从 plans 中按顺序找非 zai 的 plan 来获取阈值，但当前不阻塞。

---

## 总结

| UC | 结果 | 说明 |
|----|------|------|
| UC-1 | ✅ PASS | 非高峰期 "prefer zai" 规则正确注入 |
| UC-2 | ✅ PASS | 高峰期 "Prefer ocg unless" 三条件规则正确注入 |
| UC-3 | ✅ PASS | ocg ≥80% 规则 + 数据行配合，AI 可判断 |
| UC-4 | ✅ PASS | urgent 条件以规则+数据形式呈现，AI 自主判断 |
| UC-5 | ✅ PASS | cache 为空 → null snapshot → quota 行跳过 |
| UC-6 | ✅ PASS | justCompacted=true → "Free switch (just compacted)." |

**verdict: pass** — 所有 6 个业务用例均被代码正确实现。发现 2 个低风险信息性问题，均不阻塞。
