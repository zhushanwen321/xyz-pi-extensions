---
verdict: fail
must_fix: 4
reviewer: robustness-expert
date: 2026-05-29
scope:
  - evolution-engine/src/daily-trigger.ts
  - evolution-engine/src/report-generator.ts
  - evolution-engine/src/state.ts
  - evolution-engine/src/gc.ts
  - evolution-engine/src/commands.ts (handleEvolveReport)
---

# Evolve Daily Report — 健壮性审查

## 总评

核心 pipeline 的错误处理框架合理（lock + try/catch/finally + 状态持久化），但有 4 个必须在发布前修复的缺陷，其中 1 个会导致运行时 crash（`Infinity.toFixed()`）。建议修复后再进入测试阶段。

---

## M1 [Critical] `Infinity.toFixed()` 抛 RangeError

**文件**: `report-generator.ts`
**位置**: `buildOverview`, `buildTrends`, `buildEffectReview`, `formatNum`

**问题**: 当 metrics 值为 `Infinity`（如除零产生 `changePercent = Infinity`）时，`.toFixed(n)` 抛出 `RangeError`。`NaN.toFixed()` 虽然返回 `"NaN"` 字符串不崩溃，但输出"NaN"到报告中也不可接受。

**影响路径**:
1. `TrendDelta.changePercent` = `Infinity` → `buildTrends` 中 `t.changePercent.toFixed(1)` 抛异常
2. `MetricsSnapshot.avgTurnsPerSession` = `Infinity` → `buildOverview` 中 `snapshot.avgTurnsPerSession.toFixed(1)` 抛异常
3. `EffectReview.changePercent` = `Infinity` → `buildEffectReview` 中 `r.changePercent.toFixed(1)` 抛异常
4. `formatNum(Infinity)` → `n.toFixed(2)` 抛异常

**触发场景**: 某日只有 1 个 session 且 0 tool calls → `editRetryRate` 等指标的分母为零 → summarizer 的 `computeTrends` 产生 `Infinity` 或 `NaN`。

**修复建议**:

```typescript
function safeToFixed(n: number, digits: number): string {
  if (!Number.isFinite(n)) return "N/A";
  return n.toFixed(digits);
}

// 替换所有 .toFixed() 调用
// formatNum 同样加守卫：
function formatNum(n: number): string {
  if (!Number.isFinite(n)) return "N/A";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
```

**严重度**: Critical — 直接导致报告生成失败，而该函数在 lock 内被调用，failure 路径仅 console.error，用户看到的是"今天的报告尚未生成"。

---

## M2 [High] Lock 机制存在 TOCTOU 竞态

**文件**: `daily-trigger.ts`
**位置**: `acquireLock()` L70-88

**问题**: `existsSync` → `unlinkSync` → `writeFileSync` 三步之间存在时间窗口。两个 session_start 同时触发时（Pi 支持多 session），两者可能同时通过 `existsSync` 检查，都写入各自的 lock 文件，导致两份报告同时运行。

**实际风险**: 中等。Pi 多 session 并发不常见，但 bare-repo workspace 模式下同一用户可开多个 worktree，各自触发 `session_start`。

**修复建议**: 使用 `writeFileSync` + `O_EXCL` 原子创建，或 `mkdirSync`（mkdir 在 POSIX 上是原子的）:

```typescript
import { openSync, closeSync } from "node:fs";
import { O_WRONLY, O_CREAT, O_EXCL } from "node:fs/constants";

function acquireLock(lockPath: string): boolean {
  // 清理 stale lock（同原逻辑）
  if (existsSync(lockPath)) {
    // ... PID 检查逻辑不变 ...
  }

  // 原子创建：O_EXCL 保证只有一个进程成功
  try {
    const fd = openSync(lockPath, O_WRONLY | O_CREAT | O_EXCL);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }));
    closeSync(fd);
    return true;
  } catch {
    return false; // 另一个进程已创建
  }
}
```

**严重度**: High — 竞态导致重复运行 analyzer + Judge，浪费 token 且可能产生冲突写入。

---

## M3 [High] 临时文件未清理

**文件**: `daily-trigger.ts`
**位置**: `checkAndRunDailyAnalysis` L148-189

**问题**: `daily-raw-{today}.json` 在步骤 1 创建后，无论成功或失败都不清理。`gc.ts` 的 `MAX_DAILY_DAYS = 90` 只管理 `daily/*.json`，不管 `tmp/` 目录。

长期累积：每天一个 ~50KB JSON，90 天 ≈ 4.5MB，不致命但违反"不留垃圾"原则。

**修复建议**: 在 finally 块或 pipeline 成功后添加清理:

```typescript
try {
  // ... pipeline ...
} finally {
  releaseLock(lockPath);
  // 清理临时文件
  try { unlinkSync(tmpReportPath); } catch { /* 已经不在了 */ }
}
```

注意 `tmpReportPath` 的作用域需要在 try 外声明（目前已在 try 外，位置正确）。

**严重度**: High — 虽不致命，但 tmp 泄漏会导致磁盘空间问题（长期运行 1 年 = 18MB）和诊断困惑（以为 daily 数据文件在 tmp 中就是正式数据）。

---

## M4 [Medium] `mergePending` 容量驱逐顺序不可预测

**文件**: `state.ts`
**位置**: `mergePending()` L198-207

**问题**: 当 `pending` 建议超过 `MAX_PENDING_SUGGESTIONS = 30` 时， eviction 循环遍历 `existing.suggestions`，将最早的 `pending` 标记为 `rejected`。但"最早"是指数组顺序，而非时间戳。如果之前有 apply/skip 操作，数组中 `pending` 状态的建议不是按时间排列的（中间可能穿插 `applied`/`rejected` 状态的建议）。

**影响**: 可能驱逐一个刚加入的高优先级建议（如果它恰好排在数组前面），而非真正的最老建议。

**修复建议**: 按加入时间排序（`generatedAt` 或添加 `createdAt` 字段），或改为 FIFO 队列结构：

```typescript
// 驱逐时，只驱逐 pending 中 generation 最早的
const pendingSuggestions = existing.suggestions
  .map((s, i) => ({ suggestion: s, index: i }))
  .filter(x => x.suggestion.status === "pending");

// 按数组位置驱逐（第一个 pending 是最早加入的，前提是 push 尾部添加）
if (pendingSuggestions.length > MAX_PENDING_SUGGESTIONS) {
  const overflow = pendingSuggestions.length - MAX_PENDING_SUGGESTIONS;
  for (let i = 0; i < overflow; i++) {
    pendingSuggestions[i].suggestion.status = "rejected";
  }
}
```

**严重度**: Medium — 不会 crash，但可能丢失高价值建议。降级为"不理想"而非"必须修复"，但建议一并处理。

---

## 其他发现（非 must-fix）

### S1 [Low] fire-and-forget 的 unhandled rejection 已被防护

**文件**: `index.ts` L138

调用方已正确使用 `.catch()`:
```typescript
checkAndRunDailyAnalysis(dirs).catch((err) => {
  console.error("[evolve] Daily analysis failed:", ...);
});
```
**结论**: 无问题。

### S2 [Low] `acquireLock` 中损坏 lock 文件丢失诊断信息

**文件**: `daily-trigger.ts` L83-85

```typescript
} catch {
  // 锁文件损坏 → 清理
  unlinkSync(lockPath);
}
```

静默删除损坏的 lock 文件，无法事后诊断"为什么 lock 损坏了"。建议在删除前 log 一下：

```typescript
} catch (err) {
  console.warn(`[evolve] Corrupted lock file, removing: ${lockPath}`);
  unlinkSync(lockPath);
}
```

### S3 [Low] `signalReport.anomalies` / `signalReport.trends` 类型安全

**文件**: `report-generator.ts`

TypeScript 类型声明 `anomalies: Anomaly[]` 和 `trends: TrendDelta[]` 保证编译时类型，但 `summarizeReport` 运行时如果返回 undefined/null（如 JSON 反序列化路径异常），`buildAnomalies(anomalies)` 的 `.length` 访问会 throw。

风险极低（`summarizeReport` 内部初始化为空数组），但如果在 daily-trigger 中 `JSON.parse(rawReport)` 得到畸形数据传给 `summarizeReport`，链条可能断裂。建议 `generateDailyReport` 入口加防御：

```typescript
const anomalies = signalReport.anomalies ?? [];
const trends = signalReport.trends ?? [];
```

### S4 [Info] 成功路径无日志

**文件**: `daily-trigger.ts`

失败时有 `console.error`，但成功时无 `console.log`。对于调试"为什么今天的报告没更新"的问题，成功日志（含耗时、建议数）很有价值。

### S5 [Info] `handleEvolveReport` 的 `readFileSync` 错误处理充分

**文件**: `commands.ts` L566-608

外层 try/catch 覆盖了 `readFileSync`、`readdirSync`、`readLastRunStatus` 的所有异常路径。今日报告缺失时提供额外诊断信息（最后运行状态 + 错误摘要）。`isDateString` 同时校验格式和日期有效性。

**结论**: 处理得当。

### S6 [Info] GC 的 `readdirSync` + `statSync` 间 TOCTOU

**文件**: `gc.ts` `listJsonByMtime`

文件可能在 `readdirSync` 和 `statSync` 之间被删除。但 `removeFiles` 已处理单文件删除失败，且外层 `try/catch` 返回空数组。**无实际影响**。

---

## 六维度评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 错误处理 | 7/10 | 框架完善（try/catch/finally + 状态持久化），但 `Infinity.toFixed()` 未防护 |
| 异常路径 | 8/10 | lock stale 清理、GC 文件删除失败、JSON 解析损坏均有处理 |
| 日志记录 | 5/10 | 失败有日志，成功无日志，lock 损坏静默删除 |
| Fail-fast | 8/10 | analyzer 缺失立即 reject，lock 获取失败立即返回 |
| 测试友好 | 6/10 | `Dirs` 参数化好，但 `ANALYZER_SCRIPT` 硬编码 homedir 路径，mock 困难 |
| 调试友好 | 7/10 | `.last-run-status` 文件是好设计，但缺少成功路径日志和耗时统计 |

---

## 修复优先级

| # | 编号 | 严重度 | 工作量 | 建议 |
|---|------|--------|--------|------|
| 1 | M1 | Critical | 10min | `safeToFixed` 守卫函数 + 替换所有 `.toFixed()` |
| 2 | M2 | High | 15min | `O_EXCL` 原子创建 lock |
| 3 | M3 | High | 5min | finally 中 `unlinkSync(tmpReportPath)` |
| 4 | M4 | Medium | 10min | 按数组位置 FIFO 驱逐 pending |
