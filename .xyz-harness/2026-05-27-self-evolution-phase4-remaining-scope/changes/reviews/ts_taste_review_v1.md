---
verdict: fail
must_fix: 10
review_metrics:
  files_reviewed: 8
  issues_found: 24
  must_fix_count: 10
  low_count: 6
  info_count: 8
  duration_estimate: 30m
---

# TypeScript 品味审查报告

**审查范围**: `evolution-engine/src/`（8 个源文件 + 1 个模板文件 + 1 个测试文件）  
**审查时间**: 2026-05-27  
**ESLint 结果**: 9 errors, 37 warnings（taste-lint 规则）

---

## 自动 Lint 摘要

运行 `npx eslint evolution-engine/src/ --no-error-on-unmatched-pattern` 产出：

| 分类 | 数量 | 主要规则 |
|------|------|----------|
| `@typescript-eslint/no-unused-vars` (error) | 9 | 未使用的 import/变量/函数 |
| `taste/no-silent-catch` (warning) | 8 | 空 catch 块吞错误 |
| `no-magic-numbers` (warning) | 26 | 魔数未命名常量 |
| `max-lines-per-function` (warning) | 1 | `evolutionEngineExtension` 310 行超限 |

**所有 9 个 error 都是 `@typescript-eslint/no-unused-vars`，全部为必须修复。**

---

## 逐文件审查

### `types.ts`（158 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P3 | 结构 | L68 | `EvolveCommandParams.sample: number \| undefined` 可改为 `number?` | 用 `params?: number` 替代 |

其余：结构清晰，职责单一（纯类型）。无问题。

**统计**: P0: 0 | P1: 0 | P2: 0 | P3: 1

---

### `commands.ts`（516 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P0 | 清理 | L22 | `HistoryEntry` import 但未使用（ESLint error） | 删除 import |
| P0 | 类型 | L150 | `JSON.parse(raw) as Record<string, unknown>` 后手动访问字段 | 为 Phase 2 报告定义 `SessionReport` 接口，入口断言为结构化类型 |
| P1 | 结构 | L56-70 | `findRecentReport` 中 `getMtimeMs` 是一行包装，没必要独立函数 | 内联 `statSync(filePath).mtimeMs` 或合并到 `findRecentReport` |
| P1 | 命名 | L56 | `MS_PER_DAY` 定义在 L19 但 `findRecentReport` 内 L59 用 `sinceDays * MS_PER_DAY` — 整体 OK，但 `findRecentReport` 与 `handleEvolveStats` 共用同一个常量 | 无歧义，可保留 |
| P1 | 健壮 | L63 | 空 `catch` 块（taste/no-silent-catch） | 加 `// skip unreadable files` 注释或记录日志 |
| P1 | 命名 | L84 | 魔数 `7`（parseSinceDays fallback） | 提取 `const DEFAULT_SINCE_DAYS = 7` |
| P1 | 命名 | L243 | 魔数 `10`（suggestion.diff 预览行数） | 提取 `const DIFF_PREVIEW_LINES = 10` |
| P1 | 命名 | L371 | 魔数 `7`（recent 天数） | 提取 `const STATS_WINDOW_DAYS = 7` |
| P1 | 命名 | L425,432 | 魔数 `5`（topSkills / topFailures 数量） | 提取 `const TOP_N = 5` |
| P1 | 命名 | L430 | 魔数 `3`（filter 最少调用次数） | 提取 `const MIN_CALLS_FOR_RATE = 3` |
| P1 | 命名 | L467 | 魔数 `20`（history limit） | 提取 `const HISTORY_LIMIT = 20` |
| P1 | 结构 | 全文件 | 516 行、4 个 handler 全部在一个文件中，接近 CLI.md 上限 1000 行 | 建议横向拆分：每个 handler 独立一个文件（`evolve.ts`/`apply.ts`/`stats.ts`/`rollback.ts`） |

**统计**: P0: 2 | P1: 11 | P2: 0 | P3: 0

---

### `index.ts`（484 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| **P0** | **结构** | **L108** | **`evolutionEngineExtension` 函数 310 行，超过项目规范 300 行上限**（CLAUDE.md "函数不超过 80 行" 其实是 80 行，但 taste-lint 配置为 300） | **拆分工具注册到独立 `registerTools()`/`registerCommands()` 函数** |
| P0 | 清理 | L22 | `EvolutionSuggestion` import 但未使用（ESLint error） | 删除 import（types 只用到了 `Dirs`） |
| P0 | 清理 | L31 | `renderSuggestionSummary` import 但未使用（ESLint error） | 删除 import |
| P0 | 清理 | L32 | `renderStatsDashboard` import 但未使用（ESLint error） | 删除 import |
| P1 | 命名 | L192 | 魔数 `2`（suggestions[0].confidence.toFixed(2)） | `confidence.toFixed(2)` 是格式化，可接受，建议提取 `const CONFIDENCE_DIGITS = 2` |
| P1 | 命名 | L264 | 魔数 `2`（同 toFixed(2)） | 同上 |
| P1 | 命名 | L469 | 魔数 `20`（history limit） | 提取 `const HISTORY_LIST_LIMIT = 20` |
| P3 | 设计 | L45-50 | `TEMPLATE_DIR` 的 `catch` 分支回退 `process.cwd()` — 声明"理论上不会执行" | 如果确定 ESM 下可用，可以移除 fallback 或加日志 |

**统计**: P0: 4 | P1: 2 | P2: 0 | P3: 1

---

### `judge.ts`（318 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P0 | 清理 | L13 | `randomUUID` import 但未使用（ESLint error） | 删除 import |
| P0 | 清理 | L86 | `templateFileName` 赋值后未使用（ESLint error） | 删除此变量或使用它 |
| P1 | 命名 | L84,89 | 魔数 `2`（JSON.stringify 缩进） | `JSON.stringify(subset, null, 2)` 是标准模式，可容忍 |
| P1 | 命名 | L266 | 魔数 `200`（错误消息截断长度） | 提取 `const ERROR_PREVIEW_LENGTH = 200` |
| P1 | 命名 | L181,207 | 魔数 `1000`, `500`（超时/截断） | 提取 `const STDERR_PREVIEW_LENGTH = 500`、`const TIMEOUT_MS = 120_000`（已有）|
| P1 | 健壮 | L181-207 | `proc.on("close")` 与 `clearTimeout(timer)` 模式, `settled` 标记 — 正确的竞态处理 | 无问题，但需确认 timer 在 reject(resolve) 后清理干净 |

**统计**: P0: 2 | P1: 4 | P2: 0 | P3: 0

---

### `monitor.ts`（331 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P0 | 清理 | L27 | `ERROR_SPIKE_BASELINE_DAYS` 常量定义后未使用（ESLint error） | 删除 |
| P0 | 清理 | L146 | `sliceBeforeLast` 函数定义后未使用（ESLint error） | 删除 |
| P1 | 结构 | L56 | `SkillTriggerEntry` 定义后只在 `checkSkillDormant` 一处使用，可以内联 | 保留为顶层类型，更清晰 |
| P1 | 命名 | L93 | `tailN` 中 `arr.length <= n` — 魔数不明显 | 这是参数比较，非魔数，可豁免 |
| P1 | 命名 | L241,251 | 魔数 `100`（`toFixed(1)` 乘 100 做百分比） | 提取 `const PERCENT_MULTIPLIER = 100` |
| P1 | 健壮 | L100,326 | 空 `catch` 块（taste/no-silent-catch） | 至少加注释或 log.warn |
| P3 | 设计 | L141-160 | `checkTokenDecline`: baseline 取前 7 天，recent 取后 3 天，中间 4 天数据被跳过 | 设计意图明确（避免重叠），但可考虑滑动窗口 |
| P3 | 设计 | L33 | `FLAG_EXPIRY_MS` 使用 7 `* MS_PER_DAY`（魔数 7） | 已定义命名常量 `FLAG_EXPIRY_MS`，合格 |

**统计**: P0: 2 | P1: 4 | P2: 0 | P3: 2

---

### `applier.ts`（258 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P1 | 健壮 | L202,233,253 | 空 `catch` 块（taste/no-silent-catch），git add/commit 失败静默吞掉 | 至少加注释说明"git 失败不阻塞 apply" |
| P3 | 设计 | L104-150 | `parseUnifiedDiff` 手动解析 diff — 复杂但无第三方依赖，符合项目约束 | 保留，添加更多测试覆盖边缘情况 |

**统计**: P0: 0 | P1: 1 | P2: 0 | P3: 1

---

### `state.ts`（94 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P1 | 命名 | L52 | 魔数 `2`（JSON.stringify 缩进） | 惯例，可容忍 |
| P1 | 命名 | L69 | 魔数 `10`（loadHistory 默认 limit） | 在 `appendHistory` 函数签名 `10` 已定义默认参数，OK |
| P1 | 健壮 | L86 | 空 `catch` 块（taste/no-silent-catch） | 加 `// skip corrupted lines` 注释 |

**统计**: P0: 0 | P1: 3 | P2: 0 | P3: 0

---

### `widget.ts`（147 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P0 | 清理 | L8 | `Text` import 但未使用（ESLint error） | 删除 import（widget 函数只返回 `string`，不返回 `Text`） |
| P1 | 命名 | L94 | 魔数 `100`（百分比乘数） | 提取 `const PERCENT_BASE = 100` |
| P1 | 命名 | L116 | 魔数 `19`（`h.timestamp.slice(0, 19)` — ISO 字符串截断） | 提取 `const TIMESTAMP_DISPLAY_LENGTH = 19` |

**统计**: P0: 1 | P1: 2 | P2: 0 | P3: 0

---

### `integration.test.mts`（435 行）

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P3 | 结构 | L139-168 | `loadHistory` limit 参数测试覆盖了 3 和 10，但未测试 limit=0 边缘 | 补充 limit=0 测试 |
| P3 | 结构 | L10 | `srcDir` 使用 `new URL("../src", import.meta.url).pathname` — ESM 兼容做法 | 正确做法，无改动必要 |

**统计**: P0: 0 | P1: 0 | P2: 0 | P3: 2

---

## 跨文件共性问题

### 1. `Record<string, unknown>` + `as` 断言（非白名单场景）

| 文件 | 位置 | 场景 | 判定 |
|------|------|------|------|
| `commands.ts` | L150 | `JSON.parse(raw) as Record<string, unknown>` — 读取 Phase 2 报告 | ⚠️ 报告结构已知（有 `tool_stats`/`token_stats`/等字段），应当定义 `SessionReport` 接口 |
| `monitor.ts` | L183 | `readJsonSafe<T>` 泛型读取 | ✅ 泛型安全读取，白名单允许 |

**建议**: 为 Phase 2 报告定义一个结构化接口（在 `types.ts` 或 `commands.ts` 附近），用于 `commands.ts` 的入口断言。

### 2. 空 catch 块（8 处）

所有 `catch {}` 都涉及"非关键路径"的错误：文件读失败、git 命令失败、JSON 解析失败。最低要求：加注释说明为什么可以安全地跳过。

### 3. 无 `any` 类型

全代码库未发现 `any` 类型使用。符合项目规范。

---

## 汇总

| 优先级 | 数量 | 分类描述 |
|--------|------|----------|
| **P0 (必须修复)** | **10** | 9 个 unused variables + 1 个函数超限 |
| P1 (推荐修复) | 27 | 魔数命名(23) + 空catch注释(3) + 结构拆分(1) |
| P2 (安全) | 0 | — |
| P3 (细节) | 7 | 类型优化、测试补全、设计改进 |

**9 个 unused import/variable/function error 全部由 `@typescript-eslint/no-unused-vars` 捕获，类型检查不可通过当前代码。最小修复可以 1 次 edit 完成（删除无用 import/变量）。**

**`evolutionEngineExtension` 函数 310 行超过 limit 300 行，是结构性违反，需要拆分为独立函数。**

### 修复建议顺序

1. **P0 清理**（~5 分钟）：删除 9 处 unused imports/variables/functions
2. **P0 结构**（~15 分钟）：将 `index.ts` 的 `evolutionEngineExtension` 函数拆为 `registerTools()` + `registerCommands()` + `registerEvents()` 三个函数
3. **P1 空 catch**（~5 分钟）：为 8 处空 catch 添加解释性注释
4. **P1 魔数**（~10 分钟）：将 23 处魔数提取为命名常量
5. **P3 补充**（~10 分钟）：按需补充边缘测试

**本审查 verdict: fail — must_fix（10 个 P0）需修复后才能 merge。**
