---
verdict: fail
must_fix: 2
review_metrics:
  files_reviewed: 8
  issues_found: 9
  must_fix_count: 2
  low_count: 4
  info_count: 3
---

# Business Logic Review — Evolution Engine v2

**审查时间**: 2026-05-27
**审查范围**: v1 MUST_FIX 修复验证 + 全量回归检查
**审查文件**: types.ts, commands.ts, index.ts, applier.ts, monitor.ts, judge.ts, state.ts, widget.ts

---

## v1 MUST_FIX 修复验证

### MUST_FIX-1 (v1): TUI 逐条审批交互 — 已修复 (改为 per-call 模型)

**修复方式**: 从"批量 apply 所有 pending"改为 per-call `list/apply/skip` 三动作模型。

**验证**:
- `EvolveApplyCommandParams.action` 支持 `"list" | "apply" | "skip"` ✓
- `action=list`: 过滤 pending 建议，不做 apply ✓
- `action=apply` + `index`: 对单条建议执行 apply ✓
- `action=skip` + `index`: 对单条建议标记 rejected ✓
- 中途退出自然支持（不调用 tool 即停）✓

**残差问题**:
- "list" 返回的 details 缺少 `description`/`rationale`/`diff`（见新 MUST_FIX-2）
- "e (edit)" 操作未实现（spec 要求 y/n/e/q，降级为 LOW）

### MUST_FIX-2 (v1): backup 路径与 history 不一致 — 已修复 ✓

**修复方式**: `applySuggestion()` 返回 `{ backupPath, commitSha }`，`handleEvolveApply()` 使用 `result.backupPath` 写入 history。

**验证** (`commands.ts` L171):
```typescript
backupPath: result.backupPath ?? join(backupDir, `${suggestion.id}.bak`),
```
`result.backupPath` 由 `backupFile()` 返回实际路径。fallback 分支为死代码但不影响正确性。History 记录的路径与实际备份路径一致。Rollback 能找到备份文件。✓

### MUST_FIX-3 (v1): approved 状态过滤 — 已修复 (设计变更消除) ✓

**修复方式**: per-call 模型下，建议直接 `pending → applied/rejected/failed`，无中间 approved 状态。`handleEvolveApply` 的 apply 分支只检查 `status === "pending"` 在新模型下正确——用户每次只对一条 pending 建议决策。

### MUST_FIX-4 (v1): rollback 使用 git commit 而非 git revert — 部分修复

**修复方式**:
- `applySuggestion()` 记录 `commitSha`（通过 `git rev-parse HEAD`）✓
- `HistoryEntry` 增加 `commitSha?: string` 字段 ✓
- `rollbackSuggestion()` 优先使用 `git revert --no-edit <sha>` ✓

**新问题**: backup restore + git revert 执行顺序冲突（见新 MUST_FIX-1）。

### MUST_FIX-5 (v1): token-decline 逻辑 — 部分修复

**修复方式**:
- baseline 改为 `daily.slice(0, DECLINE_BASELINE_DAYS)`，取前 7 天 ✓
- 废弃 `sliceBeforeLast` ✓
- 改为逐天检查"每一天的 avg > baseline" ✓

**残差**: "连续 3 天高于基线" ≠ spec 的"连续 3 天上升"（逐天递增）。语义差异降级为 LOW。

---

## 新 MUST_FIX

### MUST_FIX-1: rollback 中 backup restore 与 git revert 执行顺序冲突

**位置**: `applier.ts:rollbackSuggestion()` L186-206

**问题**: 函数先从 backup 恢复文件（step 2），再尝试 `git revert`（step 3）。恢复文件后 working tree 变为 dirty（文件内容与 HEAD 不一致），`git revert` 检测到 dirty working tree 后拒绝执行：

```
error: your local changes to the following files would be overwritten by revert:
  <file>
Please commit your changes or stash them before you revert.
```

**后果**:
- 有 commitSha 时（主路径）: backup restore 成功，git revert 失败 → 文件恢复但无 git commit 记录，working tree 残留未提交变更
- 无 commitSha 时（fallback）: backup restore 成功，`git add + commit` 成功 → 文件恢复且有 git commit
- **悖论**: 有 commitSha（本应更好）反而比无 commitSha 的结果更差

**Spec 映射**: UC-3 Alt 6a "git revert 失败 → 文件已恢复，显示 warning"——spec 容忍 revert 失败，但实现中没有 warning 提示，且此失败是可避免的（只需调换顺序）。

**修复建议**:
```typescript
// 方案 A: 先 revert，失败再 fallback
if (entry.commitSha) {
    try {
        execFileSync("git", ["revert", "--no-edit", entry.commitSha], { cwd, stdio: "pipe" });
        return { success: true }; // revert 处理了文件恢复 + git commit
    } catch {
        // revert 失败（冲突等），fallback 到 backup restore
    }
}
// Fallback: backup restore + git add + commit
fs.copyFileSync(entry.backupPath, entry.targetPath);
execFileSync("git", ["add", entry.targetPath], { cwd, stdio: "pipe" });
execFileSync("git", ["commit", "-m", `evolve: rollback ${entry.title}`], { cwd, stdio: "pipe" });
```

---

### MUST_FIX-2: list action 返回的建议缺少 diff/rationale，用户无法做知情决策

**位置**: `commands.ts:handleEvolveApply()` — action === "list" 分支

**Spec UC-1 Step 7**: "TUI 逐条展示建议卡片（标题、严重程度、置信度、原因、diff 预览）"
**Spec UC-1 Step 8**: "用户对每条建议输入 y/n" — 决策依据是完整信息

**当前 list 返回的 details**:
```typescript
{
    index, id, title, severity, confidence,
    target, targetPath, status
}
```

**缺失字段**: `description`, `rationale`, `diff`

**影响**: AI agent 调用 `evolve-apply action=list` 后，只能向用户展示标题和置信度。用户不知道建议的具体内容、原因和将要做的改动，无法做出有意义的 apply/skip 决策。Per-call 审批模型的核心价值——知情决策——无法实现。

**修复建议**: list response 的 suggestions 数组中增加 `description`、`rationale`（截取前 200 字符）和 `diffPreview`（diff 前 10 行）：
```typescript
suggestions: pendingItems.map(({ suggestion, index }) => ({
    index, id, title, severity, confidence, target, targetPath, status,
    description: suggestion.description,
    rationale: suggestion.rationale.split("\n")[0]?.slice(0, 200),
    diffPreview: suggestion.diff.split("\n").slice(0, 10).join("\n"),
})),
```

---

## 残留 LOW (from v1)

### LOW-1: claude-md target 包含额外字段 — 未修复

`judge.ts:extractReportSubset()` 仍然包含 `tool_stats` 和 `error_stats`。无功能危害，与 spec 定义不一致。

### LOW-2: stats 缺少趋势箭头 — 未修复

`handleEvolveStats()` 只聚合 7 天数据，不对比前 7 天。

### LOW-5: --sample 参数未传递 — 未修复

`handleEvolve()` 中 `params.sample` 未传递给 analyze.py 命令。

### LOW-6: token-decline "above baseline" vs "monotonically increasing"

v1 MUST_FIX-5 的残差。`checkTokenDecline()` 检查"最近 3 天每一天 > 7 天基线"，spec 原文"连续 3 天上升"语义更偏向逐天递增趋势。当前实现对"效率持续偏高"场景有效，但对"先高后低但仍高于基线"的场景会误触发。建议后续确认 spec 意图后统一。

---

## 新 LOW

### LOW-7: "e (edit)" 操作未实现

**Spec UC-1 Step 8**: y（应用）/ n（跳过）/ e（编辑）/ q（退出）。实现只有 list/apply/skip，无 edit。

edit 需要修改 diff 内容后 apply，在 Pi tool 模型中实现成本高。建议 defer 到后续迭代，或在 description 中标注 edit 暂不支持。

### LOW-8: "approved" status 是死代码

`EvolutionSuggestion.status` 定义了 `"approved"` 但从未被赋值。Per-call 模型下 suggestion 直接 `pending → applied/rejected/failed`，不需要中间 approved 状态。建议从联合类型中移除，避免误导。

---

## 新 INFO

### INFO-6: git revert 冲突时的用户感知

v1 MUST_FIX-4 修复后，`git revert --no-edit` 在有多方冲突时会自动失败（revert 本身不支持 `--no-commit` + 手动解决路径）。当前 try/catch 吞掉了错误，用户不知道 revert 因冲突失败而走了 backup restore fallback。建议在 rollback 结果中记录 git 操作的实际路径（revert / backup+commit / 仅backup）。

### INFO-7: parseJudgeOutput 对 target "skill"（单数）的校验

`judge.ts:parseJudgeOutput()`:
```typescript
if (target !== "claude-md" && target !== "skill") continue;
```
但 `EvolutionSuggestion.target` 类型是 `"claude-md" | "skill"`。而 `JudgeInput.target` 和 `EvolveCommandParams.target` 用的是 `"skills"`（复数）。LLM Judge 输出中 target 字段是 "skill" 还是 "skills"？如果 LLM 输出 "skills"（与命令参数一致），parseJudgeOutput 会过滤掉所有 skills 类建议。

### INFO-8: renderSuggestionSummary 已导入但未被调用

`index.ts` 导入了 `renderSuggestionSummary` 但 tool renderResult 使用内联渲染逻辑。`widget.ts:renderSuggestionSummary()` 是死代码。

---

## 模拟执行路径验证（回归）

### 路径 1: /evolve 全流程（正常路径）

```
1. findRecentReport → 找到报告
2. buildJudgeInput → 提取子集，写临时文件
3. runJudge → spawn pi → parseJudgeOutput → 3 条建议
4. savePending → pending.json
5. 返回: "Generated 3 evolution suggestion(s). Use /evolve-apply action=list..."
✓ 正确
```

### 路径 2: /evolve-apply action=list

```
1. loadPending → 3 条 pending 建议
2. filter(status === "pending") → 3 条
3. 返回: summary (index/title/severity/confidence)
⚠️ 缺少 diff/rationale（MUST_FIX-2）
```

### 路径 3: /evolve-apply action=apply index=0

```
1. loadPending → 建议列表
2. suggestion = allSuggestions[0]
3. check status === "pending" ✓
4. applySuggestion(suggestion, backupDir)
   a. isPathAllowed → true
   b. backupFile → backups/2026-05-27T12-00-00/CLAUDE.md → 返回 backupPath
   c. applyUnifiedDiff → 成功
   d. execFileSync("git", ["add", ...]) + execFileSync("git", ["commit", ...]) → commitSha
   e. return { success: true, backupPath, commitSha }
5. suggestion.status = "applied"
6. appendHistory: backupPath = result.backupPath（一致）✓, commitSha = result.commitSha ✓
7. savePending
✓ 正确
```

### 路径 4: /evolve-rollback 1

```
1. loadHistory(20) → [ { action: "apply", backupPath: "backups/.../CLAUDE.md", commitSha: "abc123" } ]
2. rollbackSuggestion(entry):
   a. fs.existsSync(backupPath) → true ✓
   b. fs.copyFileSync(backupPath, targetPath) → 文件已恢复
   c. git revert --no-edit abc123
      → 失败！working tree dirty（步骤 b 已修改文件）
      → catch 吞掉错误
   d. return { success: true }
3. appendHistory(rollback record)
4. 返回 "Rolled back: ..."
⚠️ 文件恢复正确，但 git 无 rollback commit（MUST_FIX-1）
```

---

## 审查总结

### v1 修复状态

| v1 ID | 问题 | v2 状态 |
|-------|------|---------|
| MUST_FIX-1 | 逐条审批 | 已修复（per-call 模型） |
| MUST_FIX-2 | backup 路径不一致 | 已修复 |
| MUST_FIX-3 | approved 过滤 | 已修复（设计消除） |
| MUST_FIX-4 | git revert | 部分修复（新顺序问题） |
| MUST_FIX-5 | token-decline 逻辑 | 部分修复（语义残差降 LOW） |

### v2 必须修复 (MUST_FIX: 2)

| ID | 问题 | 严重性 |
|----|------|--------|
| MUST_FIX-1 | rollback backup restore 在 git revert 之前导致 revert 必失败 | 阻塞 |
| MUST_FIX-2 | list action 缺少 diff/rationale，审批无决策依据 | 阻塞 |

### 低优先级 (LOW: 4)

| ID | 问题 |
|----|------|
| LOW-1 | claude-md target 包含额外字段 (v1 残留) |
| LOW-6 | token-decline "above baseline" vs "monotonically increasing" (v1→v2 降级) |
| LOW-7 | "e (edit)" 操作未实现 |
| LOW-8 | "approved" status 死代码 |

### 改进建议 (INFO: 3)

| ID | 说明 |
|----|------|
| INFO-6 | rollback git 操作路径对用户不可见 |
| INFO-7 | parseJudgeOutput 对 target "skill" vs "skills" 单复数可能过滤错误 |
| INFO-8 | renderSuggestionSummary 导入未使用（死代码） |
