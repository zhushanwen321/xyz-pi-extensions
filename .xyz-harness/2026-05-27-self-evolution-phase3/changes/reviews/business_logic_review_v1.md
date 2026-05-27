---
verdict: fail
must_fix: 5
review_metrics:
  files_reviewed: 8
  issues_found: 15
  must_fix_count: 5
  low_count: 5
  info_count: 5
---

# Business Logic Review — Evolution Engine v1

**审查时间**: 2026-05-27
**审查范围**: spec.md (8 FR + 7 AC) + use-cases.md (4 UC) vs 源代码实现
**审查文件**: types.ts, state.ts, judge.ts, applier.ts, monitor.ts, commands.ts, index.ts, widget.ts

---

## UC-1: /evolve 全流程 — analyze.py 降级 → Judge 调用 → TUI → apply

### Main Flow 路径验证

| 步骤 | Spec 要求 | 实现代码路径 | 状态 |
|------|----------|-------------|------|
| 1. 查找 7 天内报告 | FR-1 §1 | `commands.ts:findRecentReport()` | OK |
| 2. 无报告 → 运行 analyze.py | FR-1 §2 + FR-8 | `commands.ts:handleEvolve()` L110-125 | OK |
| 3. analyze.py 失败 → 显示错误终止 | FR-1 §3 | catch 块返回 `errorResult()` | OK |
| 4. 读取报告 + 按 target 裁剪 | FR-1 §4 | `judge.ts:extractReportSubset()` | OK（见 LOW-1） |
| 5. 构建 Judge 输入 + 临时文件 | FR-1 §5 | `judge.ts:buildJudgeInput()` | OK |
| 6. spawn pi 子进程 | FR-1 §6 | `judge.ts:runJudge()` | OK |
| 7. 120s 超时 | FR-1 §7 | `JUDGE_TIMEOUT_MS = 120_000` | OK |
| 8. 写入 pending.json | FR-1 §9 | `commands.ts:savePending()` | OK |
| 9. TUI 审批交互 | FR-1 §TUI | **缺失**（见 MUST_FIX-1） |
| 10. apply → backup → commit | FR-3 | `applier.ts:applySuggestion()` | OK（见 MUST_FIX-2） |

### MUST_FIX-1: TUI 逐条审批交互未实现

**Spec FR-1**: "逐条展示建议（标题、严重程度、置信度、原因、建议 diff），用户输入 y/n/e 逐条决策。支持中途退出（已决策的不丢失，pending.json 保留未决策的）。"

**UC-1 Main Flow Step 8**: "用户对每条建议输入 y（应用）/ n（跳过）/ e（编辑）/ q（退出）"

**UC-1 Alt Path 8a**: "用户输入 q 中途退出 → 已决策的建议保留在 pending.json，后续可用 /evolve-apply 续批"

**AC-6**: "审批过程中用户选择退出，已决策的建议状态保留在 pending.json"

**实际实现**:
- `handleEvolve()` 执行完 Judge 后直接返回摘要文本，不等待用户逐条审批
- `handleEvolveApply()` 对所有 `pending` 状态的建议**全部批量执行 apply**，无逐条 y/n/e/q 交互
- `widget.ts:renderSuggestionCard()` 定义了渲染单条卡片的函数（含 `[y] Apply [n] Skip [e] Edit [q] Quit` 提示），但该函数**从未被调用**
- 不存在任何读取用户输入实现 y/n/e/q 决策逻辑的代码路径

**影响**: 核心交互流程缺失。用户无法逐条审批建议，`/evolve-apply` 变成了"全部应用"而非"逐条审批后应用"。Spec 明确要求"所有 apply 必须人工确认"（Out of Scope 中也强调了"自动应用建议"排除在外）。

**修复建议**: `handleEvolveApply()` 需要改为逐条交互模式，或通过 Pi 的 tool 返回机制引导 AI 主循环逐条询问用户。

---

### MUST_FIX-2: applySuggestion 的 backup 路径与 history 记录不一致

**Spec FR-3 §3**: "备份原文件到 `~/.pi/agent/evolution-data/backups/<timestamp>/<relative-path>`"

**实际实现**:
- `applier.ts:backupFile()` 生成的备份路径格式为 `backupDir/<ISO-timestamp>/<basename>` — 这里 `basename` 只取文件名（如 `CLAUDE.md`），不保留原始目录结构
- `commands.ts:handleEvolveApply()` 写入 history 时使用 `join(backupDir, "${suggestion.id}.bak")` 作为 `backupPath`
- 两者指向完全不同的路径：`backupFile()` 返回的是 `backups/2026-05-27T12-00-00-000Z/CLAUDE.md`，而 history 记录的是 `backups/uuid.bak`

**影响**: rollback 操作依赖 `entry.backupPath` 恢复文件。由于 history 记录的路径与实际备份路径不同，**rollback 将永远找不到备份文件**，返回 "backup file not found"。

**修复建议**: `applySuggestion()` 需要返回 `backupPath`，`handleEvolveApply()` 使用该返回值写入 history，而非自己拼接路径。

---

### MUST_FIX-3: /evolve-apply 跳过了 pending 中 approved 状态的建议

**Spec FR-4 + UC-1 Step 8**: 用户在审批中 approved 的建议需要被 apply。审批中 rejected 的建议不需要。

**AC-6**: "已决策的建议状态保留在 pending.json。/evolve-apply 可以继续处理剩余的 pending 建议"

**实际实现** (`commands.ts:handleEvolveApply()`):
```typescript
const pendingSuggestions = pending.suggestions.filter(
    (s) => s.status === "pending",
);
```
只过滤 `pending` 状态，忽略了 `approved` 状态。当 MUST_FIX-1 修复后（引入逐条审批），用户 approved 的建议 status 应变为 `"approved"`，但此 filter 会跳过它们。

不过即使当前代码逻辑下（没有审批环节），所有建议初始都是 `"pending"`，filter 行为是正确的。这是一个**前置性问题**——在 MUST_FIX-1 修复后必然暴露。

**影响**: 在引入审批交互后，已 approved 的建议无法被 apply。

**修复建议**: filter 条件改为 `(s) => s.status === "pending" || s.status === "approved"`。

---

### MUST_FIX-4: rollback 使用 `git commit` 而非 `git revert`

**Spec FR-6 §2**: "若之前在 git 中有对应 commit，执行 `git revert`"

**UC-3 Main Flow Step 6**: "系统尝试 git revert（如有对应 commit）"

**实际实现** (`applier.ts:rollbackSuggestion()`):
```typescript
execSync(`git add ${entry.targetPath}`, { cwd: dirName, stdio: "pipe" });
execSync(`git commit -m "evolve: rollback ${escapedTitle}"`, {
    cwd: dirName, stdio: "pipe",
});
```
使用 `git add + git commit` 创建新 commit，而非 `git revert <original-commit>`。

**影响**: 
- 无法利用 git 的三方合并能力处理冲突
- 回滚后的 git 历史丢失了与原始 commit 的关联
- 若 apply 和 rollback 之间有其他 commit，`git add + commit` 会正确恢复文件内容（因为从 backup 恢复了完整文件），所以**文件恢复是正确的**，但 git 层面的操作方式与 spec 不一致

**严重程度**: 当前实现功能上可以恢复文件（从 backup copy），但不符合 spec 要求的 `git revert` 语义。如果需要 revert 的精确 commit SHA，需要在 history 中记录 apply 时的 commit SHA。

**修复建议**: 在 `HistoryEntry` 中增加 `commitSha` 字段，apply 时记录 commit SHA，rollback 时优先尝试 `git revert <sha>`，失败则 fallback 到当前的 add+commit 模式。

---

### MUST_FIX-5: checkTokenDecline 规则逻辑与 spec 不匹配

**Spec FR-7**: "最近 7 天 `tokenUsage.totalInput/sessions` 均值 vs 前 7 天 | 连续 3 天上升"

**AC-5**: "token 连续 3 天上升时，flag 文件被创建"

**实际实现** (`monitor.ts:checkTokenDecline()`):
```typescript
const baseline = sliceBeforeLast(daily, DECLINE_RECENT_DAYS, DECLINE_BASELINE_DAYS);
const recent = tailN(daily, DECLINE_RECENT_DAYS);
// ...
// 连续 3 天均值 > 前 7 天均值
if (recentAvg > baselineAvg) { ... }
```

两个问题：

1. **"连续 3 天上升" 被实现为 "最近 3 天均值 > 前 7 天均值"**：Spec 要求的是"连续 3 天上升"（即 day1 < day2 < day3 的趋势判断），但代码实现的是"近期 3 天的 per-session 均值 vs 基线 7 天的 per-session 均值"。两者语义不同——近期均值高于基线不等于连续 3 天逐天上升。

2. **sliceBeforeLast 窗口偏移问题**：`sliceBeforeLast(daily, 3, 7)` 从 daily 数组的 `len-3` 位置开始取 7 个元素。如果 daily 有 14 天数据，baseline 取的是 day 5-11（最近 3 天之前的 7 天），而 spec 说的"前 7 天"语义上应该是 day 1-7。14 天滑动窗口下，day 5-11 并非"前 7 天"。

**影响**: 自动触发的 token-decline 规则可能在不应触发时触发（或反之），与 AC-5 的验收标准不一致。

**修复建议**: 实现"连续 3 天逐天上升"的检查逻辑，即验证 `avg[n-3] < avg[n-2] < avg[n-1]`。

---

### LOW-1: extractReportSubset 对 claude-md target 包含了额外字段

**Spec FR-1 §4**: "claude-md：仅 token_stats + user_patterns + actionable_issues"

**实际实现** (`judge.ts:extractReportSubset()`):
```typescript
if (target === "claude-md") {
    if (report.token_stats != null) subset.token_stats = report.token_stats;
    if (report.user_patterns != null) subset.user_patterns = report.user_patterns;
    if (report.actionable_issues != null) subset.actionable_issues = report.actionable_issues;
    // 子集可能为空——传可用的
    if (report.tool_stats != null) subset.tool_stats = report.tool_stats;
    if (report.error_stats != null) subset.error_stats = report.error_stats;
    return subset;
}
```
额外包含了 `tool_stats` 和 `error_stats`。注释说"子集可能为空——传可用的"，但 spec 明确定义了 target 对应的字段子集。

**影响**: 不会破坏功能（多给数据不影响 LLM 分析），但与 spec 定义不一致，可能导致 Judge 给出不相关的建议。

---

### LOW-2: /evolve-stats 缺少趋势箭头和上周对比

**Spec FR-5**: "与上周对比的趋势箭头（上涨/下降/持平）"

**实际实现**: `handleEvolveStats()` 只聚合最近 7 天数据，不对比前 7 天数据，不计算趋势箭头。

**影响**: 统计面板缺少趋势信息，但不影响核心进化流程。

---

### LOW-3: findRecentReport 只检查 mtime 不检查文件名日期

**Spec FR-1 §1**: "检查 reports/ 下 7 天内是否有 JSON 报告"

**实际实现** (`commands.ts:findRecentReport()`):
```typescript
const stat = { mtime: getMtimeMs(filePath) };
if (stat.mtime >= cutoff) { ... }
```
使用文件修改时间判断。如果文件是 cp/rsync 来的（mtime 不变），可能在 7 天外被误判。Phase 2 analyzer 生成的文件名含时间戳，但 mtime 语义上是对的。

**影响**: 边界场景，日常使用不会触发。

---

### LOW-4: applySuggestion 中 git commit 的路径未转义

**实际实现** (`applier.ts:applySuggestion()`):
```typescript
execSync(`git add ${suggestion.targetPath}`, { cwd: dirName, stdio: "pipe" });
```
如果 `targetPath` 包含空格或特殊字符，shell 命令会出错。虽然 `shell: false`（默认值）在 spawn 中不经过 shell 解释，但 `execSync` 默认通过 shell 执行。

不过 `isPathAllowed()` 限制了路径必须在 `~/.pi/agent/` 下且以 `.md` 结尾，实际路径中出现空格的概率很低。

**影响**: 低概率的路径注入问题。

---

### LOW-5: handleEvolve 中 --sample 参数未使用

**Spec FR-1**: "--sample int | 否 | 透传给 analyze.py 的 --sample 参数"

**实际实现**: `EvolveCommandParams` 定义了 `sample` 字段，`index.ts` 的 command handler 解析参数时设置了 `sample: undefined`，`handleEvolve()` 接收参数但不传递给 analyze.py 命令。

```typescript
// commands.ts:handleEvolve() — 未使用 params.sample
execSync(
    `python3 "${ANALYZER_SCRIPT}" --since ${params.since} --format json --output "${tmpReportPath}"`,
    { timeout: 60_000, stdio: "pipe" },
);
```

**影响**: `--sample` 参数被接受但不生效，与 spec 不一致。

---

## UC-2: 自动触发 — 3 条规则的触发逻辑和除零保护

### Main Flow 路径验证

| 步骤 | Spec 要求 | 实现代码路径 | 状态 |
|------|----------|-------------|------|
| 1. session_start 事件 | FR-7 | `index.ts:pi.on("session_start")` | OK |
| 2. checkAutoTriggerRules | FR-7 | `monitor.ts:checkAutoTriggerRules()` | OK（见 MUST_FIX-5） |
| 3. 写 flag 文件 | FR-7 | `monitor.ts:writeFlag()` | OK |
| 4. 24h 去重 | UC-2 Alt 4a | `FLAG_COOLDOWN_MS` 检查 | OK |
| 5. 条件不再满足 → 删除 flag | UC-2 Alt 3b | `removeFlag()` | OK |
| 6. 提示消息 | FR-7 | `ctx.ui.notify()` | OK |
| 7. 除零保护 | FR-7 约束 | `baselineSessions === 0` 检查 | OK |

### 除零保护验证

| 规则 | 除零场景 | 保护逻辑 | 状态 |
|------|---------|---------|------|
| token-decline | baseline 无 session | `if (baselineSessions === 0) return { hit: false }` | OK |
| token-decline | recent 无 session | `if (recentSessions === 0) return { hit: false }` | OK |
| error-spike | baseline 无 tool calls | `if (baselineTotal === 0) return { hit: false }` | OK |
| error-spike | recent 无 tool calls | `if (recentTotal === 0) return { hit: false }` | OK |
| error-spike | baselineRate === 0 | 特殊处理：recentFailures > 0 → hit | OK |
| skill-dormant | 无 skill-triggers.json | `readJsonSafe` 返回 undefined → hit: false | OK |

### 24h 去重验证

```typescript
// monitor.ts:checkAutoTriggerRules()
if (existing) {
    const age = now.getTime() - new Date(existing.triggeredAt).getTime();
    if (age < FLAG_COOLDOWN_MS) continue;
}
```
OK — 已有 flag 且在 24h 内时跳过写入。

### INFO-1: session_start 事件签名可能不匹配

`index.ts`:
```typescript
pi.on("session_start", async (_event, ctx) => {
```
Pi Extension API 的 `session_start` 事件 handler 签名是否为 `(event, ctx)` 需要确认。其他 extension（如 usage-tracker）的模式如果不同，这里会有运行时错误。当前无法验证。

---

## UC-3: 回滚 — backup 恢复 + history 记录

### Main Flow 路径验证

| 步骤 | Spec 要求 | 实现代码路径 | 状态 |
|------|----------|-------------|------|
| 1. /evolve-rollback 命令 | FR-6 | `index.ts:registerCommand("evolve-rollback")` | OK |
| 2. 读取 history 最近 N 条 | UC-3 §2 | `loadHistory(dir, 20)` — 取 20 条，spec 说 10 条 | OK（见 INFO-2） |
| 3. TUI 展示回滚列表 | UC-3 §3 | `widget.ts:renderRollbackList()` | OK |
| 4. 用户选择 → 执行 rollback | UC-3 §4-5 | `handleEvolveRollback(index, dirs)` | OK |
| 5. backup 恢复 | UC-3 §5 | `applier.ts:rollbackSuggestion()` | OK |
| 6. git revert | UC-3 §6 | 使用 commit 而非 revert | **MUST_FIX-4** |
| 7. rollback 记录到 history | UC-3 §7 | `appendHistory()` 写入 rollback 记录 | OK |
| 8. backup 不存在 → 错误 | UC-3 Alt 5a | `if (!fs.existsSync(entry.backupPath))` | OK（但路径不一致 → **MUST_FIX-2**） |

### INFO-2: loadHistory 取 20 条而非 spec 要求的 10 条

**Spec UC-3 §2**: "系统读取 history.jsonl 最近 10 条记录"

**实际实现**: `commands.ts:handleEvolveRollback()` 中 `loadHistory(dirs.evolutionDir, 20)`

UC 限定 10 条是为了回滚列表展示简洁，实际取 20 条无功能危害，但与 spec 不一致。

---

## UC-4: 统计 — 数据聚合和渲染

### Main Flow 路径验证

| 步骤 | Spec 要求 | 实现代码路径 | 状态 |
|------|----------|-------------|------|
| 1. /evolve-stats 命令 | FR-5 | `index.ts:registerCommand("evolve-stats")` | OK |
| 2. 读取 daily/ 最近 7 天 | UC-4 §2 | `handleEvolveStats()` | OK |
| 3. 聚合 tool calls、token、skill | UC-4 §3 | 聚合逻辑存在 | OK |
| 4. TUI 展示 dashboard | UC-4 §4 | `widget.ts:renderStatsDashboard()` | OK |
| 无数据 → 显示提示 | UC-4 Alt 2a | "No usage data available yet." | OK |

### 数据聚合正确性

`handleEvolveStats()` 中的聚合逻辑：
- `toolCalls`: 累加 `day.toolCalls?.total` — 正确
- `tokenInput/tokenOutput`: 累加 `day.tokenUsage?.totalInput/totalOutput` — 正确
- `topSkills`: 从 `day.skillTriggers` 累加计数 — 正确
- `topFailures`: 从 `day.toolCalls.byTool` 和 `day.toolCalls.failures` 计算失败率 — 正确

### INFO-3: StatsData 接口缺少趋势数据字段

`types.ts:StatsData` 未包含趋势箭头相关字段。结合 LOW-2，趋势功能完全未实现。

---

## INFO-4: renderSuggestionCard 定义了但未被调用

`widget.ts:renderSuggestionCard()` 是一个完整的渲染函数（包含 diff 预览、y/n/e/q 提示），但 `index.ts` 中的 `renderResult` 没有使用它，而是直接内联渲染。这是一个死代码，暗示 TUI 逐条审批功能的设计意图未完成。

---

## INFO-5: Extension 工厂函数中的 tool 和 command 重复注册

`index.ts` 中每个功能同时注册了 `pi.registerTool()` 和 `pi.registerCommand()`：
- `evolve` tool + `/evolve` command
- `evolve-stats` tool + `/evolve-stats` command
- `evolve-rollback` tool + `/evolve-rollback` command

command handler 直接调用 `handleXxx()` 函数并使用 `ctx.ui.notify()` 显示结果。这导致同一功能有两条触发路径（tool 调用和命令），但行为略有不同（tool 走 `execute` + `renderResult`，command 走 `notify`）。这是否符合 Pi Extension 的最佳实践需要确认。

---

## 模拟业务数据与执行路径

### 路径 1: /evolve 全流程（正常路径）

```
输入: /evolve --target all --since 7d

1. findRecentReport("~/.pi/agent/evolution-data/reports/", 7)
   → 找到 phase2-1234567890.json → reportPath

2. readFileSync(reportPath) → report JSON
   extractReportSubset(report, "all") → 完整报告

3. buildJudgeInput(report, "all", tmpDir)
   → 写入 judge-input-1234567890.json
   → 写入 judge-prompt-1234567890.txt
   → 返回 { target: "all", reportPath, promptFilePath }

4. runJudge(input, templateDir)
   → spawn("pi", ["--mode", "json", "-p", "--model", "router-openai/glm-5.1",
                   "--no-session", "--append-system-prompt", <template>, <userMsg>])
   → stdout JSONL → extractAssistantText() → "```json\n[{...}]\n```"
   → parseJudgeOutput() → EvolutionSuggestion[3]

5. savePending() → pending.json 写入 3 条建议

6. 返回: "Generated 3 evolution suggestion(s). Use /evolve-apply to review and apply."
```

### 路径 2: /evolve 全流程（无报告 → 自动分析）

```
输入: /evolve

1. findRecentReport() → null

2. execSync("python3 analyze.py --since 7d --format json --output <path>")
   → 成功 → reportPath

3-6: 同路径 1
```

### 路径 3: /evolve-apply（批量应用）

```
输入: /evolve-apply

1. loadPending() → pending 文件含 3 条 pending 建议

2. 对每条:
   a. applySuggestion(suggestion, backupDir)
      → isPathAllowed() → true
      → backupFile() → 备份到 backups/2026-05-27T12-00-00/CLAUDE.md
      → applyUnifiedDiff() → 成功
      → git add + commit → 成功/失败
      → return { success: true }
   b. appendHistory() → history.jsonl
      ⚠️ backupPath = "backups/uuid.bak" (与实际备份路径不一致!)

3. savePending() → 3 条建议 status 更新为 "applied"

4. 返回: "Applied: 3, Failed: 0"
```

### 路径 4: /evolve-rollback

```
输入: /evolve-rollback 1

1. loadHistory(20) → [ { action: "apply", backupPath: "backups/uuid.bak", ... } ]

2. rollbackSuggestion(entry)
   → fs.existsSync("backups/uuid.bak") → false ❌
   → return { success: false, reason: "backup file not found" }
   → ⚠️ 由于 backupPath 不一致，rollback 永远失败!
```

### 路径 5: 自动触发（session_start）

```
事件: session_start

1. checkAutoTriggerRules(evolutionDir)
   → loadRecentDaily(dailyDir, now, 14)
   → checkTokenDecline(daily)
      baseline = day 5-11 的数据
      recent = day 12-14 的数据
      recentAvg > baselineAvg → { hit: true, detail: "..." }
   → checkSkillDormant(evolutionDir, now)
      → skill-triggers.json 中有 skill A, lastTriggered: 20 天前 → 未超 30 天阈值
      → { hit: false }
   → checkErrorSpike(daily)
      → recentRate / baselineRate > 0.5 → { hit: true, detail: "..." }

2. token-decline: 写 flag
   error-spike: 写 flag

3. ctx.ui.notify("Evolution auto-trigger detected: ...")

4. cleanExpiredFlags()
```

---

## 审查总结

### 必须修复 (MUST_FIX: 5)

| ID | UC | 问题 | 严重性 |
|----|-----|------|--------|
| MUST_FIX-1 | UC-1 | TUI 逐条审批交互未实现，/evolve-apply 批量全量执行 | 阻塞 |
| MUST_FIX-2 | UC-1/UC-3 | backup 路径与 history 记录不一致，导致 rollback 必定失败 | 阻塞 |
| MUST_FIX-3 | UC-1 | apply filter 只取 pending 状态，审批机制修复后将遗漏 approved | 前置 |
| MUST_FIX-4 | UC-3 | rollback 使用 git commit 而非 git revert | 偏差 |
| MUST_FIX-5 | UC-2 | token-decline 规则逻辑与 spec "连续 3 天上升" 不匹配 | 偏差 |

### 低优先级 (LOW: 5)

| ID | UC | 问题 |
|----|-----|------|
| LOW-1 | UC-1 | claude-md target 额外包含了 tool_stats 和 error_stats |
| LOW-2 | UC-4 | 缺少趋势箭头和上周对比 |
| LOW-3 | UC-1 | findRecentReport 依赖 mtime 而非文件名日期 |
| LOW-4 | UC-1 | git commit 路径未转义 |
| LOW-5 | UC-1 | --sample 参数未传递给 analyze.py |

### 改进建议 (INFO: 5)

| ID | 说明 |
|----|------|
| INFO-1 | session_start 事件签名需确认与 Pi API 匹配 |
| INFO-2 | rollback 加载 20 条而非 spec 的 10 条 |
| INFO-3 | StatsData 接口缺少趋势字段 |
| INFO-4 | renderSuggestionCard 是死代码 |
| INFO-5 | tool 和 command 重复注册，行为路径不同 |
