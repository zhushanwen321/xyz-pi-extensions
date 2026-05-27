---
verdict: fail
must_fix: 2
review_metrics:
  files_reviewed: 8
  issues_found: 12
  must_fix_count: 2
  low_count: 5
  info_count: 5
---

# Integration Review — Evolution Engine v1

**审查时间**: 2026-05-27
**审查范围**: 8 个源码模块间的接口调用、数据流、配置一致性和 widget 对齐
**参照**: business_logic_review_v1.md（BLR）
**审查文件**: types.ts, state.ts, judge.ts, applier.ts, monitor.ts, commands.ts, index.ts, widget.ts

---

## 模块依赖图与调用链路

```
index.ts (工厂)
  ├──→ commands.ts (4 个 handler)
  │      ├──→ judge.ts (buildJudgeInput, runJudge)
  │      ├──→ applier.ts (applySuggestion, rollbackSuggestion)
  │      └──→ state.ts (loadPending, savePending, appendHistory, loadHistory)
  ├──→ monitor.ts (checkAutoTriggerRules, cleanExpiredFlags)
  ├──→ state.ts (loadHistory) — command handler 直接调用
  └──→ widget.ts (renderRollbackList, renderAutoTriggerHint)
         ⚠️ renderSuggestionSummary, renderStatsDashboard 已导入但未使用
```

---

## BLR 关键纠偏

在进入集成分析前，先纠正 BLR 中的 3 个误判：

### 纠偏-1: BLR MUST_FIX-2（backup 路径不一致）— 不成立

BLR 声称 "history 记录的 `backups/uuid.bak` 与 `backupFile()` 返回的 `backups/<timestamp>/<basename>` 不一致"。

**实际代码路径分析**:

1. `applier.ts:applySuggestion()` 调用 `backupFile()` → 返回 `backupPath`（格式 `backupDir/<timestamp>/<basename>`）
2. 成功时返回 `{ success: true, backupPath, commitSha }` — `backupPath` 必定有值
3. `commands.ts:handleEvolveApply()` 写入 history: `result.backupPath ?? join(backupDir, "${suggestion.id}.bak")`
4. 由于 `result.backupPath` 在成功路径上**始终有值**，fallback `join(backupDir, ...)` 是**不可达的死代码**

**结论**: backupPath 在成功路径上正确传播。BLR 的 "rollback 永远找不到备份文件" 结论不成立。fallback 路径虽然误导性很强（见 LOW-1），但不构成运行时 bug。

### 纠偏-2: BLR MUST_FIX-4（git revert 缺失）— 不成立

BLR 声称 "使用 git add + commit 而非 git revert"。

**实际代码** (`applier.ts:rollbackSuggestion()`):
```typescript
if (entry.commitSha) {
    execFileSync("git", ["revert", "--no-edit", entry.commitSha], { cwd, stdio: "pipe" });
} else {
    // fallback: add + commit
}
```

数据流验证:
1. `applySuggestion()` → git commit 成功 → `execFileSync("git", ["rev-parse", "HEAD"])` → 获取 `commitSha`
2. `handleEvolveApply()` → 写入 `HistoryEntry.commitSha = result.commitSha`
3. `handleEvolveRollback()` → 加载 HistoryEntry → 传入 `rollbackSuggestion(entry)`
4. `rollbackSuggestion()` → `entry.commitSha` 有值 → 执行 `git revert`

**结论**: 完整的 `commit → record SHA → revert by SHA` 链路已正确实现。BLR 只看到了 fallback 路径的 `add + commit`，忽略了主路径的 `git revert`。

### 纠偏-3: BLR MUST_FIX-5（token-decline 逻辑）— 严重性被低估

BLR 正确指出了 `sliceBeforeLast` 的窗口偏移问题，但分析不够深入。

**实际 bug 更严重**: `sliceBeforeLast` 函数返回的 baseline 窗口与 recent 窗口**完全重叠**。

推导过程（14 天 daily 数据，DECLINE_RECENT_DAYS=3，DECLINE_BASELINE_DAYS=7）:
- `sliceBeforeLast(daily, 3, 7)`: start = 14-3 = 11, end = 11+7 = 18 → clamp 到 14 → `daily[11..13]`（3 个元素）
- `tailN(daily, 3)`: `daily[11..13]`（3 个元素）
- **baseline === recent**（完全相同的数据）

根本原因: `sliceBeforeLast` 的 `start = arr.length - totalLast` 取的是 recent 窗口的起始位置，而非 recent 窗口之前的结束位置。正确实现应为 `start = max(0, arr.length - totalLast - sliceLen), end = arr.length - totalLast`。

**影响**: 不是 "窗口偏移" 的精度问题，而是 **baseline 和 recent 是同一组数据**。token-decline 规则的检查退化为 "最近 3 天中每天是否都高于自身的平均"，这是一个统计上的随机事件，而非有意义的趋势检测。

此问题在下面 MUST_FIX-1 中记录。

---

## MUST_FIX

### MUST_FIX-1: sliceBeforeLast 使 baseline 与 recent 窗口完全重叠

**模块**: monitor.ts → checkTokenDecline

**问题描述**: `sliceBeforeLast(daily, DECLINE_RECENT_DAYS, DECLINE_BASELINE_DAYS)` 的计算逻辑有误。`start = arr.length - totalLast` 定位到了 recent 窗口的起始位置，而非 recent 窗口之前的位置。由于 `start + sliceLen` 超出数组长度后被 `Array.slice` 截断，返回的元素数量远少于预期的 7 个，实际最多返回 `totalLast` 个（3 个），且与 recent 窗口完全重叠。

**影响**: token-decline 自动触发规则在正常数据下表现为随机触发（取决于 3 天内数据的方差），无法可靠检测效率下降趋势。

**修复建议**:
```typescript
function sliceBeforeLast<T>(arr: T[], totalLast: number, sliceLen: number): T[] {
    const end = arr.length - totalLast;
    if (end <= 0) return [];
    const start = Math.max(0, end - sliceLen);
    return arr.slice(start, end);
}
```

### MUST_FIX-2: `/evolve-apply` 命令未注册

**模块**: index.ts

**问题描述**: `evolve-apply` 已通过 `pi.registerTool()` 注册为 AI 可调用的 tool，但 `index.ts` 中没有对应的 `pi.registerCommand("evolve-apply", ...)`。

**现有命令注册**:
- `pi.registerCommand("evolve", ...)` — 有
- `pi.registerCommand("evolve-stats", ...)` — 有
- `pi.registerCommand("evolve-rollback", ...)` — 有
- `pi.registerCommand("evolve-apply", ...)` — **缺失**

**用户可见影响**: 
- `handleEvolve()` 输出文本 "Use /evolve-apply action=list to review details"
- `renderSuggestionSummary()` 输出 "Use /evolve-apply action=list..."
- `renderResult` for evolve-apply tool 显示 "Use /evolve-apply action=apply index=<N>..."
- 用户在终端输入 `/evolve-apply` 得不到任何响应

AI agent 可以通过 tool call 调用 `evolve-apply`，但直接使用命令的用户无法触发。

**修复建议**: 添加 `pi.registerCommand("evolve-apply", ...)` handler，参照 `/evolve-rollback` 的命令注册模式，解析 `action=list|apply|skip` 和 `index=N` 参数。

---

## LOW

### LOW-1: backupPath fallback 路径是误导性死代码

**模块**: commands.ts → handleEvolveApply

**代码**:
```typescript
backupPath: result.backupPath ?? join(backupDir, `${suggestion.id}.bak`),
```

`result.backupPath` 在 `applySuggestion()` 成功路径上始终有值（来自 `backupFile()` 返回值），因此 fallback `join(backupDir, "${suggestion.id}.bak")` 是不可达代码。这段 fallback 路径的格式（`uuid.bak`）与 `backupFile()` 的格式（`<timestamp>/<basename>`）完全不同，会误导维护者认为存在路径不一致问题。

**建议**: 移除 fallback，改为 `result.backupPath!`（成功时必定有值）或添加注释说明。

### LOW-2: renderSuggestionSummary 和 renderStatsDashboard 是死导入

**模块**: index.ts → widget.ts

**分析**:
- `index.ts` 导入了 `renderSuggestionSummary` 和 `renderStatsDashboard`
- `evolve` tool 的 `renderResult` 使用**内联渲染**，未调用 `renderSuggestionSummary`
- `evolve-stats` tool 的 `renderResult` 直接使用 `result.content[0].text`，未调用 `renderStatsDashboard`
- `renderSuggestionCard`（widget.ts）甚至**未被导入**，完全孤立

**影响**: widget.ts 中 3 个函数是死代码。TUI 渲染路径与 widget 模块的设计意图不一致。如果未来修改 widget 函数签名，index.ts 的内联渲染不会同步更新。

**建议**: 统一渲染路径——要么在 renderResult 中调用 widget 函数，要么删除 widget 中的死函数。

### LOW-3: applyUnifiedDiff 失败后备份文件成为孤儿

**模块**: applier.ts → applySuggestion

**执行路径**:
1. `backupFile(targetPath, backupDir)` → 创建备份 → 返回 `backupPath`
2. `applyUnifiedDiff(targetPath, diff)` → 失败 → 返回 `{ success: false, reason: "diff conflict" }`
3. `applySuggestion` 返回 `{ success: false, reason }` — **不包含 `backupPath`**

此时磁盘上存在一个无主备份文件（格式 `backupDir/<timestamp>/<basename>`），没有任何代码能找到或清理它。多次重试会产生多个孤儿备份。

**影响**: 资源泄漏，长期运行后 `backups/` 目录膨胀。

**建议**: diff 失败时清理已创建的备份，或返回 `backupPath` 让调用方决定是否清理。

### LOW-4: failed 状态的建议无法重试

**模块**: commands.ts → handleEvolveApply

**流程**:
1. `applySuggestion()` 返回 `{ success: false, reason: "diff conflict" }`
2. `suggestion.status = "failed"`
3. `savePending()` 写入 pending.json
4. 下次 `/evolve-apply action=list` 过滤 `status === "pending"` → failed 的不显示
5. 下次 `/evolve-apply action=apply index=N` → 检查 `suggestion.status !== "pending"` → 抛错

**影响**: 一条建议一旦进入 "failed" 状态，用户无法看到它（list 不显示），也无法重试它（apply 拒绝非 pending）。该建议永久卡在 pending.json 中。

**建议**: 要么在 list 中也显示 failed 建议，要么为 failed 建议提供 reset 到 pending 的路径。

### LOW-5: sample 参数流经全链路但从未使用

**模块**: index.ts → commands.ts → (未传递给 analyzer)

**数据流**:
1. `EvolveParams` schema 定义 `sample: Type.Optional(Type.Number())`
2. `execute()` 传入 `{ ..., sample: params.sample }` → `EvolveCommandParams.sample`
3. `handleEvolve(params, dirs)` 接收 `params.sample` 但**不传递给 analyzer 命令**

```typescript
execSync(
    `python3 "${ANALYZER_SCRIPT}" --since ${params.since} --format json --output "${tmpReportPath}"`,
    { timeout: ANALYZER_TIMEOUT_MS, stdio: "pipe" },
);
```

`--sample` 参数缺失。参数通过了 schema 验证和类型传播，但在最终执行点被丢弃。

---

## INFO

### INFO-1: renderResult 的 details 类型安全依赖运行时结构

**模块**: index.ts — 所有 tool 的 renderResult

`CommandResult.details` 类型为 `Record<string, unknown>`，但 `renderResult` 回调通过 `details.action`、`details.suggestions`、`details.success` 等字段直接访问，依赖运行时结构匹配：

```typescript
const details = result.details as {
    action?: string;
    count?: number;
    suggestions?: Array<{...}>;
    // ...
} | undefined;
```

如果 handler 返回的 details 结构变更（如字段重命名），renderResult 不会在编译时报错。这是 Pi Extension API 的已知限制（execute 返回 details，renderResult 消费 details，两者无编译时关联）。

### INFO-2: renderResult 中的 error 渲染路径是死代码

**模块**: index.ts — evolve, evolve-apply, evolve-rollback, evolve-stats 的 renderResult

每个 renderResult 都有:
```typescript
if (details?.error) {
    return new Text(theme.fg("error", `Error: ${details.message ?? "unknown"}`), 0, 0);
}
```

但所有 handler 通过 `throw new Error()` 报错（不返回 `details.error = true`）。错误由 Pi 框架捕获和渲染，不经过 renderResult。此分支在正常流程中不可达。

### INFO-3: 错误传播模式不一致

| 模块 | 错误策略 | 使用方处理方式 |
|------|---------|-------------|
| judge.ts | `throw new Error()` / `reject()` | commands.ts try/catch |
| applier.ts | 返回 `{ success: false, reason }` | commands.ts 检查 `result.success` |
| state.ts | 返回 `null` / 跳过损坏行 | commands.ts 检查 `null` |
| monitor.ts | 返回 `{ hit: false }` | index.ts 只收集 `hit: true` |

三种不同的错误策略共存。这不是 bug（commands.ts 对每种策略都有对应的处理），但增加了维护者的认知负担。

### INFO-4: handleEvolveApply 对 pending.json 的原地修改

`loadPending()` 返回解析后的 JSON 对象。`handleEvolveApply` 通过 `pending.suggestions[params.index]` 直接修改对象属性（如 `suggestion.status = "applied"`），然后 `savePending()` 序列化回文件。

在 Pi 的单 session 执行模型下这是安全的。但如果未来支持并发 tool 调用，两次 apply 操作可能读取同一份 pending.json，互相覆盖对方的修改。

### INFO-5: session_start 事件 handler 签名

```typescript
pi.on("session_start", async (_event, ctx) => {
```

参数签名为 `(event, ctx)`。需确认 Pi Extension API 的 `session_start` 事件回调签名是否匹配。其他 extension（如 usage-tracker）的用法可作为参照。签名不匹配会导致 `ctx` 实际接收 event 对象，`ctx.hasUI` 和 `ctx.ui.notify()` 调用会运行时报错。

---

## 模块间接口一致性总表

| 调用方 | 被调用方 | 接口 | 参数类型匹配 | 返回值使用 | 状态 |
|--------|---------|------|-------------|-----------|------|
| index.ts | commands.ts | handleEvolve(params, dirs) | EvolveCommandParams × Dirs → OK | CommandResult → renderResult OK | OK |
| index.ts | commands.ts | handleEvolveApply(params, dirs) | EvolveApplyCommandParams × Dirs → OK | CommandResult → renderResult OK | OK |
| index.ts | commands.ts | handleEvolveStats(evolutionDir) | string → OK | CommandResult → renderResult OK | OK |
| index.ts | commands.ts | handleEvolveRollback(index, dirs) | number × Dirs → OK | CommandResult → renderResult OK | OK |
| commands.ts | judge.ts | buildJudgeInput(report, target, tmpDir) | Record<string,unknown> × target × string → OK | JudgeInput → OK | OK |
| commands.ts | judge.ts | runJudge(input, templateDir) | JudgeInput × string → OK | Promise<EvolutionSuggestion[]> → OK | OK |
| commands.ts | applier.ts | applySuggestion(suggestion, backupDir) | EvolutionSuggestion × string → OK | Promise<ApplyResult> → OK | OK |
| commands.ts | applier.ts | rollbackSuggestion(entry) | HistoryEntry → OK | Promise<RollbackResult> → OK | OK |
| commands.ts | state.ts | loadPending(dir) | string → OK | PendingFile\|null → OK | OK |
| commands.ts | state.ts | savePending(dir, pending) | string × PendingFile → OK | void → OK | OK |
| commands.ts | state.ts | appendHistory(dir, entry) | string × HistoryEntry → OK | void → OK | OK |
| commands.ts | state.ts | loadHistory(dir, limit?) | string × number? → OK | HistoryEntry[] → OK | OK |
| index.ts | monitor.ts | checkAutoTriggerRules(evolutionDir) | string → OK | AutoTriggerFlag[] → OK | OK |
| index.ts | monitor.ts | cleanExpiredFlags(evolutionDir) | string → OK | void → OK | OK |
| index.ts | widget.ts | renderRollbackList(history) | HistoryEntry[] → OK | string → notify OK | OK |
| index.ts | widget.ts | renderAutoTriggerHint(flags) | AutoTriggerFlag[] → OK | string → notify OK | OK |
| index.ts | widget.ts | renderSuggestionSummary | — 未调用 — | — | DEAD |
| index.ts | widget.ts | renderStatsDashboard | — 未调用 — | — | DEAD |

**结论**: 所有活跃接口的参数和返回值类型完全一致。无类型不匹配。

---

## 配置路径一致性

| 用途 | 路径 | 定义位置 | 一致性 |
|------|------|---------|--------|
| evolutionDir | `~/.pi/agent/evolution-data` | index.ts:EVOLUTION_DIR | 根路径 |
| reportsDir | `{evolutionDir}/reports` | index.ts:makeDirs() | OK |
| tmpDir | `{evolutionDir}/tmp` | index.ts:makeDirs() | OK |
| templateDir | `src/templates/` (相对本文件) | index.ts:TEMPLATE_DIR | OK |
| pending.json | `{evolutionDir}/suggestions/pending.json` | state.ts:suggestionsPath() | OK |
| history.jsonl | `{evolutionDir}/history.jsonl` | state.ts:historyPath() | OK |
| daily/ | `{evolutionDir}/daily/` | monitor.ts | OK |
| flags/ | `{evolutionDir}/auto-trigger.flags/` | monitor.ts:FLAGS_DIR | OK |
| skill-triggers.json | `{evolutionDir}/skill-triggers.json` | monitor.ts | OK |
| backups/ | `{evolutionDir}/backups/` | commands.ts:handleEvolveApply | OK |
| analyzer script | `~/.pi/agent/scripts/pi-session-analyzer/analyze.py` | commands.ts:ANALYZER_SCRIPT | 独立于 evolutionDir |

**结论**: 所有路径从同一个 `evolutionDir` 根派生，无硬编码路径冲突。analyzer 脚本路径是独立的（不属于 evolution-data 目录），设计合理。

---

## Widget 渲染与 Data Model 对齐

| Widget 函数 | 期望类型 | 实际调用时传入类型 | 对齐 |
|------------|---------|-----------------|------|
| renderSuggestionCard | EvolutionSuggestion × number × number | **从未调用** | N/A |
| renderSuggestionSummary | EvolutionSuggestion[] | **从未调用** | N/A |
| renderStatsDashboard | StatsData | **从未调用** | N/A |
| renderRollbackList | HistoryEntry[] | loadHistory() → HistoryEntry[] | OK |
| renderAutoTriggerHint | AutoTriggerFlag[] | checkAutoTriggerRules() → AutoTriggerFlag[] | OK |

5 个 widget 函数中 3 个是死代码。活跃的 2 个（renderRollbackList、renderAutoTriggerHint）类型完全对齐。

renderResult 中对 details 的内联渲染使用的字段（`details.suggestions[].severity`、`details.suggestions[].confidence` 等）与 handler 返回的 details 结构一致，无字段缺失或类型不匹配。

---

## 审查总结

### 必须修复 (MUST_FIX: 2)

| ID | 模块 | 问题 | 影响 |
|----|------|------|------|
| MUST_FIX-1 | monitor.ts | sliceBeforeLast 使 baseline 与 recent 窗口完全重叠，token-decline 规则失效 | 自动触发功能退化为随机触发 |
| MUST_FIX-2 | index.ts | `/evolve-apply` 命令未注册，用户无法通过命令触发 apply 操作 | UX 断裂 |

### 低优先级 (LOW: 5)

| ID | 模块 | 问题 |
|----|------|------|
| LOW-1 | commands.ts | backupPath fallback 是误导性死代码（BLR MUST_FIX-2 的实际根源） |
| LOW-2 | index.ts/widget.ts | 3 个 widget 函数是死导入/死代码 |
| LOW-3 | applier.ts | diff 失败后备份文件成为孤儿 |
| LOW-4 | commands.ts | failed 状态的建议无法重试，永久卡在 pending.json |
| LOW-5 | commands.ts | sample 参数流经全链路但未传递给 analyzer |

### 改进建议 (INFO: 5)

| ID | 说明 |
|----|------|
| INFO-1 | renderResult 的 details 访问依赖运行时结构，无编译时保障 |
| INFO-2 | renderResult 的 error 渲染路径是死代码（handler 通过 throw 报错） |
| INFO-3 | 错误传播模式不一致（throw / return error / return null 三种） |
| INFO-4 | handleEvolveApply 对 pending.json 的原地修改在并发场景下不安全 |
| INFO-5 | session_start 事件签名需与 Pi Extension API 确认 |

### BLR 纠偏汇总

| BLR ID | BLR 结论 | 实际情况 | 原因 |
|--------|---------|---------|------|
| MUST_FIX-2 | backupPath 不一致导致 rollback 必定失败 | **不成立** — 成功路径上 backupPath 正确传播 | 未追踪 `result.backupPath` 的赋值来源 |
| MUST_FIX-4 | rollback 使用 git commit 而非 git revert | **不成立** — commitSha 存在时正确使用 git revert | 只看了 fallback 路径，未追踪 commitSha 数据流 |
| MUST_FIX-5 | sliceBeforeLast 窗口偏移 | **严重性被低估** — baseline 与 recent 完全重叠，非偏移 | 未手动推导 sliceBeforeLast 的实际返回值 |
