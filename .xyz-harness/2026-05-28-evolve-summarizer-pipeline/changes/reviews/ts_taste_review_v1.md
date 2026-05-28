---
verdict: fail
must_fix: 6
---

# TypeScript 代码品味审查报告

**审查范围**：`summarizer.ts`(新建417行) · `effect-tracker.ts`(新建157行) · `gc.ts`(新建124行) · `judge.ts`(修改) · `commands.ts`(修改)

**审查日期**：2026-05-28

---

## 自动品味检查结果（ESLint）

项目 taste-lint + 自定义规则扫描结果：

| 文件 | 错误 | 警告 |
|------|------|------|
| `summarizer.ts` | 1 | 17 |
| `effect-tracker.ts` | 1 | 13 |
| `gc.ts` | 0 | 5 |
| `judge.ts` | 3 | 10 |
| `commands.ts` | 1 | 10 |
| **合计** | **6** | **55** |

6 个错误均为 `@typescript-eslint/no-unused-vars`，55 个警告以 `no-magic-numbers` 为主（51 处），其余为 `taste/no-silent-catch`（3 处）。

---

## 逐维度审查

### 1. 命名

**良好**：
- `extractToolFailureRates` — 自解释，告知行为+产出
- `compressTopN` / `compressByProject` — 语义明确
- `listJsonByMtime` / `listExpiredDaily` — 清晰描述行为
- `buildEffectReview` / `buildJudgeInput` — "build+名词" 模式一致

**问题**：
- `compressByProject` — 名不副实。它并不按 project 压缩，而是按指定 metricKey 排序后取 topN。排序+截断行为没有被函数名反映。应改为 `sortAndTruncateByMetric` 或类似。
- `buildEffectReviewPlaceholder` 返回 `never[]` — 类型和名称都不对。见下文类型安全部分。

### 2. 抽象层次与函数长度

**超标函数**（以 80 行为参照线，taste-lint 上限为 300）：

| 函数 | 文件 | 估算行数 | 评价 |
|------|------|----------|------|
| `handleEvolveApply` | commands.ts | ~150 | **严重超标**。list/apply/skip 三条路径混合在一体，复杂分支管理的大函数 |
| `handleEvolve` | commands.ts | ~100 | **超标**。6 步流程（找报告→读→summarize→judge→保存→返回）混在一起 |
| `extractMetricsSnapshot` | summarizer.ts | ~80 | **边缘**。body 本身逻辑简单，但重复 typeof 检查膨胀了代码量 |
| `handleEvolveStats` | commands.ts | ~80 | **边缘**。内联 JSON 解析和聚合逻辑可提取 |

**建议**：
- `handleEvolveApply` 按 action 拆分为三个内部函数：`handleList` / `handleApply` / `handleSkip`
- `handleEvolve` 将 3a→3e 的 summarizer pipeline 提取为 `runSummarizerPipeline()`
- `extractMetricsSnapshot` 用提取的 `safeNumber()` 或 `pickNumber()` 工具函数消除重复

### 3. 数据流

**重复模式** — `extractMetricsSnapshot` 中 `typeof ... === "number" ? ... : 0` 模式出现了约 **20 次**：

```typescript
const totalToolCalls = typeof toolStats?.total_calls === "number"
  ? toolStats.total_calls
  : 0;
const editRetryRate = typeof toolStats?.edit_retry_rate === "number"
  ? toolStats.edit_retry_rate
  : 0;
// ...重复 18 次
```

每个字段 4 行，20 个字段 = 80 行模板代码。一个 `safeNumber(val, fallback = 0)` 工具函数即可消除，降到 1 行/字段。

**不必要的包装函数** — `commands.ts` 中的 `getMtimeMs`：

```typescript
function getMtimeMs(filePath: string): number {
  return statSync(filePath).mtimeMs;
}
```

只在一个调⽤点使用。可直接内联 `statSync(filePath).mtimeMs`。

### 4. 错误处理

**空 catch 块**（3 处，taste/no-silent-catch 警告）：

| 位置 | 行号 | 上下文 |
|------|------|--------|
| `commands.ts` | 67 | `findRecentReport` 中文件读取失败跳过 |
| `commands.ts` | 450 | `handleEvolveStats` 中损坏 JSON 文件跳过 |
| `gc.ts` | 51 | `removeFiles` 中权限/并发删除失败跳过 |

均为"静默忽略"模式。当前上下文合理（文件竞争的边缘情况无法 recover），但 **至少应当 console.warn 或 debug 日志**，否则长运行时错误无从诊断。

**judge.ts 中运行时类型假设无校验** — `extractAssistantText` 函数中：

```typescript
const msg = event.message as {
  role?: string;
  content?: Array<{ type: string; text?: string }>;
};
```

此处假设 JSONL event 结构固定，但无运行时校验。若 pi 输出格式变化（如 content 中不再包含 type/text 结构），会静默返回空字符串，导致 judge 无产出且难以调试。建议加 JSON schema 校验或至少防御性访问。

### 5. 魔法数字

51 处 `no-magic-numbers` 警告，集中在以下类别：

**时间常量未命名**（effect-tracker.ts:61, gc.ts:62）：
```typescript
// effect-tracker.ts:61 — isWithinDays 内联计算
const then = new Date(isoTimestamp).getTime();
return Date.now() - then < days * 24 * 60 * 60 * 1000;

// gc.ts:62 — listExpiredDaily 内联计算
const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
```
`24 * 60 * 60 * 1000` 在代码库中出现 5 次，应提取为 `HOUR_MS` 或 `DAY_MS`。

**阈值散落**（summarizer.ts）：
- `0.05` — 工具高失败率阈值
- `0.3` — 异常检测阈值（出现 3 次）
- `0.5` — 高严重性阈值（出现 2 次）
- `5_000_000` / `20_000_000` — Token 热点阈值
- `10` — 沉睡 skill/趋势变化阈值（出现 3 次）

应提取为语义化常量，如 `TOOL_FAILURE_THRESHOLD = 0.05`。

**冗余百分比计算**（effect-tracker.ts:144）：
```typescript
Math.round(((after - before) / before) * 10000) / 100;
```
等价于 `Math.round(((after - before) / before) * 100)`。`* 10000 / 100 = * 100`，中间步骤冗余。

### 6. 代码重复

- **`extractMetricsSnapshot` 的 typeof 守卫** — 见数据流部分，20 次重复模式。
- **`listJsonByMtime` / `listExpiredDaily`** — 都有 `readdirSync` + filter `.json` 的逻辑，但后续处理不同，不必合并。
- **`findRecentReport` 和 `handleEvolveStats`** 都遍历目录按日期筛选 — 但一个按 mtime 一个按文件名日期，略有差异，不值得硬合并。

### 7. 类型安全

**`never[]` 误用**（summarizer.ts:382）：

```typescript
function buildEffectReviewPlaceholder(
  _metricsHistory: MetricsSnapshot[],
): never[] {
  return [];
}
```

`never[]` 表示"这个函数永远不会正常返回"（死循环或抛错）。但这里返回了空数组——这是可达路径。虽然 `never` 可赋值给任何类型（`never[]` 可赋给 `EffectReview[]`），但语义错误，误导读者。应改为显式类型标注：

```typescript
function buildEffectReviewPlaceholder(...): EffectReview[] {
  return [];
}
```

**`Record<string, unknown>` 泛用** — 4 个文件都大量使用 `Record<string, unknown>`。这在动态报告结构场景下有合理性（Phase 2 报告结构不由本扩展控制），但需要注意：
- `extractMetricsSnapshot` 中每次字段访问都带 typeof 守卫，说明运行时结构不确定
- `judge.ts` 中 `extractAssistantText` 的 `as` cast 无运行时校验，是安全薄弱点
- `commands.ts` 中 inline 类型断言（lines 506-510）同样无校验

**未使用的导入和变量**（6 个，ESLint 错误）：

| 文件 | 行 | 符号 | 说明 |
|------|-----|------|------|
| `commands.ts` | 22 | `HistoryEntry` | 导入未使用 |
| `effect-tracker.ts` | 55 | `SEVEN_DAYS_MS` | 定义了 `isWithinDays` 内联相同计算，未引用该常量 |
| `judge.ts` | 13 | `randomUUID` | 导入未使用 |
| `judge.ts` | 93 | `templateFileName` | 赋值后未使用 |
| `judge.ts` | 222 | `parseErr` | catch 绑定变量未使用，应 `_parseErr` |
| `summarizer.ts` | 20 | `loadMetricsHistory` | 导入未使用。`summarizeReport` 接收已加载的 history 参数 |

其中 `SEVEN_DAYS_MS` 问题值得注意——变量存在但不被引用，`isWithinDays` 重复了相同的计算逻辑。

---

## 综合评分

| 维度 | 评价 | 等级 |
|------|------|------|
| 命名 | 整体好，`compressByProject` 名不副实 | B+ |
| 抽象层次 | `handleEvolveApply` 和 `handleEvolve` 需拆分 | C |
| 数据流 | `extractMetricsSnapshot` 中 20 次重复 typeof 模式需提取 | C- |
| 错误处理 | silent catch 缺乏日志；JSONL 解析缺运行时校验 | C |
| 魔法数字 | 51 处，时间常量和阈值散落各处 | D |
| 代码重复 | 单文件内重复程度高（typeof 守卫），跨文件尚可 | C+ |
| 函数长度 | 3 个函数超标，1 个边缘 | C- |
| 类型安全 | 6 处未使用导出/变量，`never[]` 类型误用，多处 unsafe `as` | D |

**总体 verdict: fail**

---

## 必须修复项（must_fix: 6）

| # | 严重级别 | 问题 | 涉及文件 | 改法简述 |
|---|----------|------|----------|----------|
| 1 | 🔴 | 清理所有未使用的导入和变量（6 处） | 4 个文件 | 删除或 `_` 前缀 |
| 2 | 🔴 | 空 catch 块需添加日志（3 处） | `commands.ts` / `gc.ts` | 添加 `console.warn` |
| 3 | 🟠 | `never[]` 返回类型错误 | `summarizer.ts` | 改为 `EffectReview[]` |
| 4 | 🟠 | `extractAssistantText` 中 unsafe `as` 类型断言 | `judge.ts` | 加运行时结构校验 |
| 5 | 🟠 | 提取 `safeNumber` 消除 20 次 typeof 重复 | `summarizer.ts` | 提取工具函数 |
| 6 | 🟠 | `handleEvolveApply`（~150行）按 action 拆分 | `commands.ts` | 拆分三个内部函数 |

**建议修复项（非 blocker）**：
- 为 `MS_PER_DAY = 86_400_000` 补充注释说明，将 5 处 `* 24 * 60 * 60 * 1000` 替换为命名常量
- `compressByProject` 更名为 `sortAndTruncateByMetric`
- 提取 summarizer.ts 中的异常检测阈值为语义常量（`TOOL_FAILURE_THRESHOLD`, `DORMANT_SKILL_THRESHOLD` 等）
- 简化 `effect-tracker.ts:144` 的百分比计算（`*10000/100` → `*100`）
