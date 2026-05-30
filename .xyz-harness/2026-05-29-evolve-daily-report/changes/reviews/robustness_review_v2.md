---
verdict: fail
must_fix: 2
---

# Robustness Review v2 — evolve-daily-report

审查范围：验证第 1 轮 4 个 must-fix 的修复质量，并检查是否引入新问题。

## 第 1 轮修复验证

### MF-1: Infinity.toFixed() → formatNum

**修复状态：部分修复，仍有残留**

`formatNum()` 本身已正确添加 `Number.isFinite` 守卫（report-generator.ts:117-118）：

```typescript
function formatNum(n: number): string {
	if (!Number.isFinite(n)) return "N/A";
	return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
```

但以下两处 `.toFixed()` 调用绕过了 `formatNum`：

1. **report-generator.ts:86** — `buildTrends`
   ```typescript
   return `- ${t.field}: ${formatNum(t.previous)} → ${formatNum(t.current)} (${sign}${t.changePercent.toFixed(1)}%)`;
   ```
   `t.previous` 和 `t.current` 受 formatNum 保护，但 `t.changePercent.toFixed(1)` 直接调用。若 `changePercent` 为 Infinity/NaN（类型签名 `number` 允许），此处抛 TypeError，整个报告生成中断。

2. **report-generator.ts:111** — `buildEffectReview`
   ```typescript
   return `- ... ${formatNum(r.before)} → ${formatNum(r.after)} (${sign}${r.changePercent.toFixed(1)}%)`;
   ```
   同上，`r.changePercent.toFixed(1)` 未受保护。

**风险分析**：当前 `summarizer.ts:291` 和 `effect-tracker.ts:138` 在生产端显式处理了 `prev === 0` 的除零情况，所以正常运行中 `changePercent` 不会是 Infinity。但防御层应在格式化端而非生产端——类型签名 `number` 不排除 Infinity/NaN，且 report-generator 不控制数据来源。

**结论：must-fix**（round 1 #1 的同一类 bug，修复不完整）

---

### MF-2: Lock TOCTOU

**修复状态：注释与代码矛盾**

注释（daily-trigger.ts:60-61）声称：

```
* 注意：使用 mkdirSync 作为原子操作（POSIX 上 mkdir 是原子的），
* 避免 existsSync → writeFileSync 之间的 TOCTOU 竞态。
```

但实际代码（daily-trigger.ts:87）使用的是 `writeFileSync`，不是 `mkdirSync`：

```typescript
writeFileSync(lockPath, JSON.stringify(data, null, 2), "utf-8");
```

第 1 轮修复任务描述是"在注释中说明使用 existsSync+writeFileSync 模式，风险已知且可接受"。但实际注释说的是反话——声称使用了原子 mkdirSync，与代码矛盾。

这比没有注释更危险：后续维护者读注释会认为锁是原子的，不会去审查竞态风险。

**结论：must-fix**（注释与实现不一致，误导维护者）

---

### MF-3: 临时文件未清理

**修复状态：成功路径已修复，失败路径未覆盖**

`executePipeline` 步骤 9（daily-trigger.ts:201-204）在成功后清理 `tmpReportPath`：

```typescript
try {
    unlinkSync(tmpReportPath);
} catch {
    // 临时文件清理失败不影响主流程
}
```

但如果步骤 2-8 抛异常（如 JSON.parse 失败、Judge 超时），控制流跳到 `checkAndRunDailyAnalysis` 的 catch 块（daily-trigger.ts:224-228），该块不清理 tmp 文件。

文件名格式 `daily-raw-${today}.json` 限制了每天最多一个泄漏文件，风险有限。但长期运行（每天失败）会积累。

**结论：should-fix**（非 must-fix，泄漏量有上限且可通过 GC 或手动清理处理）

---

### MF-4: mergePending eviction 顺序

**修复状态：已正确修复**

eviction 循环按数组顺序遍历（先入先出），将最早的 `pending` 项改为 `rejected`（state.ts:195-206）。`console.warn` 审计日志包含 evicted 数量。

逻辑正确，顺序语义（FIFO）与数组顺序一致。

**结论：PASS**

---

## 新发现

### SF-1: statSync TOCTOU 在 checkAndRunDailyAnalysis 顶部

**文件**：daily-trigger.ts:218
**严重度**：should-fix

```typescript
if (existsSync(reportPath) && statSync(reportPath).size > 0) {
    return;
}
```

`statSync` 在 try-catch 外部。若文件在 `existsSync` 和 `statSync` 之间被删除，`statSync` 抛 ENOENT。由于此函数是 fire-and-forget（`session_start` 调用），抛出的异常变成 unhandled promise rejection。

修复建议：将 statSync 包裹在 try-catch 中，catch 时视为"文件不存在"，继续执行。

---

## 汇总

| ID | 类别 | 文件 | 行号 | 状态 |
|----|------|------|------|------|
| MF-1 | changePercent.toFixed 未防护 | report-generator.ts | 86, 111 | **must-fix** |
| MF-2 | Lock 注释与实现矛盾 | daily-trigger.ts | 60-61 vs 87 | **must-fix** |
| MF-3 | 失败路径 tmp 文件泄漏 | daily-trigger.ts | 201 vs 224-228 | should-fix |
| MF-4 | mergePending eviction FIFO | state.ts | 195-206 | PASS |
| SF-1 | statSync TOCTOU 无 catch | daily-trigger.ts | 218 | should-fix |

**Verdict: FAIL** — 2 项 must-fix 未通过（MF-1 修复不完整，MF-2 注释错误）。
