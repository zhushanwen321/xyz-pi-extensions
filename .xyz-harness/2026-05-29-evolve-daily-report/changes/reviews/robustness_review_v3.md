---
verdict: pass
must_fix: []
---

# Robustness Review — Round 3

**目标**: `report-generator.ts` + `daily-trigger.ts`
**日期**: 2026-05-29
**审查轮次**: 3

## Round 2 Must-Fix 验证

| # | 问题 | 状态 | 验证 |
|---|------|------|------|
| 1 | `buildTrends` / `buildEffectReview` 中 `toFixed` 未处理 NaN/Infinity | **已修复** | `formatNum` 统一处理 `!Number.isFinite` → `"N/A"`，所有 6 处数字格式化（行 67/86x2/111x3）均使用 `formatNum` |
| 2 | `acquireLock` 注释声称使用 `mkdirSync`（实际未使用） | **已修复** | 注释改为准确描述 `existsSync → writeFileSync` 并记录 TOCTOU 竞态窗口（行 60） |

## Round 3 完整审查

### report-generator.ts

**异常路径**:

1. `formatNum` 处理了 `Infinity` / `NaN` / 正常数字三种路径。整数路径 `String(n)` 和浮点路径 `n.toFixed(2)` 均不会抛异常。**通过**。
2. `buildOverview` 中 `snapshot.sessionCount` 判断 `hasData`，所有字段来自 `MetricsSnapshot` 接口，默认 0 不会触发 `toLocaleString` 异常。**通过**。
3. `buildAnomalies` / `buildSuggestions` 只做字符串拼接和数组遍历，无异常风险。**通过**。
4. `buildSuggestions` 使用 `for` 循环 + 索引 `#${i}`（第一条是 `#0`），这是有意为之的索引格式，不是 off-by-one。**通过**。

**数据一致性**: 所有数字输出路径统一使用 `formatNum`，无遗漏的 `toFixed` 或 `toString` 直接输出浮点。**通过**。

### daily-trigger.ts

**锁机制**:

1. `acquireLock` — `JSON.parse` 失败（锁文件损坏）由外层 `catch` 捕获并 `unlinkSync`。`process.kill(pid, 0)` 失败由内层 `catch` 处理为 stale lock。**通过**。
2. `releaseLock` — `unlinkSync` 失败静默忽略，符合 fire-and-forget 语义。**通过**。
3. TOCTOU 注释准确，不声称已消除竞态。**通过**。

**Pipeline 错误处理**:

1. `runAnalyzer` — `execFile` 的 `err` 通过 Promise rejection 传播。脚本不存在时提前 reject。**通过**。
2. `executePipeline` — 第 145 行 `JSON.parse(rawReport)` 未包裹 try-catch，如果 analyzer 输出非法 JSON 会抛出未捕获异常。但调用方 `checkAndRunDailyAnalysis` 在第 228 行有 `catch` 兜底，最终被捕获。**可接受**——不需要为每个子步骤单独 try-catch，顶层兜底足够。
3. Judge 失败有独立的 try-catch（行 169-175），重新抛出带上下文的 Error。**通过**。
4. 原子写入：`writeFileSync(tmp)` + `renameSync` 模式正确，避免写入一半的报告被读取。**通过**。
5. GC 在 Judge 成功后执行（行 184），避免删除刚产出的信号文件。**通过**。
6. 临时文件清理（行 202-205）有独立 try-catch，不影响主流程。**通过**。

**幂等性**:

1. 行 216-218：通过 `existsSync(reportPath) && statSync(reportPath).size > 0` 跳过已生成的报告。**通过**。
2. 如果 pipeline 中途失败（报告未写入），下次 session 会重试。**通过**。

**资源清理**:

1. `finally` 块确保 `releaseLock` 始终调用。**通过**。
2. 失败时调用 `saveLastRunStatus(dirs.dailyReportsDir, "failed", msg)`（行 233），提供诊断信息。**通过**。

## 结论

两个文件经过 3 轮审查后健壮性达标：
- 所有数字格式化路径统一使用 `formatNum`，处理了边界值
- 锁机制注释准确，异常路径覆盖完整
- Pipeline 错误传播链完整，fire-and-forget 语义正确
- 原子写入、幂等检查、资源清理均到位

无 must-fix，无 should-fix。
