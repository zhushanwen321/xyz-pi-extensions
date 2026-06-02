---
verdict: fail
must_fix: 2
review_metrics:
  files_reviewed: 27
  issues_found: 8
  must_fix_count: 2
  low_count: 4
  info_count: 2
---

# Business Logic Review — Evolve 扩展追踪维度

## 审查范围

| 层级 | 文件 | 数量 |
|------|------|------|
| L2 TS Detectors | `src/detectors/*.ts`, `src/index.ts`, `src/problems.ts` | 6 |
| L3 Python Extractors | `analyzer/extractors/*.py` | 6 |
| L3 Python Rules | `analyzer/rules/*.py` | 14 |
| L4 Skills | `skills/evolve/SKILL.md`, `skills/evolve-report/SKILL.md` | 2 |
| **合计** | | **28** |

## UC 覆盖矩阵

| UC | 描述 | Python Extractor | Python Rules | L2 Detector | Skill 覆盖 | 状态 |
|----|------|-----------------|--------------|-------------|------------|------|
| UC-1 | Compact 频率 | `compact.py` ✅ | `compact_high_frequency`, `compact_early_trigger` ✅ | `compact.ts` ✅ | ✅ | ⚠ 数据正确性问题 |
| UC-2 | 上下文压力 | `context.py` ✅ | `context_high_utilization` ✅ | **缺失** ❌ | ✅ | ⚠ alt path 未实现 |
| UC-3 | Subagent 效率 | `subagent.py` ✅ | `subagent_failure_rate`, `subagent_high_retry` ✅ | `subagent-result.ts` ✅ | ✅ | ✅ |
| UC-4 | 工具错误分类 | `tool_errors.py` ✅ | `param_error_rate`, `edit_match_failure`, `low_self_correction` ✅ | `param-error.ts` ✅ | ✅ | ✅ |
| UC-5 | 工作流阶段 | `workflow.py` ✅ | `workflow_slow_phase`, `workflow_gate_retry` ✅ | **缺失** ❌ | ✅ | ⚠ 统计字段永远为 0 |
| UC-6 | Goal 质量 | `goal_quality.py` ✅ | `goal_low_completion`, `goal_low_evidence`, `goal_stall_frequent` ✅ | `goal-quality.ts` ✅ | ✅ | ❌ MUST_FIX |
| UC-7 | 生成优化建议 | N/A | N/A | N/A | `evolve/SKILL.md` ✅ | ⚠ 依赖上游数据 |

---

## MUST_FIX — 2 个

### MF-1: goal_quality extractor 数据双重嵌套，规则全部失效

**严重性**: MUST_FIX — 3 条规则（goal_low_completion, goal_low_evidence, goal_stall_frequent）永远无法触发

**根因**: `goal_quality.py` 的 `extract()` 返回：
```python
{
    "goal_quality_stats": { "goals_total": 5, "completion_rate": 0.6, ... },
    "todo_stats": { "total_todos": 10, ... }
}
```
`run_extractors` 用 `f"{name}_stats"` 包装，key 为 `goal_quality_stats`：
```python
daily_report["goal_quality_stats"] = {
    "goal_quality_stats": { "goals_total": 5, ... },  # ← 双重嵌套
    "todo_stats": { ... }
}
```
规则访问路径 `daily_report["goal_quality_stats"]["goals_total"]` → `None`（default 0）。
`goals_total` 永远是 0，条件 `goals_total >= 2` 永远不满足。

**影响**:
- `goal_low_completion.py` — 永远不触发（goal 完成率低检测失效）
- `goal_low_evidence.py` — 永远不触发（Evidence 质量检测失效，`task_total < 3` 必然满足 → 但 0 < 3 所以提前 return）
- `goal_stall_frequent.py` — 永远不触发（Stall 检测失效）

**注意**: `todo_high_abandon.py` 访问 `daily_report["goal_quality_stats"]["todo_stats"]` 恰好能工作（因为 todo_stats 在第二层），但这是偶然的，不代表数据路径正确。

**修复建议**: `goal_quality.py` 的 `extract()` 应返回扁平结构（key 直接在顶层），与其他 extractor 保持一致：
```python
# 当前（错误）
return { "goal_quality_stats": {...}, "todo_stats": {...} }
# 应改为
return { "goals_total": ..., "completion_rate": ..., "task_stats": {...}, "todo_stats": {...} }
```

### MF-2: PROBLEM_REGISTRY 引用了不存在的 minerRule `goal-high-cancel`

**严重性**: MUST_FIX — PROBLEM_REGISTRY 声明了 `goal-high-cancel` 规则但不存在对应文件

**位置**: `src/problems.ts` → `goal-task-quality` 的 `analysis.minerRules`

```typescript
minerRules: [
    "goal-low-completion",
    "goal-high-cancel",         // ← 文件 goal_high_cancel.py 不存在
    "goal-low-evidence",
    "goal-low-evidence-quality", // ← 虽然无独立文件，但 goal_low_evidence.py 内输出了此 id
    "goal-stall-frequent",
    "todo-high-abandon",
]
```

`goal-low-evidence-quality` 由 `goal_low_evidence.py` 兼职输出（单个 issue ID `goal-low-evidence-quality`），可以接受。但 `goal-high-cancel` 完全没有实现。

**影响**: `run_rules` 通过自动发现机制加载 rules，不依赖 PROBLEM_REGISTRY 的 `minerRules` 字段（rules/__init__.py 用 `pkgutil.iter_modules` 发现），所以运行时不会报错。但 `minerRules` 列表作为文档/元数据是错误的——声明了不存在的规则。

**修复建议**: 二选一——
1. 创建 `goal_high_cancel.py` 实现 cancel rate 检测（与 `goal_low_completion.py` 互补）
2. 从 PROBLEM_REGISTRY 的 `minerRules` 列表中移除 `goal-high-cancel`

---

## Low — 4 个

### L-1: UC-2 alt path 未实现——无 model_change 时不使用默认 context limit

**UC-2 Alternative Paths**: "无 model_change 事件 → 使用默认 context limit"

`context.py` 中，当无 `model_change` 事件时，`current_model` 保持 `None`，所有利用率计算被跳过（`if current_model and current_model in MODEL_CONTEXT_LIMITS` 守卫），最终返回全零统计。

UC-2 要求使用默认值（如 200K tokens）作为 fallback，但代码未实现。

**影响**: 如果 session 数据中没有 `model_change` 事件，context 利用率永远返回 0，无法触发 `context_high_utilization` 规则。

### L-2: workflow extractor 三个统计字段永远为 0

`workflow.py` 中 `review_findings_total`、`retrospect_written`、`retrospect_expected` 三个变量初始化为 0，但整个 extract 函数中没有任何代码更新它们。输出中这三个字段的值永远为 0：

```python
"review_findings": {
    "total_must_fix": 0,          # 永远 0
    "avg_per_workflow": 0.0,      # 永远 0.0
    "by_phase": {},               # 永远空
},
"retrospect_coverage": {
    "written": 0,                 # 永远 0
    "total_expected": 0,          # 永远 0
    "coverage_rate": 0.0,         # 永远 0.0（0/0 被守卫为 0）
},
```

**影响**: 无对应规则依赖这些字段，对规则挖掘无影响，但对 report 展示和 future rules 是误导性数据。

### L-3: L2 detector 缺失——context-utilization 和 workflow-phase-duration 无实时追踪

PROBLEM_REGISTRY 定义了 `context-utilization` 和 `workflow-phase-duration` 两个问题，但 `src/detectors/` 中没有对应的 detector 文件，`src/index.ts` 也未注册它们。

UC-1~UC-6 的 L3 批量分析不受影响（Python extractors 覆盖完整），但 L2 实时追踪有缺口：context 压力和 workflow 阶段无法在 session 内实时反馈。

### L-4: subagent retry 检测过于粗放

`subagent.py` 的重试检测逻辑：
```python
if prev_subagent_call_idx is not None:
    retry_count += 1
prev_subagent_call_idx = i
```

任何 session 内第二个及之后的 subagent 调用都会被计为"重试"，即使它们是独立的、不同的任务。这会系统性膨胀 `retry_count` 和 `retry_rate`。

合理的重试检测应基于：同一 task prompt 的重复调用，或连续失败后紧接的同类型调用。

---

## Info — 2 个

### I-1: goal_quality todo 解析依赖字符串匹配

`goal_quality.py` 通过检测 content 中的关键词（`"add"`, `"completed"`, `"delete"` 等）来推断 todo 操作类型。这种启发式方法在以下场景可能误判：
- content 包含这些词的其他上下文（如 "add a feature" 被误判为 add 操作）
- 一次 response 中包含多个操作时可能重复计数

当前影响有限，因为 todo_stats 用于趋势分析而非精确计费。

### I-2: PROBLEM_REGISTRY `minerRules` 字段未被运行时消费

`rules/__init__.py` 使用 `pkgutil.iter_modules` 自动发现所有 rule 模块，不依赖 PROBLEM_REGISTRY 的 `minerRules` 字段。`minerRules` 目前仅作为文档元数据。如果未来需要按 problem 筛选相关 rules，当前设计无法实现这一点。

---

## 数据流审查总结

```
Session JSONL
    │
    ├─ L2 (实时) ──┬─ compact.ts ──────── appendEntry("evolve-feedback") ✅
    │              ├─ subagent-result.ts ─ appendEntry("evolve-feedback") ✅
    │              ├─ param-error.ts ───── appendEntry("evolve-feedback") ✅
    │              ├─ goal-quality.ts ──── appendEntry("evolve-feedback") ✅
    │              ├─ [context] ────────── ❌ 缺失
    │              └─ [workflow] ───────── ❌ 缺失
    │
    └─ L3 (批量) ──┬─ compact.py ──────────── compact_stats ──────── ✅
                   ├─ context.py ──────────── context_stats ──────── ⚠ 无 fallback
                   ├─ subagent.py ─────────── subagent_stats ─────── ⚠ retry 膨胀
                   ├─ tool_errors.py ──────── tool_errors_stats ──── ✅
                   ├─ workflow.py ─────────── workflow_stats ──────── ⚠ 3 字段永远 0
                   └─ goal_quality.py ─────── goal_quality_stats ─── ❌ 双重嵌套
                              │
                   L3 Rules (14 个)
                   ├─ goal_low_completion ──── ❌ MF-1 导致永远不触发
                   ├─ goal_low_evidence ────── ❌ MF-1 导致永远不触发
                   ├─ goal_stall_frequent ──── ❌ MF-1 导致永远不触发
                   ├─ todo_high_abandon ────── ⚠ 恰好能工作（数据路径偶然正确）
                   ├─ 其余 10 条规则 ───────── ✅
                   │
                   daily-reports JSON
                              │
                   L4 Skills
                   ├─ /evolve ──────────────── ✅（依赖上游数据）
                   └─ /evolve-report ───────── ✅（展示逻辑完整）
```

## 结论

**Verdict: FAIL, MUST_FIX=2**

两个 MUST_FIX 都是数据路径/结构问题，不会导致运行时崩溃，但会导致特定功能的静默失效——规则永远不触发、统计永远为零。这对一个数据分析系统来说是最危险的失败模式：看起来在正常工作，但实际上 UC-6（Goal 质量分析）的整个规则挖掘管线是失效的。
