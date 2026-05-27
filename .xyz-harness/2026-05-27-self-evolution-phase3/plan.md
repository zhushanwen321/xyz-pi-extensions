---
verdict: pass
complexity: L1
---

# Evolution Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建完整的 evolution-engine Pi Extension，实现信号分析 → LLM Judge 审批 → Applier 应用的自我进化闭环。

**Architecture:** Pi Extension 作为编排层，注册 4 个 command + session_start 事件监听。LLM 推理通过 spawn 独立 Pi 子进程实现。所有组件通过 `~/.pi/agent/evolution-data/` 文件系统通信。

**Tech Stack:** TypeScript, Pi Extension API (@mariozechner/pi-coding-agent), typebox, pi-tui, child_process.spawn

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `evolution-engine/package.json` | create | BG1 | Extension 包定义 |
| `evolution-engine/index.ts` | create | BG1 | 入口 re-export |
| `evolution-engine/src/index.ts` | create | BG3 | 工厂函数，注册 command + event |
| `evolution-engine/src/types.ts` | create | BG1 | 所有接口和类型定义 |
| `evolution-engine/src/state.ts` | create | BG1 | pending.json + history.jsonl 管理 |
| `evolution-engine/src/templates/session-quality.txt` | create | BG1 | LLM Judge session 质量分析 prompt |
| `evolution-engine/src/templates/skill-health.txt` | create | BG1 | LLM Judge skill 健康度评估 prompt |
| `evolution-engine/src/templates/prompt-optimize.txt` | create | BG1 | LLM Judge CLAUDE.md 质量评估 prompt |
| `evolution-engine/src/judge.ts` | create | BG2 | LLM Judge 子进程编排 |
| `evolution-engine/src/applier.ts` | create | BG2 | 建议应用引擎（backup + diff + git） |
| `evolution-engine/src/monitor.ts` | create | BG2 | 自动触发规则检查 |
| `evolution-engine/src/widget.ts` | create | BG3 | TUI 渲染 |
| `evolution-engine/src/commands.ts` | create | BG3 | 4 个 command 的处理逻辑 |

## Interface Contracts

### Module: types

#### Data: EvolutionSuggestion

| Field | Type | Description |
|-------|------|-------------|
| id | string | UUID |
| target | "claude-md" \| "skill" | 建议目标类型 |
| targetPath | string | 要修改的文件绝对路径 |
| severity | "high" \| "medium" \| "low" | 严重程度 |
| confidence | number | 0-1 置信度 |
| title | string | 建议标题 |
| description | string | 建议内容描述 |
| rationale | string | 数据支撑说明 |
| diff | string | unified diff |
| status | "pending" \| "approved" \| "rejected" \| "applied" \| "failed" | 当前状态 |

#### Data: PendingFile

| Field | Type | Description |
|-------|------|-------------|
| generatedAt | string | ISO timestamp |
| reportUsed | string | 使用的报告路径 |
| suggestions | EvolutionSuggestion[] | 建议列表 |

#### Data: HistoryEntry

| Field | Type | Description |
|-------|------|-------------|
| timestamp | string | ISO timestamp |
| action | "apply" \| "rollback" | 操作类型 |
| suggestionId | string | 对应 suggestion ID |
| targetPath | string | 目标文件路径 |
| backupPath | string | 备份文件路径 |
| diff | string | 应用的 diff |
| title | string | 建议标题（用于回滚展示） |

#### Data: AutoTriggerFlag

| Field | Type | Description |
|-------|------|-------------|
| rule | "token-decline" \| "skill-dormant" \| "error-spike" | 触发规则 |
| triggeredAt | string | ISO timestamp |
| detail | string | 具体数值描述 |

#### Data: JudgeInput

| Field | Type | Description |
|-------|------|-------------|
| target | "all" \| "claude-md" \| "skills" | 分析目标 |
| reportPath | string | Phase 2 JSON 报告路径 |
| promptFilePath | string | 构建的 prompt 临时文件路径 |

#### Data: EvolveCommandParams

| Field | Type | Description |
|-------|------|-------------|
| target | "all" \| "claude-md" \| "skills" | 分析目标，默认 "all" |
| since | string | 时间范围，默认 "7d" |
| sample | number \| undefined | 抽样 session 数，透传给 analyze.py |

### Module: state

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| loadPending | (dir: string) | PendingFile \| null | 文件不存在返回 null；JSON 损坏返回 null 并覆盖写空 | AC-6 |
| savePending | (dir: string, pending: PendingFile) | void | 目录不存在时递归创建 | AC-6 |
| appendHistory | (dir: string, entry: HistoryEntry) | void | 文件不存在时创建 | AC-7 |
| loadHistory | (dir: string, limit?: number) | HistoryEntry[] | 默认返回最近 10 条；文件不存在返回空数组 | AC-7 |

### Module: judge

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| runJudge | (input: JudgeInput, templateDir: string) | Promise\<EvolutionSuggestion[]\> | 超时 120s 抛 Error；非 JSON 输出抛 Error（含 raw output 路径） | AC-2 |
| buildJudgeInput | (report: Record\<string, unknown\>, target: string, tmpDir: string) | JudgeInput | 报告字段缺失时按 target 裁剪可用的子集 | AC-3 |
| parseJudgeOutput | (raw: string) | EvolutionSuggestion[] | 非 JSON 抛 Error；JSON 中缺必需字段抛 Error | AC-2 |

### Module: applier

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| applySuggestion | (suggestion: EvolutionSuggestion, backupDir: string) | Promise\<{success: boolean, reason?: string}\> | targetPath 不在白名单内拒绝；diff 冲突时 success=false；backup 失败拒绝 apply | AC-4 |
| rollbackSuggestion | (entry: HistoryEntry) | Promise\<{success: boolean, reason?: string}\> | backup 文件不存在时 success=false | AC-7 |
| backupFile | (filePath: string, backupDir: string) | string (backup path) | 目录不存在时创建 | AC-1 |
| applyUnifiedDiff | (filePath: string, diff: string) | {success: boolean, reason?: string} | 文件已变更导致 patch 不匹配时返回 false | AC-4 |

### Module: monitor

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| checkAutoTriggerRules | (evolutionDir: string) | AutoTriggerFlag[] | 无历史数据时跳过（除零保护），返回空数组 | AC-5 |
| cleanExpiredFlags | (evolutionDir: string) | void | flag 目录不存在时不报错 | AC-5 |

#### Data: Dirs

| Field | Type | Description |
|-------|------|-------------|
| evolutionDir | string | `~/.pi/agent/evolution-data` |
| reportsDir | string | `~/.pi/agent/evolution-data/reports` |
| tmpDir | string | `~/.pi/agent/evolution-data/tmp` |
| templateDir | string | extension 源码下 `src/templates/` 的绝对路径 |

### Module: commands

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| handleEvolve | (params: EvolveCommandParams, dirs: Dirs) | Promise\<CommandResult\> | analyze.py 失败时返回错误信息 | AC-1, AC-3 |
| handleEvolveApply | (dirs: Dirs) | Promise\<CommandResult\> | pending.json 不存在或为空时提示先运行 /evolve | AC-6 |
| handleEvolveStats | (evolutionDir: string) | Promise\<CommandResult\> | 无数据时显示空状态 | FR-5 |
| handleEvolveRollback | (dirs: Dirs) | Promise\<CommandResult\> | history 为空时提示无操作 | AC-7 |

### Module: widget

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| renderSuggestionCard | (suggestion: EvolutionSuggestion, index: number, total: number) | Text | — | AC-6 |
| renderStatsDashboard | (stats: StatsData) | Text | 空数据时显示 "No data" | FR-5 |
| renderRollbackList | (history: HistoryEntry[]) | Text | 空列表时显示 "No evolution history" | AC-7 |
| renderAutoTriggerHint | (flags: AutoTriggerFlag[]) | string | 空数组返回空字符串 | AC-5 |

## Spec Coverage Matrix

| Spec AC | Interface Method | Task |
|---------|-----------------|------|
| AC-1 (full flow) | commands.handleEvolve + judge.runJudge + applier.applySuggestion | Task 3, 4, 6 |
| AC-2 (Judge output valid) | judge.parseJudgeOutput | Task 3 |
| AC-3 (auto analyze) | commands.handleEvolve (analyze.py fallback) | Task 6 |
| AC-4 (diff fail tolerant) | applier.applySuggestion + applier.applyUnifiedDiff | Task 4 |
| AC-5 (auto trigger) | monitor.checkAutoTriggerRules | Task 5 |
| AC-6 (TUI exit/resume) | widget.renderSuggestionCard + state.loadPending/savePending | Task 2, 6 |
| AC-7 (rollback) | applier.rollbackSuggestion + state.loadHistory | Task 2, 4 |

No [GAP] entries.

## Spec Metrics Traceability

| Spec AC | 采纳状态 | 对应 Task |
|---------|---------|----------|
| AC-1: /evolve 全流程 | adopted | Task 1, 2, 3, 4, 6 |
| AC-2: Judge 输出有效 | adopted | Task 3 |
| AC-3: 自动分析降级 | adopted | Task 6 |
| AC-4: diff 应用失败不中断 | adopted | Task 4 |
| AC-5: 自动触发规则 | adopted | Task 5 |
| AC-6: TUI 中途退出/续批 | adopted | Task 2, 6 |
| AC-7: Rollback 恢复 | adopted | Task 2, 4 |

---

## Task List

### Task 1: Project Skeleton + Types

**Type:** backend

**Files:**
- Create: `evolution-engine/package.json`
- Create: `evolution-engine/index.ts`
- Create: `evolution-engine/src/types.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "evolution-engine",
  "version": "0.1.0",
  "main": "index.ts",
  "dependencies": {}
}
```

- [ ] **Step 2: Create index.ts (re-export)**

```typescript
export { default } from "./src/index";
```

- [ ] **Step 3: Create types.ts**

定义所有接口：EvolutionSuggestion, PendingFile, HistoryEntry, AutoTriggerFlag, JudgeInput, EvolveCommandParams, ApplyResult, RollbackResult, StatsData, CommandResult, Dirs。

所有 status/target/severity 类型使用联合字面量（不使用 enum，与项目其他 extension 一致）。

EvolutionSuggestion.status 初始值固定为 "pending"。

- [ ] **Step 4: Verify type check passes**

Run: `cd evolution-engine && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add evolution-engine/
git commit -m "feat(evo): add project skeleton and type definitions"
```

### Task 2: State Management + Prompt Templates

**Type:** backend

**Depends on:** Task 1

**Files:**
- Create: `evolution-engine/src/state.ts`
- Create: `evolution-engine/src/templates/session-quality.txt`
- Create: `evolution-engine/src/templates/skill-health.txt`
- Create: `evolution-engine/src/templates/prompt-optimize.txt`

- [ ] **Step 1: Create state.ts**

实现 4 个函数：
- `loadPending(dir)` — 读取 `dir/suggestions/pending.json`，文件不存在或 JSON 损坏返回 null
- `savePending(dir, pending)` — 写入 `dir/suggestions/pending.json`，目录不存在时递归创建（`fs.mkdirSync({ recursive: true })`）
- `appendHistory(dir, entry)` — 追加 JSON 行到 `dir/history.jsonl`，文件不存在时创建
- `loadHistory(dir, limit?)` — 读取 `dir/history.jsonl` 最后 N 行（默认 10），文件不存在返回 `[]`

所有路径基于 `evolutionDir` 参数（值为 `~/.pi/agent/evolution-data`），不硬编码。

- [ ] **Step 2: Create prompt templates**

三个模板文件放在 `src/templates/` 下，每个包含：
1. 角色定义（"你是 Pi Agent 的进化分析器"）
2. 输入数据说明（"以下是最近 N 天的 session 信号数据"）
3. 评判维度（每个模板不同，见下）
4. 输出 JSON schema（EvolutionSuggestion[] 的 JSON schema 定义）
5. 置信度要求（"confidence 必须 >= 0.6 才输出"）

session-quality.txt 评判维度：token 效率、工具使用模式、错误热点、用户习惯变化
skill-health.txt 评判维度：skill 触发频率、沉睡 skill、skill 文件大小与复杂度
prompt-optimize.txt 评判维度：重复模式、CLAUDE.md 规则覆盖率、规则冲突

- [ ] **Step 3: Verify type check passes**

Run: `cd evolution-engine && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add evolution-engine/src/state.ts evolution-engine/src/templates/
git commit -m "feat(evo): add state management and judge prompt templates"
```

### Task 3: LLM Judge

**Type:** backend

**Depends on:** Task 1, Task 2

**Files:**
- Create: `evolution-engine/src/judge.ts`

- [ ] **Step 1: Implement judge.ts**

三个核心函数：

**`buildJudgeInput(report, target, tmpDir)`**：
- 根据 target 裁剪 report JSON：
  - `"all"`: 传入完整 report
  - `"claude-md"`: 提取 `token_stats` + `user_patterns` + `actionable_issues`
  - `"skills"`: 提取 `skill_stats` + `skill_health` + `actionable_issues`
- 将裁剪后的数据写入 `tmpDir/judge-input-{timestamp}.json`
- 返回 `{ target, reportPath: tmpDir/judge-input-*.json, promptFilePath: <根据 target 选模板> }`

target 到模板的映射：
- `"all"` → session-quality.txt
- `"claude-md"` → prompt-optimize.txt
- `"skills"` → skill-health.txt

**`runJudge(input, templateDir)`**：
- 读取 promptFilePath（模板文件）获取 system prompt
- 读取 reportPath 获取信号数据
- 构建用户消息：`"分析以下信号数据，生成进化建议：\n\n${JSON.stringify(signalData)}"`
- spawn 子进程：
  ```
  spawn("pi", ["--mode", "json", "-p", "--model", "router-openai/glm-5.1",
                "--no-session",
                "--append-system-prompt", templatePath])
  ```
- 将用户消息通过 stdin pipe 传入（或作为最后一个 positional arg）
- 等待 stdout JSON（超时 120s）
- 调用 parseJudgeOutput 解析
- **非 JSON 输出处理**：若 parseJudgeOutput 抛错，将 raw stdout 写入 `evolution-dir/tmp/judge-raw-{timestamp}.txt`，然后抛 Error（含保存路径）
- **错误处理**：spawn 失败 / 超时均抛 Error，含诊断信息

**`parseJudgeOutput(raw)`**：
- 尝试 JSON.parse
- 验证是数组
- 验证每个元素包含所有必需字段（id, target, targetPath, severity, confidence, title, description, rationale, diff）
- confidence 范围检查 [0, 1]
- severity 枚举检查
- 为每条 suggestion 设置 status: "pending"
- 无效条目跳过并记录 warning（不抛错）
- 若所有条目均无效，返回空数组（不报错，与 AC-1 对齐）

注意：参考 `subagent/src/spawn.ts` 的 spawn + stdout JSON 解析模式。Pi `--mode json` 输出的是 JSONL（每行一个 JSON 事件），取最后一个 `type: "message_end"` 之前的内容作为 LLM 响应。

- [ ] **Step 2: Verify type check passes**

Run: `cd evolution-engine && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add evolution-engine/src/judge.ts
git commit -m "feat(evo): add LLM Judge subprocess orchestration"
```

### Task 4: Applier

**Type:** backend

**Depends on:** Task 1

**Files:**
- Create: `evolution-engine/src/applier.ts`

- [ ] **Step 1: Implement applier.ts**

四个核心函数：

**`backupFile(filePath, backupDir)`**：
- 生成 backup 路径：`backupDir/<timestamp>/<relative-path>`
- 递归创建目录
- `fs.copyFileSync(filePath, backupPath)`
- 返回 backupPath

**`applyUnifiedDiff(filePath, diff)`**：
- 解析 unified diff 获取旧内容和新内容
- 读取当前文件内容
- 尝试应用 diff（纯字符串匹配+替换，不引入 npm 依赖）
- 成功：写入新内容，返回 `{ success: true }`
- 失败（内容不匹配）：返回 `{ success: false, reason: "diff conflict" }`

**`applySuggestion(suggestion, backupDir)`**：
1. **路径白名单校验**：验证 targetPath 以 `~/.pi/agent/` 开头且扩展名为 `.md`，否则拒绝（防路径遍历）
2. 检查 targetPath 存在（`fs.existsSync`），不存在返回失败
3. 调用 backupFile 备份
4. 调用 applyUnifiedDiff 应用 diff
5. 若 diff 应用失败：返回 `{ success: false, reason: "diff conflict" }`
6. 尝试 git commit：
   - `execSync("git add " + targetPath, { cwd: dirname })`
   - `execSync('git commit -m "evolve: ' + suggestion.title + '"', { cwd: dirname })`
   - git 失败时 catch 并设 warning flag（不影响 success）
7. 返回 `{ success: true }`

**`rollbackSuggestion(entry)`**：
1. 检查 entry.backupPath 存在
2. `fs.copyFileSync(entry.backupPath, entry.targetPath)` 恢复原文件
3. 尝试 `git revert`（若有对应 commit）
4. 返回结果

- [ ] **Step 2: Verify type check passes**

Run: `cd evolution-engine && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add evolution-engine/src/applier.ts
git commit -m "feat(evo): add apply engine with backup, diff, and rollback"
```

### Task 5: Auto-Trigger Monitor

**Type:** backend

**Depends on:** Task 1

**Files:**
- Create: `evolution-engine/src/monitor.ts`

- [ ] **Step 1: Implement monitor.ts**

两个核心函数：

**`checkAutoTriggerRules(evolutionDir)`**：
1. 读取 `evolutionDir/daily/` 下最近 14 天的 JSON 文件
2. 读取 `evolutionDir/tool-stats.json`
3. 读取 `evolutionDir/skill-triggers.json`

逐条检查：

**Token 效率下降**：
- 取最近 7 天和前 7 天的 `tokenUsage.totalInput / sessions` 均值
- 若前 7 天 sessions = 0，跳过（除零保护）
- 若最近 3 天均值连续 > 前 7 天均值 → 命中

**Skill 沉睡**：
- 遍历 skill-triggers.json（结构：`{ [skillName]: { count, lastTriggered } }`）
- 若 `Date.now() - lastTriggered > 30 * 86400000` → 命中
- 收集所有沉睡 skill 名，拼成 detail

**错误率突升**：
- 最近 3 天 `toolCalls.failures` 总和 / `toolCalls.total` 总和
- 前 30 天同样的比率（从 daily 文件聚合）
- 若前 30 天 total = 0，跳过（除零保护）
- 若 (最近 3 天 - 前 30 天) / 前 30 天 > 0.5 → 命中

命中后：
- 检查 `evolutionDir/auto-trigger.flags/` 下同类型 flag 是否存在且 < 24h
- 若不存在或 > 24h：写 flag 文件（JSON: AutoTriggerFlag）
- 若条件不再满足：删除对应 flag 文件

返回所有当前有效 flags 数组。

**`cleanExpiredFlags(evolutionDir)`**：
- 列出 `evolutionDir/auto-trigger.flags/` 下所有文件
- 删除 triggeredAt > 7 天的 flag 文件
- flag 目录不存在时不报错

- [ ] **Step 2: Verify type check passes**

Run: `cd evolution-engine && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add evolution-engine/src/monitor.ts
git commit -m "feat(evo): add auto-trigger monitor with 3 hardcoded rules"
```

### Task 6: Commands + Widget + Integration

**Type:** backend

**Depends on:** Task 2, 3, 4, 5

**Files:**
- Create: `evolution-engine/src/widget.ts`
- Create: `evolution-engine/src/commands.ts`
- Create: `evolution-engine/src/index.ts`

- [ ] **Step 1: Implement widget.ts**

四个渲染函数：

**`renderSuggestionCard(suggestion, index, total)`**：
- 格式：`#N/M [SEVERITY conf:X.XX] targetPath\n标题\n原因摘要\n---\nDiff 预览（前 10 行）\n[y] Apply [n] Skip [e] Edit [q] Quit`
- 使用 `theme.fg("toolTitle", ...)`, `theme.fg("success", ...)` 等语义 token

**`renderStatsDashboard(stats)`**：
- 最近 7 天汇总：tool calls 总数、token 消耗、skill 触发排名
- 工具失败率 Top 5
- 趋势箭头

**`renderRollbackList(history)`**：
- 每条记录一行：`#N timestamp | action | title | targetPath`

**`renderAutoTriggerHint(flags)`**：
- 每条 flag 一行提示消息，拼成字符串追加到 session_start 返回内容

- [ ] **Step 2: Implement commands.ts**

封装 4 个 command handler，每个返回 `CommandResult`（content 数组 + details 对象）。

**`handleEvolve(params, dirs)`**：
1. 检查 `dirs.reportsDir` 下 7 天内是否有 JSON 报告
2. 若无：执行 `execSync("python3 " + ANALYZER_PATH + " --since " + params.since + " --format json --output " + tmpPath, { timeout: 60000 })`
3. 若 analyze.py 失败：返回错误 CommandResult
4. 读取报告 JSON
5. 调用 `buildJudgeInput(report, params.target, dirs.tmpDir)`
6. 调用 `runJudge(input, dirs.templateDir)`
7. 调用 `savePending(dirs.evolutionDir, { generatedAt, reportUsed, suggestions })`
8. 返回 suggestions 列表给 TUI 渲染
9. TUI 审批循环中逐条调用 `renderSuggestionCard`，收集用户输入
10. 对 approved 的调用 `applySuggestion`
11. 对每条 applied 的调用 `appendHistory`
12. 返回 summary CommandResult

**`handleEvolveApply(dirs)`**：
1. 调用 `loadPending`
2. 过滤 status === "pending" 的 suggestion
3. 同上 TUI 审批循环
4. 保存更新后的 pending.json

**`handleEvolveStats(evolutionDir)`**：
1. 读取 daily/ + tool-stats.json + skill-triggers.json
2. 聚合最近 7 天数据
3. 渲染 dashboard

**`handleEvolveRollback(dirs)`**：
1. 调用 `loadHistory(dirs.evolutionDir)`
2. 调用 `renderRollbackList` 展示
3. 用户选择后调用 `rollbackSuggestion`
4. 追加 rollback 记录到 history

常量定义：
```
ANALYZER_PATH = "~/.pi/agent/scripts/pi-session-analyzer/analyze.py"
EVOLUTION_DIR = "~/.pi/agent/evolution-data"
```

- [ ] **Step 3: Implement index.ts (factory function)**

```typescript
export default function evolutionEngineExtension(pi: ExtensionAPI) {
  // 注册 session_start 事件
  pi.on("session_start", async (ctx) => {
    const flags = checkAutoTriggerRules(EVOLUTION_DIR);
    cleanExpiredFlags(EVOLUTION_DIR);
    if (flags.length > 0) {
      // 追加提示消息到 session
    }
  });

  // 注册 /evolve command
  pi.registerCommand("evolve", {
    description: "Analyze session data and suggest improvements",
    parameters: /* typebox schema for EvolveCommandParams */,
    execute: async (params, ctx) => handleEvolve(params, dirs),
    renderCall: (params) => new Text("Running evolution analysis..."),
    renderResult: (result) => /* render summary or error */
  });

  // 注册 /evolve-apply command
  pi.registerCommand("evolve-apply", { ... });

  // 注册 /evolve-stats command
  pi.registerCommand("evolve-stats", { ... });

  // 注册 /evolve-rollback command
  pi.registerCommand("evolve-rollback", { ... });
}
```

- [ ] **Step 4: Verify type check passes**

Run: `cd evolution-engine && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add evolution-engine/src/widget.ts evolution-engine/src/commands.ts evolution-engine/src/index.ts
git commit -m "feat(evo): add commands, widget, and factory integration"
```

---

## Execution Groups

#### BG1: Foundation (Types + State + Templates)

**Description:** 扩展的基础类型定义、状态持久化、LLM Judge prompt 模板。无外部依赖。

**Tasks:** Task 1, Task 2

**Files (预估):** 7 个文件（7 create + 0 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（medium） |
| 注入上下文 | Task 1-2 描述、spec.md §Constraints、types.ts 接口定义、subagent spawn.ts 参考模式 |
| 读取文件 | `subagent/src/spawn.ts`、`usage-tracker/src/index.ts` |
| 修改/创建文件 | package.json, index.ts, src/types.ts, src/state.ts, src/templates/*.txt |

**Execution Flow (BG1 内部):** 串行派遣。

  Task 1:
    1. general-purpose → 创建 package.json + index.ts + types.ts
    2. 验证 tsc --noEmit 通过

  Task 2 (depends on Task 1):
    1. general-purpose → 创建 state.ts + 3 个 prompt 模板
    2. 验证 tsc --noEmit 通过

**Dependencies:** 无

#### BG2: Core Logic (Judge + Applier + Monitor)

**Description:** 三个核心引擎——LLM Judge 子进程编排、建议应用引擎、自动触发规则。依赖 BG1 的类型定义。

**Tasks:** Task 3, Task 4, Task 5

**Files (预估):** 3 个文件（3 create + 0 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（high） |
| 注入上下文 | Task 3-5 描述、spec.md §FR-1~FR-8、types.ts 接口定义、subagent spawn.ts 参考模式、Phase 2 report JSON 字段结构 |
| 读取文件 | `subagent/src/spawn.ts`、`evolution-engine/src/types.ts`、`evolution-engine/src/state.ts`、Phase 2 报告样本 |
| 修改/创建文件 | src/judge.ts, src/applier.ts, src/monitor.ts |

**Execution Flow (BG2 内部):** 串行派遣（Task 3 和 Task 4/5 可并行，但建议串行确保类型一致性）。

  Task 3:
    1. general-purpose → 创建 judge.ts
    2. 验证 tsc --noEmit 通过

  Task 4:
    1. general-purpose → 创建 applier.ts
    2. 验证 tsc --noEmit 通过

  Task 5:
    1. general-purpose → 创建 monitor.ts
    2. 验证 tsc --noEmit 通过

**Dependencies:** BG1

#### BG3: Integration (Commands + Widget + Entry Point)

**Description:** 命令处理、TUI 渲染、工厂函数注册。将所有模块组装为完整 Extension。

**Tasks:** Task 6

**Files (预估):** 3 个文件（3 create + 0 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（high） |
| 注入上下文 | Task 6 描述、spec.md §FR-1~FR-8、所有 BG1/BG2 模块的接口签名、usage-tracker 的 registerCommand 模式、pi-tui 渲染模式 |
| 读取文件 | `usage-tracker/src/index.ts`、`evolution-engine/src/*.ts` |
| 修改/创建文件 | src/widget.ts, src/commands.ts, src/index.ts |

**Execution Flow (BG3 内部):**

  Task 6:
    1. general-purpose → 创建 widget.ts + commands.ts + index.ts
    2. 验证 tsc --noEmit 通过

**Dependencies:** BG1, BG2

## Dependency Graph & Wave Schedule

```
BG1 (Foundation) ──→ BG2 (Core Logic) ──→ BG3 (Integration)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | 类型 + 状态 + 模板，无依赖 |
| Wave 2 | BG2 | 核心逻辑，依赖 BG1 类型定义 |
| Wave 3 | BG3 | 集成组装，依赖 BG1 + BG2 全部模块 |
