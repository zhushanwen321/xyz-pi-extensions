---
review:
  type: code_review
  round: 2
  timestamp: "2026-05-27T21:00:00"
  target: "evolution-engine/src/ (diff HEAD~2..HEAD for Phase 4 merge-reviewer scope)"
  verdict: fail
  summary: "健壮性评审完成，第2轮，增量审查，1条MUST FIX未修复（fix为死代码），需修改后重审"

statistics:
  total_issues: 6
  must_fix: 1
  must_fix_resolved: 1
  low: 3
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "evolution-engine/src/judge.ts:61-67"
    title: "extractReportSubset merge-reviewer 分支为死代码，数据语义错误未修复"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "evolution-engine/src/types.ts:80, index.ts:148"
    title: "EvolveCommandParams.target 类型添加 merge-reviewer"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: LOW
    location: "evolution-engine/src/commands.ts:246-251"
    title: "diffPreview 与 return 语句缩进不一致（3 tab vs 4 tab）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "evolution-engine/src/commands.ts (全域)"
    title: "commands.ts 完全缺失日志设施，含静默错误吞噬"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "evolution-engine/src/monitor.ts:54, 62"
    title: "writeFlag/ensureDir 缺少 try/catch 保护"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: INFO
    location: "evolution-engine/src/judge.ts:64-79"
    title: "merge-reviewer 目标缺少明确的数据字段提取定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null

---

# Robustness Review v2 — Phase 4 evolution-engine 增量审查

## 评审记录

- **评审时间**：2026-05-27 21:00
- **评审类型**：增量健壮性审查（验证 v1 的 MUST FIX 修复 + 检查回归）
- **评审对象**：`evolution-engine/src/` 下 Phase 4 变更（diff HEAD~2..HEAD）
- **增量依据**：v1 评审报告的 MUST FIX 列表
- **审查模式**：增量审查 — 逐条验证 v1 MUST FIX 修复 + 检查回归，不重做全量扫描

---

## 增量验证结果

### ✅ [FIXED] #2 — EvolveCommandParams.target 类型缺少 merge-reviewer

**文件**: `evolution-engine/src/types.ts:80`, `evolution-engine/src/index.ts:148`
**状态**: `resolved` (round 2)

**验证详情**:
| 检查点 | 结果 | 证据 |
|--------|------|------|
| `EvolveCommandParams.target` 类型 | ✅ | 已从 `"all" \| "claude-md" \| "skills"` 更新为 `"all" \| "claude-md" \| "skills" \| "merge-reviewer"` |
| `JudgeInput.target` 类型 | ✅ | 同步更新 |
| `index.ts` 类型断言 | ✅ | 从 `as "all" \| "claude-md" \| "skills"` 更新为 `as "all" \| "claude-md" \| "skills" \| "merge-reviewer"` |
| `TARGET_TEMPLATE` 注册 | ✅ | 新增 `"merge-reviewer": "merge-reviewer.txt"` |

**结论**: 所有检查点通过。`merge-reviewer` 现在在类型系统中是一等公民，类型断言与目标类型一致。✅ **已修复**。

---

### ❌ [UNFIXED] #1 — extractReportSubset 未处理 merge-reviewer target

**文件**: `evolution-engine/src/judge.ts:61-67`
**状态**: `open` — **修复引入死代码，未改变运行时行为**

**问题描述**:

`extractReportSubset` 中新增的 merge-reviewer 分支代码**位于 `return subset;` 之后，是不可达的死代码**。

当前函数结构（简化）：

```typescript
function extractReportSubset(report, target) {
  if (target === "all") return report;          // ← early return
  const subset = {};

  if (target === "claude-md") {
    // 提取 claude-md 相关字段
    return subset;
  }

  // target === "skills" (fallthrough)
  if (report.skill_stats != null) subset.skill_stats = report.skill_stats;
  if (report.skill_health != null) subset.skill_health = report.skill_health;
  if (report.actionable_issues != null) subset.actionable_issues = report.actionable_issues;
  return subset;  // ← 提前返回，后续代码不可达

  // ⚠️ DEAD CODE — 以下代码永不执行
  if (report.tool_stats != null) subset.tool_stats = report.tool_stats;
  if (report.error_stats != null) subset.error_stats = report.error_stats;
  if (report.user_patterns != null) subset.user_patterns = report.user_patterns;
  return subset;
}
```

**运行时行为**（与修复前完全一致）：
- `target === "merge-reviewer"` 时，既不匹配 `"all"`，也不匹配 `"claude-md"`，fallthrough 到 skills 分支
- LLM Judge 收到的是 `skill_stats`、`skill_health` 等技能相关数据
- `tool_stats`（含 editRetries）、`error_stats`（含 merge 冲突）、`user_patterns`（含代码审查反馈）均未被提取
- `merge-reviewer.txt` 模板期望的三类数据全部缺失

**死代码的成因**: 新代码追加在 `return subset;` 之后，JavaScript 引擎不会执行 `return` 之后的语句。这是典型的"追加代码但未移动 return"的编辑错误。

**判定理由**: 该问题在生产环境会导致数据语义错误 — LLM Judge 基于错误的数据子集产出建议，直接影响 merge-reviewer 功能的分析质量。**原始 MUST FIX 未修复，且新增了死代码降低可维护性。**

**修改方向**: 将 merge-reviewer 分支移至 skills 分支之前，或改为 if-else if 链，确保 `target === "merge-reviewer"` 时被正确路由且不落入 skills 默认分支。推荐结构：

```typescript
if (target === "merge-reviewer") {
  if (report.tool_stats != null) subset.tool_stats = report.tool_stats;
  if (report.error_stats != null) subset.error_stats = report.error_stats;
  if (report.user_patterns != null) subset.user_patterns = report.user_patterns;
  return subset;
}

// target === "skills" (fallthrough)
if (report.skill_stats != null) subset.skill_stats = report.skill_stats;
if (report.skill_health != null) subset.skill_health = report.skill_health;
if (report.actionable_issues != null) subset.actionable_issues = report.actionable_issues;
return subset;
```

---

## 回归检查

| 检查项 | 结果 | 说明 |
|--------|------|------|
| #1 修复引入的新问题 | ⚠️ 死代码 | 新增的 merge-reviewer 分支不可达，降低了代码可读性 |
| 类型断言 | ✅ | 未引入新问题，类型系统一致 |
| 其他文件 | ✅ | `index.ts` 类型断言更新、`monitor.ts` 日志添加、`commands.ts` ANALYZER_SCRIPT 检查 — 均无回归 |

---

## 各 MUST FIX 验证摘要

| # | v1 问题 | 修复状态 | 当前状态 |
|---|---------|---------|---------|
| 1 | extractReportSubset 未处理 merge-reviewer | ❌ 死代码，行为未变 | **open** |
| 2 | EvolveCommandParams.target 类型缺少 merge-reviewer | ✅ 类型已更新 | **resolved** |

---

## 结论

**需修改后重审**。1 条 MUST FIX 在本轮未修复（fix 为死代码），需更正修复后重审通过：

1. **#1** — `extractReportSubset` 中 merge-reviewer 分支需移至 `return subset;` 之前，确保 `target === "merge-reviewer"` 被正确路由并提取 `tool_stats`、`error_stats`、`user_patterns` 而非 `skill_*` 字段
