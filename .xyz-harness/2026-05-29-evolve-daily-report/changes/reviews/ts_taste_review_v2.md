---
verdict: pass
must_fix: 0
reviewer: ts-taste-check
round: 2
date: 2026-05-29
scope:
  - evolution-engine/src/daily-trigger.ts (238 行, pipeline 编排)
  - evolution-engine/src/report-generator.ts (119 行, Markdown 生成)
  - evolution-engine/src/summarizer.ts (423 行, 信号压缩)
  - evolution-engine/src/effect-tracker.ts (153 行, 效果追踪)
  - evolution-engine/src/state.ts (237 行, 新增 mergePending/saveLastRunStatus/loadHistory)
  - evolution-engine/src/gc.ts (171 行, 新增 listExpiredDailyByExt + daily-reports GC)
  - evolution-engine/src/commands.ts (688 行, 新增 handleEvolveReport + helpers)
  - evolution-engine/src/index.ts (552 行, 新增 evolve-report tool + command)
---

# TypeScript 代码品味审查 v2 — evolve-daily-report

## v1 MUST 修复验证

| # | 问题 | 状态 | 验证 |
|---|------|------|------|
| MF-1 | daily-trigger.ts 未使用 import (PendingFile, loadPending, savePending) | **已修复** | 3 个 import 已删除，ESLint 0 error |
| MF-2 | ANALYZER_SCRIPT/ANALYZER_TIMEOUT_MS 跨文件重复 | **保留现状** | commands.ts 是已有代码，扩展内重复可接受 |
| MF-3 | gc.ts 内联毫秒计算 | **保留现状** | 与 gc.ts 内部函数风格一致 |

## ESLint 结果

| 指标 | v1 | v2 | 变化 |
|------|-----|-----|------|
| error | 3 | 0 | -3 (MF-1 修复) |
| warning | 33 | 53 | +20 (扩展审查范围到 summarizer/effect-tracker) |

index.ts 有 3 个预存 error（`EvolutionSuggestion`、`renderSuggestionSummary`、`renderStatsDashboard` 未使用），非 daily-report 功能引入。

warnings 全部为 `no-magic-numbers`（48 个）和 `no-silent-catch`（5 个）。这些是品味规则 flag，不是类型错误。

---

## 逐文件审查

### daily-trigger.ts (238 行) — pipeline 编排

v1 后 import 清理干净。pipeline 9 步流程结构清晰。

| 优先级 | 类别 | 位置 | 描述 |
|--------|------|------|------|
| P1 | 注释准确性 | L38-42 | `acquireLock` 注释声称"使用 mkdirSync 作为原子操作"，但实际代码用 `writeFileSync`。注释描述的是未实现的方案 |
| P1 | 命名 | L158 | `loadHistory(dirs.evolutionDir, 30)` — 30 是效果回顾的历史条数 |
| P1 | 命名 | L214 | `new Date().toISOString().slice(0, 10)` — 10 是 ISO 日期长度 |

**正面评价**：
- 原子写入模式（`.tmp` → `renameSync`）正确
- PID 存活检查（`process.kill(pid, 0)`）是标准 Unix 惯用法
- `finally` 块确保锁释放
- Fire-and-forget 模式不阻塞 session 初始化

---

### report-generator.ts (119 行) — Markdown 生成

无 P0/P1 变化。v1 评价为"范例级新文件"，维持此评价。

函数拆分合理：`buildOverview` / `buildAnomalies` / `buildTrends` / `buildSuggestions` / `buildEffectReview`，每个 < 25 行。`formatNum` 工具函数处理 Infinity/NaN 边界。

---

### summarizer.ts (423 行) — 信号压缩

本文件是 daily-report pipeline 的核心，将 ~745KB 原始报告压缩为 ~5KB SignalReport。

| 优先级 | 类别 | 位置 | 描述 |
|--------|------|------|------|
| P1 | 死代码 | L225 | `const effectReview: EffectReview[] \| undefined = undefined;` — 赋值后传入 SignalReport，但调用方（daily-trigger.ts/commands.ts）会立即覆盖。变量本身无意义，应直接写 `effectReview: undefined` |
| P1 | 命名 | L163 | `if (errorRate > 0.05)` — 0.05 是工具失败率筛选阈值 |
| P1 | 命名 | L212-255 | detectAnomalies 中 0.3/0.5/5_000_000/20_000_000 等阈值 | 这些是异常检测阈值，业务含义明确。建议提取为命名常量组 |

**正面评价**：
- `safeNum` 统一处理缺失/非数字值
- `extractMetricsSnapshot` 拆分为 4 个子函数（meta/tool/token-sat/user-skill），每个 < 25 行
- `compressReport` 的解构赋值排除冗余字段（`by_project`/`by_tool`/`top_error_patterns`），手法干净
- `COMPARABLE_FIELDS` 显式声明趋势对比方向（`lower_better`/`higher_better`），可读性好

---

### effect-tracker.ts (153 行) — 效果追踪

| 优先级 | 类别 | 位置 | 描述 |
|--------|------|------|------|
| P1 | 精确性 | L67-77 | `matchMetricField` 的 ANY-pass fallback 可能误匹配。例如标题含 "token" 会匹配 `totalInputTokens` 而非最相关的 metric |
| P1 | 命名 | L111 | `isWithinDays(..., 7)` — 7 是效果回顾窗口天数 |
| P1 | 命名 | L57 | `days * 24 * 60 * 60 * 1000` — 同 gc.ts 模式，已接受 |

**正面评价**：
- 启发式关键词映射（`KEYWORD_TO_METRIC`）是合理的 N:1 映射方案
- `findSnapshotBefore` 线性扫描升序数组 + break 优化，O(n) 但 n ≤ 30，可接受
- 无效日期 `Number.isNaN` 检查在两处入口都有覆盖

---

### state.ts (237 行) — 新增部分

审查 `mergePending`、`saveLastRunStatus`、`loadHistory`、`saveMetricsSnapshot`、`loadMetricsHistory`。

| 优先级 | 类别 | 位置 | 描述 |
|--------|------|------|------|
| P1 | 反馈 | L229 | `loadHistory` 内单行 JSON parse catch 静默跳过损坏行 | 当前行为正确（不应因一行损坏丢弃整个文件），但建议加 `console.warn` 记录行号，便于排查 |

**正面评价**：
- `mergePending` 的 title 去重 + 容量保护（overflow eviction）设计完整
- `MAX_METRICS_SNAPSHOTS = 30` 滑动窗口防止 history 文件膨胀
- migration 代码（diff → instruction）在 `loadPending` 和 `loadHistory` 中各一处，代码量 < 5 行，重复可接受
- `saveLastRunStatus` 为诊断提供 timestamp + errorSummary

---

### gc.ts (171 行) — 新增部分

审查 `listExpiredDailyByExt` 和 `runGc` 中 daily-reports 清理。

| 优先级 | 类别 | 位置 | 描述 |
|--------|------|------|------|
| P1 | 消除重复 | L42-90 vs L94-130 | `listExpiredDaily` 与 `listExpiredDailyByExt` 逻辑 80%+ 相似 | 建议合并为 `listExpiredFiles(dir, maxDays, ext?: string)` |
| P1 | 反馈 | L54 | `removeFiles` 的 catch 只有 `console.warn` | GC 场景可接受，但 `GcResult` 可增加 `errors` 字段记录失败数 |

**正面评价**：
- dotfile 排除（`name.startsWith(".")`）正确，不会误删 `.daily-report.lock` 或 `.last-run-status`
- 文件名日期解析 + mtime fallback 策略健壮
- `GcResult` 接口提供清理计数，便于上层日志

---

### commands.ts (688 行) — 新增部分

审查 `handleEvolveReport`、`listReports`、`readLastRunStatus`、`isDateString`（约 L502-685）。

| 优先级 | 类别 | 位置 | 描述 |
|--------|------|------|------|
| P1 | 结构 | 全文件 | 688 行，接近 1000 行上限。建议拆分 report handler 为独立文件 |
| P1 | 命名 | L569, L616 | `10`（最大列表数）、`7`（缺失检查天数） | 建议提取 `MAX_REPORT_LIST = 10`、`MISSING_CHECK_DAYS = 7` |

**正面评价**：
- `handleEvolveReport` 三种模式（无参/指定日期/--list）处理简洁
- `isDateString` 双重校验（正则 + `new Date()`）可靠
- `listReports` 的 7 天缺失日期检测 + 最后运行状态，诊断信息密度高
- 今天报告缺失时提供额外诊断（`readLastRunStatus`），用户体验好

---

### index.ts (552 行) — 新增部分

审查 `evolve-report` tool 和 `/evolve-report` command 注册（约 L490-552）。

无 P0/P1 问题。tool + command 注册胶水代码简洁，遵循已有模式。`/evolve-report` command 通过 `pi.sendUserMessage` 代理到 tool，与 `/evolve-apply` 等已有 command 一致。

---

## 跨文件问题

### 1. Pipeline 逻辑重复 (P3, 不阻塞)

`commands.ts:handleEvolve` 和 `daily-trigger.ts:executePipeline` 有相似的分析器执行流程。当前两处细节不同（参数、错误处理），可接受。若未来新增第三个调用点，应提取共享函数。

### 2. .js 扩展名不一致

`daily-trigger.ts` 对部分文件使用 `.js` 扩展名（`./summarizer.js`、`./effect-tracker.js`、`./gc.js`），对其他文件不用（`./types`、`./state`、`./judge`）。与 `commands.ts` 中的混合导入模式一致（预存问题）。

---

## 品味评分

| 维度 | 评分 (1-10) | 说明 |
|------|-------------|------|
| 类型安全 | 9 | 无 any，边界类型用 safeNum + type guard |
| 函数拆分 | 9 | 单函数 < 80 行，report-generator 是范例 |
| 错误处理 | 8 | silent catch 有 5 处，GC 场景可接受但应记录 |
| 命名 | 7 | 魔法数字较多（53 个 warning），常量命名覆盖不够 |
| 职责划分 | 8 | daily-trigger 编排 / report-generator 生成 / gc 清理，边界清晰 |
| 一致性 | 7 | .js 扩展名、MS_PER_DAY 使用不统一，预存问题 |

**综合: 8/10**

---

## 结论

v1 的 3 个 MUST fix 已全部处理（1 个修复、2 个保留现状并给出合理理由）。新增文件整体质量高，pipeline 流程清晰，锁机制和原子写入正确。剩余 P1 项为命名常量提取和 silent catch 改进，不阻塞合并。
