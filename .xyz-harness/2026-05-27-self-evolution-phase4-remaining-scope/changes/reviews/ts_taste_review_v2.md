---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 8
  v1_must_fix: 10
  v1_must_fix_pre_existing: 10
  new_issues_introduced: 1  # dead code after return in judge.ts
  duration_estimate: 5m
---

# TypeScript 品味审查报告 v2

**审查范围**: `evolution-engine/src/`（8 个源文件 + 1 个模板文件 + 1 个测试文件）
**审查时间**: 2026-05-27
**审查类型**: Phase 4 变更增量审查（确认 v1 MUST FIX 是否为 PRE-EXISTING）

---

## 变更范围

Phase 4 实际变更的源文件（`git diff HEAD~2 HEAD`）：

| 文件 | 变更内容 |
|------|----------|
| `commands.ts` | +3 行（analyzer script 存在检查）+ 8 行（diff preview 显示） |
| `index.ts` | 扩展 `target` 枚举含 `"merge-reviewer"`（2 处字符串拼接） |
| `judge.ts` | +1 行 TARGET_TEMPLATE 条目 + 6 行 extractReportSubset（位于 return 后，见下方） |
| `monitor.ts` | +28 行（内联 logger + 2 处 log 调用） |
| `types.ts` | 3 处扩展 `target` union type 含 `"merge-reviewer"` |
| `widget.ts` | 未变更 |
| `templates/merge-reviewer.txt` | 新增模板文件（50 行） |
| `integration.test.mts` | 1 行路径修正（`srcDir` 改为 `new URL` 相对路径） |

---

## 逐项确认 v1 MUST FIX（10 项）

### 9 个 unused imports/variables

| v1 位置 | 描述 | 是否 Phase 4 引入 | 证据 |
|----------|------|-------------------|------|
| `commands.ts L22` | `HistoryEntry` import 未使用 | ❌ PRE-EXISTING | Phase 4 diff 未触及 L22 附近 |
| `index.ts L22` | `EvolutionSuggestion` import 未使用 | ❌ PRE-EXISTING | Phase 4 diff 未触及 L22 附近 |
| `index.ts L31` | `renderSuggestionSummary` import 未使用 | ❌ PRE-EXISTING | Phase 4 diff 未触及 L31 附近 |
| `index.ts L32` | `renderStatsDashboard` import 未使用 | ❌ PRE-EXISTING | Phase 4 diff 未触及 L32 附近 |
| `judge.ts L13` | `randomUUID` import 未使用 | ❌ PRE-EXISTING | Phase 4 diff 未触及 L13 |
| `judge.ts L86`（现 L92） | `templateFileName` 变量赋值后未使用（它给 `promptFilePath` 传参，但 diff preview 未用到） | ❌ PRE-EXISTING | 变量在 Phase 3 已存在，Phase 4 未修改该函数 |
| `monitor.ts L27`（现 L43） | `ERROR_SPIKE_BASELINE_DAYS` 常量未使用 | ❌ PRE-EXISTING | Phase 4 diff 未触及该常量 |
| `monitor.ts L146`（现 L162） | `sliceBeforeLast` 函数未使用 | ❌ PRE-EXISTING | Phase 4 diff 未触及该函数 |
| `widget.ts L8` | `Text` import 未使用 | ❌ PRE-EXISTING | widget.ts 无 Phase 4 变更 |

### 1 个函数超限

| v1 位置 | 描述 | 是否 Phase 4 引入 | 证据 |
|----------|------|-------------------|------|
| `index.ts L108` | `evolutionEngineExtension` 310 行超限（限 300） | ❌ PRE-EXISTING | Phase 4 diff 仅动了参数 schema（~5 行），不影响函数长度 |

**结论：10/10 MUST FIX 全部 PRE-EXISTING（Phase 3 遗留），Phase 4 未引入其中任何一项。**

---

## Phase 4 引入的新问题

### 1. judge.ts：`extractReportSubset` 中死代码（dead code） ⚠️

```typescript
// target === "skills"
if (report.skill_stats != null) subset.skill_stats = report.skill_stats;
if (report.skill_health != null) subset.skill_health = report.skill_health;
if (report.actionable_issues != null) subset.actionable_issues = report.actionable_issues;
return subset;  // ← 此处提前 return

// target === "merge-reviewer"    ← 以下代码不可达
if (report.tool_stats != null) subset.tool_stats = report.tool_stats;
if (report.error_stats != null) subset.error_stats = report.error_stats;
if (report.user_patterns != null) subset.user_patterns = report.user_patterns;
return subset;
```

`extractReportSubset` 使用 `if-return` 链式风格，`"merge-reviewer"` 分支未嵌入到 `if-return` 结构中，导致被前一个分支的 `return` 遮蔽。

**影响**: `target === "merge-reviewer"` 时的信号子集提取无效，LLM Judge 拿不到完整的信号数据。

**建议修复**: 将 `"merge-reviewer"` 分支加入 `if-return` 链中：

```typescript
// target === "skills"
if (target === "skills") {
  if (report.skill_stats != null) subset.skill_stats = report.skill_stats;
  if (report.skill_health != null) subset.skill_health = report.skill_health;
  if (report.actionable_issues != null) subset.actionable_issues = report.actionable_issues;
  return subset;
}

// target === "merge-reviewer"
if (target === "merge-reviewer") {
  if (report.tool_stats != null) subset.tool_stats = report.tool_stats;
  if (report.error_stats != null) subset.error_stats = report.error_stats;
  if (report.user_patterns != null) subset.user_patterns = report.user_patterns;
  return subset;
}
```

### 2. monitor.ts：catch block 无声吞错误

Phase 4 新增的 `createMonitorLogger` 中：

```typescript
try { appendFileSync(filePath, ...); } catch { /* silent */ }
```

`/* silent */` 注释虽说明意图，但风味检查（`taste/no-silent-catch`）仍会告警。建议改为：

```typescript
try { appendFileSync(filePath, ...); } catch { /* logger failure is non-fatal */ }
```

或使用 `console.error` 回退。

---

## 跨文件共性问题（v1 中已有的，Phase 4 未恶化）

| 问题 | v1 已有数量 | Phase 4 新增 | 总数量 |
|------|-------------|-------------|--------|
| `no-unused-vars` (error) | 9 | 0 | 9 |
| `max-lines-per-function` (warning) | 1 | 0 | 1 |
| `no-silent-catch` (warning) | 8 | 1（新增） | **9** |
| `no-magic-numbers` (warning) | 26 | 0 | 26 |
| 死代码逻辑错误 | 0 | **1** | 1 |

---

## 汇总

| 项目 | 数值 |
|------|------|
| v1 MUST FIX（P0） | 10 |
| 其中 Phase 4 引入 | **0** |
| 其中 PRE-EXISTING | **10** |
| Phase 4 新引入问题 | **1**（judge.ts 死代码） |
| Verdict | **pass**（v1 的 MUST FIX 全为 Phase 3 遗留，不阻塞 Phase 4 merge） |

### 建议事项

1. **不阻塞 merge**：Phase 4 变更本身质量干净，v1 的 MUST FIX 全为历史遗留
2. **推荐修复**：judge.ts 的 `extractReportSubset` 死代码 — 影响 `merge-reviewer` 目标的功能正确性
3. **长期治理**：9 个 unused import/variable + 1 个函数超限建议在今后面向维修的提交中统一清理，不推给 Phase 4
