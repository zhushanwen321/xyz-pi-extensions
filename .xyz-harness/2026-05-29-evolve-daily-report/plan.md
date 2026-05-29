---
verdict: pass
complexity: L1
---

# Evolve Daily Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add daily automated evolution analysis that generates human-readable Markdown reports, triggered automatically on session_start once per day.

**Architecture:** Wrap the existing analyzer→summarizer→judge pipeline in a new `daily-trigger` module. On session_start, fire-and-forget an async check: if today's report doesn't exist, acquire a lock file, run the full pipeline, generate a Markdown report, merge suggestions into pending.json, release lock. Add `/evolve-report` command for viewing reports. Extend GC to clean old reports.

**Tech Stack:** TypeScript, Node.js built-ins (fs, path, child_process), Pi Extension API

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `evolution-engine/src/types.ts` | modify | BG1 | Add `dailyReportsDir` to Dirs interface |
| `evolution-engine/src/state.ts` | modify | BG1 | Add `mergePending` + `saveLastRunStatus` |
| `evolution-engine/src/report-generator.ts` | create | BG1 | SignalReport + Suggestions + EffectReview → Markdown |
| `evolution-engine/src/gc.ts` | modify | BG1 | Add daily-reports directory cleanup (30 days) |
| `evolution-engine/src/daily-trigger.ts` | create | BG2 | Lock → pipeline → report → merge pending → unlock |
| `evolution-engine/src/commands.ts` | modify | BG2 | Add `handleEvolveReport` function |
| `evolution-engine/src/index.ts` | modify | BG2 | Wire dailyReportsDir, daily-trigger in session_start, /evolve-report |

## Task List

| # | Task | Type | Depends on | Group |
|---|------|------|-----------|-------|
| 1 | Extend Dirs + state (mergePending, saveLastRunStatus) | backend | — | BG1 |
| 2 | Create report-generator module | backend | — | BG1 |
| 3 | Extend GC for daily-reports | backend | — | BG1 |
| 4 | Create daily-trigger orchestration | backend | 1, 2 | BG2 |
| 5 | Wire commands + index integration | backend | 1, 3, 4 | BG2 |

---

## Interface Contracts

### Module: types (modify)

#### Data: Dirs (extend)

| Field | Type | Description |
|-------|------|-------------|
| dailyReportsDir | string | `~/.pi/agent/evolution-data/daily-reports` |

Location: `evolution-engine/src/types.ts` line ~222, after `signalsDir` field.

### Module: state (modify)

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| mergePending | (dir: string, newSuggestions: EvolutionSuggestion[]) => void | void | No existing pending → create new PendingFile; newSuggestions empty → no-op; title collision → skip duplicate; pending count > 30 → auto-evict oldest with status "rejected" | AC-7, AC-8b |
| saveLastRunStatus | (dir: string, status: "success" \| "failed", errorSummary?: string) => void | void | Directory doesn't exist → create | AC-8 |

Location: `evolution-engine/src/state.ts`, append after `saveMetricsSnapshot`.

### Module: report-generator (create)

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| generateDailyReport | (signalReport: SignalReport, suggestions: EvolutionSuggestion[], effectReview?: EffectReview[]) => string | string (Markdown) | 0 suggestions → "系统运行良好，无需调整"; empty anomalies → "无异常"; empty trends → "无显著变化"; 0 sessionCount → "无数据" indicators | AC-3 |

Location: `evolution-engine/src/report-generator.ts` (new file).

### Module: daily-trigger (create)

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| checkAndRunDailyAnalysis | (dirs: Dirs) => Promise<void> | void | Report exists → no-op; lock held by alive PID → no-op; stale lock → clean + proceed; pipeline failure → log + saveLastRunStatus("failed") | AC-1, AC-2, AC-8 |
| acquireLock | (lockPath: string) => boolean | boolean | Stale lock (PID dead) → unlink + acquire; lock held → return false; no lock file → create + return true | AC-8a |
| releaseLock | (lockPath: string) => void | void | Lock file missing → no-op | — |

Location: `evolution-engine/src/daily-trigger.ts` (new file).

### Module: commands (modify)

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| handleEvolveReport | (args: string, dirs: Dirs) => CommandResult | CommandResult | No args → today's report; date arg → specific date; --list → list reports; report missing → error message with last-run status; corrupted file → "报告文件损坏" | AC-5, AC-6 |

Location: `evolution-engine/src/commands.ts`, append after `handleEvolveRollback`.

### Module: index (modify)

Changes:
1. `makeDirs()`: Add `dailyReportsDir` field, ensure directory exists
2. `session_start` handler: Add `checkAndRunDailyAnalysis(dirs)` call (no await — fire-and-forget with `.catch()`)
3. Register new `/evolve-report` command
4. Register new `evolve-report` tool

Location: `evolution-engine/src/index.ts`.

---

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1 | checkAndRunDailyAnalysis | session_start → check file → pipeline → write report | Task 4, 5 |
| AC-2 | checkAndRunDailyAnalysis | file-exists-and-non-empty → skip | Task 4 |
| AC-3 | generateDailyReport | SignalReport + Suggestions → Markdown string | Task 2 |
| AC-4 | checkAndRunDailyAnalysis → mergePending | pipeline → suggestions → pending.json (via merge) | Task 4 |
| AC-5 | handleEvolveReport | read markdown file → CommandResult | Task 5 |
| AC-6 | handleEvolveReport(--list) | readdir → format → CommandResult | Task 5 |
| AC-7 | mergePending | loadPending → dedup by title → cap at 30 → savePending | Task 1 |
| AC-8 | checkAndRunDailyAnalysis | try/catch → log → saveLastRunStatus | Task 4 |
| AC-8a | acquireLock / releaseLock | PID check → stale cleanup → lock file | Task 4 |
| AC-8b | mergePending (title dedup) | title exact match → skip new | Task 1 |
| AC-9 | runGc (extended) | daily-reports dir → keep 30 days | Task 3 |
| AC-10 | npx tsc --noEmit | — | all |
| AC-11 | existing commands unchanged | — | Task 5 (only additions) |

## Spec Metrics Traceability

| Spec AC | 采纳状态 | 对应 Task |
|---------|---------|----------|
| AC-1 启动自动生成报告 | adopted | Task 4, 5 |
| AC-2 同一天不重复生成 | adopted | Task 4 |
| AC-3 报告包含四+条件章节 | adopted | Task 2 |
| AC-4 建议与 pending.json 一致 | adopted | Task 4 |
| AC-5 /evolve-report 展示 | adopted | Task 5 |
| AC-6 /evolve-report --list | adopted | Task 5 |
| AC-7 已有 pending 不被覆盖 | adopted | Task 1 |
| AC-8 失败不阻塞 + status | adopted | Task 4 |
| AC-8a 并发不重复 | adopted | Task 4 |
| AC-8b title 去重 | adopted | Task 1 |
| AC-9 GC 清理 > 30 天 | adopted | Task 3 |
| AC-10 tsc 通过 | adopted | all |
| AC-11 现有命令不变 | adopted | Task 5 |

---

## Tasks

### Task 1: Extend Dirs type + add mergePending / saveLastRunStatus to state

**Type:** backend

**Files:**
- Modify: `evolution-engine/src/types.ts:222` — Dirs interface
- Modify: `evolution-engine/src/state.ts` — append after `saveMetricsSnapshot`

- [ ] **Step 1: Add dailyReportsDir to Dirs interface**

In `types.ts`, add field to Dirs interface after `signalsDir`:

```typescript
/** ~/.pi/agent/evolution-data/daily-reports */
dailyReportsDir: string;
```

- [ ] **Step 2: Add mergePending function to state.ts**

Function signature and behavior:

```typescript
/**
 * 增量合并新建议到 pending.json。
 * - title 精确匹配去重：已有 pending 建议的 title 与新建议相同时跳过
 * - 容量保护：pending 状态的建议不超过 30 条，超出时将最早的标记为 rejected
 * - 无现有文件时创建新 PendingFile
 */
export function mergePending(dir: string, newSuggestions: EvolutionSuggestion[]): void
```

Read `loadPending(dir)`:
- null → create new PendingFile with all newSuggestions
- existing → filter newSuggestions where `!existing.suggestions.some(e => e.status === "pending" && e.title === new.title)`
- Append filtered suggestions
- If pending-status count > 30, mark oldest pending as rejected with reason "auto-evicted: exceeded capacity"
- `savePending(dir, updated)`

- [ ] **Step 3: Add saveLastRunStatus to state.ts**

```typescript
/**
 * 写入每日运行状态文件，供 /evolve-report --list 展示。
 * 文件路径: {dailyReportsDir}/../daily-reports/.last-run-status
 */
export function saveLastRunStatus(
  dailyReportsDir: string,
  status: "success" | "failed",
  errorSummary?: string,
): void
```

Write JSON file `{dailyReportsDir}/.last-run-status`:
```typescript
{ status, timestamp: new Date().toISOString(), errorSummary?: string }
```

- [ ] **Step 4: Type check**

Run: `cd evolution-engine && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add evolution-engine/src/types.ts evolution-engine/src/state.ts
git commit -m "feat(evolve): add dailyReportsDir to Dirs + mergePending + saveLastRunStatus"
```

---

### Task 2: Create report-generator module

**Type:** backend

**Files:**
- Create: `evolution-engine/src/report-generator.ts`

- [ ] **Step 1: Create report-generator.ts with generateDailyReport**

```typescript
/**
 * Evolution Engine — 每日报告生成器
 *
 * 将 SignalReport + Suggestions + EffectReview 转换为人类可读的 Markdown 报告。
 */
import type { SignalReport, EvolutionSuggestion, EffectReview } from "./types";

/**
 * 生成每日分析报告的 Markdown 文本。
 * 报告结构：数据概览 → 异常信号 → 趋势变化 → 改进建议 → 效果回顾（条件章节）
 */
export function generateDailyReport(
  signalReport: SignalReport,
  suggestions: EvolutionSuggestion[],
  effectReview?: EffectReview[],
): string
```

Output format per spec FR-2.1:

```markdown
# Evolution Daily Report — YYYY-MM-DD

## 数据概览
- Session 数量：N
- 工具调用总数：N
- Token 消耗：input N / output N
- 平均每 session 轮次：N.X

## 异常信号
（anomalies 列表，每条格式: `- [HIGH] detail`，空则 "无异常"）

## 趋势变化
（trends 列表，每条格式: `- field: previous → current (±X%)`，空则 "无显著变化"）

## 改进建议
（suggestions 列表，空则 "系统运行良好，无需调整"）
### #0 [HIGH] title
- 描述：description
- 依据：rationale
- 修改目标：targetPath
- 修改指令：instruction

## 效果回顾
（effectReview 列表，仅有数据时出现此章节）
- suggestionTitle: metric before → after (±X%)
```

Edge cases:
- `signalReport.metricsSnapshot.sessionCount === 0` → all values show "无数据"
- `suggestions.length === 0` → "系统运行良好，无需调整"
- `anomalies.length === 0` → "无异常"
- `trends.length === 0` → "无显著变化"
- `effectReview` undefined or empty → omit section entirely

Date from `signalReport.generatedAt` using `new Date(generatedAt).toISOString().slice(0, 10)` (UTC).

- [ ] **Step 2: Type check**

Run: `cd evolution-engine && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add evolution-engine/src/report-generator.ts
git commit -m "feat(evolve): add daily report Markdown generator"
```

---

### Task 3: Extend GC for daily-reports cleanup

**Type:** backend

**Files:**
- Modify: `evolution-engine/src/gc.ts`

- [ ] **Step 1: Add daily-reports cleanup to GcResult and runGc**

Add to `GcResult` interface:
```typescript
dailyReportsRemoved: number;
```

Add constant:
```typescript
/** daily-reports/*.md 保留天数 */
const MAX_DAILY_REPORT_DAYS = 30;
```

In `runGc`, after daily cleanup block, add daily-reports cleanup:
- Path: `join(evolutionDir, "daily-reports")`
- Filter: `*.md` files, exclude dotfiles (`.last-run-status`, `.daily-report.lock`)
- Reuse `listExpiredDaily` pattern but check `.md` extension
- Files older than `MAX_DAILY_REPORT_DAYS` days → delete

- [ ] **Step 2: Type check**

Run: `cd evolution-engine && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add evolution-engine/src/gc.ts
git commit -m "feat(evolve): add daily-reports cleanup to GC"
```

---

### Task 4: Create daily-trigger orchestration module

**Type:** backend

**Files:**
- Create: `evolution-engine/src/daily-trigger.ts`

Depends on: Task 1 (state.ts mergePending, saveLastRunStatus, Dirs), Task 2 (report-generator)

- [ ] **Step 1: Create daily-trigger.ts with lock helpers + orchestration**

```typescript
/**
 * Evolution Engine — 每日自动分析触发器
 *
 * 在 session_start 中异步触发，每天最多运行一次完整的分析流程。
 * Fire-and-forget：不阻塞 session 初始化。
 */
import { existsSync, writeFileSync, readFileSync, unlinkSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Dirs } from "./types";
import { loadPending, mergePending, saveLastRunStatus } from "./state";
import { generateDailyReport } from "./report-generator";
// Reuse existing pipeline pieces:
import { summarizeReport } from "./summarizer";
import { buildEffectReview } from "./effect-tracker";
import { runJudge } from "./judge";
import { loadMetricsHistory, saveMetricsSnapshot, loadHistory, savePending } from "./state";
import { runGc } from "./gc";
```

**acquireLock(lockPath: string): boolean**

- Check if lock file exists
- If exists: read JSON `{ pid, timestamp }`, check if PID is alive (`process.kill(pid, 0)`)
  - Alive → return false (another process running)
  - Dead → unlink stale lock, fall through to acquire
- Write new lock: `{ pid: process.pid, timestamp: new Date().toISOString() }`
- Return true

**releaseLock(lockPath: string): void**

- try { unlinkSync(lockPath) } catch { /* already removed */ }

**checkAndRunDailyAnalysis(dirs: Dirs): Promise<void>**

Orchestration flow:
1. Compute today's date: `new Date().toISOString().slice(0, 10)` (UTC)
2. Compute report path: `join(dirs.dailyReportsDir, "${date}.md")`
3. Check: `existsSync(reportPath) && statSync(reportPath).size > 0` → return (already done)
4. Acquire lock: `join(dirs.dailyReportsDir, ".daily-report.lock")` → if false, return
5. **Pipeline** (wrapped in try/catch):
   a. Run analyzer (same as handleEvolve but fixed `since="1d"`): execFile python3 ANALYZER_SCRIPT with `--since 1d --format json --output {tmpReportPath}`
   b. Read report JSON
   c. Load metrics history, run summarizeReport
   d. Build effect review
   e. Run GC
   f. Run LLM Judge
   g. Generate Markdown report via `generateDailyReport(signalReport, suggestions, effectReview)`
   h. Write report: write to `reportPath + ".tmp"`, then `renameSync` to reportPath (atomic)
   i. Merge suggestions into pending: `mergePending(dirs.evolutionDir, suggestions)`
   j. `saveLastRunStatus(dirs.dailyReportsDir, "success")`
6. **On error**: `saveLastRunStatus(dirs.dailyReportsDir, "failed", error.message)`
7. **Finally**: `releaseLock(lockPath)`

Error handling: All errors caught, logged to console, and written to `.last-run-status`. Never throws.

ANALYZER_SCRIPT path: `join(homedir(), ".pi/agent/scripts/pi-session-analyzer/analyze.py")` (same as commands.ts)
ANALYZER_TIMEOUT_MS: 60_000 (same as commands.ts)

- [ ] **Step 2: Type check**

Run: `cd evolution-engine && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add evolution-engine/src/daily-trigger.ts
git commit -m "feat(evolve): add daily-trigger with lock + pipeline orchestration"
```

---

### Task 5: Wire commands + index integration

**Type:** backend

**Files:**
- Modify: `evolution-engine/src/commands.ts` — add handleEvolveReport
- Modify: `evolution-engine/src/index.ts` — wire everything

Depends on: Task 1 (Dirs.dailyReportsDir), Task 3 (GC), Task 4 (daily-trigger)

- [ ] **Step 1: Add handleEvolveReport to commands.ts**

```typescript
import { checkAndRunDailyAnalysis } from "./daily-trigger";
```

```typescript
/**
 * /evolve-report handler:
 * - 无参数 → 显示今天的报告
 * - YYYY-MM-DD → 显示指定日期的报告
 * - --list → 列出所有可用报告（最多 10 条）
 */
export function handleEvolveReport(args: string, dirs: Dirs): CommandResult
```

Logic:
- Parse args: `const trimmed = args.trim()`
- `trimmed === "--list"`:
  - readdir `dirs.dailyReportsDir`, filter `*.md` (exclude dotfiles), sort descending
  - Read `.last-run-status` if exists
  - Find today's date, check if today's report exists
  - Find missing dates in last 7 days
  - Format and return
- `trimmed` matches `YYYY-MM-DD`:
  - Read `join(dirs.dailyReportsDir, "${trimmed}.md")`
  - Not found → error: `${trimmed} 的报告不存在`
  - Found → return markdown content
- No args (empty):
  - Today's date, check report
  - Not found → check `.last-run-status` for error info, return "今天的报告尚未生成" + status
  - Found → return markdown content

- [ ] **Step 2: Update makeDirs in index.ts**

Add `dailyReportsDir` to makeDirs return, ensure directory exists:

```typescript
const dailyReportsDir = join(evolutionDir, "daily-reports");
if (!existsSync(dailyReportsDir)) {
  mkdirSync(dailyReportsDir, { recursive: true });
}
```

Return object gains: `dailyReportsDir`

- [ ] **Step 3: Add daily-trigger call to session_start**

In the `session_start` handler, after existing `checkAutoTriggerRules` + `cleanExpiredFlags`:

```typescript
checkAndRunDailyAnalysis(dirs).catch((err) => {
  console.error("[evolve] Daily analysis failed:", err instanceof Error ? err.message : String(err));
});
```

No await — fire-and-forget.

- [ ] **Step 4: Register /evolve-report command + tool**

Command:
```typescript
pi.registerCommand("evolve-report", {
  description: "View daily evolution reports. Usage: /evolve-report [YYYY-MM-DD] | --list",
  handler: async (args, _ctx) => {
    pi.sendUserMessage(
      `Please call the evolve-report tool with args="${args.trim()}". Do not add any commentary, just call the tool directly.`,
    );
  },
});
```

Tool schema:
```typescript
const EvolveReportParams = Type.Object({
  args: Type.String({ default: "", description: "Date (YYYY-MM-DD) or --list" }),
});
```

Tool execute:
```typescript
async execute(_toolCallId, params) {
  return handleEvolveReport(params.args, dirs);
}
```

Tool renderResult: display markdown content from result.content[0].

- [ ] **Step 5: Type check**

Run: `cd evolution-engine && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Lint check**

Run: `cd xyz-pi-extensions && npm run lint`
Expected: 0 error

- [ ] **Step 7: Commit**

```bash
git add evolution-engine/src/commands.ts evolution-engine/src/index.ts
git commit -m "feat(evolve): wire daily-trigger + /evolve-report command"
```

---

## Execution Groups

#### BG1: Foundation modules

**Description:** Independent module extensions and new report generator. No cross-dependencies within group.

**Tasks:** Task 1, Task 2, Task 3

**Files (预估):** 4 个文件（2 create + 2 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: high、tdd-coder: medium） |
| 注入上下文 | Task 1-3 描述 + spec FR-1/FR-2/FR-4/FR-5 + 编码规范（CLAUDE.md 禁止 any、函数 ≤ 80 行） |
| 读取文件 | `evolution-engine/src/types.ts`, `evolution-engine/src/state.ts`, `evolution-engine/src/gc.ts` |
| 修改/创建文件 | `types.ts`, `state.ts`, `report-generator.ts`, `gc.ts` |

**Execution Flow (BG1 内部):** 串行派遣。

  Task 1:
    1. general-purpose (read xyz-harness-test-driven-development) → 类型定义 + mergePending 实现
    2. general-purpose → tsc 验证

  Task 2 (independent of Task 1):
    1. general-purpose → report-generator 实现
    2. general-purpose → tsc 验证

  Task 3 (independent of Task 1, 2):
    1. general-purpose → gc.ts 扩展
    2. general-purpose → tsc 验证

**Dependencies:** 无

**设计细节:** L1 — 设计细节直接写在各 Task 步骤中。

---

#### BG2: Orchestration + integration

**Description:** daily-trigger (core orchestration) and final wiring in commands + index. Depends on BG1 outputs.

**Tasks:** Task 4, Task 5

**Files (预估):** 3 个文件（1 create + 2 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择 |
| 注入上下文 | Task 4-5 描述 + spec FR-1/FR-3 + 编码规范 + BG1 产出的接口签名 |
| 读取文件 | `evolution-engine/src/commands.ts`, `evolution-engine/src/index.ts`, `evolution-engine/src/summarizer.ts`, `evolution-engine/src/judge.ts` |
| 修改/创建文件 | `daily-trigger.ts`, `commands.ts`, `index.ts` |

**Execution Flow (BG2 内部):** 串行派遣。

  Task 4 (depends on BG1):
    1. general-purpose → daily-trigger 实现（含 lock + pipeline 复用）
    2. general-purpose → tsc 验证

  Task 5 (depends on Task 4 + BG1):
    1. general-purpose → commands + index 集成
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** BG1（需要 mergePending, generateDailyReport, Dirs.dailyReportsDir）

**设计细节:** L1 — 设计细节直接写在各 Task 步骤中。

---

## Dependency Graph & Wave Schedule

```
BG1 (foundation) ──→ BG2 (orchestration + integration)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | 独立基础模块，无外部依赖 |
| Wave 2 | BG2 | 依赖 BG1 的接口和数据类型 |
