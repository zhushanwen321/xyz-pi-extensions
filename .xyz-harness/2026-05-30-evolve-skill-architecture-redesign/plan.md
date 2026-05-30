---
verdict: pass
complexity: L1
---

# Evolve Skill Architecture Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 evolution-engine extension（~1500 行 TS）替换为 3 个 Skill + 1 个极简 hook extension（~40 行）。

**Architecture:** 删除重量级 extension 的 5 tool + 5 command + TUI 渲染。LLM 直接通过 Skill prompt 指令读数据、分析、修改文件。唯一保留的 TypeScript 代码是 `evolve-daily` hook，仅负责每天首次 session 启动时触发 Python analyzer。

**Tech Stack:** TypeScript（evolve-daily extension）、Markdown（3 个 SKILL.md）、Python analyzer（不修改）、Pi Extension API

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `evolve-daily/package.json` | create | BG1 | Extension 包配置 |
| `evolve-daily/index.ts` | create | BG1 | 入口 re-export |
| `evolve-daily/src/index.ts` | create | BG1 | session_start hook，~40 行 |
| `skills/evolve/SKILL.md` | create | BG2 | 分析使用数据生成建议的 Skill |
| `skills/evolve-apply/SKILL.md` | create | BG2 | 管理建议生命周期的 Skill |
| `skills/evolve-report/SKILL.md` | create | BG2 | 查看报告和统计的 Skill |
| `evolution-engine/` | delete | BG3 | 整个目录删除 |
| `~/.pi/agent/extensions/evolution-engine` | delete | BG3 | 旧 symlink 删除 |
| `~/.pi/agent/skills/evolve` | create (symlink) | BG3 | Skill 安装 |
| `~/.pi/agent/skills/evolve-apply` | create (symlink) | BG3 | Skill 安装 |
| `~/.pi/agent/skills/evolve-report` | create (symlink) | BG3 | Skill 安装 |
| `~/.pi/agent/extensions/evolve-daily` | create (symlink) | BG3 | Extension 安装 |

## Interface Contracts

### Module: evolve-daily (Extension)

#### Function: evolveDailyExtension

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| evolveDailyExtension | (pi: ExtensionAPI) -> void | void | — | FR-1.1 |

#### Data: DailyReportPath

| Field | Type | Description |
|-------|------|-------------|
| dateStr | string | YYYY-MM-DD 格式 |
| reportPath | string | `~/.pi/agent/evolution-data/daily-reports/{dateStr}.json` |
| analyzerPath | string | `~/.pi/agent/scripts/pi-session-analyzer/analyze.py` |

### Module: evolve (Skill)

无代码接口。数据契约：

#### Data: PendingFile

| Field | Type | Description |
|-------|------|-------------|
| generatedAt | string | ISO timestamp |
| reportUsed | string | 使用的数据源标识 |
| suggestions | EvolutionSuggestion[] | 建议数组 |

#### Data: EvolutionSuggestion

| Field | Type | Description |
|-------|------|-------------|
| id | string | UUID |
| target | "claude-md" \| "skill" | 建议目标类型 |
| targetPath | string | 目标文件绝对路径 |
| severity | "high" \| "medium" \| "low" | 严重度 |
| confidence | number | 0.0-1.0 |
| title | string | 一行标题 |
| description | string | 详细描述 |
| rationale | string | 数据支撑的推理 |
| instruction | string | LLM 修改指令 |
| status | "pending" \| "applied" \| "rejected" | 建议状态 |

### Module: evolve-apply (Skill)

无代码接口。数据契约：

#### Data: HistoryEntry

| Field | Type | Description |
|-------|------|-------------|
| timestamp | string | ISO timestamp |
| action | "apply" \| "rollback" | 操作类型 |
| suggestionId | string | 关联的 suggestion UUID |
| targetPath | string | 目标文件路径 |
| backupPath | string | 备份文件路径 |
| instruction | string | 修改指令 |
| title | string | 建议标题 |
| commitSha | string \| undefined | git commit SHA |

## Spec Coverage Matrix

| Spec AC | Interface Method / Data | Data Flow | Task |
|---------|------------------------|-----------|------|
| AC-1 每日自动收集 | evolveDailyExtension | session_start → existsSync → pi.exec(analyze.py) | Task 1 |
| AC-2 /evolve 分析 | PendingFile + EvolutionSuggestion | LLM 读 JSON → 分析 → 写 pending.json | Task 2 |
| AC-3 apply 操作 | HistoryEntry + cp backup | LLM 读 pending → edit file → cp backup → append history.jsonl | Task 3 |
| AC-3 apply 失败 | EvolutionSuggestion.status=pending | edit 报错时 pending.json 不变，history.jsonl 不追加 | Task 3 |
| AC-3 skip 操作 | EvolutionSuggestion.status | LLM 读 pending → 更新 status → 写回 pending.json | Task 3 |
| AC-3 rollback 操作 | HistoryEntry + cp restore | LLM 读 history → cp 恢复 → append history.jsonl | Task 3 |
| AC-4 /evolve-report | DailyReport JSON | LLM 读 daily-reports/*.json → 格式化展示 | Task 4 |
| AC-5 清理 | — | rm evolution-engine/ + 更新 symlink | Task 5 |

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 每日自动收集 | adopted | Task 1 |
| AC-2 /evolve 分析 | adopted | Task 2 |
| AC-3 /evolve-apply 操作 | adopted | Task 3 |
| AC-4 /evolve-report 展示 | adopted | Task 4 |
| AC-5 清理 | adopted | Task 5 |

---

## Tasks

### Task 1: Create evolve-daily hook extension

**Type:** backend

**Files:**
- Create: `evolve-daily/package.json`
- Create: `evolve-daily/index.ts`
- Create: `evolve-daily/src/index.ts`

**上下文参考：**
- 参考 `hooks/src/index.ts`（现有 hook extension 的结构模式）
- 参考 `usage-tracker/src/index.ts`（数据采集 extension 模式）
- Python analyzer 路径：`~/.pi/agent/scripts/pi-session-analyzer/analyze.py`
- 数据目录：`~/.pi/agent/evolution-data/daily-reports/`

- [ ] **Step 1: Create package.json**

文件 `evolve-daily/package.json`：

```json
{
  "name": "pi-extension-evolve-daily",
  "version": "0.1.0",
  "description": "Daily evolution data collector — runs Python analyzer on first session of the day.",
  "main": "src/index.ts"
}
```

- [ ] **Step 2: Create index.ts entry re-export**

文件 `evolve-daily/index.ts`：

```typescript
export { default } from "./src/index";
```

- [ ] **Step 3: Implement session_start hook**

文件 `evolve-daily/src/index.ts`：

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ANALYZER_PATH = join(
  homedir(),
  ".pi/agent/scripts/pi-session-analyzer/analyze.py"
);
// daily-reports/ 目录复用旧 extension 的目录路径。
// 旧 extension 写入 .md 文件，新 evolve-daily 写入 .json 文件，天然不冲突。
// 删除旧 extension 后残留的 .md 文件可忽略。
const REPORTS_DIR = join(homedir(), ".pi/agent/evolution-data/daily-reports");

export default function evolveDailyExtension(pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const reportPath = join(REPORTS_DIR, `${today}.json`);

    if (existsSync(reportPath)) return;

    try {
      await pi.exec("python3", [
        ANALYZER_PATH,
        "--since", "1d",
        "--format", "json",
        "--output", reportPath,
      ], { timeout: 30_000 });
    } catch (e) {
      console.error("[evolve-daily] analyzer failed:", e);
    }
  });
}
```

**设计说明：**
- `existsSync` 检查当天报告是否已存在，幂等
- `pi.exec` 执行 Python analyzer，fire-and-forget（不 await 外层 catch 以外的逻辑）
- 失败仅 `console.error`，不阻塞 session
- timeout 30 秒，analyzer 通常 < 10 秒

- [ ] **Step 4: Verify tsc passes**

Run: `cd /Users/zhushanwen/Code/xyz-pi-extensions-workspace/fix-evolve-problem && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add evolve-daily/
git commit -m "feat: add evolve-daily hook extension"
```

---

### Task 2: Create skills/evolve/SKILL.md

**Type:** backend (Markdown skill)

**Files:**
- Create: `skills/evolve/SKILL.md`

**上下文参考：**
- spec FR-2：分析使用数据并生成建议
- 数据源路径：`~/.pi/agent/evolution-data/` 下各子目录
- pending.json 格式：见 spec 数据模型（generatedAt, reportUsed, suggestions[]）
- EvolutionSuggestion 字段：id, target, targetPath, severity, confidence, title, description, rationale, instruction, status

- [ ] **Step 1: Create SKILL.md**

文件 `skills/evolve/SKILL.md`：

```markdown
---
name: evolve
description: >-
  Analyze session usage data and generate evolution suggestions. Runs Python
  analyzer data through LLM analysis to produce actionable improvement
  recommendations for CLAUDE.md and skills.
  Trigger: "/evolve", "evolve", "进化分析", "分析使用模式", "analyze usage".
---

# Evolve — Usage Analysis & Suggestion Generator

## Purpose

Analyze Pi agent usage data, identify trends and anomalies, and generate
evolution suggestions for CLAUDE.md and skill files.

## When Triggered

User says "/evolve", "evolve", "进化分析", "分析使用模式", or wants to
analyze usage patterns.

## Procedure

### 1. Parse User Intent

- No args → analyze last 7 days, all dimensions
- `since=Nd` → analyze last N days
- "分析 skill" / "分析 CLAUDE.md" → focus on specific dimension
- Natural language: extract time range and focus area

### 2. Read Data Sources

Read files from `~/.pi/agent/evolution-data/` as needed:

- `daily/*.json` — daily summaries (date, sessions, toolCalls, tokens)
- `daily-reports/*.json` — Python analyzer deep analysis
- `skill-triggers.json` — skill usage statistics
- `tool-stats.json` — tool call statistics
- `history.jsonl` — applied suggestion history (for effect review)
- `metrics-history.json` — metric trends

Filter by user's requested time range. If requesting "last N days",
read files with dates >= (today - N days).

**No data scenario:** If no data files exist for the requested range,
tell the user: "No usage data available for the requested period. Ensure
the evolve-daily extension is installed and has had time to collect data."
Do NOT proceed to generate suggestions.

### 3. Analyze

Use your judgment to identify:
- **Trends**: Increasing/decreasing patterns in tool usage, token consumption,
  error rates
- **Anomalies**: Spikes in errors, sudden drops in efficiency
- **Opportunities**: Skills never triggered, redundant patterns, optimization
  chances
- **Effect review**: Check history.jsonl for recently applied suggestions and
  evaluate their impact using before/after metrics

### 4. Generate Suggestions

For each actionable finding, create an EvolutionSuggestion object:

| Field | Value |
|-------|-------|
| id | Generate a UUID-like string (hex 8-4-4-4-12). Use bash `uuidgen` or python `uuid.uuid4()`, or construct manually |
| target | "claude-md" or "skill" |
| targetPath | Absolute path to target .md file under `~/.pi/agent/` |
| severity | "high" (breaks workflow), "medium" (significant improvement), "low" (nice-to-have) |
| confidence | 0.0-1.0 based on data strength |
| title | One-line summary |
| description | Detailed description of the issue and proposed change |
| rationale | Data-backed reasoning (cite specific numbers) |
| instruction | Step-by-step modification instruction for the LLM to apply |
| status | "pending" |

**Constraints:**
- targetPath MUST be under `~/.pi/agent/` and end with `.md`
- Limit to 3-7 suggestions per run (prioritize by severity * confidence)
- Each suggestion must be independently actionable

### 5. Write pending.json

Write to `~/.pi/agent/evolution-data/suggestions/pending.json`:

```json
{
  "generatedAt": "<current ISO timestamp>",
  "reportUsed": "daily-reports + history",
  "suggestions": [
    { ... }
  ]
}
```

Use the `write` tool. Overwrite the entire file (replace any existing
pending suggestions that have status "pending" — they will be re-evaluated).

### 6. Present Results

Show the user a summary:
- Number of suggestions generated
- Top 3 by severity
- How to apply: "/evolve-apply list" to view, "/evolve-apply apply N" to apply
```

- [ ] **Step 2: Commit**

```bash
git add skills/evolve/SKILL.md
git commit -m "feat: add evolve skill"
```

---

### Task 3: Create skills/evolve-apply/SKILL.md

**Type:** backend (Markdown skill)

**Files:**
- Create: `skills/evolve-apply/SKILL.md`

**上下文参考：**
- spec FR-3：管理建议生命周期（list/apply/skip/rollback）
- pending.json 路径：`~/.pi/agent/evolution-data/suggestions/pending.json`
- history.jsonl 路径：`~/.pi/agent/evolution-data/history.jsonl`
- backups 目录：`~/.pi/agent/evolution-data/backups/`

- [ ] **Step 1: Create SKILL.md**

文件 `skills/evolve-apply/SKILL.md`：

```markdown
---
name: evolve-apply
description: >-
  Manage evolution suggestion lifecycle: list, apply, skip, and rollback
  suggestions generated by /evolve.
  Trigger: "/evolve-apply", "evolve-apply", "应用建议", "/evolve-rollback",
  "evolve rollback".
---

# Evolve-Apply — Suggestion Lifecycle Manager

## Purpose

View, apply, skip, or rollback evolution suggestions from pending.json.

## When Triggered

User says "/evolve-apply", "evolve-apply", "应用建议", "/evolve-rollback",
"evolve rollback", or wants to manage evolution suggestions.

## Data Paths

- Pending: `~/.pi/agent/evolution-data/suggestions/pending.json`
- History: `~/.pi/agent/evolution-data/history.jsonl`
- Backups: `~/.pi/agent/evolution-data/backups/`

## Procedure

### Parse Command

- No args or "list" → LIST mode
- "apply N" → APPLY mode (0-indexed)
- "skip N" → SKIP mode (0-indexed)
- "rollback" → ROLLBACK mode

---

### LIST Mode

1. Read `pending.json` using the `read` tool
2. If file doesn't exist or suggestions array is empty:
   "No pending suggestions. Run /evolve first to generate suggestions."
3. Display each suggestion:
   ```
   [#0] [HIGH] Clean up dormant skills (confidence: 0.85)
     Target: ~/.pi/agent/CLAUDE.md
     Status: pending
     Summary: <first 2 lines of description>
   ```

---

### APPLY Mode

1. Read `pending.json`, validate index N exists and status is "pending"
2. Get suggestion at index N
3. **Backup**: Use `bash` tool to run:
   ```bash
   mkdir -p ~/.pi/agent/evolution-data/backups
   cp "<targetPath>" "~/.pi/agent/evolution-data/backups/<timestamp>-<filename>"
   ```
   Use ISO timestamp with colons replaced by dashes for the directory name.
   If cp fails → ABORT, tell user "Backup failed, cannot apply. Reason: ..."
4. **Modify file**: Use `edit` or `write` tool to apply the suggestion's
   `instruction` to `targetPath`. Follow the instruction precisely.
   If edit fails → ABORT, tell user reason, keep status as "pending"
5. **Git commit**: Use `bash` tool:
   ```bash
   cd "$(dirname '<targetPath>')" && git add '<filename>' && git commit -m "evolve: <title>"
   ```
   If commit fails → CONTINUE (commitSha will be empty)
6. **Update pending.json**: Change suggestion status to "applied". Use `write`
   tool to overwrite the entire file.
7. **Append to history.jsonl**: Use `bash` tool to append one JSON line:
   ```bash
   cat >> ~/.pi/agent/evolution-data/history.jsonl << 'EOF'
   {"timestamp":"<ISO>","action":"apply","suggestionId":"<id>","targetPath":"<path>","backupPath":"<backup>","instruction":"<escaped>","title":"<title>","commitSha":"<sha or omit>"}
   EOF
   ```
8. Confirm to user: "Applied suggestion #N: <title>. Backup at <backupPath>."

---

### SKIP Mode

1. Read `pending.json`, validate index N exists and status is "pending"
2. Update suggestion status to "rejected"
3. Write back `pending.json` using `write` tool
4. Confirm: "Skipped suggestion #N: <title>."

---

### ROLLBACK Mode

1. Read `history.jsonl` (last line = most recent action)
2. Find the most recent "apply" action that hasn't been rolled back
3. Check if `backupPath` file exists
4. **If backup exists**: Use `bash` tool:
   ```bash
   cp "<backupPath>" "<targetPath>"
   cd "$(dirname '<targetPath>')" && git add '<filename>' && git commit -m "evolve: rollback <title>"
   ```
5. **If backup missing**: Tell user "Cannot auto-restore: backup file not found
   at <backupPath>. You may need to manually check git history."
6. **Append rollback to history.jsonl**:
   ```bash
   cat >> ~/.pi/agent/evolution-data/history.jsonl << 'EOF'
   {"timestamp":"<ISO>","action":"rollback","suggestionId":"<id>","targetPath":"<path>","backupPath":"<backup>","instruction":"","title":"<title>","commitSha":"<sha or omit>"}
   EOF
   ```
7. Confirm: "Rolled back: <title>. File restored from backup."
```

- [ ] **Step 2: Commit**

```bash
git add skills/evolve-apply/SKILL.md
git commit -m "feat: add evolve-apply skill"
```

---

### Task 4: Create skills/evolve-report/SKILL.md

**Type:** backend (Markdown skill)

**Files:**
- Create: `skills/evolve-report/SKILL.md`

**上下文参考：**
- spec FR-4：查看报告和统计
- daily-reports 路径：`~/.pi/agent/evolution-data/daily-reports/`
- daily 汇总路径：`~/.pi/agent/evolution-data/daily/`

- [ ] **Step 1: Create SKILL.md**

文件 `skills/evolve-report/SKILL.md`：

```markdown
---
name: evolve-report
description: >-
  View evolution daily reports and usage statistics. Shows session data,
  tool usage, token consumption, and trend analysis.
  Trigger: "/evolve-report", "evolve-report", "查看报告", "进化报告",
  "/evolve-stats", "evolve-stats".
---

# Evolve-Report — Report & Statistics Viewer

## Purpose

Display daily analysis reports and usage statistics from collected data.

## When Triggered

User says "/evolve-report", "evolve-report", "查看报告", "进化报告",
"/evolve-stats", "evolve-stats", or wants to view evolution data.

## Data Paths

- Daily reports: `~/.pi/agent/evolution-data/daily-reports/*.json`
- Daily summaries: `~/.pi/agent/evolution-data/daily/*.json`
- Metrics history: `~/.pi/agent/evolution-data/metrics-history.json`

## Procedure

### Parse Command

- No args → show today's report
- Date string (YYYY-MM-DD) → show that date's report
- `--list` → list all available reports
- `--stats` or "/evolve-stats" → show usage statistics overview

### Show Report

1. Use `bash` tool to check available reports:
   ```bash
   ls ~/.pi/agent/evolution-data/daily-reports/*.json
   ```
2. Read the requested report using `read` tool
3. Present key information in a structured format:
   - Session count and duration
   - Tool call statistics (most used, error rates)
   - Token consumption (input/output)
   - Anomalies and signals
   - Improvement suggestions (if any in the report)

### List Reports

```bash
ls -1 ~/.pi/agent/evolution-data/daily-reports/*.json | xargs -I{} basename {} .json
```
Present as a numbered list of available dates.

### Show Statistics

1. Read multiple `daily/*.json` files for the requested period
2. Aggregate and present:
   - Total sessions, tool calls, tokens
   - Per-tool usage breakdown
   - Day-over-day trends
   - Top skills triggered
   - Error patterns

Use tables and summaries for readability. Highlight significant changes.
```

- [ ] **Step 2: Commit**

```bash
git add skills/evolve-report/SKILL.md
git commit -m "feat: add evolve-report skill"
```

---

### Task 5: Delete old evolution-engine + install new skills and extension

**Type:** backend (cleanup)

**Files:**
- Delete: `evolution-engine/` (entire directory)
- Delete: `~/.pi/agent/extensions/evolution-engine` (symlink)
- Create: `~/.pi/agent/skills/evolve` (symlink)
- Create: `~/.pi/agent/skills/evolve-apply` (symlink)
- Create: `~/.pi/agent/skills/evolve-report` (symlink)
- Create: `~/.pi/agent/extensions/evolve-daily` (symlink)

**上下文参考：**
- 项目 workspace 根目录：`/Users/zhushanwen/Code/xyz-pi-extensions-workspace/fix-evolve-problem/`
- Skills 安装目标：`~/.pi/agent/skills/`
- Extensions 安装目标：`~/.pi/agent/extensions/`

- [ ] **Step 1: Delete old evolution-engine directory**

```bash
rm -rf evolution-engine/
```

- [ ] **Step 2: Delete old symlink**

```bash
rm -f ~/.pi/agent/extensions/evolution-engine
```

- [ ] **Step 3: Create skill symlinks**

```bash
PROJECT_ROOT=/Users/zhushanwen/Code/xyz-pi-extensions-workspace/fix-evolve-problem
ln -sf "$PROJECT_ROOT/skills/evolve" ~/.pi/agent/skills/evolve
ln -sf "$PROJECT_ROOT/skills/evolve-apply" ~/.pi/agent/skills/evolve-apply
ln -sf "$PROJECT_ROOT/skills/evolve-report" ~/.pi/agent/skills/evolve-report
```

- [ ] **Step 4: Create extension symlink**

```bash
PROJECT_ROOT=/Users/zhushanwen/Code/xyz-pi-extensions-workspace/fix-evolve-problem
ln -sf "$PROJECT_ROOT/evolve-daily" ~/.pi/agent/extensions/evolve-daily
```

- [ ] **Step 5: Verify**

```bash
# Verify old extension is gone
ls ~/.pi/agent/extensions/evolution-engine 2>/dev/null && echo "FAIL: old symlink still exists" || echo "OK: old symlink removed"
# Verify new symlinks exist
ls -la ~/.pi/agent/skills/evolve
ls -la ~/.pi/agent/skills/evolve-apply
ls -la ~/.pi/agent/skills/evolve-report
ls -la ~/.pi/agent/extensions/evolve-daily
# Verify tsc passes
cd /Users/zhushanwen/Code/xyz-pi-extensions-workspace/fix-evolve-problem && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove evolution-engine, install evolve skills and daily extension"
```

---

## Execution Groups

#### BG1: evolve-daily extension

**Description:** 唯一的 TypeScript 编码任务。创建极简 session_start hook extension。

**Tasks:** Task 1

**Files (预估):** 3 个文件（3 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | taskComplexity: medium |
| 注入上下文 | Task 1 描述 + spec FR-1 + 参考文件（hooks/src/index.ts） |
| 读取文件 | `hooks/src/index.ts`, `hooks/package.json` |
| 修改/创建文件 | `evolve-daily/package.json`, `evolve-daily/index.ts`, `evolve-daily/src/index.ts` |

**Dependencies:** 无

**设计细节:** 见 Task 1。~40 行代码，单一职责。

#### BG2: Skill 文件

**Description:** 3 个 SKILL.md 文件，纯 Markdown prompt 设计。功能关联度高（evolve 生成建议、evolve-apply 消费建议、evolve-report 展示数据），共享 pending.json 数据模型。

**Tasks:** Task 2, Task 3, Task 4

**Files (预估):** 3 个文件（3 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | taskComplexity: medium |
| 注入上下文 | Task 2-4 描述 + spec FR-2/3/4 + pending.json 格式 + history.jsonl 格式 |
| 读取文件 | 无需读取已有代码文件（纯新建） |
| 修改/创建文件 | `skills/evolve/SKILL.md`, `skills/evolve-apply/SKILL.md`, `skills/evolve-report/SKILL.md` |

**Dependencies:** 无

**设计细节:** 见 Task 2-4。每个 SKILL.md 包含触发条件、数据路径、操作步骤、失败处理。

#### BG3: 清理和安装

**Description:** 删除旧 extension + 安装新 skill/extension symlinks。依赖 BG1 和 BG2 完成。

**Tasks:** Task 5

**Files (预估):** 1 delete + 4 create (symlink)

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | taskComplexity: low |
| 注入上下文 | Task 5 描述 + spec FR-5/6 + symlink 规范 |
| 读取文件 | 无需读取 |
| 修改/创建文件 | 删除 `evolution-engine/`，创建 4 个 symlink |

**Dependencies:** BG1 + BG2 完成

**设计细节:** 见 Task 5。纯文件系统操作，无代码逻辑。

## Dependency Graph & Wave Schedule

```
BG1 (extension) ──┬──→ BG3 (cleanup + install)
BG2 (skills) ────┘
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1, BG2 | 可并行，无依赖 |
| Wave 2 | BG3 | 依赖 BG1 + BG2 完成 |
