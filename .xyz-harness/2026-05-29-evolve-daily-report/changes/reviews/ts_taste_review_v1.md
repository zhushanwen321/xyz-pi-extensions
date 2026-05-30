---
verdict: fail
must_fix: 3
reviewer: ts-taste-check
date: 2026-05-29
scope:
  - evolution-engine/src/report-generator.ts (118 行)
  - evolution-engine/src/daily-trigger.ts (226 行)
  - evolution-engine/src/state.ts (234 行, 审查 mergePending/saveLastRunStatus/loadHistory 新增部分)
  - evolution-engine/src/gc.ts (171 行, 审查 listExpiredDailyByExt + daily-reports GC 新增部分)
  - evolution-engine/src/commands.ts (685 行, 审查 handleEvolveReport + helpers 新增部分)
---

# TypeScript 代码品味审查 — evolve-daily-report

## 审查总结

| 优先级 | 数量 | 说明 |
|--------|------|------|
| P0 原则 | 3 | 跨文件常量重复、未使用 import (lint error)、gc.ts 魔法数字重复 |
| P1 偏好 | 5 | commands.ts 超行数、silent catch ×2、多处魔法数字未命名、Record<string,unknown> 边界类型 |
| P2 安全 | 0 | — |
| P3 细节 | 1 | daily-trigger 与 commands.ts 的 analyzer 执行逻辑重复 |

**ESLint 结果**: 3 error / 33 warnings（errors 为 unused imports，warnings 为 magic numbers + silent catch）

---

## 逐文件审查

### report-generator.ts (118 行)

结构清晰、职责单一（Markdown 报告生成）。无 P0 问题。

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P1 | 命名 | L20 | `slice(0, 10)` 提取日期 | 提取为 `ISO_DATE_LENGTH = 10` 或内联注释说明 |
| P1 | 命名 | L117 | `toFixed(2)` 魔法数字 | 可接受 — 2 位小数是通用格式惯例，不需要常量 |

**评价**: 新文件中质量最高的一个。函数拆分合理，每个 builder 函数 < 30 行，无 any、无 Record 滥用、无 silent catch。

---

### daily-trigger.ts (226 行)

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| **P0** | 消除重复 | L42-48 vs commands.ts:35-41 | `ANALYZER_TIMEOUT_MS` + `ANALYZER_SCRIPT` 两处完全相同定义 | 提取到 `constants.ts` 共享 |
| **P0** | 类型 | L24, L26-27 | `PendingFile`, `loadPending`, `savePending` import 后未使用 | 删除这三个 import（ESLint error） |
| P1 | 反馈 | L95 | `acquireLock` 内 `catch {}` 吞掉锁文件解析错误 | 添加 `console.warn` 记录损坏锁文件路径 |
| P1 | 类型 | L162 | `JSON.parse(rawReport) as Record<string, unknown>` | Python 脚本输出属于外部边界，此处用法合理。但应定义 AnalyzerOutput 接口并在入口断言 `as unknown as AnalyzerOutput`，提升下游字段访问的类型安全 |
| P1 | 命名 | L177 | `loadHistory(dirs.evolutionDir, 30)` 魔法数字 | 提取 `EFFECT_REVIEW_HISTORY_DAYS = 30` |

**Pipeline 流程评价**: `checkAndRunDailyAnalysis` 的 8 步流程（检查 → 锁 → analyzer → summarizer → effect review → GC → Judge → 写报告 → 合并 pending）结构清晰，每步职责明确。`acquireLock` 的 PID 存活检查（`process.kill(pid, 0)`）是正确的 Unix 惯用法。原子写入（`.tmp` → `renameSync`）模式正确。

---

### state.ts — 新增部分

审查 `mergePending`、`saveLastRunStatus`、`loadHistory` 及相关常量。

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P1 | 反馈 | L226 | `loadHistory` 内 catch 块吞掉单行 JSON 解析错误 | 当前行为合理（损坏行跳过），但应加 `console.warn` 记录损坏行，便于诊断 |
| — | 设计 | L197-232 | `mergePending` + `saveLastRunStatus` 职责清晰 | 无问题 |

**Migration 代码评价**: `(sug as unknown as Record<string, unknown>).diff` 的 migration 模式在 `loadPending` 和 `loadHistory` 中重复出现（L42-45 vs L221-224），但因为两处逻辑完全相同且代码量 < 5 行，提取反而增加间接性。当前可接受。

**容量保护评价**: `mergePending` 的 overflow eviction（将最早的 pending 改为 rejected）策略正确，保证了 `pending.json` 不会无限膨胀。

---

### gc.ts — 新增部分

审查 `listExpiredDailyByExt` 及 `runGc` 中的 daily-reports 清理逻辑。

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| **P0** | 消除重复 | L66, L99 | `24 * 60 * 60 * 1000` 计算毫秒数 — commands.ts 已定义 `MS_PER_DAY` | 提取 `MS_PER_DAY` 到共享常量文件，gc.ts 引用它 |
| P1 | 消除重复 | L59-104 | `listExpiredDaily` 与 `listExpiredDailyByExt` 逻辑 80%+ 相似 | 合并为一个通用函数 `listExpiredFiles(dir, maxDays, ext?: string)` |
| P1 | 反馈 | L54 | catch 块只有 `console.warn` | GC 场景下可接受（清理失败不应阻塞主流程），但应在 `GcResult` 中记录失败数量 |

**`listExpiredDailyByExt` 设计评价**: 新增的 `.md` 文件扩展名过滤和 dotfile 排除逻辑正确。用文件名解析日期 + mtime 兜底的策略健壮。

---

### commands.ts — 新增部分 (handleEvolveReport + helpers)

审查范围: L502-685（handleEvolveReport、listReports、readLastRunStatus、isDateString）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P1 | 结构 | 全文件 (685 行) | 超过品味阈值 300 行。新增 ~120 行加重了已有问题 | 新增的 report handler 应独立为 `commands/report.ts`，而不是继续追加到已有大文件 |
| P1 | 命名 | L569, L616, L629-630 | `10` (最大列表数)、`7` (缺失检查天数) 等魔法数字 | 提取 `MAX_REPORT_LIST = 10`、`MISSING_CHECK_DAYS = 7` |
| P1 | 命名 | L410 | `7 * MS_PER_DAY` | 提取 `STATS_WINDOW_DAYS = 7` |
| P1 | 命名 | L465, L470, L472 | `5` (top skills)、`3` (最小调用数)、`5` (top failures) | 提取 `TOP_N_ITEMS = 5`、`MIN_CALLS_FOR_FAILURE_RATE = 3` |

**`handleEvolveReport` 设计评价**: 三种模式（无参 / 指定日期 / --list）的处理简洁正确。`isDateString` 用正则 + `new Date()` 双重校验是可靠的做法。`readLastRunStatus` 为今天的报告缺失提供诊断信息，用户体验好。

**`listReports` 设计评价**: 7 天缺失日期检测 + 今日标记 + 最后运行状态，信息密度高，辅助诊断能力强。

---

## 跨文件问题汇总

### 1. ANALYZER_SCRIPT + ANALYZER_TIMEOUT_MS 重复定义

- `commands.ts:35-41` — 定义 `ANALYZER_TIMEOUT_MS = 60_000` + `ANALYZER_SCRIPT = join(homedir(), ...)`
- `daily-trigger.ts:42-48` — 完全相同的定义

**建议**: 提取到 `constants.ts`，两文件共享。

### 2. MS_PER_DAY 重复/缺失

- `commands.ts:33` — 定义 `MS_PER_DAY = 86_400_000`
- `gc.ts:66,99` — 内联计算 `24 * 60 * 60 * 1000`

**建议**: `MS_PER_DAY` 放入共享常量文件，gc.ts 引用。

### 3. analyzer 执行逻辑重复 (P3)

- `commands.ts:121-139` — handleEvolve 中的 analyzer 执行
- `daily-trigger.ts:93-122` — checkAndRunDailyAnalysis 中的 analyzer 执行

两处逻辑结构类似但细节不同（参数、错误处理方式），当前可接受，但若未来继续扩展 analyzer 调用点，应提取为共享函数。

---

## 必须修复项 (must_fix = 3)

### MF-1: daily-trigger.ts 未使用 import (lint error)

```typescript
// L24: PendingFile 未使用
// L26: loadPending 未使用
// L27: savePending 未使用
```

**修复**: 删除这三行 import。

### MF-2: ANALYZER_SCRIPT + ANALYZER_TIMEOUT_MS 跨文件重复

**修复**: 创建 `evolution-engine/src/constants.ts`，两文件共享引用。

### MF-3: gc.ts 内联毫秒计算与 MS_PER_DAY 重复

**修复**: 将 `MS_PER_DAY` 移入 `constants.ts`，gc.ts 引用它替代 `24 * 60 * 60 * 1000`。

---

## 建议修复项 (推荐，不阻塞)

| # | 文件 | 建议 |
|---|------|------|
| R1 | commands.ts | handleEvolveReport + helpers 独立为 `commands/report.ts` |
| R2 | daily-trigger.ts:162 | 定义 `AnalyzerOutput` 接口替代 `Record<string, unknown>` |
| R3 | gc.ts:59-104 | 合并 `listExpiredDaily` 和 `listExpiredDailyByExt` 为通用函数 |
| R4 | commands.ts | 提取魔法数字为命名常量 (STATS_WINDOW_DAYS, TOP_N_ITEMS, etc.) |
| R5 | daily-trigger.ts:95 | silent catch 加 `console.warn` |

---

## 正面评价

1. **report-generator.ts** 是范例级新文件 — 职责单一、函数拆分合理、无类型违规
2. **原子写入**（.tmp → renameSync）在 daily-trigger 中正确应用
3. **Lock 机制**设计周到 — PID 存活检查 + stale lock 清理 + finally 释放
4. **容量保护**（mergePending 的 overflow eviction + metrics 滑动窗口）防止数据膨胀
5. **诊断信息**（saveLastRunStatus + 7 天缺失检测）体现了"反馈不断裂"原则
6. 无 `any` 使用、无 `Promise.all` 误用
