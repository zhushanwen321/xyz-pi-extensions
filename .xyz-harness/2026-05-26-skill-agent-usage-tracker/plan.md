---
verdict: pass
complexity: L1
---

# Skill & Agent Usage Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a passive data collection extension that tracks skill full-text loads and agent invocations across Pi sessions, plus an analysis skill for usage pattern insights.

**Architecture:** Extension listens to Pi events (`before_agent_start` for skill mapping, `tool_call` for counting) and persists counters to a shared JSON file. Skill reads the JSON and provides an LLM-driven analysis framework. Zero UI, zero tool registration.

**Tech Stack:** TypeScript, Pi Extension API (`@mariozechner/pi-coding-agent`), Node.js `fs` + `os` + `path` module, typebox (for subagent tool param parsing, optional).

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `usage-tracker/package.json` | create | BG1 | Extension metadata |
| `usage-tracker/index.ts` | create | BG1 | Re-export entry |
| `usage-tracker/src/index.ts` | create | BG1 | Extension factory — event listeners, counting, persistence |
| `usage-analyzer/SKILL.md` | create | BG2 | Analysis skill — data reading guide + analysis framework |

---

## Interface Contracts

### Module: usage-tracker/src/index.ts

#### Functions (exported as default factory)

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| default factory | `(pi: ExtensionAPI) => void` | void | — | FR-3, FR-4 |
| onBeforeAgentStart | `(event: BeforeAgentStartEvent) => void` | void | `skills` array empty/undefined → skip rebuild | FR-3 |
| onToolCall | `(event: ToolCallEvent) => void` | void | skillMap empty → skip + console.error; subagent args malformed → skip | FR-1, FR-2 |
| incrementAndPersist | `(category: "skills" \| "agents", name: string) => void` | void | File read/write fails → console.error + return | FR-4 |

#### Data: UsageStats

| Field | Type | Description |
|-------|------|-------------|
| skills | `Record<string, number>` | skill name → cumulative load count |
| agents | `Record<string, number>` | agent name → cumulative invocation count |
| updatedAt | `string` | ISO 8601 timestamp of last write |

#### Data: SkillMap (internal)

| Field | Type | Description |
|-------|------|-------------|
| Map key | `string` | resolved file path (absolute) |
| Map value | `string` | skill name |

---

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1 | onToolCall (read) → incrementAndPersist | tool_call(read) → resolve path → match skillMap → incrementAndPersist → file write | Task 1 |
| AC-2 | onToolCall (subagent) → incrementAndPersist | tool_call(subagent) → parse agent/tasks/chain → incrementAndPersist per agent → file write | Task 1 |
| AC-3 | incrementAndPersist (read-before-write) | incrementAndPersist → read file → merge counts → write file | Task 1 |
| AC-4 | incrementAndPersist (catch) | incrementAndPersist → try/catch → console.error on failure | Task 1 |
| AC-5 | usage-analyzer SKILL.md content | agent reads SKILL.md → reads JSON file → applies analysis framework | Task 2 |
| AC-6 | Extension factory (no registerTool/registerCommand) | factory only calls pi.on() | Task 1 |

---

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 skill 全文加载计数 | adopted | Task 1 |
| AC-2 agent 调用计数 | adopted | Task 1 |
| AC-3 跨 session 累积 | adopted | Task 1 |
| AC-4 写入失败不阻塞 | adopted | Task 1 |
| AC-5 usage-analyzer skill | adopted | Task 2 |
| AC-6 纯被动采集 | adopted | Task 1 |

---

## Task List

| # | Task | Type | Depends on | Group |
|---|------|------|-----------|-------|
| 1 | Extension: event listeners + counting + persistence | backend | — | BG1 |
| 2 | Skill: usage-analyzer SKILL.md | backend | 1 | BG2 |
| 3 | Symlink installation + manual verification | backend | 1, 2 | BG3 |

---

### Task 1: Extension — Event Listeners + Counting + Persistence

**Type:** backend

**Files:**
- Create: `usage-tracker/package.json`
- Create: `usage-tracker/index.ts`
- Create: `usage-tracker/src/index.ts`

- [ ] **Step 1: Create package.json**

Create `usage-tracker/package.json`:
```json
{
  "name": "pi-extension-usage-tracker",
  "version": "0.1.0",
  "description": "Passive skill & agent usage counter for Pi — tracks full-text skill loads and agent invocations across sessions.",
  "main": "src/index.ts",
  "keywords": ["pi", "extension", "usage", "tracker", "analytics"],
  "license": "MIT"
}
```

- [ ] **Step 2: Create index.ts re-export**

Create `usage-tracker/index.ts`:
```ts
export { default } from "./src/index.ts";
```

- [ ] **Step 3: Implement extension factory in src/index.ts**

Create `usage-tracker/src/index.ts` with the following structure:

```
imports:
  - path (resolve)
  - os (homedir)
  - fs (readFileSync, writeFileSync, existsSync)
  - ExtensionAPI from @mariozechner/pi-coding-agent

constants:
  - STATS_FILE = path.join(os.homedir(), ".pi", "agent", "usage-stats.json")

factory function export default(pi: ExtensionAPI):
  closure state:
    - skillMap: Map<string, string>  // resolved filePath → skillName
    - initialized: boolean = false

  pi.on("before_agent_start", handler):
    - Extract event.systemPromptOptions.skills (Skill[])
    - If skills exists and is array:
      - Clear skillMap
      - For each skill: skillMap.set(path.resolve(skill.filePath), skill.name)
      - Set initialized = true
      - console.error(`[usage-tracker] Skill map built: ${skillMap.size} entries`)

  pi.on("tool_call", handler):
    - If !initialized:
      - console.error("[usage-tracker] tool_call received before skill map initialized, skipping")
      - return
    - If event.toolName === "read":
      - If skillMap.size === 0:
        - console.error("[usage-tracker] skillMap is empty (no skills loaded), skipping skill matching")
        - return
      - const readPath = path.resolve(event.input.path)
      - If skillMap.has(readPath):
        - const skillName = skillMap.get(readPath)!
        - incrementAndPersist("skills", skillName)
        - console.error(`[usage-tracker] Skill loaded: ${skillName} (${readPath})`)
    - If event.toolName === "subagent":
      - Extract agent names from event.input:
        - input.agent (single mode) → push to names array
        - input.tasks?.forEach(t => t.agent) (parallel mode) → push each
        - input.chain?.forEach(c => c.agent) (chain mode) → push each
      - For each unique name: incrementAndPersist("agents", name)
      - console.error(`[usage-tracker] Agent(s) called: ${names.join(", ")}`)

helper function incrementAndPersist(category, name):
  try:
    - Read current file: fs.readFileSync(STATS_FILE, "utf-8")
    - If file doesn't exist: start with { skills: {}, agents: {}, updatedAt: "" }
    - Parse JSON, handle parse errors with default empty object
    - If !stats[category]: stats[category] = {}
    - stats[category][name] = (stats[category][name] || 0) + 1
    - stats.updatedAt = new Date().toISOString()
    - fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), "utf-8")
  catch (err):
    - console.error(`[usage-tracker] Failed to write stats: ${err}`, STATS_FILE)
```

Key implementation notes:
- `path.resolve()` on both the skill's `filePath` (from `before_agent_start`) and the `read` tool's `input.path` (from `tool_call`) to normalize before matching
- The `subagent` tool input has type `Record<string, unknown>` since it's a `CustomToolCallEvent`. Parse defensively with optional chaining
- `incrementAndPersist` does a full read-modify-write cycle each time (reads latest from disk, merges, writes back) to prevent stale overwrites across sessions
- No `registerTool`, `registerCommand`, or `registerWidget` calls — AC-6

- [ ] **Step 4: Type-check**

Run: `cd usage-tracker && npx tsc --noEmit`
Expected: PASS (no type errors)

- [ ] **Step 5: Lint check**

Run: `cd /path/to/xyz-pi-extensions && npm run lint`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add usage-tracker/
git commit -m "feat: add usage-tracker extension for skill/agent counting"
```

---

### Task 2: Skill — usage-analyzer SKILL.md

**Type:** backend

**Files:**
- Create: `usage-analyzer/SKILL.md`

- [ ] **Step 1: Create SKILL.md**

Create `usage-analyzer/SKILL.md` with the following structure:

```markdown
---
name: usage-analyzer
description: >-
  分析 skill 和 agent 的使用统计数据。当用户想了解哪些 skill/agent
  高频使用、哪些可以清理、是否需要整合或新增时使用此 skill。
  触发词："使用统计"、"usage stats"、"skill 分析"、"哪些 skill 没用过"。
---

# Usage Analyzer

## 数据来源

使用统计数据存储在 `~/.pi/agent/usage-stats.json`。读取此文件获取数据：

```bash
cat ~/.pi/agent/usage-stats.json
```

JSON 结构：
- `skills`: { [skillName: string]: number } — skill 全文加载次数
- `agents`: { [agentName: string]: number } — agent 调用次数
- `updatedAt`: string — 最后更新时间（ISO 8601）

## 分析维度

按以下 4 个维度分析数据：

### 1. 使用频率排序

分别对 skills 和 agents 按调用次数降序排列。输出：
- 高频（top 5）：这些是核心 skill/agent，保持现状
- 低频（≤ 2 次且非零）：低价值或使用场景狭窄，评估是否值得保留
- 零使用：对比 system prompt 中的 available_skills 列表，找出从未被加载过的 skill

### 2. 零使用检测

对比 usage-stats.json 中的 skills 字段和当前 available_skills 列表（可以通过读取 system prompt 中的 skill 列表获取，或用 `ls ~/.pi/agent/skills/` 列出全局 skills、用 `ls .pi/skills/` 或 `.claude/skills/` 列出项目级 skills）。

从未出现在 usage-stats.json 中的 skill 就是零使用候选。

### 3. 关联分析

[未来扩展] 分析哪些 skill/agent 经常在同一个 session 中被一起使用。当前数据结构只记录总计数，不支持此分析。

### 4. 时间趋势

[当前限制] 当前只记录累计总计数，不记录时间戳序列。无法分析趋势。如需趋势分析，需在 extension 中增加按日/周维度的计数。

## 决策建议模板

对每个分析结果，按以下分类给出建议：

| 分类 | 条件 | 建议动作 |
|------|------|---------|
| 删除候选 | 零使用，且存在超过 30 天 | 考虑删除，释放 context 空间 |
| 整合候选 | 多个低频 skill 功能重叠 | 合并为一个更通用的 skill |
| 保留 | 高频使用 | 保持现状，可考虑优化质量 |
| 新增候选 | 用户反复用其他方式解决的问题（需用户输入） | 考虑新增专用 skill |

## 输出格式

分析完成后，输出结构化报告：

1. **Skill 使用排行**（表格：名称 | 调用次数 | 建议）
2. **Agent 使用排行**（表格：名称 | 调用次数 | 建议）
3. **零使用 Skill 列表**
4. **综合建议**（删除 / 整合 / 保留 / 新增，各列出具体 skill/agent 名称）
```

- [ ] **Step 2: Commit**

```bash
git add usage-analyzer/
git commit -m "feat: add usage-analyzer skill for usage data analysis"
```

---

### Task 3: Symlink Installation + Manual Verification

**Type:** backend

**Files:**
- Symlink: `~/.pi/agent/extensions/usage-tracker` → `usage-tracker/`
- Symlink: `~/.pi/agent/skills/usage-analyzer` → `usage-analyzer/`

- [ ] **Step 1: Install extension symlink**

```bash
ln -sf /path/to/xyz-pi-extensions/usage-tracker ~/.pi/agent/extensions/usage-tracker
```

- [ ] **Step 2: Install skill symlink**

```bash
ln -sf /path/to/xyz-pi-extensions/usage-analyzer ~/.pi/agent/skills/usage-analyzer
```

- [ ] **Step 3: Manual verification**

1. Start a new Pi session
2. Ask Pi to read any skill file (e.g., "read the skill file for usage-analyzer")
3. Check `~/.pi/agent/usage-stats.json` — should show the skill count incremented
4. Call a subagent (e.g., via any task delegation)
5. Check `~/.pi/agent/usage-stats.json` — should show the agent count incremented
6. Load the usage-analyzer skill ("analyze my skill usage") and verify it reads the JSON and produces a report

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: install usage-tracker extension and usage-analyzer skill"
```

---

## Execution Groups

#### BG1: Extension Core

**Description:** Extension factory with event listeners, skill path mapping, counting logic, and file persistence. Single cohesive unit.

**Tasks:** Task 1

**Files (预估):** 3 个文件（3 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | 按 taskComplexity 自动选择（medium） |
| 注入上下文 | Task 1 描述 + spec FR-1~FR-5 + Pi Extension API 类型定义（BeforeAgentStartEvent, ToolCallEvent, Skill） |
| 读取文件 | todo/src/index.ts（参考扩展模式）、Pi 类型文件 |
| 修改/创建文件 | usage-tracker/package.json, usage-tracker/index.ts, usage-tracker/src/index.ts |

**Dependencies:** 无

**设计细节:** 见 Task 1

#### BG2: Analysis Skill

**Description:** Markdown skill file providing analysis framework for LLM-driven usage insights.

**Tasks:** Task 2

**Files (预估):** 1 个文件（1 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | 按 taskComplexity 自动选择（low） |
| 注入上下文 | Task 2 描述 + spec FR-6 |
| 读取文件 | 无（纯新文件创建） |
| 修改/创建文件 | usage-analyzer/SKILL.md |

**Dependencies:** 无（与 BG1 可并行，但逻辑上 BG1 先产出数据才有意义。此处无代码依赖，skill 内容不引用 extension 代码）

**设计细节:** 见 Task 2

#### BG3: Installation & Verification

**Description:** Symlink creation and manual smoke test.

**Tasks:** Task 3

**Files (预估):** 0 个新文件（2 symlink）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | 按 taskComplexity 自动选择（low） |
| 注入上下文 | Task 3 描述 + 安装路径 |
| 读取文件 | usage-stats.json（验证） |
| 修改/创建文件 | 2 个 symlink |

**Dependencies:** BG1, BG2（需要 extension 和 skill 都存在）

**设计细节:** 见 Task 3

---

## Dependency Graph & Wave Schedule

```
BG1 (extension) ──┬──→ BG3 (install + verify)
BG2 (skill) ──────┘
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1, BG2 | Extension 和 Skill 可并行开发，无依赖 |
| Wave 2 | BG3 | 安装和验证需要两者完成 |
