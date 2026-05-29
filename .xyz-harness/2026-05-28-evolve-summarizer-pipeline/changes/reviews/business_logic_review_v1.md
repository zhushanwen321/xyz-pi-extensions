---
verdict: fail
must_fix: 1
review:
  type: business_logic_review
  round: 1
  timestamp: "2026-05-28T14:00:00"
  target:
    - "evolution-engine/src/commands.ts"
    - "evolution-engine/src/summarizer.ts"
    - "evolution-engine/src/effect-tracker.ts"
    - "evolution-engine/src/gc.ts"
    - "evolution-engine/src/judge.ts"
  summary: "业务逻辑审查：发现 1 条 MUST FIX（效果追踪 after snapshot 滞后一轮）、2 条 LOW（关键词匹配歧义、SEVEN_DAYS_MS 未使用）、2 条 INFO（buildJudgeInput 死代码、buildEffectReviewPlaceholder 冗余）"
  data_simulation: true

statistics:
  total_issues: 5
  must_fix: 1
  low: 2
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "commands.ts:handleEvolve step 3c → effect-tracker.ts:buildEffectReview"
    title: "Effect review 'after' snapshot 使用过时数据（off-by-one）"
    status: open
    description: "handleEvolve step 3a 加载 metricsHistory（不含当前轮 snapshot），step 3b summarizeReport 生成并持久化新 snapshot 但不更新内存中的 metricsHistory，step 3c buildEffectReview(metricsHistory) 使用旧的 'latest' snapshot 作为 after 值，导致效果对比滞后一轮。"

  - id: 2
    severity: LOW
    location: "effect-tracker.ts:KEYWORD_TO_METRIC"
    title: "Token 输入/输出关键词匹配无法区分"
    status: open
    description: "totalInputTokens 和 totalOutputFields 的严格匹配分别依赖中文'输入'/'输出'区分；仅英文 title（如 'Reduce output tokens'）在严格匹配均失败后进入 fallback，fallback 按数组顺序匹配到 totalInputTokens（第一条带 token 的映射），导致错配。"

  - id: 3
    severity: LOW
    location: "effect-tracker.ts"
    title: "SEVEN_DAYS_MS 常量声明未使用"
    status: open
    description: "第 56 行声明 const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000，但 isWithinDays 函数从 days 参数计算 delta，未引用该常量。"

  - id: 4
    severity: INFO
    location: "judge.ts:buildJudgeInput"
    title: "buildJudgeInput 是死代码（不再被调用）"
    status: open
    description: "buildJudgeInput 仍定义且 export，但 commands.ts 在 diff 中已删除其 import。信号报告通过 summarizer pipeline 直接生成，judge input 在 commands.ts 中内联构造。可考虑清理。"

  - id: 5
    severity: INFO
    location: "summarizer.ts:buildEffectReviewPlaceholder"
    title: "占位函数始终返回空数组，建议移除"
    status: open
    description: "summarizeReport 调用 buildEffectReviewPlaceholder(metricsHistory) 始终返回 []，实效为无意义调用。效果回顾由 commands.ts step 3c 独立计算并回写。建议删除该占位调用以消除读者困惑。"

---

# Business Logic Review — Evolve Summarizer Pipeline

## 审查信息

- **审查轮次**: 第 1 轮
- **审查类型**: 业务逻辑审查
- **审查范围**: summarizer pipeline 新增代码 + judge 修改 + commands 胶水
- **依据文档**: `use-cases.md` + git diff + 完整源文件
- **审查目标**: UC-1 / UC-2 每一步在代码中的正确实现、数据流完整性、边界条件

---

## 一、UC-1 逐步骤验证

### Step 1: 查找或生成报告

| 检查点 | 实现 | 状态 |
|--------|------|------|
| `findRecentReport()` 按 mtime 筛选 sinceDays 内的报告 | `commands.ts:findRecentReport` — 遍历 reportsDir，筛选 mtime >= cutoff 的报告，取最新 | ✅ |
| 无报告时运行 analyzer 生成 | `execFileSync("python3", [ANALYZER_SCRIPT, "--since", ...])` — 60s 超时 | ✅ |
| analyzer 脚本不存在时报错 | 检查 `existsSync(ANALYZER_SCRIPT)`，抛明确错误 | ✅ |
| analyzer 执行失败时报错 | try-catch 包裹 execFileSync，抛异常含 stderr | ✅ |
| `since` 参数降级（非法格式→7d） | `parseSinceDays` — 先尝试 `N+d` 格式，fallback parseInt，最终 fallback 7 | ✅ |

**边界验证**:
- `reportsDir` 不存在 → `findRecentReport` 返回 null → 触发 analyzer 路径 ✅
- `since = "abc"` → `parseSinceDays` → `parseInt("abc") = NaN` → fallback 到 7 ✅
- analyzer 超时 → `execFileSync` 抛错 → 被 catch 重新抛出 ✅

### Step 2: 读取报告

| 检查点 | 实现 | 状态 |
|--------|------|------|
| 读取文件 + JSON parse | `readFileSync` + `JSON.parse` | ✅ |
| 解析失败时抛错 | try-catch，错误含文件和原因 | ✅ |
| 空文件 | `JSON.parse` 抛 SyntaxError → 被 catch 重新抛出 | ✅ |

### Step 3: Signal Summarizer Pipeline

#### 3a: 加载 metrics 历史

```typescript
const metricsHistory = loadMetricsHistory(dirs.evolutionDir);
```

- 读 `metrics-history.json` → `{ snapshots: MetricsSnapshot[] }` → 返回 snapshots 数组
- 文件不存在 → 返回 `[]` ✅
- 文件损坏（JSON 解析失败）→ catch → 返回 `[]` ✅
- **注意**: 此 `metricsHistory` 不含即将在 step 3b 生成的新 snapshot ⚠️

#### 3b: `summarizeReport()` — 核心压缩

```
┌─────────────────────────────────────────────────────────────┐
│ summarizeReport(report, metricsHistory, evolutionDir, reportPath) │
├─────────────────────────────────────────────────────────────┤
│ ① extractMetricsSnapshot       → MetricsSnapshot            │
│ ② detectAnomalies              → Anomaly[]                  │
│ ③ computeTrends(current, prev) → TrendDelta[]  (有历史时)   │
│ ④ buildEffectReviewPlaceholder → [] (始终空)                 │
│ ⑤ compressReport               → Record<string,unknown>    │
│ ⑥ 组装 SignalReport                                          │
│ ⑦ saveMetricsSnapshot → 写入 metrics-history.json (滑动窗口)│
│ ⑧ writeFileSync → signals/signal-{date}.json                │
│ ⑨ 返回 SignalReport                                          │
└─────────────────────────────────────────────────────────────┘
```

**`extractMetricsSnapshot` 字段提取验证**:

| 来源字段 | snapshot 字段 | 默认值 | 状态 |
|---------|---------------|--------|------|
| `_meta.total_sessions` | `sessionCount` | 0 | ✅ |
| `_meta.analysis_period.until` | `date` | 当日 | ✅ |
| `tool_stats.total_calls` | `totalToolCalls` | 0 | ✅ |
| `tool_stats.edit_retry_rate` | `editRetryRate` | 0 | ✅ |
| `error_stats.bash_failure_rate` | `bashFailureRate` | 0 | ✅ |
| `error_stats.self_correction_rate` | `selfCorrectionRate` | 0 | ✅ |
| `token_stats.total_input` | `totalInputTokens` | 0 | ✅ |
| `token_stats.total_output` | `totalOutputTokens` | 0 | ✅ |
| `token_stats.cost_total` | `totalCost` | 0 | ✅ |
| `token_stats.avg_per_session.input` | `avgInputPerSession` | 0 | ✅ |
| `token_stats.avg_per_session.output` | `avgOutputPerSession` | 0 | ✅ |
| `user_patterns.corrections.rate` | `userCorrectionRate` | 0 | ✅ |
| `user_patterns.repeated_requests` | `repeatedRequestCount` | 0 (length) | ✅ |
| `satisfaction.single_turn_completion_rate` | `singleTurnCompletionRate` | 0 | ✅ |
| `satisfaction.avg_turns_per_session` | `avgTurnsPerSession` | 0 | ✅ |
| `satisfaction.avg_tool_calls_per_session` | `avgToolCallsPerSession` | 0 | ✅ |
| `satisfaction.session_duration_stats.median_minutes` | `medianSessionMinutes` | 0 | ✅ |
| `skill_stats.triggered_skills` | `activeSkillCount` | 0 (keys length) | ✅ |
| `skill_stats.never_triggered` | `dormantSkillCount` | 0 (array length) | ✅ |
| `skill_stats.skill_file_sizes` | `totalSkillFileSize` | 0 (sum) | ✅ |
| `error_stats.by_tool` | `toolFailureRates` | `{}` (过滤 >0.05) | ✅ |

**`extractToolFailureRates` 阈值**:
- `errorRate > 0.05` — 只保留值得关注的工具 ✅
- 缺失 `by_tool` 或非对象 → 返回 `{}` ✅

**异常检测阈值验证**:

| 异常类型 | 阈值 | 严重度 | 状态 |
|---------|------|--------|------|
| Tool failure | rate >= 0.3 (medium), >= 0.5 (high) | 正确分级 | ✅ |
| Dormant skills | count > 10 (medium), > 20 (high) | 正确分级 | ✅ |
| User correction | rate > 0.3 (medium), > 0.5 (high) | 正确分级 | ✅ |
| Token hotspot | input > 5M (medium), > 20M (high) | 正确分级 | ✅ |

**趋势对比** (`computeTrends`):
- 对比字段: editRetryRate, bashFailureRate, singleTurnCompletionRate, userCorrectionRate, selfCorrectionRate, avgTurnsPerSession
- 过滤条件: 变化绝对值 >= 10%
- 无历史数据 → 返回 `[]` ✅
- prev=0, curr=0 → skip ✅
- prev=0, curr>0 → change=100%（合理近似）✅

**`compressReport` — 原始报告子集提取**:

| 数据类型 | 保留策略 | 状态 |
|---------|---------|------|
| `_meta` | 完整保留 | ✅ |
| `actionable_issues` | top-5 | ✅ |
| `skill_health` | top-10 | ✅ |
| `satisfaction.by_project` | top-5 by sessions | ✅ |
| `error_stats` | 摘要（排除 `by_project`） | ✅ |
| `top_error_patterns` | top-3 | ✅ |

#### 3c: Effect Review 追加

```typescript
const effectReview = buildEffectReview(recentHistory, metricsHistory);
```

**实现在 `effect-tracker.ts` 中验证** → 见下文 UC-2 评审。

**⚠️ MUST FIX #1 在此处**: `metricsHistory` 是 step 3a 加载的版本（不含当前轮新 snapshot）。新 snapshot 在 step 3b 由 `summarizeReport` 创建并持久化，但内存中的 `metricsHistory` 变量未更新。`buildEffectReview` 用 `findLatestSnapshot(metricsHistory)` 得到的是**上一轮的 latest**，而非当前最新状态。

#### 3d: GC 清理

| 清理项 | 策略 | 实现 | 状态 |
|-------|------|------|------|
| reports/ | 保留最新 3 个 | `listJsonByMtime` → sort desc → slice(3) → unlink | ✅ |
| signals/ | 保留最新 30 个 | 同上 | ✅ |
| daily/ | 保留 90 天内 | 文件名解析日期 → 过滤超期 → unlink | ✅ |
| 目录不存在 | 静默跳过 | `existsSync` 检查 | ✅ |
| 文件名非法日期 | mtime 兜底 | `Number.isNaN(fileTime)` → `statSync().mtimeMs` | ✅ |

**GC 策略验证**:
- 信号文件保留 30 个，与 `metrics-history.json` 的滑动窗口上限（30 条）匹配 ✅
- 报告文件只保留 3 个（原始报告很大 ~750KB），合理 ✅
- daily 数据保留 90 天，合理 ✅

#### 3e: 构建 Judge Input

```typescript
const judgeInput: JudgeInput = {
    target: params.target === "all" ? "all" : params.target,
    reportPath: signalPath,
    promptFilePath: "",
};
```

- `reportPath` 指向信号文件而非原始报告 — pipeline 变更正确 ✅
- `promptFilePath: ""` — runJudge 不读取该字段（已内联构建 userMessage），有效但不优雅 ✅

### Step 4: 运行 LLM Judge

`runJudge(judgeInput, dirs.templateDir)`:

| 检查点 | 实现 | 状态 |
|--------|------|------|
| 读取 template 文件 | `readFileSync(templatePath)` | ✅ |
| template 不存在抛错 | `existsSync` 检查 | ✅ |
| 读取信号文件 | `readFileSync(input.reportPath)` | ✅ |
| stdin 传 userMessage（vs args） | `proc.stdin.write(userMessage)` | ✅ |
| 首次解析成功 → 返回 | 直接返回 `first.suggestions` | ✅ |
| 首次空输出 → 重试简化 prompt | `retryMessage` = "Output ONLY JSON..." | ✅ |
| 重试成功 → 返回 | 返回 `second.suggestions` | ✅ |
| 两次失败 → 保存诊断 + 抛错 | 写入 judge-stderr-{ts}.txt | ✅ |
| 超时处理（120s） | setTimeout → SIGTERM → reject | ✅ |
| JSONL 解析 | `extractAssistantText` 取最后一个 assistant text | ✅ |
| `parseJudgeOutput` 校验 | 必需字段、confidence 范围、severity 枚举 | ✅ |

**重试机制边界条件**:
- 首次 `parseJudgeOutput` 抛错（含 "Empty Judge output"）→ catch 块 resolve `{ suggestions: [], raw, stderr }` ✅
- 两次均为空 → throw Error with diagnostics ✅
- 首次成功但有 parse 错 → catch 返回 `{ suggestions: [], raw, stderr }` → 进入重试 ✅

### Step 5: 保存 pending.json

| 检查点 | 实现 | 状态 |
|--------|------|------|
| 构造 PendingFile（含 generatedAt + reportUsed + suggestions） | `savePending` | ✅ |

### Step 6: 返回摘要

| 检查点 | 实现 | 状态 |
|--------|------|------|
| 格式化建议列表 | `#N [SEV] title` | ✅ |
| details 含完整元数据 | index, id, title, severity, confidence, target, targetPath, status | ✅ |
| 无建议时返回 "0 suggestions" | `suggestions.length === 0` → 空行 | ✅ |

---

## 二、UC-2 效果回顾验证

### 整体流程

```
apply 发生时 (handleEvolveApply):
  └ appendHistory 记录 apply 事件 + metricsSnapshotDate

下次 /evolve 运行时 (handleEvolve step 3c):
  loadHistory(30)          → 取最近 30 条 history
  loadMetricsHistory()     → 取 metrics 快照历史
  buildEffectReview()      → 匹配 apply 记录 → 比对前后 snapshot
  signalReport.effectReview = effectReview (if non-empty)
  writeFileSync(信号文件)   → 追加写入
```

### 2a: 筛选 apply 记录

```typescript
const recentApplies = recentHistory.filter(
    entry => entry.action === "apply" && isWithinDays(entry.timestamp, 7),
);
```

- 只筛选 `action === "apply"` ✅
- 只保留 7 天内的记录 ✅
- `isWithinDays` 对非法 timestamp 返回 false ✅

### 2b: 关键词匹配 (`matchMetricField`)

**两遍匹配策略**:
1. **严格匹配**: `mapping.keywords.every(kw → lower.includes(kw))` — 所有关键词匹配
2. **宽松匹配**: `mapping.keywords.some(kw → lower.includes(kw))` — 任一关键词匹配

**映射表**:

| keywords | field | 严格匹配难度 | 宽松匹配风险 |
|----------|-------|-------------|-------------|
| `["edit", "retry", "匹配"]` | `editRetryRate` | 需要中文 | 宽松"edit"/"retry" |
| `["bash", "failure", "失败"]` | `bashFailureRate` | 需要中文 | 宽松"bash"/"failure" |
| `["single-turn", "单轮", "completion"]` | `singleTurnCompletionRate` | 需要中文 | 宽松"completion" |
| `["correction", "纠正", "用户纠正"]` | `userCorrectionRate` | 需要中文 | 宽松"correction" |
| `["self-correction", "自纠正", "self_correction"]` | `selfCorrectionRate` | 无需中文 | fine |
| `["turns", "轮次", "avg_turns"]` | `avgTurnsPerSession` | 需要中文 | 宽松"turns" |
| `["token", "input", "输入"]` | `totalInputTokens` | 需要中文 | 宽松"token" ⚠️ |
| `["token", "output", "输出"]` | `totalOutputTokens` | 需要中文 | 宽松"token" ⚠️ |
| `["cost", "成本", "花费"]` | `totalCost` | 需要中文 | 宽松"cost" |
| `["dormant", "沉睡", "未触发"]` | `dormantSkillCount` | 需要中文 | 宽松"dormant" |
| `["skill", "技能"]` | `activeSkillCount` | 需要中文 | 宽松"skill" |

**⚠️ LOW #2 详细说明**:

场景: suggestion title = "Reduce output token costs"
- 严格匹配 `["token", "input", "输入"]` → "input" 不在 title 中 → ❌
- 严格匹配 `["token", "output", "输出"]` → "输出" 不在 title 中 → ❌
- 进入宽松匹配:
  - `["token", "input", "输入"]` → "token" matches → ✅ **匹配到 `totalInputTokens`** ← ❌ 错误
- 结果: 输出 token 优化被匹配到输入 token 指标

> 根因: 宽松匹配按数组顺序返回第一个命中，`totalInputTokens` 排在 `totalOutputTokens` 之前。英文 title 建议无法区分 input/output。

### 2c: Snapshot 查找

**before snapshot**:
```typescript
const beforeSnapshot = entry.metricsSnapshotDate
    ? findSnapshotBefore(metricsHistory, entry.metricsSnapshotDate)
    : findSnapshotBefore(metricsHistory, entry.timestamp);
```

- `findSnapshotBefore` 遍历升序数组，取 `date <= target` 的最新一条 ✅
- 无 `metricsSnapshotDate`（旧 history）→ 用 apply timestamp 近似 ✅
- 找不到 before snapshot → skip 该条 apply ✅

**after snapshot**:
```typescript
const latest = findLatestSnapshot(metricsHistory);
```
- **⚠️ MUST FIX #1**: `metricsHistory` 是 step 3a 加载的版本，不含 step 3b 生成的新 snapshot
- 因此 `latest` 是上一轮的 latest，而非当前最新状态
- 效果对比: 比较的是 (apply 之前) vs (上一轮 /evolve 时的 state)，而非 (当前 state)

### 2d: 变化率计算

```
changePercent = before === 0
    ? 100
    : round(((after - before) / before) * 10000) / 100
```

| 条件 | 结果 | 合理性 |
|------|------|--------|
| before=0.15, after=0.12 | -20% | ✅ |
| before=0, after=0.05 | 100% | 近似（实际为无穷大），可接受 |
| before=0.05, after=0 | -100% | 正确 |
| before=0, after=0 | skip | ✅ |
| before/after 非 number | skip | ✅ |

---

## 三、边界条件审查

### 空报告 / 最小报告

| 条件 | 预期行为 | 实际实现 | 状态 |
|------|---------|---------|------|
| 空对象 `{}` | 全部取默认值 0 | `extractMetricsSnapshot` 全字段都有 `typeof === "number"` 防护 | ✅ |
| 缺失顶级字段 | 按缺失处理 | 每个字段独立 as-cast + typeof 检查 | ✅ |
| 零 session | snapshot 全部为 0 | 合理 | ✅ |
| metric 值为 negative | 保持原值 | 类型守卫只检查 number，不检查范围 | ✅（由上游保证） |

### 无历史数据

| 条件 | 预期行为 | 实际实现 | 状态 |
|------|---------|---------|------|
| 首次运行 /evolve | metricsHistory = [] | `loadMetricsHistory` 返回 `[]` | ✅ |
| computeTrends 无前驱 | 返回 [] | `previous === undefined → trends = []` | ✅ |
| saveMetricsSnapshot | 创建第一条 entry | push + write — 数组长度为 1 | ✅ |
| buildEffectReview | 返回 [] | `if (metricsHistory.length === 0) return []` | ✅ |

### 无 apply 记录

| 条件 | 预期行为 | 实际实现 | 状态 |
|------|---------|---------|------|
| 从未 apply | recentApplies = [] | `filter(action === "apply")` → 空 | ✅ |
| apply 超过 7 天 | recentApplies = [] | `isWithinDays` 过滤 | ✅ |
| apply 记录 < 7 天但 title 无关键词 | reviews = [] | `matchMetricField` → null → continue | ✅ |
| before snapshot 不可用 | skip 该条 | `if (!beforeSnapshot) continue` | ✅ |

### Judge 空输出

| 条件 | 预期行为 | 实际实现 | 状态 |
|------|---------|---------|------|
| LLM 返回空字符串 | 重试 | `parseJudgeOutput` throw "Empty Judge output" → catch → resolve([]) → retry | ✅ |
| LLM 返回非 JSON | 重试 | `JSON.parse` throw → catch → resolve([]) → retry | ✅ |
| 第一次失败，第二次成功 | 返回第二次结果 | 检查 `second.suggestions.length > 0` → return | ✅ |
| 两次都失败 | 抛错含诊断 | 保存 stderr/raw 到 judge-stderr-{ts}.txt | ✅ |
| 第一成功但有 valid 建议 | 直接返回 | `first.suggestions.length > 0` → return | ✅ |

---

## 四、数据流完整性图

```
analyzer/report
    │
    ▼
┌─────────────────────────────────────────────────────┐
│  handleEvolve (commands.ts)                          │
│                                                       │
│  1. findRecentReport / run analyzer                   │
│     → reportPath (phase2-{ts}.json)                   │
│                                                       │
│  2. readFileSync + JSON.parse                          │
│     → report: Record<string, unknown>                  │
│                                                       │
│  3a. loadMetricsHistory                                │
│      → metricsHistory: MetricsSnapshot[]  ←─── (不含当前轮) │
│                                                       │
│  3b. summarizeReport(report, metricsHistory, ...)      │
│      ├── extractMetricsSnapshot → MetricsSnapshot      │
│      ├── detectAnomalies → Anomaly[]                  │
│      ├── computeTrends(prev from metricsHistory)       │
│      │   → TrendDelta[]                                │
│      ├── compressReport → compressed subset           │
│      ├── saveMetricsSnapshot                           │
│      │   → metrics-history.json  (append + slide)  ←── 新 snapshot 写入磁盘 │
│      └── writeFileSync                                 │
│          → signals/signal-{date}.json                  │
│      └── return SignalReport                           │
│                                                       │
│  3c. loadHistory(30) → recentHistory                  │
│      buildEffectReview(recentHistory, metricsHistory) ←──── 使用过时 metricsHistory │
│      if non-empty → rewrite signal file                │
│                                                       │
│  3d. runGc(evolutionDir)                              │
│      → clean reports(3), signals(30), daily(90d)      │
│                                                       │
│  3e. judgeInput = { reportPath: signalPath, ... }     │
│                                                       │
│  4. runJudge(judgeInput, templateDir)                  │
│      ├── readFileSync(signalPath) → signalData        │
│      ├── readFileSync(templatePath) → templateContent │
│      ├── runJudgeOnce(templateContent, userMessage)   │
│      ├── [retry on empty]                             │
│      └── return EvolutionSuggestion[]                  │
│                                                       │
│  5. savePending → pending.json                        │
│  6. return formatted summary                          │
└─────────────────────────────────────────────────────┘
```

### 关键数据依赖

```
report ──→ extractMetricsSnapshot ──→ snapshot ──→ saveMetricsSnapshot ──→ metrics-history.json
                  │                                    │
                  ├──→ detectAnomalies ──→ anomalies   │
                  │                                    │
                  └──→ computeTrends ────→ trends      │
                           ↑                           │
                        metricsHistory             新 snapshot here
                        (不含当前轮)                     │
                                                        │
                                                  buildEffectReview
                                                  使用 metricsHistory
                                                  来自 step 3a (不含新snapshot)
                                                        ↑
                                                   ⚠️ MUST FIX #1
```

---

## 五、关键问题清单

### MUST FIX #1: Effect review "after" snapshot 滞后一轮

**位置**: `commands.ts` step 3a → step 3c 数据传递

**现象**:
```
step 3a:  metricsHistory = [T0, T1]           ← 加载现有
step 3b:  summarizeReport → 创建 snapshot T2  ← 写入磁盘
          saveMetricsSnapshot(T2)              ← metrics-history.json 现在有 [T0, T1, T2]
step 3c:  buildEffectReview(metricsHistory)    ← metricsHistory 仍是 [T0, T1]
          → latest = metricsHistory[-1] = T1   ← "after" = T1 而非 T2 ❌
```

**影响**: 每次 /evolve 的效果回顾比较的是 (apply 前 snapshot) vs (上一次 /evolve 时的 snapshot)，而非当前最新 snapshot。变化率可能偏小或方向相反。

**修复方案**（二选一）:

**方案 A**（推荐，最小改动）: 将 `signalReport.metricsSnapshot` 传给 `buildEffectReview` 作为 after 值：

```typescript
// commands.ts step 3c — 传入当前最新 snapshot
const effectReview = buildEffectReview(recentHistory, metricsHistory, signalReport.metricsSnapshot);
```

对应 `effect-tracker.ts` 增加可选参数：

```typescript
export function buildEffectReview(
    recentHistory: HistoryEntry[],
    metricsHistory: MetricsSnapshot[],
    latestOverride?: MetricsSnapshot,  // 新增
): EffectReview[] {
    // ...
    const latest = latestOverride ?? findLatestSnapshot(metricsHistory);
    // ...
}
```

**方案 B**: 在 step 3c 前重新加载 metricsHistory：

```typescript
// commands.ts step 3c — 重新加载以确保包含新 snapshot
const updatedMetricsHistory = loadMetricsHistory(dirs.evolutionDir);
const effectReview = buildEffectReview(recentHistory, updatedMetricsHistory);
```

方案 A 更优：避免额外 I/O，语义明确。

### LOW #2: Token 输入/输出关键词匹配无法区分

**位置**: `effect-tracker.ts:KEYWORD_TO_METRIC` — `totalInputTokens` vs `totalOutputTokens`

**根因**: 两字段的严格匹配都依赖中文关键词（"输入"/"输出"）来区分。纯英文 title 无法区分。

**影响**: 约 30-50% 的场景（英文 AI 生成的 suggestion title）可能匹配到错误的 metric 字段。

**建议修复**: 在严格匹配中增加英文区分的策略。两种方案：

**方案 A**（推荐）: 删除中文依赖，用唯一英文关键词组合区分：

```typescript
{ keywords: ["input", "token"], field: "totalInputTokens" },
{ keywords: ["output", "token"], field: "totalOutputTokens" },
```

这样严格匹配阶段引擎英文 title 也能区分 input/output。

**方案 B**（更鲁棒）: 保留宽松匹配作为 fallback，但为容易混淆的字段增加优先级权重（先匹配 output-specific 字段再 fallback 到通用字段）。

### LOW #3: SEVEN_DAYS_MS 未使用

**位置**: `effect-tracker.ts:56`

```typescript
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
```

未被任何代码引用 — `isWithinDays` 函数从参数 `days` 计算 delta。

**建议**: 删除该常量，或在 `isWithinDays` 中引用它作为默认值。

### INFO #4: buildJudgeInput 死代码

**位置**: `judge.ts` — 函数定义 + export 存在，但 `commands.ts` 不再 import

**遗留原因**: 旧 pipeline 使用 `buildJudgeInput` 裁剪报告 → 写临时文件 → 传给 judge。新 pipeline 经过 summarizer 后，judge input 在 `commands.ts` 中内联构造。

**建议**: 清理代码，删除 `buildJudgeInput` 和 `extractReportSubset`（它们不再被使用）。

### INFO #5: buildEffectReviewPlaceholder 冗余

**位置**: `summarizer.ts:summarizeReport` step 4

函数内部调用 `buildEffectReviewPlaceholder(metricsHistory)` 始终返回 `[]`。效果回顾在 `commands.ts` step 3c 独立计算。

**建议**: 删除该占位调用。SignalReport 的 `effectReview` 字段已是 `undefined` 默认。如果担心 SignalReport 结构不完整，可在类型声明中将 `effectReview` 标记为 `@default undefined`。

---

## 六、模拟数据与执行路径

### 模拟原始报告输入

以下是一份简化的原始报告，用于追踪完整执行路径：

```json
{
  "_meta": {
    "total_sessions": 42,
    "analysis_period": { "until": "2026-05-28" }
  },
  "tool_stats": {
    "total_calls": 1523,
    "edit_retry_rate": 0.12,
    "by_tool": { "edit": 450, "bash": 380, "read": 420, "write": 273 }
  },
  "token_stats": {
    "total_input": 52428800,
    "total_output": 10485760,
    "cost_total": 1.25,
    "avg_per_session": { "input": 1248304, "output": 249660 }
  },
  "error_stats": {
    "bash_failure_rate": 0.08,
    "self_correction_rate": 0.15,
    "by_tool": { "edit": { "error_rate": 0.12 }, "bash": { "error_rate": 0.08 } }
  },
  "user_patterns": {
    "corrections": { "rate": 0.22 }
  },
  "satisfaction": {
    "single_turn_completion_rate": 0.72,
    "avg_turns_per_session": 4.5,
    "avg_tool_calls_per_session": 36.2,
    "session_duration_stats": { "median_minutes": 18 }
  },
  "skill_stats": {
    "triggered_skills": { "code-review": 5, "debug": 3 },
    "never_triggered": ["s1","s2","s3","s4","s5","s6","s7","s8","s9","s10","s11"],
    "skill_file_sizes": { "cr": 2048, "db": 1024 }
  }
}
```

### 假设前置条件

- `metrics-history.json` 已有 2 条历史记录:
  - T0: `{ date: "2026-05-21", editRetryRate: 0.15, bashFailureRate: 0.10, singleTurnCompletionRate: 0.68, ... }`
  - T1: `{ date: "2026-05-24", editRetryRate: 0.14, bashFailureRate: 0.09, singleTurnCompletionRate: 0.70, ... }`
- `history.jsonl` 有 1 条 apply 记录（7 天内）:
  - `{ action: "apply", title: "Reduce edit retry rate in CLAUDE.md", metricsSnapshotDate: "2026-05-21", timestamp: "2026-05-22T10:00:00Z", ... }`

### handleEvolve 执行路径追踪

```
┌──────────────────────────────────────────────────────────────────┐
│ 1. findRecentReport(reportsDir, 7)                                │
│    → /path/to/reports/phase2-1716873600000.json                   │
├──────────────────────────────────────────────────────────────────┤
│ 2. read + parse → report (已解析为 Record<string, unknown>)        │
├──────────────────────────────────────────────────────────────────┤
│ 3a. loadMetricsHistory(evolutionDir)                               │
│    → [{ date:"2026-05-21", editRetryRate:0.15, ... },              │
│        { date:"2026-05-24", editRetryRate:0.14, ... }]             │
│    ↑ metricsHistory.length = 2                                      │
├──────────────────────────────────────────────────────────────────┤
│ 3b. summarizeReport(report, metricsHistory, dir, reportPath)       │
│    │                                                               │
│    ├─ extractMetricsSnapshot(report)                                │
│    │  → snapshot = {                                                │
│    │      date: "2026-05-28",                                       │
│    │      sessionCount: 42,                                         │
│    │      totalToolCalls: 1523,                                     │
│    │      editRetryRate: 0.12,                                      │
│    │      bashFailureRate: 0.08,                                    │
│    │      singleTurnCompletionRate: 0.72,                           │
│    │      ...                                                       │
│    │    }                                                           │
│    │                                                               │
│    ├─ detectAnomalies(report)                                       │
│    │  → [                                                          │
│    │      { type:"tool_failure", detail:"Tool \"edit\" error rate 12.0%", severity:"medium" }, │
│    │    ]                                                          │
│    │  (注: 0.12 < 0.3 阈值, 不会被触发—示例数据需调整)                 │
│    │  (注: dormant 11 < 20 → severity:"medium", 11 > 10 → 触发)     │
│    │                                                               │
│    ├─ computeTrends(snapshot, previous=[T1, date:2026-05-24])      │
│    │  → editRetryRate: 0.14→0.12 = -14.29% → |14.29| >= 10 → TRUE │
│    │    bashFailureRate: 0.09→0.08 = -11.11% → |11.11| >= 10 → TRUE│
│    │    singleTurnCompletionRate: 0.70→0.72 = +2.86% → |2.86|<10→SKIP│
│    │    userCorrectionRate: prev=0, curr=0.22 → change=100% → TRUE │
│    │    selfCorrectionRate: prev=0, curr=0.15 → change=100% → TRUE │
│    │    avgTurnsPerSession: prev=0, curr=4.5 → change=100% → TRUE  │
│    │  → [                                                          │
│    │      { field:"editRetryRate", previous:0.14, current:0.12,    │
│    │        changePercent:-14.29 },                                │
│    │      { field:"bashFailureRate", previous:0.09, current:0.08,  │
│    │        changePercent:-11.11 },                                │
│    │      { field:"userCorrectionRate", previous:0, current:0.22,  │
│    │        changePercent:100 },                                   │
│    │      { field:"selfCorrectionRate", previous:0, current:0.15,  │
│    │        changePercent:100 },                                   │
│    │      { field:"avgTurnsPerSession", previous:0, current:4.5,   │
│    │        changePercent:100 }                                    │
│    │    ]                                                          │
│    │                                                               │
│    ├─ compressReport(report) → subset with top-5, top-10, etc.     │
│    │                                                               │
│    ├─ saveMetricsSnapshot(evolutionDir, snapshot)                   │
│    │  → metrics-history.json now has [T0, T1, T2]                  │
│    │                                                               │
│    ├─ writeFileSync(signal-2026-05-28.json) → SignalReport JSON    │
│    │                                                               │
│    └─ return signalReport                                           │
│                                                                     │
│    signalReport = {                                                  │
│      generatedAt: "...",                                             │
│      reportPath: "phase2-1716873600000.json",                       │
│      metricsSnapshot: snapshot (2026-05-28),                         │
│      anomalies: [...],                                              │
│      trends: [...],                                                 │
│      effectReview: undefined,                                       │
│      compressed: { _meta, actionable_issues, ... }                  │
│    }                                                                │
├──────────────────────────────────────────────────────────────────┤
│ 3c. loadHistory(evolutionDir, 30)                                   │
│    → [{ action:"apply", title:"Reduce edit retry rate...",          │
│         metricsSnapshotDate:"2026-05-21",                           │
│         timestamp:"2026-05-22T10:00:00Z", ... }]                    │
│                                                                     │
│    buildEffectReview(recentHistory, metricsHistory)                  │
│    │ metricsHistory = [T0, T1]  ← 不含 T2 (step 3b 生成的 snapshot)│
│    │ latest = metricsHistory[-1] = T1 (2026-05-24) ← ⚠️ 过时        │
│    │                                                                │
│    │ matchMetricField("Reduce edit retry rate in CLAUDE.md")        │
│    │ → strict: ["edit","retry","匹配"] - "匹配" 不在 title → ❌     │
│    │ → relaxed: ["edit","retry","匹配"].some(...) → "edit" matches │
│    │ → matches editRetryRate                                        │
│    │                                                                │
│    │ before = findSnapshotBefore([T0,T1], "2026-05-21")             │
│    │ → T0.editRetryRate = 0.15                                      │
│    │                                                                │
│    │ after = latest.editRetryRate = T1.editRetryRate = 0.14         │
│    │ ⚠️ 本应使用 T2.editRetryRate = 0.12                            │
│    │                                                                │
│    │ changePercent = (0.14-0.15)/0.15*100 = -6.67%                  │
│    │ ⚠️ 正确值应为 (0.12-0.15)/0.15*100 = -20%                     │
│    │                                                                │
│    │ → [{ suggestionTitle:"Reduce edit retry rate...",              │
│    │      targetMetric:"editRetryRate",                             │
│    │      before:0.15, after:0.14, changePercent:-6.67 }]           │
│    │    ↑ 错误：应为 after:0.12, changePercent:-20                  │
│    │                                                                │
│    effectReview.length > 0 → rewrite signal file with effectReview  │
├──────────────────────────────────────────────────────────────────┤
│ 3d. runGc(evolutionDir)                                             │
│    → reports: 0 removed (假设只有 1 个报告)                         │
│    → signals: 0 removed (假设信号文件不多)                          │
│    → daily: 0 removed (假设 90 天内)                                │
├──────────────────────────────────────────────────────────────────┤
│ 3e. judgeInput = {                                                  │
│      target: "all",                                                 │
│      reportPath: "signals/signal-2026-05-28.json",                  │
│      promptFilePath: ""                                             │
│    }                                                                │
├──────────────────────────────────────────────────────────────────┤
│ 4. runJudge(judgeInput, templateDir)                                │
│    → spawn pi with stdin=signalData                                 │
│    → parse JSONL output → extract suggestions                       │
│    → return EvolutionSuggestion[]                                   │
├──────────────────────────────────────────────────────────────────┤
│ 5. savePending(evolutionDir, pending) → writes pending.json         │
├──────────────────────────────────────────────────────────────────┤
│ 6. return formatted summary                                         │
└──────────────────────────────────────────────────────────────────┘
```

### 关键函数输入输出摘要

| 函数 | 输入 | 输出 |
|------|------|------|
| `findRecentReport(dir, days)` | `/path/reports/`, 7 | `"/path/reports/phase2-1716873600000.json"` |
| `extractMetricsSnapshot(report)` | raw report obj | `MetricsSnapshot{ date:"2026-05-28", sessionCount:42, ... }` |
| `detectAnomalies(report)` | raw report obj | `Anomaly[]{ type:"tool_failure", ... }` |
| `computeTrends(curr, prev)` | curr snapshot + prev snapshot | `TrendDelta[]{ field:"editRetryRate", changePercent:-14.29 }` |
| `compressReport(report)` | raw report | `{ _meta, actionable_issues:[top-5], ... }` |
| `saveMetricsSnapshot(dir, snap)` | dir + new snapshot | writes to metrics-history.json |
| `buildEffectReview(hist, metrics)` | history[30] + snapshot[] | `EffectReview[]{ targetMetric:"editRetryRate", changePercent:-6.67 }` |
| `runJudge(input, templateDir)` | JudgeInput + template dir | `EvolutionSuggestion[]{ id, title, severity, ... }` |
| `runGc(evolutionDir)` | evolution dir | `GcResult{ reportsRemoved:0, signalsRemoved:0, dailyRemoved:0 }` |

---

## 七、审查结论

### 风险矩阵

| # | 问题 | 严重度 | 影响面 | 是否阻塞 |
|---|------|--------|--------|---------|
| 1 | Effect review after snapshot 滞后一轮 | **MUST FIX** | UC-2 效果对比数据始终滞后，随时间积累误差 | **是** |
| 2 | Token input/output 关键词错配 | LOW | 部分英文 title 匹配到错误 metric | 否 |
| 3 | SEVEN_DAYS_MS 未使用 | LOW | 代码整洁性 | 否 |
| 4 | buildJudgeInput 死代码 | INFO | 可维护性 | 否 |
| 5 | buildEffectReviewPlaceholder 冗余 | INFO | 可读性 | 否 |

### 最终裁定

**verdict: fail**

**must_fix: 1** — Issue #1 必须在进入集成测试前修复。

**修复优先级**:
1. ⚠️ MUST FIX #1 — Effect review after snapshot off-by-one
2. 👎 LOW #2 — Token metric keyword ambiguity
3. 👎 LOW #3 — Unused constant cleanup
4. ℹ️ INFO #4 — Dead code `buildJudgeInput`
5. ℹ️ INFO #5 — Placeholder cleanup

### 跨依赖说明

- Issue #1 修复涉及 `commands.ts` + `effect-tracker.ts` 两处改动（~5 行），不改变 summarizer 的逻辑
- Issue #2 修复仅涉及 `effect-tracker.ts` KEYWORD_TO_METRIC 映射表
- 两个 LOW/INFO 问题独立可修复，不影响 UC-1/UC-2 的主数据流
- 修复后建议按相同模拟数据和前置条件重新验证 effect review 的 changePercent 值
