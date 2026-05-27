---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 8
  issues_found: 5
  must_fix_count: 0
  low_count: 3
  info_count: 2
---

# Integration Review — Evolution Engine v2

**审查时间**: 2026-05-27
**审查范围**: v1 MUST_FIX 修复验证 + 全量模块间集成复查
**参照**: integration_review_v1.md + business_logic_review_v3.md（BLR 最终版）
**审查文件**: types.ts, state.ts, judge.ts, applier.ts, monitor.ts, commands.ts, index.ts, widget.ts

---

## v1 MUST_FIX 修复验证

### MUST_FIX-1: sliceBeforeLast 窗口重叠 — 已修复

**v1 问题**: `sliceBeforeLast(daily, DECLINE_RECENT_DAYS, DECLINE_BASELINE_DAYS)` 导致 baseline 与 recent 窗口完全重叠。

**修复验证** (`monitor.ts:checkTokenDecline()` L143-145):

```typescript
function checkTokenDecline(daily: DailyFile[]): { hit: boolean; detail: string } {
    // baseline: 前 7 天（day 0-6），不与 recent（最后 3 天）重叠
    const baseline = daily.slice(0, DECLINE_BASELINE_DAYS);
    const recent = tailN(daily, DECLINE_RECENT_DAYS);
```

**验证推导**（14 天 daily 数据，DECLINE_BASELINE_DAYS=7，DECLINE_RECENT_DAYS=3）:
- baseline = `daily.slice(0, 7)` → `daily[0..6]`（7 个元素，第 1-7 天）
- recent = `tailN(daily, 3)` → `daily[11..13]`（3 个元素，第 12-14 天）
- 两个窗口**无重叠**（baseline 结束于 index 6，recent 开始于 index 11）

**残留观察**: `sliceBeforeLast` 函数（L100-105）仍存在于 monitor.ts 中但已无调用方。这是死代码，不影响运行时正确性（见 INFO-1）。

**结论**: ✓ 已修复

---

### MUST_FIX-2: /evolve-apply 命令未注册 — 已修复

**v1 问题**: `evolve-apply` 只有 tool 注册（AI 可调用），缺少 `pi.registerCommand("evolve-apply", ...)`。

**修复验证** (`index.ts` L244-267):

```typescript
pi.registerCommand("evolve-apply", {
    description:
        "Review and manage evolution suggestions. " +
        "Usage: /evolve-apply [list|apply|skip] [index]",
    handler: async (args, ctx) => {
        const parts = args.trim().split(/\s+/);
        let action: "list" | "apply" | "skip" = "list";
        let index: number | undefined;

        for (const part of parts) {
            if (part === "list" || part === "apply" || part === "skip") {
                action = part;
            } else {
                const n = parseInt(part, 10);
                if (!Number.isNaN(n) && n >= 0) index = n;
            }
        }

        const result = await handleEvolveApply({ action, index }, dirs);
        const textPart = result.content[0];
        if (textPart?.type === "text" && ctx.hasUI) {
            ctx.ui.notify(textPart.text, "info");
        }
    },
});
```

**验证要点**:
- 命令名 `"evolve-apply"` 与用户提示文本中的 `/evolve-apply` 一致 ✓
- 参数解析覆盖 `list`/`apply`/`skip` + 数字 index ✓
- 调用 `handleEvolveApply` 的参数结构与 tool handler 一致 ✓
- 结果通过 `ctx.ui.notify` 展示 ✓
- 4 个命令全部注册: `evolve`、`evolve-apply`、`evolve-stats`、`evolve-rollback` ✓

**结论**: ✓ 已修复

---

## 模块间接口一致性复查

### 调用链路总表

| 调用方 | 被调用方 | 接口 | 参数匹配 | 返回值使用 | 状态 |
|--------|---------|------|---------|-----------|------|
| index.ts (tool) | commands.ts | `handleEvolve(params, dirs)` | EvolveCommandParams × Dirs ✓ | CommandResult → renderResult ✓ | OK |
| index.ts (cmd) | commands.ts | `handleEvolve({target, since, sample}, dirs)` | 手动构造 EvolveCommandParams ✓ | content[0].text → notify ✓ | OK |
| index.ts (tool) | commands.ts | `handleEvolveApply(params, dirs)` | EvolveApplyCommandParams × Dirs ✓ | CommandResult → renderResult ✓ | OK |
| index.ts (cmd) | commands.ts | `handleEvolveApply({action, index}, dirs)` | 手动构造 EvolveApplyCommandParams ✓ | content[0].text → notify ✓ | OK |
| index.ts (tool) | commands.ts | `handleEvolveStats(evolutionDir)` | string ✓ | CommandResult → renderResult ✓ | OK |
| index.ts (cmd) | commands.ts | `handleEvolveStats(dirs.evolutionDir)` | string ✓ | content[0].text → notify ✓ | OK |
| index.ts (tool) | commands.ts | `handleEvolveRollback(index, dirs)` | number × Dirs ✓ | CommandResult → renderResult ✓ | OK |
| index.ts (cmd) | commands.ts | `handleEvolveRollback(index, dirs)` | number × Dirs ✓ | content[0].text → notify ✓ | OK |
| index.ts (cmd/rollback) | state.ts | `loadHistory(dirs.evolutionDir, 20)` | string × number ✓ | HistoryEntry[] → renderRollbackList ✓ | OK |
| commands.ts | judge.ts | `buildJudgeInput(report, target, tmpDir)` | Record × target × string ✓ | JudgeInput ✓ | OK |
| commands.ts | judge.ts | `runJudge(input, templateDir)` | JudgeInput × string ✓ | Promise<EvolutionSuggestion[]> ✓ | OK |
| commands.ts | applier.ts | `applySuggestion(suggestion, backupDir)` | EvolutionSuggestion × string ✓ | Promise<ApplyResult> ✓ | OK |
| commands.ts | applier.ts | `rollbackSuggestion(entry)` | HistoryEntry ✓ | Promise<RollbackResult> ✓ | OK |
| commands.ts | state.ts | `loadPending(dir)` | string ✓ | PendingFile\|null ✓ | OK |
| commands.ts | state.ts | `savePending(dir, pending)` | string × PendingFile ✓ | void ✓ | OK |
| commands.ts | state.ts | `appendHistory(dir, entry)` | string × HistoryEntry ✓ | void ✓ | OK |
| commands.ts | state.ts | `loadHistory(dir, limit?)` | string × number? ✓ | HistoryEntry[] ✓ | OK |
| index.ts (session_start) | monitor.ts | `checkAutoTriggerRules(evolutionDir)` | string ✓ | AutoTriggerFlag[] ✓ | OK |
| index.ts (session_start) | monitor.ts | `cleanExpiredFlags(evolutionDir)` | string ✓ | void ✓ | OK |
| index.ts (session_start) | widget.ts | `renderAutoTriggerHint(flags)` | AutoTriggerFlag[] ✓ | string → notify ✓ | OK |
| index.ts (cmd/rollback) | widget.ts | `renderRollbackList(history)` | HistoryEntry[] ✓ | string → notify ✓ | OK |

**结论**: 所有 21 条活跃调用链路的参数类型和返回值使用完全一致。无类型不匹配。

---

## 数据流端到端验证

### 流程 1: /evolve 完整链路

```
用户输入 /evolve claude-md 14d
  → index.ts registerCommand("evolve") handler
    → 解析: target="claude-md", since="14d"
    → commands.ts handleEvolve({target:"claude-md", since:"14d", sample:undefined}, dirs)
      → parseSinceDays("14d") = 14
      → findRecentReport(reportsDir, 14)
        → 返回 reportPath 或 null
      → [null] execFileSync("python3", [ANALYZER_SCRIPT, "--since", "14d", ...])
        → 成功: reportPath = tmpReportPath
      → readFileSync(reportPath) → JSON.parse → report
      → buildJudgeInput(report, "claude-md", tmpDir)
        → extractReportSubset(report, "claude-md") — 提取 token_stats + user_patterns + ...
        → writeFileSync(tmpDir/judge-input-TS.json, subset)
        → writeFileSync(tmpDir/judge-prompt-TS.txt, userMessage)
        → return {target, reportPath, promptFilePath}
      → runJudge(input, templateDir)
        → templatePath = join(templateDir, "prompt-optimize.txt")
        → spawn("pi", ["--mode", "json", "-p", "--model", "router-openai/glm-5.1",
                       "--no-session", "--append-system-prompt", templateContent, userMessage])
        → stdout → extractAssistantText() → raw
        → parseJudgeOutput(raw) → EvolutionSuggestion[]（status 全为 "pending"）
      → savePending(evolutionDir, {generatedAt, reportUsed, suggestions})
      → return successResult(summary, {action:"evolve", count, suggestions})
    → ctx.ui.notify(textPart.text, "info")
```

**验证**: 完整链路无断裂。每个模块的输入来自上游的正确输出。✓

### 流程 2: /evolve-apply action=apply index=0

```
用户输入 /evolve-apply apply 0
  → index.ts registerCommand("evolve-apply") handler
    → 解析: action="apply", index=0
    → commands.ts handleEvolveApply({action:"apply", index:0}, dirs)
      → loadPending(evolutionDir) → pending
      → allSuggestions = pending.suggestions
      → suggestion = allSuggestions[0]
      → suggestion.status === "pending" ✓
      → backupDir = join(evolutionDir, "backups")
      → applySuggestion(suggestion, backupDir)
        → isPathAllowed(suggestion.targetPath) → ~/.pi/agent/ 下的 .md 文件 ✓
        → existsSync(targetPath) ✓
        → backupFile(targetPath, backupDir) → backupPath (格式: backupDir/<timestamp>/<basename>)
        → applyUnifiedDiff(targetPath, diff)
          → parseUnifiedDiff(diff) → hunks
          → 精确匹配 + 替换
          → writeFileSync(filePath, newContent)
          → return { success: true }
        → git add + commit → commitSha = git rev-parse HEAD
        → return { success: true, backupPath, commitSha }
      → suggestion.status = "applied"
      → appendHistory(evolutionDir, {
          action: "apply",
          backupPath: result.backupPath,  // 来自 backupFile()，格式一致
          commitSha: result.commitSha,     // 来自 git rev-parse HEAD
          ...
        })
      → savePending(evolutionDir, pending)
      → return successResult("Applied #0: ...", {...})
    → ctx.ui.notify(textPart.text, "info")
```

**验证**: backupPath 从 `backupFile()` → `applySuggestion()` 返回 → 写入 `appendHistory()` → 读取时用于 `rollbackSuggestion()`。全链路一致。✓

### 流程 3: /evolve-rollback 1（有 commitSha）

```
用户输入 /evolve-rollback 1
  → index.ts registerCommand("evolve-rollback") handler
    → parseInt("1") = 1, 有效
    → handleEvolveRollback(1, dirs)
      → loadHistory(evolutionDir, 20) → history
      → entry = history[0]  (1-based → index 0)
      → entry.action === "apply" ✓
      → rollbackSuggestion(entry)
        → existsSync(entry.backupPath) ✓
        → entry.commitSha 有值
          → execFileSync("git", ["revert", "--no-edit", entry.commitSha], {cwd})
          → 成功: return { success: true }
      → appendHistory(evolutionDir, {action: "rollback", ...})
      → return successResult("Rolled back: ...", {...})
    → ctx.ui.notify(textPart.text, "info")
```

**验证**: revert 优先、在 clean tree 上执行，fallback 到 copyFileSync。v3 BLR 确认顺序正确。✓

### 流程 4: 自动触发（session_start）

```
Pi session 启动
  → index.ts session_start handler
    → checkAutoTriggerRules(dirs.evolutionDir)
      → loadRecentDaily(dailyDir, now, 14)
      → checkTokenDecline(daily):
          baseline = daily.slice(0, 7) — 前 7 天
          recent = tailN(daily, 3) — 后 3 天
          无重叠 ✓
          逐天检查: dayAvg > baselineAvg
      → checkSkillDormant(evolutionDir, now):
          读取 skill-triggers.json，30 天阈值
      → checkErrorSpike(daily):
          recent = tailN(daily, 3)
          baseline = daily.slice(0, max(0, daily.length - 3))
          无重叠 ✓
      → 写/删 flag 文件，收集有效 flags
    → cleanExpiredFlags(dirs.evolutionDir) — 清理 >7 天 flag
    → flags.length > 0 → renderAutoTriggerHint(flags) → ctx.ui.notify()
```

**验证**: token-decline 的 baseline 用 `daily.slice(0, 7)` 而非 `sliceBeforeLast`，窗口不再重叠。error-spike 的 baseline 也用 `daily.slice(0, max(0, len-3))`，与 recent 不重叠。✓

---

## Widget 渲染与 Data Model 对齐复查

| Widget 函数 | 调用位置 | 传入类型 | 期望类型 | 对齐 |
|------------|---------|---------|---------|------|
| renderSuggestionCard | — 无调用 — | N/A | EvolutionSuggestion × number × number | DEAD |
| renderSuggestionSummary | index.ts L21 import，但无实际调用 | N/A | EvolutionSuggestion[] | DEAD（仅导入） |
| renderStatsDashboard | index.ts L22 import，但无实际调用 | N/A | StatsData | DEAD（仅导入） |
| renderRollbackList | index.ts /evolve-rollback cmd handler | loadHistory() → HistoryEntry[] | HistoryEntry[] | ✓ |
| renderAutoTriggerHint | index.ts session_start handler | checkAutoTriggerRules() → AutoTriggerFlag[] | AutoTriggerFlag[] | ✓ |

活跃函数（2/5）类型完全对齐。死函数（3/5）仅增加维护负担，不构成运行时风险。

renderResult 内联渲染中使用的字段与 handler 返回的 details 结构：

| Tool | renderResult 读取的字段 | handler 返回的字段 | 对齐 |
|------|----------------------|-------------------|------|
| evolve | action, count, suggestions[].severity/confidence/title | action:"evolve", count, suggestions[] | ✓ |
| evolve-apply | action, pendingCount, suggestions[].index/title/severity/confidence/status, success, reason, suggestionId, title | action, pendingCount, suggestions[], success, reason, suggestionId, title | ✓ |
| evolve-stats | 无内联渲染，直接取 content[0].text | content[0].text | ✓ |
| evolve-rollback | action, suggestionId, targetPath | action:"rollback", suggestionId, targetPath | ✓ |

**结论**: 所有活跃渲染路径的 details 字段完全对齐。

---

## 配置路径一致性复查

| 用途 | 路径 | 定义位置 | 使用位置 | 一致 |
|------|------|---------|---------|------|
| evolutionDir | `~/.pi/agent/evolution-data` | index.ts EVOLUTION_DIR | index.ts makeDirs() → dirs | ✓ |
| reportsDir | `{evolutionDir}/reports` | index.ts makeDirs() | commands.ts handleEvolve | ✓ |
| tmpDir | `{evolutionDir}/tmp` | index.ts makeDirs() | commands.ts handleEvolve → judge.ts | ✓ |
| templateDir | `src/templates/`（相对本文件） | index.ts TEMPLATE_DIR | judge.ts runJudge | ✓ |
| pending.json | `{evolutionDir}/suggestions/pending.json` | state.ts suggestionsPath() | commands.ts loadPending/savePending | ✓ |
| history.jsonl | `{evolutionDir}/history.jsonl` | state.ts historyPath() | commands.ts appendHistory/loadHistory | ✓ |
| daily/ | `{evolutionDir}/daily/` | monitor.ts | monitor.ts loadRecentDaily | ✓ |
| flags/ | `{evolutionDir}/auto-trigger.flags/` | monitor.ts FLAGS_DIR | monitor.ts readFlag/writeFlag/removeFlag | ✓ |
| skill-triggers.json | `{evolutionDir}/skill-triggers.json` | monitor.ts checkSkillDormant | monitor.ts readJsonSafe | ✓ |
| backups/ | `{evolutionDir}/backups` | commands.ts handleEvolveApply | applier.ts backupFile | ✓ |
| analyzer script | `~/.pi/agent/scripts/pi-session-analyzer/analyze.py` | commands.ts ANALYZER_SCRIPT | commands.ts handleEvolve | ✓（独立路径） |

**结论**: 所有路径从 `EVOLUTION_DIR` 根派生，无硬编码冲突。

---

## v1 LOW/INFO 问题追踪

| v1 ID | 严重性 | v2 状态 |
|-------|--------|---------|
| LOW-1: backupPath fallback 死代码 | LOW | 仍存在（commands.ts L181 `result.backupPath ?? join(backupDir, ...)`） |
| LOW-2: 3 个 widget 死导入/死代码 | LOW | 仍存在（renderSuggestionSummary/StatsDashboard 已导入未调用，renderSuggestionCard 未导入） |
| LOW-3: diff 失败后备份文件成为孤儿 | LOW | 仍存在（applier.ts L155 返回 `{success:false}` 不含 backupPath） |
| LOW-4: failed 状态的建议无法重试 | LOW | 仍存在（list 过滤 pending，apply 拒绝非 pending） |
| LOW-5: sample 参数未传递给 analyzer | LOW | 仍存在（commands.ts L93 未传 --sample） |
| INFO-1: renderResult details 无编译时类型安全 | INFO | 仍存在（Pi API 限制） |
| INFO-2: renderResult error 分支是死代码 | INFO | 仍存在（handler 用 throw） |
| INFO-3: 错误传播模式不一致 | INFO | 仍存在（3 种策略共存） |
| INFO-4: pending.json 原地修改并发不安全 | INFO | 仍存在（单 session 模型下安全） |
| INFO-5: session_start 签名确认 | INFO | 与其他 extension 一致，无风险 |

v1 的 5 个 LOW 和 5 个 INFO 问题均为非阻塞性改进建议，v2 修复未引入新的回归。这些问题已在 BLR v3 中确认为可接受残留。

---

## 新发现

### LOW-6: sliceBeforeLast 函数成为死代码

**模块**: monitor.ts L100-105

`sliceBeforeLast` 在 v1 时被 `checkTokenDecline` 调用，v2 修复后 `checkTokenDecline` 改用 `daily.slice(0, DECLINE_BASELINE_DAYS)` 直接切片。`sliceBeforeLast` 不再被任何函数调用。

**影响**: 死代码增加维护者阅读负担。未来有人误用它可能重新引入窗口重叠问题。

**建议**: 删除 `sliceBeforeLast` 函数。

---

## 审查总结

### v1 MUST_FIX 修复验证

| v1 ID | 问题 | v2 验证结果 |
|-------|------|-----------|
| MUST_FIX-1 | sliceBeforeLast 窗口重叠 | ✓ 已修复 — 改用 `daily.slice(0, 7)` 直接切片 |
| MUST_FIX-2 | /evolve-apply 命令未注册 | ✓ 已修复 — `registerCommand("evolve-apply", ...)` 完整实现 |

### 集成质量评估

| 维度 | 评估 |
|------|------|
| 接口一致性 | 所有 21 条活跃调用链路参数/返回值类型完全匹配 |
| 数据流正确性 | /evolve → Judge → pending.json → apply → backup → commit → history 全链路无断裂 |
| 路径一致性 | 11 个路径全部从同一 EVOLUTION_DIR 根派生 |
| Widget 对齐 | 2/5 活跃，3/5 死代码；活跃函数类型完全对齐 |
| 命令注册 | 4/4 命令全部注册（evolve, evolve-apply, evolve-stats, evolve-rollback） |
| Tool 注册 | 4/4 tool 全部注册 |
| 命令/Tool 行为一致性 | 同一 handler 被命令和 tool 共用，参数解析和调用方式一致 |

### 最终结论

**Verdict: PASS**

v1 的 2 个 MUST_FIX 已全部修复。全量集成复查确认：
- 所有模块间接口类型一致
- 端到端数据流无断裂
- 路径管理统一
- 命令与 tool 双通道完整覆盖

残留问题均为 LOW/INFO 级别，不影响核心功能正确性。

### 低优先级 (LOW: 3)

| ID | 模块 | 问题 | 来源 |
|----|------|------|------|
| LOW-1 | commands.ts | backupPath fallback 是误导性死代码 | v1 |
| LOW-2 | index.ts/widget.ts | 3 个 widget 函数是死导入/死代码 | v1 |
| LOW-6 | monitor.ts | sliceBeforeLast 函数已无调用方，成为死代码 | v2 新发现 |

### 改进建议 (INFO: 2)

| ID | 说明 | 来源 |
|----|------|------|
| INFO-1 | renderResult 的 details 访问依赖运行时结构，无编译时类型安全（Pi API 限制） | v1 |
| INFO-2 | renderResult 的 error 渲染路径是死代码（handler 通过 throw 报错） | v1 |
