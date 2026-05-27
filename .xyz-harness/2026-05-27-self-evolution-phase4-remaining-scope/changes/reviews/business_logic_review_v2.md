---
review:
  type: code_review
  round: 2
  timestamp: "2026-05-27T21:00:00"
  target: "git diff HEAD~2 HEAD -- evolution-engine/"
  verdict: fail
  summary: "增量审查 v2：3 条 MUST FIX 中 1 条已修复（logger 内联化 ✅），2 条未修复（extractReportSubset 死代码、command handler），且 #1 的修复引入了回归——merge-reviewer 分支位于 unconditional return 之后，成为死代码。需修改后重审。"

statistics:
  total_issues: 6
  must_fix: 2
  must_fix_resolved: 1
  low: 2
  low_resolved: 1
  info: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "evolution-engine/src/judge.ts:57-68 (extractReportSubset)"
    title: "merge-reviewer 分支位于 unconditional return 之后，死代码，数据流断裂"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "evolution-engine/src/monitor.ts:10"
    title: "logger import 跨扩展目录边界，可能运行时解析失败"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: MUST_FIX
    location: "evolution-engine/src/index.ts:362-365"
    title: "/evolve command handler 未解析 merge-reviewer target"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "evolution-engine/src/types.ts:90-93 (EvolveCommandParams)"
    title: "EvolveCommandParams.target 类型缺失 merge-reviewer"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 5
    severity: LOW
    location: "evolution-engine/src/commands.ts:242-245"
    title: "diffPreview 变量缩进不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: MUST_FIX
    location: "evolution-engine/src/judge.ts:65-68"
    title: "[REGRESSION] merge-reviewer 分支被错误放置在 skills 分支的 return 之后，形成死代码"
    status: open
    raised_in_round: 2
    resolved_in_round: null
---

# 业务逻辑评审 v2（增量审查）

## 评审记录
- 评审时间：2026-05-27 21:00
- 评审类型：增量编码评审（v1 → v2）
- 评审对象：`git diff HEAD~2 HEAD -- evolution-engine/`
- 基线与目标：v1（3 MUST FIX）→ v2 修复验证

---

## 增量审查：MUST FIX 逐条验证

### #1 — extractReportSubset 缺少 merge-reviewer 分支

**状态：❌ 未修复，且引入回归**

v1 提出的问题：当 `target === "merge-reviewer"` 时，函数落入 `else` 分支（skills 提取路径），提取 `skill_stats` + `skill_health` + `actionable_issues` 而非 merge-reviewer 模板期望的 `tool_stats` + `error_stats` + `user_patterns`。

当前代码（`judge.ts:40-68`）：
```typescript
if (target === "all") return report;

const subset: Record<string, unknown> = {};

if (target === "claude-md") {
    if (report.token_stats != null) subset.token_stats = report.token_stats;
    if (report.user_patterns != null) subset.user_patterns = report.user_patterns;
    if (report.actionable_issues != null) subset.actionable_issues = report.actionable_issues;
    if (report.tool_stats != null) subset.tool_stats = report.tool_stats;
    if (report.error_stats != null) subset.error_stats = report.error_stats;
    return subset;
}

// target === "skills"   ← 注意：没有 if 守卫！无条件执行
if (report.skill_stats != null) subset.skill_stats = report.skill_stats;
if (report.skill_health != null) subset.skill_health = report.skill_health;
if (report.actionable_issues != null) subset.actionable_issues = report.actionable_issues;
return subset;             ← UNCONDITIONAL RETURN

// target === "merge-reviewer"   ← AFTER return — 死代码！
if (report.tool_stats != null) subset.tool_stats = report.tool_stats;
if (report.error_stats != null) subset.error_stats = report.error_stats;
if (report.user_patterns != null) subset.user_patterns = report.user_patterns;
return subset;
```

**问题 1（未修复）**：`"skills"` 分支没有 `if (target === "skills")` 守卫。当 `target === "merge-reviewer"` 时，第一行 `if (target === "all")` 不匹配，`if (target === "claude-md")` 不匹配，然后直接落入无守卫的 skills 提取代码，执行 `return subset` 退出。

**问题 2（回归）**：新增的 merge-reviewer 提取代码被放在了 `return subset` 之后——这是死代码，永远不会执行。比 v1 更糟——v1 至少整块缺失但代码可读，v2 存在看起来像实现了的代码但实际是死代码。

**修改方向**：
1. 给 skills 分支加 `if (target === "skills")` 守卫
2. 将 merge-reviewer 分支移到 skills 的 `if` 块内或作为独立的 `else if` / `if` 分支
3. 推荐结构：

```typescript
if (target === "all") return report;

const subset: Record<string, unknown> = {};

if (target === "claude-md") {
    // ... claude-md 提取 ...
    return subset;
}

if (target === "skills") {
    // ... skills 提取 ...
    return subset;
}

// target === "merge-reviewer"
if (report.tool_stats != null) subset.tool_stats = report.tool_stats;
if (report.error_stats != null) subset.error_stats = report.error_stats;
if (report.user_patterns != null) subset.user_patterns = report.user_patterns;
return subset;
```

---

### #2 — monitor.ts logger import 跨边界

**状态：✅ 已修复**

旧代码 `import { createLogger } from "../../shared/logger.js"` 已删除。替换为内联 `createMonitorLogger` 函数，写入 `~/.pi/agent/logs/evolution-monitor-<date>.log`。

关键验证点：
- 无外部文件依赖 ✅
- 无 `.ts` → `.js` 隐式解析依赖 ✅
- 使用 `appendFileSync` 同步写入，不与扩展开销竞争 ✅

---

### #3 — /evolve command handler 未解析 merge-reviewer

**状态：❌ 未修复**

当前命令处理器（`index.ts:362-372`）：
```typescript
let target: "all" | "claude-md" | "skills" = "all";  // ← 类型缺少 merge-reviewer

for (const part of parts) {
    if (part === "all" || part === "claude-md" || part === "skills") {  // ← 条件缺少 merge-reviewer
        target = part;
    } else if (part.match(/^\d+d$/)) {
        since = part;
    }
}
```

用户输入 `/evolve merge-reviewer` 时，`part === "merge-reviewer"` 不匹配任何条件，target 保持默认值 `"all"`。

同时需更新 description：
```typescript
description: "... target: all|claude-md|skills|merge-reviewer, ..."
```

---

## LOW 项验证

### #4 — EvolveCommandParams.target 类型

**状态：✅ 已修复**

`types.ts` 已更新为 `"all" | "claude-md" | "skills" | "merge-reviewer"`。

---

### #5 — diffPreview 缩进不一致

**状态：❌ 未修复**

当前代码（`commands.ts:241-243`）：
```typescript
                    const diff = suggestion.diff ? `  Diff target: ${suggestion.targetPath}` : "";
                const diffPreview = suggestion.diff
```

`const diff` 使用 5 级缩进（20 空格），而 `const diffPreview` 使用 4 级缩进（16 空格），两行相邻声明但缩进不一致。

---

## 新增问题摘要

| # | 类型 | 位置 | 说明 |
|---|------|------|------|
| 6 | MUST FIX (REGRESSION) | `judge.ts:65-68` | merge-reviewer 分支位于 skills 分支的 `return subset` 之后，死代码 |

---

## 结论

**需修改后重审。** 2 条 MUST FIX 未修复（其中 #1 还引入了回归死代码）。LOW 项有 1 条未修复（缩进问题）。

建议按以下顺序修复：
1. **#1/#6**：给 skills 分支加 `if (target === "skills")` 守卫，将 merge-reviewer 分支移到位，删除死代码
2. **#3**：command handler 的 `target` 类型和条件判断加入 `"merge-reviewer"`

### Summary

业务逻辑增量审查完成，第2轮需重审，2条MUST FIX（1条原未修复+1条回归）与1条LOW未修复。核心问题：extractReportSubset 中 skills 分支缺少 if 守卫导致 merge-reviewer 数据流仍断裂，且新增的 merge-reviewer 分支代码为死代码。
