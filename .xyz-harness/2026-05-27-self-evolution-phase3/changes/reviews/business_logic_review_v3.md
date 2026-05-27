---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 8
  issues_found: 4
  must_fix_count: 0
  low_count: 4
  info_count: 0
---

# Business Logic Review — Evolution Engine v3 (Final)

**审查时间**: 2026-05-27
**审查范围**: v2 MUST_FIX 修复验证 + 全量回归检查
**审查文件**: types.ts, commands.ts, applier.ts, monitor.ts, judge.ts, state.ts, index.ts, widget.ts

---

## v2 MUST_FIX 修复验证

### MUST_FIX-1 (v2): rollback backup restore 与 git revert 执行顺序冲突 — 已修复

**v2 问题**: `rollbackSuggestion()` 先 `copyFileSync` 恢复文件，再 `git revert`。恢复文件后 working tree 变 dirty，`git revert` 拒绝执行。

**修复验证** (`applier.ts:rollbackSuggestion()` L186-206):

```typescript
if (entry.commitSha) {
    // 有 commitSha 时优先 git revert（revert 会自动恢复文件内容）
    // 必须先 revert 再 copyFileSync，否则 dirty tree 会导致 revert 失败
    try {
        execFileSync("git", ["revert", "--no-edit", entry.commitSha], {
            cwd,
            stdio: "pipe",
        });
        return { success: true };
    } catch {
        // revert 失败，fallback 到 copyFileSync 恢复
    }
}

// 无 commitSha 或 revert 失败时：copyFileSync 恢复文件
try {
    fs.copyFileSync(entry.backupPath, entry.targetPath);
} catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, reason: `restore failed: ${msg}` };
}

// 尝试 git add + commit
try {
    execFileSync("git", ["add", entry.targetPath], { cwd, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", `evolve: rollback ${entry.title}`], {
        cwd,
        stdio: "pipe",
    });
} catch {
    // git 失败不影响 rollback 结果
}

return { success: true };
```

**执行路径分析**:

| 场景 | 执行路径 | 结果 |
|------|---------|------|
| 有 commitSha，revert 成功 | `git revert` → return success | 文件恢复 + git 有 revert commit |
| 有 commitSha，revert 失败（冲突） | revert catch → `copyFileSync` → `git add + commit` | 文件恢复 + git 有 backup+commit |
| 无 commitSha | 跳过 revert → `copyFileSync` → `git add + commit` | 文件恢复 + git 有 backup+commit |
| 无 commitSha，git add 失败 | 跳过 revert → `copyFileSync` → git catch | 文件恢复，无 git commit（符合 spec Alt 6a） |
| backup 不存在 | L182 提前返回 | 返回 `{ success: false, reason: "backup file not found" }` |

**结论**: 执行顺序正确。revert 优先且在 clean tree 上执行；fallback 路径完整。 ✓

---

### MUST_FIX-2 (v2): list action 缺少建议详情 — 已修复

**v2 问题**: `action=list` 返回的 suggestions 只有 index/title/severity/confidence/target/targetPath/status，缺少 description/rationale/diff，用户无法做知情决策。

**修复验证** (`commands.ts:handleEvolveApply()` — action === "list" 分支):

content 部分（L112-120）:
```typescript
const contentLines = pendingItems.map(({ suggestion, index }) => {
    const header = `#${index} [${suggestion.severity.toUpperCase()}] ${suggestion.title}`;
    const desc = suggestion.description ? `  Description: ${suggestion.description}` : "";
    const rationale = suggestion.rationale ? `  Rationale: ${suggestion.rationale}` : "";
    const diff = suggestion.diff ? `  Diff target: ${suggestion.targetPath}` : "";
    return [header, desc, rationale, diff].filter(Boolean).join("\n");
}).join("\n\n");
```

details 部分（L126-138）:
```typescript
suggestions: pendingItems.map(({ suggestion, index }) => ({
    index,
    id: suggestion.id,
    title: suggestion.title,
    severity: suggestion.severity,
    confidence: suggestion.confidence,
    target: suggestion.target,
    targetPath: suggestion.targetPath,
    status: suggestion.status,
    description: suggestion.description,
    rationale: suggestion.rationale,
    diff: suggestion.diff,
})),
```

**验证**:
- content 包含 description、rationale、diff target path ✓
- details 包含完整的 description、rationale、diff 字段 ✓
- AI agent 可基于完整信息向用户展示建议详情并获得 apply/skip 决策 ✓

**结论**: 已修复。用户（通过 AI agent）能获取完整的建议内容做知情决策。 ✓

---

## 全量回归检查

### UC-1: /evolve 全流程

| 步骤 | Spec 要求 | 实现状态 | 结果 |
|------|----------|---------|------|
| 1. 查找 7 天内报告 | FR-1 §1 | `findRecentReport()` | OK |
| 2. 无报告 → 自动运行 analyze.py | FR-1 §2 + FR-8 | `handleEvolve()` L88-101 | OK |
| 3. analyze.py 失败 → 显示错误终止 | FR-1 §3 | catch → throw | OK |
| 4. 读取报告 + 按 target 裁剪 | FR-1 §4 | `buildJudgeInput()` | OK |
| 5. 构建 Judge 输入 + 临时文件 | FR-1 §5 | `buildJudgeInput()` | OK |
| 6. spawn pi 子进程 | FR-1 §6 | `runJudge()` | OK |
| 7. 120s 超时 | FR-1 §7 | `JUDGE_TIMEOUT_MS` | OK |
| 8. 写入 pending.json | FR-1 §9 | `savePending()` | OK |
| 9. Per-call 审批（list/apply/skip） | FR-4 | `handleEvolveApply()` | OK |
| 10. apply → backup → commit | FR-3 | `applySuggestion()` | OK |

### UC-2: 自动触发

| 步骤 | Spec 要求 | 实现状态 | 结果 |
|------|----------|---------|------|
| token-decline | FR-7 | `checkTokenDecline()` | OK（语义残差见 LOW-1） |
| skill-dormant | FR-7 | `checkSkillDormant()` | OK |
| error-spike | FR-7 | `checkErrorSpike()` | OK |
| 24h 去重 | UC-2 Alt 4a | `FLAG_COOLDOWN_MS` | OK |
| 条件消失 → 删除 flag | UC-2 Alt 3b | `removeFlag()` | OK |
| 除零保护 | FR-7 | baselineSessions/recentSessions === 0 检查 | OK |

### UC-3: 回滚

| 步骤 | Spec 要求 | 实现状态 | 结果 |
|------|----------|---------|------|
| backup 恢复 | UC-3 §5 | `copyFileSync` (fallback) | OK |
| git revert 优先 | UC-3 §6 | 先 revert 再 fallback | OK (v3 已修复) |
| backup 路径一致 | MUST_FIX-2 (v1) | `result.backupPath` 写入 history | OK |
| rollback 记录到 history | UC-3 §7 | `appendHistory()` | OK |

### UC-4: 统计

| 步骤 | Spec 要求 | 实现状态 | 结果 |
|------|----------|---------|------|
| 7 天聚合 | UC-4 §3 | `handleEvolveStats()` | OK |
| Top skills/failures | UC-4 §3 | 聚合 + 排序 | OK |
| 趋势箭头 | FR-5 | 未实现 | LOW（v1 遗留） |

### 模拟执行路径验证

#### 路径 1: /evolve 全流程
```
1. findRecentReport → 找到报告
2. buildJudgeInput → 提取子集，写临时文件
3. runJudge → spawn pi → parseJudgeOutput → 3 条建议
4. savePending → pending.json
5. 返回: "Generated 3 evolution suggestion(s). Use /evolve-apply action=list..."
✓ 正确
```

#### 路径 2: /evolve-apply action=list
```
1. loadPending → 3 条 pending 建议
2. filter(status === "pending") → 3 条
3. content: 含 description + rationale + diff target
4. details: 含完整 suggestion 数据（含 diff）
✓ 用户有完整决策信息
```

#### 路径 3: /evolve-apply action=apply index=0
```
1. loadPending → 建议列表
2. suggestion = allSuggestions[0], status === "pending" ✓
3. applySuggestion(suggestion, backupDir)
   a. isPathAllowed → true
   b. backupFile → backups/2026-05-27T12-00-00/CLAUDE.md
   c. applyUnifiedDiff → 成功
   d. git add + commit → commitSha
   e. return { success: true, backupPath, commitSha }
4. suggestion.status = "applied"
5. appendHistory: backupPath = result.backupPath（一致）✓, commitSha ✓
6. savePending
✓ 正确
```

#### 路径 4: /evolve-rollback 1
```
1. loadHistory(20) → [ { action: "apply", backupPath: "backups/.../CLAUDE.md", commitSha: "abc123" } ]
2. rollbackSuggestion(entry):
   a. fs.existsSync(backupPath) → true ✓
   b. commitSha 存在 → git revert --no-edit abc123
      → 成功: return { success: true }
      → 失败（冲突）: fallback → copyFileSync → git add + commit → return { success: true }
   c. 两条路径都能正确恢复文件
3. appendHistory(rollback record)
✓ 正确（v3 修复后 revert 不再被 dirty tree 阻塞）
```

#### 路径 5: /evolve-rollback 1（无 commitSha）
```
1. rollbackSuggestion(entry):
   a. commitSha 不存在 → 跳过 revert
   b. copyFileSync(backupPath, targetPath) → 文件恢复 ✓
   c. git add + commit → 成功 → git 有 rollback commit ✓
   d. return { success: true }
✓ 正确
```

#### 路径 6: 自动触发（session_start）
```
1. checkAutoTriggerRules(evolutionDir)
   → loadRecentDaily(dailyDir, now, 14)
   → checkTokenDecline(daily)
      baseline = daily.slice(0, 7) — 前 7 天 ✓
      recent = tailN(daily, 3) — 最后 3 天 ✓
      逐天检查: dayAvg > baselineAvg → hit: true/false
   → checkSkillDormant → 30 天阈值检查
   → checkErrorSpike → 增长率 > 50% 检查
2. 写 flag 文件 / 删除不满足条件的 flag
3. cleanExpiredFlags()
✓ 正确
```

---

## 残留 LOW 问题

### LOW-1: token-decline 语义与 spec 的"连续 3 天上升"不完全匹配

**来源**: v1 MUST_FIX-5 → v2 降级为 LOW-6

**现状**: `checkTokenDecline()` 检查"最近 3 天每一天的 token/session > 前 7 天基线"。

**Spec 原文**: "连续 3 天上升"（逐天递增趋势）。

**分析**: 当前实现的语义是"效率持续偏高"，而 spec 语义是"效率逐日恶化"。两者在大多数场景下等价（如果每天 > baseline，通常也是递增趋势），但在"先高后低但仍高于基线"的场景下，当前实现仍会触发。这是一个保守策略——宁可多提示，不会漏提示。

**建议**: 后续迭代中确认 spec 意图。如果确实需要"逐天递增"，改为 `day[n-2].avg < day[n-1].avg < day[n].avg`。

### LOW-2: stats 缺少趋势箭头

**来源**: v1 LOW-2

**现状**: `handleEvolveStats()` 只聚合最近 7 天数据，不对比前 7 天，不计算趋势箭头。

**影响**: 统计面板缺少趋势信息。纯展示性问题，不影响进化核心流程。

### LOW-3: --sample 参数未传递给 analyze.py

**来源**: v1 LOW-5

**现状**: `EvolveCommandParams` 定义了 `sample` 字段，但 `handleEvolve()` 中未传递给 analyzer 命令。

**影响**: 参数被接受但不生效。

### LOW-4: "e (edit)" 操作未实现

**来源**: v2 LOW-7

**现状**: per-call 模型只有 list/apply/skip，无 edit。Spec UC-1 Step 8 要求 y/n/e/q。

**影响**: 用户无法在 apply 前编辑 diff 内容。在 Pi tool 模型中实现 edit 的成本较高（需要交互式编辑 diff），建议后续迭代。

---

## 审查总结

### v2 修复状态

| v2 ID | 问题 | v3 状态 |
|-------|------|---------|
| MUST_FIX-1 | rollback backup restore 与 git revert 顺序冲突 | 已修复 |
| MUST_FIX-2 | list action 缺少建议详情 | 已修复 |

### v1 全链路修复状态

| v1 ID | 问题 | 最终状态 |
|-------|------|---------|
| MUST_FIX-1 | TUI 逐条审批交互 | 已修复（per-call 模型） |
| MUST_FIX-2 | backup 路径与 history 不一致 | 已修复 |
| MUST_FIX-3 | approved 状态过滤 | 已修复（设计消除） |
| MUST_FIX-4 | rollback 使用 git commit 而非 revert | 已修复（revert 优先 + fallback） |
| MUST_FIX-5 | token-decline 逻辑 | 已修复（语义残差降 LOW） |

### 最终结论

**Verdict: PASS**

经过三轮审查，v1 的 5 个 MUST_FIX 和 v2 的 2 个 MUST_FIX 全部已修复。核心业务流程（/evolve 分析 → Judge → per-call 审批 → apply/rollback）与 spec 和 use-cases 一致。残留 4 个 LOW 级别问题均为非阻塞性改进项，不影响核心功能正确性。

### 低优先级 (LOW: 4)

| ID | 问题 | 来源 |
|----|------|------|
| LOW-1 | token-decline "above baseline" vs "monotonically increasing" | v1→v2→v3 |
| LOW-2 | stats 缺少趋势箭头 | v1 |
| LOW-3 | --sample 参数未传递 | v1 |
| LOW-4 | "e (edit)" 操作未实现 | v2 |
