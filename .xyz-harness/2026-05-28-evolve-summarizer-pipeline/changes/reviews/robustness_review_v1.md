---
verdict: fail
must_fix: 1
reviewed_files:
  - evolution-engine/src/summarizer.ts
  - evolution-engine/src/effect-tracker.ts
  - evolution-engine/src/gc.ts
  - evolution-engine/src/judge.ts
  - evolution-engine/src/commands.ts
review_date: 2026-05-28
---

# 健壮性审查：Evolve-Summarizer Pipeline

## 审查范围

新增的 summarizer pipeline（summarizer.ts, effect-tracker.ts, gc.ts）及周边修改（judge.ts, commands.ts, state.ts, types.ts）。

---

## 1. 错误处理

### ✅ 好的实践

- **judge.ts `runJudge` 重试机制**：首次空输出时用简化 prompt 重试一次，两次都失败才抛错，避免 LLM 偶发格式异常导致全崩。
- **judge.ts `runJudgeOnce` parse 失败不抛错**：将 `{ suggestions: [], raw, stderr }` 返回给上层决策，保留原始输出供诊断。
- **commands.ts 各 handler** 统一在顶层 catch 中用 `err instanceof Error ? err.message : String(err)` 保留错误消息上下文。
- **effect-tracker.ts `isWithinDays`/`findSnapshotBefore`** 对 `new Date()` 返回 NaN 做了防御。

### ❌ 问题

#### [MUST-FIX-1] gc.ts `removeFiles` 完全静默吞错

```typescript
function removeFiles(paths: string[]): number {
  let removed = 0;
  for (const p of paths) {
    try {
      unlinkSync(p);
      removed++;
    } catch {
      // 权限或并发删除导致失败，静默跳过
    }
  }
  return removed;
}
```

catch 块完全为空。这是 GC 模块，其核心职责就是清理文件——如果因权限、文件被占用、路径不存在等原因删除失败，**没有任何机制通知调用方**。当前只返回成功删除的数量，不返回失败数/失败原因链，调用方 `runGc` 也不会校验 `removed` 是否达到预期。

**风险**：磁盘无限膨胀而用户完全不知情。恢复时需要手动排查哪些文件没删掉。

**建议**：
1. 在 `GcResult` 中增加 `reportsFailed: number` / `signalsFailed: number` / `dailyFailed: number` 或捕获第一个错误消息。
2. 或者在 `runGc` 返回前打印一条 warning，让使用者至少知道 GC 不完全。

#### ⚠️ summarizer.ts 全文件无任何 try-catch

`summarizeReport` 调用 `saveMetricsSnapshot` + `writeFileSync` 写信号文件，两步磁盘操作均无 try-catch。如果磁盘满或权限错误，错误会穿透到 `commands.ts` 的顶层 catch。目前还不算严重问题（Node 内置的 `writeFileSync` 错误消息含路径），但如果期望更优雅的降级，应加保护。

---

## 2. 异常边界

### ✅ 好的实践

- **summarizer.ts `extractMetricsSnapshot`** 对所有字段使用 `typeof x === "number"` 防御 + 默认值 0，部分数据缺失不影响整体 pipeline。
- **summarizer.ts `compressReport`** 对 `report.error_stats` 做了 `truthy && typeof === "object"` 双重守卫，防止 null 通过（`typeof null === "object"` 但 null 是 falsy）。
- **effect-tracker.ts `buildEffectReview`** 在 metricsHistory 为空、recentApplies 为空、无 mirror snapshot、字段非 number 等所有异常路径均返回 `[]`，不会抛错。
- **gc.ts** 所有辅助函数在目录不存在时返回 `[]`，不会崩溃。

### ⚠️ 边界问题

#### summarizer.ts `extractToolFailureRates` 中的不安全断言

```typescript
const byTool = errorStats.by_tool as Record<string, Record<string, unknown>>;
for (const [tool, data] of Object.entries(byTool)) {
  const errorRate = typeof data.error_rate === "number" ? data.error_rate : 0;
```

`as` 断言没有运行时验证。如果 `by_tool` 的某条目值为非对象（如字符串、数字），`data` 在运行时不是对象，`data.error_rate` 是 `undefined`。当前逻辑默认 0 然后被 `> 0.05` 过滤掉，**不崩溃但静默放弃检测**，可能掩盖实际工具错误率。

同模式出现在 `detectAnomalies` 的 `byTool` 遍历。

**建议**：加内部检查 `typeof data !== "object" || data === null ? continue`。

#### summarizer.ts `computeTrends` 的 NaN 传播

```typescript
const prev = previous[key] as number;
const curr = current[key] as number;
```

`as number` 是编译时断言，运行时如果该字段是 `undefined` / string / bigint，`prev` 和 `curr` 的值是 `NaN`。`NaN === 0` 为 false，后续计算 `(NaN - NaN) / NaN` 产生 NaN，作为 `changePercent` 写入 `TrendDelta`。如果 `NaN` 通过了 `Math.abs(NaN) >= 10` 检查（实际上 `NaN >= 10` 是 false），不会产生错误输出；但如果字段值是零字符串 `"0"`，`"0" === 0` 为 false，`(0 - 0) / 0` 被前一个 `prev === 0` 分支处理为 `100`，产生错误的趋势报告。

**建议**：`const prev = Number(previous[key]); if (!Number.isFinite(prev)) continue;` 替代 `as number`。

#### judge.ts `extractAssistantText` 假设所有 message 块有 text

```typescript
if (part.type === "text" && typeof part.text === "string") {
  lastAssistantText = part.text;
}
```

如果 LLM 响应中没有 `type: "text"` 的块（例如返回纯 `tool_use`），`extractAssistantText` 返回 `""`，`parseJudgeOutput("")` 抛 "Empty Judge output"，触发重试。这是 **安全的行为**，但依赖重试机制恢复。不影响正确性，但多了一次 LLM 调用开销。

---

## 3. 日志与可观测性

### ❌ 普遍缺乏

| 模块 | 日志情况 | 问题 |
|------|---------|------|
| `summarizer.ts` | 无 | 没有任何 console.log 或注入诊断信息。summarize 成功与否、压缩比、异常数量、snapshot 保存情况完全不可见。 |
| `effect-tracker.ts` | 无 | 匹配失败、无历史、无效果时全部静默返回 `[]`，调用方无法区分"正常无匹配"和"数据损坏/解析失败"。 |
| `gc.ts` | 无 | 三个辅助函数 catch 块均无日志。GC 执行后调用方不知道清理了多少文件。 |
| `commands.ts` | 无 | `runGc()` 返回的 `GcResult` 被直接丢弃，用户看不到 GC 结果。 |

### ✅ 例外

- **judge.ts** 在最终失败时写入诊断文件（含两次尝试的 stderr + raw output），是 pipeline 中唯一有持久化诊断的模块。

**建议**：summarizer pipeline 作为一个关键的数据转换步骤，应该在关键节点输出一行日志（e.g., `summarized report: 745KB → 5KB, 3 anomalies, 2 trends`）。GC 的 `GcResult` 至少应该在返回内容中体现。

---

## 4. Fail-fast

### ✅ 好的实践

- **judge.ts `runJudge`**: 模板文件不存在 → 立即抛错，不浪费 LLM 调用。信号文件读取失败 → 立即抛错。
- **commands.ts `handleEvolve`**: analyzer 脚本不存在 → 立即抛错，带安装提示。
- **judge.ts `runJudgeOnce`**: 120s 超时 → SIGTERM + reject，不无限等待。

### ❌ 问题

#### `runJudgeOnce` 的超时/退出错误不触发重试

`runJudge` 的重试逻辑只针对 `suggestions.length === 0` 的情况。如果 `runJudgeOnce` **reject**（超时/spawn 失败/非零退出码），错误直接穿透到 `runJudge` 再穿透到 `handleEvolve`，**不经过重试逻辑**。

```typescript
const first = await runJudgeOnce(templateContent, userMessage);  // 如果 reject，下面的重试不会执行
if (first.suggestions.length > 0) { return first.suggestions; }
const second = await runJudgeOnce(templateContent, retryMessage);  // unreachable on reject
```

这是一个合理的 **权衡**（超时和 spawn 失败大概率是持久性问题，重试无意义），但应在代码注释中明确说明。当前无注释。

---

## 5. 测试友好

### ✅ 可独立测试

| 函数 | 纯函数 | 说明 |
|------|--------|------|
| `extractMetricsSnapshot` | ✅ | 入参 `report: Record<string, unknown>` → 出参 `MetricsSnapshot` |
| `detectAnomalies` | ✅ | 入参 → 出参 `Anomaly[]` |
| `computeTrends` | ✅ | 两个 snapshot → 出参 `TrendDelta[]` |
| `compressTopN` / `compressByProject` | ✅ | 纯数据变换 |
| `compressReport` | ✅ | 纯数据变换 |
| `matchMetricField` / `isWithinDays` / `findSnapshotBefore` | ✅ | 纯函数 |
| `buildEffectReview` | ✅ | 依赖显式传参 |
| `parseJudgeOutput` | ✅ | 字符串 → 建议数组 |

### ⚠️ 依赖文件系统

| 函数 | 依赖 | 说明 |
|------|------|------|
| `summarizeReport` | 文件写 (`writeFileSync` + `saveMetricsSnapshot`) | 需要 mock fs |
| `runJudgeOnce` / `runJudge` | `child_process.spawn` | 子进程，难 mock |
| `runGc` | `readdirSync` / `unlinkSync` / `statSync` | 纯文件操作 |
| `handleEvolve` / `handleEvolveApply` / `handleEvolveStats` | 大量 fs 操作 + 子进程 | 集成测试级别 |

**评价**：核心逻辑层（数据提取、异常检测、趋势计算、效果追踪）均为纯函数，**测试友好度好**。文件 IO 层（summarizeReport, runGc, commands handlers）需要 mock 或集成测试。

---

## 6. 调试友好

### ✅ 好的实践

- **judge.ts**: 超时/退出错误消息包含 stderr 片段（500 chars）；诊断文件包含完整两次尝试的 raw output + stderr。
- **commands.ts**: 顶层 catch 保留原始错误消息上下文：`Failed to read report: ${msg}`、`LLM Judge failed: ${msg}` 等。
- **summarizer.ts**: 无手动错误处理，但 Node 内置错误（writeFileSync、readFileSync）包含文件路径。

### ❌ 问题

#### gc.ts `removeFiles` 静默吞错 → 调试黑暗区

```typescript
catch {
  // 权限或并发删除导致失败，静默跳过
}
```

如果用户想排查"为什么 GC 没删掉 X 文件"，没有任何线索。这是本次审查发现的 **最严重的调试友好问题**——它创建了一个完全不可观测的错误模式。

#### effect-tracker.ts 无区分返回值

`buildEffectReview` 在以下三种场景返回 `[]`：
1. metricsHistory 为空
2. 最近 7 天无 apply 记录
3. 无匹配的 metric 字段

调用方无法区分。如果需要排查"为什么没有效果回顾"，需要额外日志。

#### summarizer.ts 无压缩比信息

调用方收到 `SignalReport` 后不知道原始报告被压缩了多少——消耗了多少内存、跳过了多少数据。这在未来性能调优时会有用。

---

## 总结

### Must-fix (1 项)

| # | 文件 | 问题 | 严重程度 |
|---|------|------|---------|
| 1 | `gc.ts` | `removeFiles` catch 完全静默吞错，GC 失败不可观测 | **高** |

### Should-fix (3 项)

| # | 文件 | 问题 | 严重程度 |
|---|------|------|---------|
| 2 | `summarizer.ts` | `computeTrends` 中 `as number` 无运行时守卫，NaN 可传播 | 中 |
| 3 | `commands.ts` | `runGc()` 返回值 GcResult 被丢弃，GC 结果对用户不可见 | 中 |
| 4 | `judge.ts` | `runJudgeOnce` reject 不触发重试，超时/spawn 失败后无二次尝试 | 低 |

### Nice-to-have (3 项)

| # | 文件 | 问题 |
|---|------|------|
| 5 | `summarizer.ts` | 全文件无日志，压缩比/异常数量不可观测 |
| 6 | `gc.ts` | 三个辅助函数 catch 均静默，内部错误完全不可见 |
| 7 | `effect-tracker.ts` | `buildEffectReview` 返回 `[]` 时，无法区分"无匹配"与"数据损坏" |

### 总体评价

summarizer pipeline 在 **错误传播**（parse 失败不回抛而是返回给上层）和 **重试策略** 上设计合理。核心逻辑层多为纯函数，测试友好。但 **可观测性** 普遍不足——GC 模块的静默吞错是最突出的健壮性问题。建议在 must-fix #1 修复后重新审查。
