---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 3
  v1_must_fix_verified: 1
  v1_must_fix_fixed: 1
  new_issues: 0
  remaining_v1_issues: 0
---

# evolution-engine — TypeScript 代码品味审查报告（第二轮）

> 审查日期: 2026-05-27
> 范围: 仅验证 v1 MUST_FIX（DailyFile.failures 类型不一致）的修复状态，及修复是否引入新品味问题
> 审查文件: `commands.ts`、`applier.ts`、`monitor.ts`

---

## v1 MUST_FIX 修复验证

### MUST_FIX #1: DailyFile.toolCalls.failures 类型不一致

| 维度 | 内容 |
|------|------|
| 来源 | v1 报告 monitor.ts L44 vs commands.ts L313 |
| 问题 | `monitor.ts` 中 `DailyFile.toolCalls.failures` 定义为 `number`，但 `commands.ts` 中作为 `Record<string, number>` 使用（`Object.entries(day.toolCalls.failures)` 迭代 per-tool failure 计数）。两种类型不可能同时正确，运行时必抛异常。 |
| 状态 | **✅ 已修复** |

**修复证据**（逐项确认）：

1. **`monitor.ts` L44 类型定义已修正**：
   ```typescript
   // 修复前: failures: number;
   // 修复后:
   failures: Record<string, number>;
   ```

2. **消费方类型一致**：
   - `monitor.ts` `checkErrorSpike`（L218, L225）：`Object.values(d.toolCalls.failures).reduce((sum, v) => sum + v, 0)` — 以 Record 方式消费
   - `commands.ts` `handleEvolveStats`（L390）：`Object.entries(day.toolCalls.failures)` — 以 Record 方式消费
   - `commands.ts` inline 类型（L368）：`failures?: Record<string, number>` — 类型声明正确

3. **数据流一致性**：`monitor.ts` 写入时将 `failures` 作为 per-tool 对象存储，`commands.ts` 读取时以 per-tool 对象迭代。读/写双方对同一字段的类型认知一致。

**类型一致矩阵**：

| 位置 | 字段路径 | 类型 | 使用方法 | 一致？ |
|------|---------|------|---------|-------|
| monitor.ts:44 (DailyFile 定义) | toolCalls.failures | `Record<string, number>` | 定义方 | ✅ |
| monitor.ts:218,225 (checkErrorSpike) | d.toolCalls.failures | 聚合求和 | `Object.values().reduce` | ✅ |
| commands.ts:368 (inline 类型) | toolCalls.failures | `Record<string, number>` | 声明方 | ✅ |
| commands.ts:390 (handleEvolveStats) | day.toolCalls.failures | per-tool 迭代 | `Object.entries().forEach` | ✅ |

**违反原则恢复评估**：

| 原则 | v1 评价 | v2 评价 |
|------|---------|---------|
| 显式优于隐式 | ❌ 类型不一致 | ✅ 恢复 |
| 一条关注点一条路径 | ❌ 两处不同类型表述 | ✅ 统一 |
| 类型即契约 | ❌ 类型与实际数据不符 | ✅ 类型准确反映数据 |

---

## 修复副作用检查

### 检查项 1：`monitor.ts` — `checkErrorSpike` 的 reduce 计算正确性

修复前 `failures` 为 `number` 时，`checkErrorSpike` 如果直接对 number 做 `Object.values` 会产生类型错误。修复后的代码：

```typescript
const baselineFailures = baseline.reduce(
    (s, d) => s + Object.values(d.toolCalls.failures).reduce((sum, v) => sum + v, 0),
    0,
);
```

`Object.values(Record<string, number>)` → `number[]`，外层的 `reduce((sum, v) => sum + v, 0)` 正确求和。**无新问题**。

### 检查项 2：`monitor.ts` — 新接口字段是否导致其他依赖错误

检查 `DailyFile` 中其他字段的使用方式：

| 字段 | 类型 | 消费方 | 使用方法 | 一致？ |
|------|------|--------|---------|-------|
| `toolCalls.total` | `number` | checkErrorSpike | 直接求和 | ✅ |
| `toolCalls.byTool` | `Record<string, number>` | — | 未在 monitor 内部使用 | ✅（仅定义） |
| `toolCalls.editRetries` | `number` | — | 未使用 | ✅（仅定义） |
| `tokenUsage.totalInput` | `number` | checkTokenDecline | 直接求和 | ✅ |
| `tokenUsage.totalOutput` | `number` | — | 未使用 | ✅ |
| `sessions` | `number` | checkTokenDecline | 直接求和 | ✅ |

**无新问题**。

### 检查项 3：`applier.ts` — execSync → execFileSync 的后续影响

v1 指出 applier.ts 的 `execSync` 字符串插值存在 shell 注入面。当前代码已切换为 `execFileSync` 参数数组模式：

```typescript
execFileSync("git", ["add", suggestion.targetPath], { cwd, stdio: "pipe" });
execFileSync("git", ["commit", "-m", `evolve: ${suggestion.title}`], { cwd, stdio: "pipe" });
```

`suggestion.targetPath` 和 `suggestion.title` 作为独立参数传递，不再经过 shell 解析。这是完全修复。`catch {}` 仍为空（系有意为之，注释说明 git 失败不阻塞主流程）。**无新问题**。

### 检查项 4：`commands.ts` — 入口层面的 shell 注入未解决

`commands.ts` L121 的 `execSync` 字符串命令中 `params.since` 仍直接插值：

```typescript
execSync(
    `python3 "${ANALYZER_SCRIPT}" --since ${params.since} --format json --output "${tmpReportPath}"`,
    { timeout: ANALYZER_TIMEOUT_MS, stdio: "pipe" },
);
```

v1 将其评为 LOW 且非 MUST_FIX，本次修复未涉及。**非本修复引入，不属于回归**。

---

## 新品味问题评估

| # | 类别 | 位置 | 描述 | 优先级 |
|---|------|------|------|--------|
| — | — | — | 修复未引入任何新品味问题 | N/A |

修复变动极小（仅 `monitor.ts` 中一行类型定义 + 两处 reduce 调用确认），scope 精准，没有跨出 MUST_FIX 边界的额外修改。

---

## 汇总

| 维度 | v1 | v2 |
|------|----|----|
| MUST_FIX 数量 | 1 | 0 |
| LOW 数量 | 3 | 3（未修复但非回归） |
| INFO 数量 | 5 | 5（未修复但非回归） |
| 新增问题 | — | 0 |

**结论**：v1 MUST_FIX 已准确修复。修复操作精确、无副作用、未引入新品味问题。跨文件类型一致性已恢复。`commands.ts` 入口 shell 注入和 silent catch 日志等 LOW/INFO 问题属于独立优化项，未被本次修复覆盖是合理选择。
