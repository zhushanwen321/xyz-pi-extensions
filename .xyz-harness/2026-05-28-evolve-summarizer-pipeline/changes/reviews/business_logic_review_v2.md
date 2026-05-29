---
verdict: pass
must_fix: 0
review:
  type: business_logic_review
  round: 2
  timestamp: "2026-05-28T15:00:00"
  target_changeset: "v2 (commit with MUST FIX #1 fix + effect-tracker/gc/summarizer integration)"
  summary: "第 2 轮业务逻辑审查：MUST FIX #1 已修复，3 项 INFO/LOW 自动解决，LOW #2 未修复但非阻塞。未发现新的阻塞性问题。"

statistics:
  v1_must_fix_total: 1
  v1_must_fix_fixed: 1
  v1_must_fix_unfixed: 0
  v1_low_total: 2
  v1_low_resolved_automatically: 1
  v1_low_unfixed: 1
  v1_info_total: 2
  v1_info_resolved: 2
  new_issues_found: 1
  new_issues_severity: info

issues:
  - id: 1
    severity: MUST_FIX
    location: "commands.ts: step 3b-2"
    title: "Effect review after snapshot 滞后一轮"
    v1_status: open
    v2_status: verified_fixed
    fix_verification: |
      commands.ts 在 step 3b 后新增 `metricsHistory.push(signalReport.metricsSnapshot)`，
      将 summarizeReport 返回的新 snapshot 推入内存中的 metricsHistory 数组，
      buildEffectReview 在 step 3c 使用时已包含当前轮 snapshot T2。
      findLatestSnapshot(metricsHistory) 返回 T2 而非 T1，
      changePercent 使用正确的 after 值计算。

  - id: 2
    severity: LOW
    location: "effect-tracker.ts:KEYWORD_TO_METRIC"
    title: "Token 输入/输出关键词匹配无法区分"
    v1_status: open
    v2_status: not_fixed
    reason: |
      关键词数组与 V1 相同：`["token", "input", "输入"]` 和 `["token", "output", "输出"]`。
      英文 title（如 "Reduce output tokens"）在严格匹配阶段两者均失败，
      进入宽松匹配时因 totalInputTokens 排在前面而错误匹配。
      修复方案：将 input/output 提到数组首位 ——
      `["input", "token"]` 实现 strict 阶段即可区分。
      非阻塞，建议后续修复。

  - id: 3
    severity: LOW
    location: "effect-tracker.ts"
    title: "SEVEN_DAYS_MS 常量声明未使用"
    v1_status: open
    v2_status: resolved_automatically
    reason: |
      V2 的 effect-tracker.ts 未引入该常量。
      isWithinDays 函数直接从 days 参数计算 `days * 24 * 60 * 60 * 1000`，
      代码更简洁，问题自动消失。

  - id: 4
    severity: INFO
    location: "judge.ts:buildJudgeInput"
    title: "buildJudgeInput 是死代码"
    v1_status: open
    v2_status: resolved
    reason: |
      V2 的 judge.ts diff 显示 buildJudgeInput 已被移除。
      commands.ts 的 import 从 `{ buildJudgeInput, runJudge }` 改为 `{ runJudge }`。
      Judge input 在 commands.ts step 3e 内联构造。

  - id: 5
    severity: INFO
    location: "summarizer.ts:buildEffectReviewPlaceholder"
    title: "占位函数始终返回空数组"
    v1_status: open
    v2_status: resolved
    reason: |
      V2 的 summarizer.ts 删除了 buildEffectReviewPlaceholder 调用。
      效果回顾全部移至 commands.ts step 3c 通过 effect-tracker.buildEffectReview 计算。

  - id: 6
    severity: INFO
    location: "commands.ts:handleEvolve 外层 try-catch"
    title: "外层 catch 将所有错误包裹为 'Unexpected error' 降低错误可诊断性"
    v1_status: new
    v2_status: open
    description: |
      handleEvolve 函数体被 try-catch 完全包裹，
      catch 块将所有错误（包括已带详细消息的预期错误）重新抛出为
      `"Unexpected error in /evolve: ..."`。
      具体错误如 "Session analyzer not found" 被转换为
      "Unexpected error in /evolve: Session analyzer not found"，
      外层错误处理逻辑无法通过 message 区分预期异常（如 analyzer 未安装）和真正不可恢复的错误。
      建议: 移除外层 try-catch，让具体错误直接冒泡，或仅 catch 非预期错误类型。

---

# Business Logic Review — Round 2

## 审查信息

- **审查轮次**: 第 2 轮
- **审查类型**: 业务逻辑审查 — MUST FIX 回归验证 + 新问题排查
- **审查范围**: V2 changeset（含 MUST FIX #1 修复 + effect-tracker/gc/summarizer 集成）
- **审查依据**: V1 审查报告 + git diff V2 + 当前 commands.ts 完整文件
- **审查目标**: 验证 MUST FIX #1 是否正确修复，检查修复是否引入新问题

---

## 一、V1 MUST FIX 回归验证

### MUST FIX #1: Effect review after snapshot 滞后一轮

**V1 描述**:
```
step 3a:  metricsHistory = [T0, T1]           ← 加载现有
step 3b:  summarizeReport → snapshot T2       ← 写入磁盘
step 3c:  buildEffectReview(metricsHistory)    ← metricsHistory 仍是 [T0, T1]
          → latest = T1                       ← "after" = T1 而非 T2 ❌
```

**V2 修复代码**（commands.ts step 3b-2）:

```typescript
// 3b. 运行 summarizer（内部会 saveMetricsSnapshot + 写信号文件到 signalsDir）
const signalReport = summarizeReport(report, metricsHistory, dirs.evolutionDir, reportPath);

// 3b-2. 将新 snapshot 加入内存历史，让 effect review 看到最新数据
metricsHistory.push(signalReport.metricsSnapshot);

// 3c. 构建 effect review
const effectReview = buildEffectReview(recentHistory, metricsHistory);
```

**修复验证**:

```
step 3a:  metricsHistory = loadMetricsHistory() → [T0, T1]        ← 从磁盘加载
step 3b:  summarizeReport(report, metricsHistory, ...)
          ├── extractMetricsSnapshot → T2
          ├── saveMetricsSnapshot(dir, T2) → 磁盘写入 [T0, T1, T2]
          │    注意: saveMetricsSnapshot 内部重新 loadMetricsHistory
          │    不修改传入的 metricsHistory 参数
          └── return signalReport { metricsSnapshot: T2, ... }
step 3b-2: metricsHistory.push(T2) → [T0, T1, T2]               ← 内存更新 ✅
step 3c:  buildEffectReview(recentHistory, metricsHistory)
          → findLatestSnapshot([T0, T1, T2]) = T2               ← after = T2 ✅
          → for each apply: beforeSnapshot = findSnapshotBefore(..., date)
          → changePercent = (T2.field - before.field) / before.field  ✅
```

**执行模拟**（复用 V1 的假设条件）:

| 数据 | V1（错误） | V2（修正后） |
|------|-----------|-------------|
| before = T0.editRetryRate | 0.15 | 0.15 |
| after | T1.editRetryRate = 0.14 | T2.editRetryRate = 0.12 |
| changePercent | -6.67% | **-20%** ✅ |

**确认**: 修复最小且精确 — 仅增加一行 `metricsHistory.push(signalReport.metricsSnapshot)`，语义明确。`metricsHistory` 是本地变量（非共享/全局状态），修复无副作用。

### 修复的正确性保障

- `summarizeReport` **不修改**传入的 `metricsHistory` 数组（内部调用 `loadMetricsHistory` 重新读取磁盘，获得独立数组）
- `metricsHistory.push()` 操作的是 `commands.ts` 中的局部 `const` 数组（`const` 禁止重新赋值但不禁止 `push`）
- 推入的 `signalReport.metricsSnapshot` 与 `summarizeReport` 内部 `saveMetricsSnapshot` 写入磁盘的是同一个对象引用 → 数据一致

---

## 二、V1 LOW/INFO 问题追踪

| # | 问题 | V1 严重度 | V2 状态 | 说明 |
|---|------|----------|---------|------|
| 2 | Token 关键词歧义 | LOW | ❌ 未修复 | 映射表与 V1 完全一致 |
| 3 | SEVEN_DAYS_MS 未使用 | LOW | ✅ 自动消失 | V2 effect-tracker.ts 未引入该常量 |
| 4 | buildJudgeInput 死代码 | INFO | ✅ 已清理 | Judge.ts 中已删除该函数 |
| 5 | buildEffectReviewPlaceholder 冗余 | INFO | ✅ 已清理 | summarizer.ts 中已删除占位调用 |

### LOW #2 详细分析（未修复）

**现状**:
```typescript
{ keywords: ["token", "input", "输入"], field: "totalInputTokens" },
{ keywords: ["token", "output", "输出"], field: "totalOutputTokens" },
```

**问题复现**: title = "Reduce output token usage"
- 严格匹配 `["token", "input", "输入"]` → "input" 不在 → ❌
- 严格匹配 `["token", "output", "输出"]` → "输出" 不在 → ❌
- 宽松匹配: `["token", "input", "输入"].some(...)` → "token" 匹配 → 匹配到 **totalInputTokens** ❌

**推荐修复**:
```typescript
{ keywords: ["input", "token"], field: "totalInputTokens" },
{ keywords: ["output", "token"], field: "totalOutputTokens" },
```
将区分性更强的 `input`/`output` 提到数组首位。对于 "Reduce output token usage"：
- 严格 `["input", "token"]` → "input" 不在 → ❌
- 严格 `["output", "token"]` → "output" 和 "token" 都在 → ✅ 匹配 totalOutputTokens

**备注**: 非阻塞性问题。实际影响取决于用户/LLM 生成 suggestion title 的语言分布。如果中文 title 为主，影响面小。

---

## 三、新增问题排查

### 检查点清单

| 检查点 | 预期 | 实际 | 状态 |
|--------|------|------|------|
| metricsHistory 写入后再读取一致性 | 磁盘与内存一致 | saveMetricsSnapshot 内部重新 load + save，不修改传入引用 | ✅ |
| effectSignalPath 与 signalPath 一致性 | 同一路径 | 两者均使用 `signal-${snapshot.date}.json` | ✅ |
| GC 清理旧信号不误删当前信号 | 最新信号保留 | listJsonByMtime 降序排列，slice(MAX_SIGNALS) 去掉末尾 | ✅ |
| summarizeReport 失败时的状态一致性 | 适当清理/可重试 | saveMetricsSnapshot 先执行，writeFileSync 后执行。如果 writeFileSync 失败，metrics-history.json 有快照但无信号文件。下次运行会恢复（loadMetricsHistory 返回含该快照的完整历史） | ✅（可接受的偶发不一致） |
| loadHistory(30) 能否覆盖 7 天 apply | 足够 | 30 条 > 7 天内的 apply 量级 | ✅ |
| apply 时 metricsHistory 为空 | metricsSnapshotDate = undefined | 有明确的三元表达式处理，undefined 时回退到 timestamp 查找 | ✅ |
| 多次 apply 间隔短于一次 /evolve | 共享同一个 before snapshot | 中间无新 snapshot 生成，所有 apply 共享同一 before 值。变化率反映累积效果 | ✅（语义正确） |
| handleEvolveRollback 的 index | 1-based | 文档标注 1-based，实现 `index < 1` 检查 | ✅ |

### 新发现问题

#### Issue #6 [INFO]: 外层 try-catch 包裹错误

**位置**: `commands.ts:handleEvolve`

```typescript
export async function handleEvolve(...) {
    try {
        // ... 具体错误已含详细消息
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Unexpected error in /evolve: ${msg}`);
    }
}
```

**问题**: 函数内部各步骤抛出的错误本身已包含具体信息（如 "Session analyzer not found at ..."、"Failed to read report: JSON parse error at ..."）。外层 catch 将它们统一包装为 `"Unexpected error in /evolve: ..."` 前缀，导致：
1. 上层调用方无法通过 `err.message.startsWith(...)` 区分错误类型
2. 调试时需手动剥离前缀
3. 所有错误被标记为 "unexpected"，包括可预期的 analyzer 未安装、报告损坏等

**影响**: 仅影响错误信息可读性和可诊断性，不影响业务逻辑正确性。

**建议**: 
- 移除外层 try-catch，让具体错误直接冒泡
- 或仅 catch 真正不可预期的错误（如底层的 OOM 异常），预期错误直接 `throw`

### 未发现的新阻塞问题

- 无数据流错位或 off-by-one 类问题
- 无异步调用时序竞争条件（所有文件操作为同步，Judge 调用为 async-await）
- 无 `any` 类型绕过检查
- 无 `Promise.all`/`Promise.allSettled` 使用错误（该 pipeline 无并行异步操作）

---

## 四、V2 数据流验证

```
handleEvolve (commands.ts)
│
├─ 1. findRecentReport / run analyzer
│    → reportPath
│    └─ ✅ 与 V1 相同
│
├─ 2. readFileSync + JSON.parse → report
│    └─ ✅ 与 V1 相同
│
├─ 3a. loadMetricsHistory
│    → metricsHistory = [T0, T1]
│    └─ ✅ 与 V1 相同
│
├─ 3b. summarizeReport(report, metricsHistory, ...)
│    │ 内部执行: extractMetricsSnapshot → detectAnomalies → computeTrends
│    │            → compressReport → saveMetricsSnapshot → write signal file
│    └─ return signalReport { metricsSnapshot: T2, ... }
│    └─ ✅ 与 V1 相同（summarizer 未修改）
│
├─ 3b-2. metricsHistory.push(signalReport.metricsSnapshot)  ← V2 新增
│    → metricsHistory = [T0, T1, T2]                        ← ❌ WAS [T0, T1]
│    └─ ✅ V2 修复点
│
├─ 3c. loadHistory(30) → recentHistory
│      buildEffectReview(recentHistory, metricsHistory)
│      → after = findLatestSnapshot([T0, T1, T2]) = T2     ← ❌ WAS T1
│      → changePercent 使用正确 after 值
│      → if non-empty: rewrite signal file with effectReview
│    └─ ✅ V2 修正后的数据流
│
├─ 3d. runGc → clean old reports/signals/daily
│    └─ ✅ 保留最新信号文件
│
├─ 3e-4. runJudge(信号文件, ...)
│    └─ ✅ 信号文件含最新 effectReview
│
├─ 5. savePending
└─ 6. return summary
```

**关键路径对比（V1 vs V2）**:

```
V1: metricsHistory = [T0, T1]
    → buildEffectReview 使用 latest = T1
    → changePercent off-by-one ❌

V2: metricsHistory = [T0, T1]
    → summarizeReport → T2 + metricsHistory.push(T2)
    → metricsHistory = [T0, T1, T2]
    → buildEffectReview 使用 latest = T2
    → changePercent 正确 ✅
```

**handleEvolveApply（apply 时记录 metricsSnapshotDate）**:

```
apply 成功
  → loadMetricsHistory() → 读取最新磁盘状态（含 /evolve 时写入的快照）
  → latestSnapshotDate = 最新 snapshot.date
  → appendHistory({ ..., metricsSnapshotDate: latestSnapshotDate })

下次 /evolve:
  buildEffectReview:
    → before = findSnapshotBefore([T0, T1, T2, ...], apply.metricsSnapshotDate)
    → after  = findLatestSnapshot([T0, T1, T2, ...])  ← 包含当前轮新快照
    → changePercent = 从 apply 时到现在的变化
  ✅ 语义正确
```

---

## 五、审查结论

### V1 问题修复总表

| # | 问题 | V1 Severity | V2 Status | 备注 |
|---|------|------------|-----------|------|
| 1 | Effect review after 滞后一轮 | MUST_FIX | ✅ **VERIFIED FIXED** | `metricsHistory.push(T2)` 一行修复 |
| 2 | Token 关键词歧义 | LOW | ❌ 未修复 | 不影响核心数据流，建议后续修复 |
| 3 | SEVEN_DAYS_MS 未使用 | LOW | ✅ 自动消失 | 代码重构未引入 |
| 4 | buildJudgeInput 死代码 | INFO | ✅ 已清理 | |
| 5 | buildEffectReviewPlaceholder 冗余 | INFO | ✅ 已清理 | |
| 6 | 外层 try-catch 降低错误可诊断性 | INFO | ⚠️ 新发现 | 非阻塞，建议改进 |

### V2 修复质量评估

- **精准性**: 修复仅影响必须动的行（+1 行 push + 上下文少量胶水代码），符合"只动必须动的"原则
- **正确性**: 推入的是 `summarizeReport` 返回的 snapshot 对象，与磁盘写入一致
- **副作用**: 无（metricsHistory 是局部变量，不涉及共享状态）
- **测试性**: 验证修复前后 changePercent 从 -6.67% 变为正确的 -20%

### 最终裁定

**verdict: pass**
**must_fix: 0**

**处理建议**:
1. MUST FIX #1 已验证修复 → 关闭
2. INFO #6（外层 try-catch 错误包裹）→ 建议在进入集成测试前修复，但非阻塞
3. LOW #2（关键词歧义）→ 后续修复，不影响本次交付
4. **修复后可继续进入集成测试阶段**
