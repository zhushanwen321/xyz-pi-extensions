---
verdict: fail
must_fix: 3
reviewer: standards-review
date: 2026-05-29
scope:
  - evolution-engine/src/types.ts
  - evolution-engine/src/state.ts
  - evolution-engine/src/report-generator.ts
  - evolution-engine/src/gc.ts
  - evolution-engine/src/daily-trigger.ts
  - evolution-engine/src/commands.ts
  - evolution-engine/src/index.ts
---

# Standards Review — evolve-daily-report

## 1. 禁止 `any` (CLAUDE.md > 代码规范 > TypeScript)

**状态**: PASS

未发现 `any` 类型使用。`state.ts` 中的 `sug as unknown as Record<string, unknown>` 和 `entry as unknown as Record<string, unknown>` 是 migration 路径的向后兼容处理，使用了 `unknown` 而非 `any`，符合规范。

`daily-trigger.ts:162` 和 `commands.ts:149` 中 `JSON.parse(...) as Record<string, unknown>` 同样合理。

## 2. 函数不超过 80 行 (CLAUDE.md > 行数)

**状态**: FAIL — 2 处违规

| # | 文件 | 函数 | 起始行 | 实际行数 | 说明 |
|---|------|------|--------|----------|------|
| M1 | `daily-trigger.ts` | `checkAndRunDailyAnalysis()` | 135 | 92 | 超出 12 行。函数内含 8 步 pipeline（analyzer → summarize → effect review → gc → judge → markdown → write → merge），建议提取子步骤为独立函数 |
| M2 | `commands.ts` | `handleEvolveStats()` | 396 | 96 | 超出 16 行。统计聚合 + Top N 排序逻辑可提取为独立函数 |

## 3. 单文件不超过 1000 行 (CLAUDE.md > 行数)

**状态**: PASS

| 文件 | 行数 |
|------|------|
| types.ts | 229 |
| state.ts | 234 |
| report-generator.ts | 118 |
| gc.ts | 171 |
| daily-trigger.ts | 226 |
| commands.ts | 685 |
| index.ts | 552 |

所有文件在 1000 行限制内。

## 4. import 使用 `@mariozechner/*` scope (CLAUDE.md > 模块导入规范)

**状态**: PASS

`index.ts` 中所有 Pi 平台依赖均使用 `@mariozechner/*` scope：
- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-tui`
- `@mariozechner/pi-ai`

其余文件仅使用 `node:fs`、`node:os`、`node:path`、`node:child_process` 和项目内部 `./` 导入，符合 import 顺序规范（Node 内置 → 项目内部）。

## 5. 命名规范 (CLAUDE.md > 命名)

**状态**: PASS

- 扩展入口: `export default function evolutionEngineExtension(pi: ExtensionAPI)` — 符合
- 状态接口: 无独立 `XxxRuntimeState` 模式（evolution-engine 使用函数式状态管理而非类），接口命名如 `PendingFile`, `HistoryEntry`, `MetricsSnapshot` 语义清晰
- 工具参数: `EvolveParams`, `EvolveApplyParams`, `EvolveStatsParams`, `EvolveRollbackParams`, `EvolveReportParams` — 符合 `XxxParams` 规范
- 工具详情: `CommandResult`, `GcResult`, `ApplyResult`, `RollbackResult` — 符合 `XxxDetails`/`XxxResult` 规范
- Handler 函数: `handleEvolve`, `handleEvolveApply`, `handleEvolveStats`, `handleEvolveRollback`, `handleEvolveReport` — 一致

## 6. 注释解释"为什么"而非"是什么" (CLAUDE.md > 输出习惯)

**状态**: FAIL — 1 处值得改进

| # | 文件 | 行 | 问题 |
|---|------|----|------|
| M3 | `state.ts` | 42-44, 221-223 | Migration 代码重复出现两次（loadPending 和 loadHistory），缺少注释解释"为什么需要迁移旧格式的 diff → instruction"。注释应说明背景：旧版本 pending.json/history.jsonl 中使用 `diff` 字段，新版本改为 `instruction`，需要运行时兼容 |

正面案例：
- `daily-trigger.ts:139` — `// process.kill(pid, 0) 不发送信号，只检查进程存在性` 解释了为什么用 `kill(pid, 0)`
- `gc.ts` — GC 策略常量 `MAX_REPORTS = 3`, `MAX_DAILY_REPORT_DAYS = 30` 有行内注释说明策略目的

## 7. 其他观察

### 7.1 `commands.ts` 中 `handleEvolveApply` 的 list 分支

`handleEvolveApply` 中 list 分支的变量命名有歧义：`instruction` 同时用于存储 `targetPath` 信息和 instruction preview，逻辑可读性差：

```typescript
const instruction = suggestion.instruction ? `  Target: ${suggestion.targetPath}` : "";
const instructionPreview = suggestion.instruction
    ? `  Instruction:\n  ${...}`
    : "";
```

这不是规范违规，但 `instruction` 变量实际存储的是 target 行而非 instruction，命名有误导性。

### 7.2 `index.ts` 的 `evolutionEngineExtension` 函数

`index.ts` 的工厂函数整体约 500 行，但这是因为 Pi Extension API 的 `registerTool` + `registerCommand` 模式要求在一个闭包中注册所有 handler（共享 `dirs` 变量）。实际的 `registerTool` / `registerCommand` 调用块各自独立，结构清晰。这符合 CLAUDE.md 中 `index.ts` "只做注册胶水"的要求——业务逻辑已全部提取到 `commands.ts`。

### 7.3 `daily-trigger.ts` 中 ANALYZER_SCRIPT 路径硬编码

`ANALYZER_SCRIPT` 使用 `homedir()` + 固定相对路径，这在 `commands.ts` 中也有同样的常量定义。两处重复定义应提取到共享位置。

## 摘要

| 级别 | 编号 | 描述 | 修复建议 |
|------|------|------|----------|
| MUST | M1 | `checkAndRunDailyAnalysis()` 92 行，超出 80 行限制 | 提取子步骤：`runDailyPipeline(dirs, today)` 或 `executeAnalysisSteps(...)` |
| MUST | M2 | `handleEvolveStats()` 96 行，超出 80 行限制 | 提取统计聚合逻辑为 `aggregateDailyStats(dailyDir, cutoff)` 和 `computeTopN(...)` |
| MUST | M3 | migration 代码缺少"为什么"注释 | 添加注释说明 diff → instruction 的迁移背景 |
| SUGGEST | S1 | `commands.ts` 中 `instruction` 变量名有误导 | 重命名为 `targetLine` 或类似 |
| SUGGEST | S2 | `ANALYZER_SCRIPT` 在 `daily-trigger.ts` 和 `commands.ts` 重复定义 | 提取到 `constants.ts` 或 `types.ts` 共享 |

**结论**: 3 个 MUST 修复项，verdict = **fail**。
