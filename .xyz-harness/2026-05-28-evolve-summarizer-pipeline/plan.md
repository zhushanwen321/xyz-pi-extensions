---
verdict: pass
complexity: L1
---

# Evolve Summarizer Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix "Empty Judge output" error by inserting a summarizer layer between Python analyzer and LLM Judge, reducing 745KB raw reports to ~5KB signal summaries, and adding trend tracking + effect review for closed-loop improvement.

**Architecture:** TypeScript-only changes within `evolution-engine/src/`. New modules (`summarizer.ts`, `effect-tracker.ts`, `gc.ts`) plugged into the existing `handleEvolve` flow in `commands.ts`. Judge spawn mechanism changes from CLI args to stdin. Metrics snapshots persisted to a fixed-size sliding window file.

**Tech Stack:** TypeScript, Node.js fs/path/child_process, typebox, Pi Extension API (`@mariozechner/*`)

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `evolution-engine/src/summarizer.ts` | create | BG1 | Signal summarizer: aggregate + anomaly + trend |
| `evolution-engine/src/effect-tracker.ts` | create | BG1 | Effect review: compare pre/post metrics snapshots |
| `evolution-engine/src/gc.ts` | create | BG1 | Data GC: clean reports/signals/daily directories |
| `evolution-engine/src/types.ts` | modify | BG1 | Add MetricsSnapshot, SignalReport, TrendDelta types |
| `evolution-engine/src/state.ts` | modify | BG1 | Add metrics-history.json read/write with sliding window |
| `evolution-engine/src/judge.ts` | modify | BG1 | stdin spawn + signal input + retry + stderr logging |
| `evolution-engine/src/commands.ts` | modify | BG1 | Wire summarizer → effect-tracker → gc into handleEvolve |
| `evolution-engine/src/templates/session-quality.txt` | modify | BG1 | Update template for signal summary input |

---

## Interface Contracts

### Module: summarizer

#### Function: summarizeReport

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| summarizeReport | (report: Record<string, unknown>, history: MetricsSnapshot[]) => SignalReport | SignalReport | report has no `tool_stats` → empty signal; history empty → no trends | AC-1, AC-4 |

#### Function: compressTopN

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| compressTopN | (items: Array<{key: string, count: number, [k: string]: unknown}>, n: number) => Array<{key: string, count: string, example: string}> | compressed array | items empty → []; items.length < n → return all | AC-1 |

#### Function: compressByProject

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| compressByProject | (items: Array<{name: string, [k: string]: unknown}>, metricKey: string, topN: number) => Array<{name: string, [k: string]: unknown}> | compressed array + other aggregate | items empty → [] | AC-1 |

#### Function: detectAnomalies

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| detectAnomalies | (report: Record<string, unknown>) => Anomaly[] | Anomaly[] | no tool_stats → empty | AC-1 |

#### Function: computeTrends

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| computeTrends | (current: MetricsSnapshot, previous: MetricsSnapshot) => TrendDelta[] | TrendDelta[] | previous undefined → empty | AC-4 |

#### Function: extractMetricsSnapshot

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| extractMetricsSnapshot | (report: Record<string, unknown>) => MetricsSnapshot | MetricsSnapshot | partial report → defaults for missing fields | AC-3 |

### Data: MetricsSnapshot

| Field | Type | Description |
|-------|------|-------------|
| date | string (ISO date) | Snapshot date |
| sessionCount | number | Sessions covered |
| totalToolCalls | number | Total tool invocations |
| toolFailureRates | Record<string, number> | Only tools with rate < 0.95 |
| editRetryRate | number | edit failure / edit total |
| bashFailureRate | number | bash failure / bash total |
| singleTurnCompletionRate | number | Fraction of 1-turn sessions |
| avgTurnsPerSession | number | Mean turns |
| avgToolCallsPerSession | number | Mean tool calls |
| selfCorrectionRate | number | corrections / total messages |
| totalInputTokens | number | Sum input tokens |
| totalOutputTokens | number | Sum output tokens |
| totalCost | number | Estimated cost USD |
| avgInputPerSession | number | Mean input per session |
| avgOutputPerSession | number | Mean output per session |
| userCorrectionRate | number | corrections / messages |
| repeatedRequestCount | number | Count of repeated requests |
| medianSessionMinutes | number | Median session duration |
| activeSkillCount | number | Skills triggered at least once |
| dormantSkillCount | number | Skills never triggered |
| totalSkillFileSize | number | Sum of skill file sizes in bytes |

### Data: SignalReport

| Field | Type | Description |
|-------|------|-------------|
| generatedAt | string (ISO) | Timestamp |
| reportPath | string | Source raw report path |
| metricsSnapshot | MetricsSnapshot | Extracted metrics |
| anomalies | Anomaly[] | Detected anomalies |
| trends | TrendDelta[] | Trend changes vs previous |
| effectReview | EffectReview[] (optional) | Pre/post apply effect data |
| compressed | Record<string, unknown> | Aggregated data for LLM |

### Data: TrendDelta

| Field | Type | Description |
|-------|------|-------------|
| field | string | Metric field name |
| previous | number | Previous snapshot value |
| current | number | Current snapshot value |
| changePercent | number | (current - previous) / previous * 100 |

### Data: Anomaly

| Field | Type | Description |
|-------|------|-------------|
| type | string | Category: tool_failure / dormant_skill / user_correction / token_hotspot |
| detail | string | Human-readable description |
| severity | "high" / "medium" / "low" | Anomaly severity |

### Module: effect-tracker

#### Function: buildEffectReview

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| buildEffectReview | (history: HistoryEntry[], metricsHistory: MetricsSnapshot[]) => EffectReview[] | EffectReview[] | no recent applies → [] | AC-5 |

### Data: EffectReview

| Field | Type | Description |
|-------|------|-------------|
| suggestionTitle | string | Applied suggestion title |
| appliedAt | string (ISO) | Apply timestamp |
| targetMetric | string | Primary metric affected |
| before | number | Metric value before apply |
| after | number | Metric value after apply |
| changePercent | number | Percentage change |

### Module: gc

#### Function: runGc

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| runGc | (evolutionDir: string) => GcResult | GcResult | directories don't exist → no-op | AC-6 |

### Data: GcResult

| Field | Type | Description |
|-------|------|-------------|
| reportsRemoved | number | Deleted report files |
| signalsRemoved | number | Deleted signal files |
| dailyRemoved | number | Deleted daily files |

### Module: state (additions)

#### Function: loadMetricsHistory

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| loadMetricsHistory | (evolutionDir: string) => MetricsSnapshot[] | MetricsSnapshot[] | file missing → [] | AC-3 |

#### Function: saveMetricsSnapshot

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| saveMetricsSnapshot | (evolutionDir: string, snapshot: MetricsSnapshot) => void | void | file missing → create | AC-3 |

### Module: judge (modifications)

#### Function: runJudge (modified)

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| runJudge | (input: JudgeInput, templateDir: string) => Promise<EvolutionSuggestion[]> | EvolutionSuggestion[] | empty output → retry once | AC-2, AC-7 |

Changes from current: (1) spawn with stdin instead of args for userMessage, (2) on empty output retry once with shorter prompt, (3) log stderr on failure.

---

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1 (745KB → ≤10KB) | summarizeReport → compressTopN → compressByProject | report.json → summarizer → signal.json | Task 1 |
| AC-2 (no Empty Judge output) | runJudge (retry) | signal.json → judge → suggestions | Task 4 |
| AC-3 (metrics-history ≤30) | saveMetricsSnapshot (sliding window) | summarizer → state.saveMetricsSnapshot | Task 1 |
| AC-4 (trend ±20%) | computeTrends | loadMetricsHistory → summarizer → trends | Task 1 |
| AC-5 (effectReview) | buildEffectReview | loadHistory + loadMetricsHistory → effect-tracker | Task 3 |
| AC-6 (GC limits) | runGc | gc → readdir + unlink | Task 3, Task 5 |
| AC-7 (stdin spawn) | runJudge (spawn change) | signal.json → judge stdin | Task 4 |
| AC-8 (tsc --noEmit) | — | — | All tasks |
| AC-9 (lint 0 error) | — | — | All tasks |

---

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 745KB → ≤10KB | adopted | Task 1 |
| AC-2 No Empty Judge output | adopted | Task 4 |
| AC-3 metrics-history ≤30 | adopted | Task 2 |
| AC-4 trend ±20% filter | adopted | Task 1 |
| AC-5 effectReview | adopted | Task 3 |
| AC-6 GC limits | adopted | Task 3, Task 5 |
| AC-7 stdin spawn | adopted | Task 4 |
| AC-8 tsc --noEmit | adopted | All tasks |
| AC-9 lint 0 error | adopted | All tasks |

---

## Task List

### Task 1: Signal Summarizer (FR-1.1 + FR-1.2 + FR-1.3 + FR-2.1)

**Type:** backend

**Files:**
- Create: `evolution-engine/src/summarizer.ts`
- Modify: `evolution-engine/src/types.ts` — add MetricsSnapshot, SignalReport, TrendDelta, Anomaly, EffectReview types
- Modify: `evolution-engine/src/state.ts` — add loadMetricsHistory, saveMetricsSnapshot with sliding window

**Description:**

Core summarizer module. Takes raw analyzer report JSON, produces ~5KB signal summary. Also extracts MetricsSnapshot for trend history.

- [ ] **Step 1: Add types to types.ts**

Add after the existing `Dirs` interface:

```typescript
// ── Metrics & Signals ────────────────────────────────

/** 趋势指标快照，写入 metrics-history.json */
export interface MetricsSnapshot {
	date: string;
	sessionCount: number;
	totalToolCalls: number;
	toolFailureRates: Record<string, number>;
	editRetryRate: number;
	bashFailureRate: number;
	singleTurnCompletionRate: number;
	avgTurnsPerSession: number;
	avgToolCallsPerSession: number;
	selfCorrectionRate: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCost: number;
	avgInputPerSession: number;
	avgOutputPerSession: number;
	userCorrectionRate: number;
	repeatedRequestCount: number;
	medianSessionMinutes: number;
	activeSkillCount: number;
	dormantSkillCount: number;
	totalSkillFileSize: number;
}

/** 趋势变化项 */
export interface TrendDelta {
	field: string;
	previous: number;
	current: number;
	changePercent: number;
}

/** 异常检测项 */
export interface Anomaly {
	type: "tool_failure" | "dormant_skill" | "user_correction" | "token_hotspot";
	detail: string;
	severity: "high" | "medium" | "low";
}

/** 效果回顾项 */
export interface EffectReview {
	suggestionTitle: string;
	appliedAt: string;
	targetMetric: string;
	before: number;
	after: number;
	changePercent: number;
}

/** 信号摘要报告 */
export interface SignalReport {
	generatedAt: string;
	reportPath: string;
	metricsSnapshot: MetricsSnapshot;
	anomalies: Anomaly[];
	trends: TrendDelta[];
	effectReview?: EffectReview[];
	compressed: Record<string, unknown>;
}
```

- [ ] **Step 2: Add metrics-history functions to state.ts**

Add two functions. `loadMetricsHistory(dir)` reads `metrics-history.json` from evolutionDir, returns empty array if missing. `saveMetricsSnapshot(dir, snapshot)` reads existing, appends, trims to 30 entries, writes back.

File path: `join(dir, "metrics-history.json")`.

- [ ] **Step 3: Create summarizer.ts with extractMetricsSnapshot**

Function `extractMetricsSnapshot(report, date)`: walks the raw report fields (`tool_stats`, `token_stats`, `error_stats`, `user_patterns`, `skill_stats`, `satisfaction`) and populates a `MetricsSnapshot`. Missing fields get zero defaults.

- [ ] **Step 4: Add compressTopN and compressByProject**

`compressTopN(items, n)`: sort by count descending, take top n, each item becomes `{key, count, example: first 100 chars of relevant detail}`.

`compressByProject(items, metricKey, topN)`: sort by metricKey descending, take top n, aggregate rest as `{name: "other", [metricKey]: sum}`.

- [ ] **Step 5: Add detectAnomalies**

`detectAnomalies(report)`: iterate tool failure rates, check thresholds (>10% = medium, >25% = high), check dormant skills, check user correction rate >20%, check token hotspots >30%. Return `Anomaly[]`.

- [ ] **Step 6: Add computeTrends**

`computeTrends(current, previous)`: for each numeric field in MetricsSnapshot, compute `(current - previous) / Math.max(Math.abs(previous), 0.001) * 100`. Filter to |changePercent| >= 20. Return `TrendDelta[]`.

- [ ] **Step 7: Add summarizeReport (main entry)**

`summarizeReport(report, metricsHistory)`: calls extractMetricsSnapshot, detectAnomalies, computeTrends (if history has previous entry), compressTopN/compressByProject for large fields, assembles `SignalReport`. Saves snapshot via `saveMetricsSnapshot`.

- [ ] **Step 8: Commit**

```bash
git add evolution-engine/src/summarizer.ts evolution-engine/src/types.ts evolution-engine/src/state.ts
git commit -m "feat(evolve): add signal summarizer module"
```

---

### Task 2: Effect Tracker (FR-3)

**Type:** backend

**Files:**
- Create: `evolution-engine/src/effect-tracker.ts`
- Modify: `evolution-engine/src/types.ts` — add `metricsSnapshotDate` to HistoryEntry (optional field)

**Description:**

Compares metrics snapshots before and after suggestion applies to measure effectiveness.

- [ ] **Step 1: Add metricsSnapshotDate to HistoryEntry in types.ts**

Add optional field `metricsSnapshotDate?: string` to `HistoryEntry`. This links an apply action to the metrics snapshot that was current at apply time.

- [ ] **Step 2: Create effect-tracker.ts with buildEffectReview**

`buildEffectReview(recentHistory, metricsHistory)`: filters history for "apply" actions within last 7 days. For each, finds the snapshot before apply date and the latest snapshot. Computes delta for the most relevant metric (heuristic: match suggestion keywords to metric field names). Returns `EffectReview[]`.

If no recent applies or no before/after snapshots, returns empty array.

- [ ] **Step 3: Commit**

```bash
git add evolution-engine/src/effect-tracker.ts evolution-engine/src/types.ts
git commit -m "feat(evolve): add effect tracker module"
```

---

### Task 3: Data GC (FR-4)

**Type:** backend

**Files:**
- Create: `evolution-engine/src/gc.ts`

**Description:**

Lazy garbage collection for reports, signals, and daily directories.

- [ ] **Step 1: Create gc.ts with runGc**

`runGc(evolutionDir)`: reads three directories and removes old files:
- `reports/*.json`: keep newest 3, delete rest
- `signals/*.json`: keep newest 30, delete rest
- `daily/*.json`: keep files within 90 days, delete rest
- `metrics-history.json`: handled by sliding window in state.ts, no GC needed here

Returns `GcResult` with counts of removed files per directory.

Guard: if directory doesn't exist, skip (no error).

- [ ] **Step 2: Commit**

```bash
git add evolution-engine/src/gc.ts
git commit -m "feat(evolve): add data GC module"
```

---

### Task 4: Judge Spawn Fix + Robustness (FR-5 + FR-6)

**Type:** backend

**Files:**
- Modify: `evolution-engine/src/judge.ts` — stdin spawn, signal input, retry, stderr logging
- Modify: `evolution-engine/src/templates/session-quality.txt` — adapt for signal summary format

**Description:**

Fix the root cause: change pi spawn from CLI args to stdin. Read signal file instead of raw report. Add retry + stderr diagnostics.

- [ ] **Step 1: Modify runJudge to use stdin**

In `runJudge()`, change spawn to pipe stdin:
- Remove `userMessage` from args array
- Change `stdio` from `["ignore", "pipe", "pipe"]` to `["pipe", "pipe", "pipe"]`
- After spawn, write userMessage via `proc.stdin.write()` + `proc.stdin.end()`
- Read signal data from `input.reportPath` (which will now point to signal file instead of raw report)

The args array becomes:
```typescript
const args = [
  "--mode", "json",
  "-p",
  "--model", "router-openai/glm-5.1",
  "--no-session",
  "--append-system-prompt", templateContent,
];
```

- [ ] **Step 2: Add retry on empty output**

Wrap the core judge logic in a helper `runJudgeOnce()`. In `runJudge()`, call it once. If `parseJudgeOutput` throws "Empty Judge output", retry once with a shorter prompt: `"Output ONLY a JSON array of suggestions. No markdown, no explanation. If no suggestions, output [].\n\n${signalData}"`.

Log stderr to `tmp/judge-stderr-{timestamp}.txt` on both failures.

- [ ] **Step 3: Update session-quality.txt template**

Update the template to reference signal summary format instead of raw JSON. Key changes:
- Header says "以下是信号摘要" instead of "session 信号数据"
- Reference sections: anomalies, trends, effectReview, compressed data
- Keep output format spec (JSON array schema) unchanged

- [ ] **Step 4: Commit**

```bash
git add evolution-engine/src/judge.ts evolution-engine/src/templates/session-quality.txt
git commit -m "fix(evolve): judge uses stdin + signal summary + retry"
```

---

### Task 5: Wire Everything in commands.ts (Integration)

**Type:** backend

**Files:**
- Modify: `evolution-engine/src/commands.ts` — insert summarizer, effect-tracker, gc calls

**Description:**

Modify `handleEvolve` to: read report → summarize → save signal → run gc → build judge input from signal → run judge → save pending.

Modify `handleEvolveApply` to: record `metricsSnapshotDate` in history entries.

- [ ] **Step 1: Add imports**

Add imports for `summarizeReport` from `./summarizer.js`, `buildEffectReview` from `./effect-tracker.js`, `runGc` from `./gc.js`, `loadMetricsHistory` and `saveMetricsSnapshot` from `./state.js`.

- [ ] **Step 2: Modify handleEvolve — insert summarize after reading report**

After reading the report JSON (around line "let report: Record<string, unknown>"), add:
1. `const metricsHistory = loadMetricsHistory(dirs.evolutionDir)`
2. `const signalReport = summarizeReport(report, metricsHistory)`
3. Save signal to `signals/signal-{timestamp}.json` in evolutionDir
4. `runGc(dirs.evolutionDir)` — lazy GC
5. Build judgeInput using signal file path instead of raw report path

- [ ] **Step 3: Modify buildJudgeInput call**

Replace `buildJudgeInput(report, target, dirs.tmpDir)` with a call that passes the signal file path. The signal data replaces the raw report as Judge input.

- [ ] **Step 4: Modify handleEvolveApply — add metricsSnapshotDate**

When recording apply to history (the `appendHistory` call), add `metricsSnapshotDate` from the latest metrics snapshot.

- [ ] **Step 5: Commit**

```bash
git add evolution-engine/src/commands.ts
git commit -m "feat(evolve): wire summarizer pipeline into handleEvolve"
```

---

### Task 6: Dirs update + signals directory

**Type:** backend

**Files:**
- Modify: `evolution-engine/src/types.ts` — add `signalsDir` to Dirs
- Modify: `evolution-engine/src/index.ts` — create signalsDir in makeDirs

**Description:**

Add `signalsDir` to the Dirs interface and ensure it's created.

- [ ] **Step 1: Add signalsDir to Dirs interface**

```typescript
export interface Dirs {
  evolutionDir: string;
  reportsDir: string;
  tmpDir: string;
  templateDir: string;
  signalsDir: string;  // ~/.pi/agent/evolution-data/signals
}
```

- [ ] **Step 2: Update makeDirs in index.ts**

Add `signalsDir: join(evolutionDir, "signals")` to the returned object. Ensure directory exists with `mkdirSync`.

- [ ] **Step 3: Update all call sites**

In `commands.ts`, use `dirs.signalsDir` where signals are read/written instead of constructing the path manually.

- [ ] **Step 4: Commit**

```bash
git add evolution-engine/src/types.ts evolution-engine/src/index.ts evolution-engine/src/commands.ts
git commit -m "feat(evolve): add signalsDir to Dirs interface"
```

---

### Task 7: Type Check + Lint Pass

**Type:** backend

**Files:**
- All files modified in Tasks 1-6

**Description:**

Final validation pass.

- [ ] **Step 1: Run tsc --noEmit**

```bash
cd evolution-engine && npx tsc --noEmit
```

Fix any type errors. Expected: 0 errors.

- [ ] **Step 2: Run lint**

```bash
cd xyz-pi-extensions && npm run lint
```

Fix any lint errors. Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore(evolve): fix typecheck and lint issues"
```

---

## Execution Groups

#### BG1: Evolve Summarizer Pipeline (全部后端)

**Description:** 所有 7 个 task 都是后端 TypeScript，功能紧密关联（summarizer → effect-tracker → gc → judge → commands → dirs → lint），共享类型定义和数据流。

**Tasks:** Task 1, Task 2, Task 3, Task 4, Task 5, Task 6, Task 7

**Files (预估):** 11 个文件（4 create + 7 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | 按 taskComplexity 自动选择（summarizer: high, 其余: medium） |
| 注入上下文 | spec.md FR-1 到 FR-6 + AC + Constraints; 本 plan.md 的 Interface Contracts |
| 读取文件 | `evolution-engine/src/` 下所有现有文件 + `evolution-engine/src/templates/session-quality.txt` |
| 修改/创建文件 | 见 File Structure 表 |

**Execution Flow (BG1 内部):** 串行派遣，每个 Task 走完整 subagent 链后再开始下一个 Task。

  Task 1 (summarizer core — high complexity):
    1. general-purpose → 实现 types.ts 类型 + state.ts 函数 + summarizer.ts 全部函数

  Task 2 (effect-tracker — medium):
    1. general-purpose → 实现 effect-tracker.ts + types.ts HistoryEntry 修改

  Task 3 (gc — low):
    1. general-purpose → 实现 gc.ts

  Task 4 (judge fix — high):
    1. general-purpose → 修改 judge.ts spawn + retry + 更新 template

  Task 5 (commands wiring — medium):
    1. general-purpose → 修改 commands.ts 集成所有模块

  Task 6 (dirs update — low):
    1. general-purpose → types.ts + index.ts + commands.ts 小改动

  Task 7 (lint — low):
    1. general-purpose → 运行 tsc + lint，修复问题

**Dependencies:** 无外部依赖

**设计细节:** L1 — 所有设计细节直接写在本 plan.md 的 Task 描述和 Interface Contracts 中。

---

## Dependency Graph & Wave Schedule

```
Task 1 (summarizer) ──→ Task 2 (effect-tracker) ──→ Task 5 (commands wiring) ──→ Task 6 (dirs) ──→ Task 7 (lint)
      │                                                       ↑
      ├──→ Task 3 (gc) ──────────────────────────────────────┘
      │
      └──→ Task 4 (judge fix) ───────────────────────────────┘
```

| Wave | Tasks | 说明 |
|------|-------|------|
| Wave 1 | Task 1 | 核心模块，无依赖 |
| Wave 2 | Task 2, Task 3, Task 4 | 并行，都只依赖 Task 1 的类型定义 |
| Wave 3 | Task 5, Task 6 | 集成层，依赖前面所有 task |
| Wave 4 | Task 7 | 最终验证 |

**实际执行:** BG1 单 subagent 串行执行即可（总共 ~400 行新代码 + ~50 行修改），不需要并行。
