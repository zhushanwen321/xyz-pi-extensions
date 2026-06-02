---
verdict: fail
must_fix: 1
review_metrics:
  files_reviewed: 28
  issues_found: 5
  must_fix_count: 1
  low_count: 3
  info_count: 1
---

# Integration Review — Evolve 扩展追踪维度

## 审查范围

| 层级 | 文件 | 数量 |
|------|------|------|
| TS Extension 入口 | `src/index.ts` | 1 |
| TS Detectors | `src/detectors/*.ts` | 4 |
| TS Problem Registry | `src/problems.ts` | 1 |
| Python Extractors | `analyzer/extractors/*.py` | 6 |
| Python Rules | `analyzer/rules/*.py` | 14 |
| Python Auto-discovery | `analyzer/extractors/__init__.py`, `analyzer/rules/__init__.py` | 2 |
| Deployed Analyzer | `~/.pi/agent/scripts/pi-session-analyzer/analyze.py` | 1 (external) |
| Skills | `skills/evolve/SKILL.md`, `skills/evolve-report/SKILL.md`, `skills/evolve-apply/SKILL.md` | 3 |
| **合计** | | **28** |

## 运行时集成拓扑

```
┌─────────────────────────────────────────────────────────────────┐
│  TS Extension (src/index.ts)                                    │
│                                                                 │
│  session_start ──► pi.exec("python3", [ANALYZER_PATH])          │
│                     │                                           │
│                     ▼                                           │
│  ┌──────────────────────────────────────────┐                   │
│  │  ~/.pi/agent/scripts/                     │                   │
│  │  pi-session-analyzer/analyze.py           │  ← DEPLOYED      │
│  │                                           │    (OLD)         │
│  │  imports:                                 │                   │
│  │  ├─ extractors/tools.py                   │                   │
│  │  ├─ extractors/tokens.py                  │                   │
│  │  ├─ extractors/errors.py                  │                   │
│  │  ├─ extractors/users.py                   │                   │
│  │  ├─ extractors/skills.py                  │                   │
│  │  ├─ extractors/cross_project.py           │                   │
│  │  ├─ extractors/satisfaction.py            │                   │
│  │  └─ extractors/skill_state.py             │                   │
│  │                                           │                   │
│  │  miner.py → aggregated JSON               │                   │
│  │  (keys: tool_stats, token_stats,          │                   │
│  │   error_stats, user_patterns, ...)        │                   │
│  └──────────────────────────────────────────┘                   │
│                     │                                           │
│                     ▼ writes                                    │
│  ~/.pi/agent/evolution-data/daily-reports/YYYY-MM-DD.json       │
│                                                                 │
│  ┌──────────────────────────────────────────┐                   │
│  │  packages/evolve-daily/analyzer/          │  ← NEW CODE      │
│  │                                           │    (DISCONNECTED) │
│  │  extractors/                              │                   │
│  │  ├─ compact.py                            │                   │
│  │  ├─ context.py                            │                   │
│  │  ├─ subagent.py                           │                   │
│  │  ├─ tool_errors.py                        │                   │
│  │  ├─ workflow.py                           │                   │
│  │  └─ goal_quality.py                       │                   │
│  │                                           │                   │
│  │  rules/                                   │                   │
│  │  ├─ compact_*.py (2)                      │                   │
│  │  ├─ context_*.py (1)                      │                   │
│  │  ├─ subagent_*.py (2)                     │                   │
│  │  ├─ param_error_*.py (3)                  │                   │
│  │  ├─ workflow_*.py (2)                     │                   │
│  │  ├─ goal_*.py (3)                         │                   │
│  │  └─ todo_*.py (1)                         │                   │
│  │                                           │                   │
│  │  run_extractors() → ❌ NEVER CALLED        │                   │
│  │  run_rules()      → ❌ NEVER CALLED        │                   │
│  └──────────────────────────────────────────┘                   │
│                                                                 │
│  tool_execution_end ──► 4 TS detectors ──► appendEntry()        │
│  (compact, subagent, param-error, goal-quality) ✅ WORKS        │
│                                                                 │
│  Skills (evolve, evolve-report) read daily-reports              │
│  expect: compact_stats, goal_quality_stats, etc.                │
│  actual: tool_stats, token_stats, error_stats, etc.             │
│  → New dimension fields NEVER EXIST in reports                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## MUST_FIX — 1 个

### MF-1: 新 Python 模块（6 extractors + 14 rules）无执行路径

**严重性**: MUST_FIX — 新增的全部 L3 批量分析能力是死代码

**根因**: `src/index.ts` 的 L1 逻辑调用已部署的旧 analyzer：

```typescript
const ANALYZER_PATH = join(
  homedir(),
  ".pi/agent/scripts/pi-session-analyzer/analyze.py"
);
```

该脚本（commit 时已存在于 `~/.pi/agent/scripts/`）使用自己的 extractor（tools, tokens, errors, users, skills, cross_project, satisfaction, skill_state）和自己的 miner。它完全不知道 `packages/evolve-daily/analyzer/` 下的新模块。

新模块的入口函数 `run_extractors()` 和 `run_rules()` 定义在各自的 `__init__.py` 中，但没有任何代码调用它们。整个 `packages/evolve-daily/analyzer/` 目录是孤立的库代码。

**数据流断点验证**:

```bash
# 新模块的入口函数——定义但从未被调用
$ grep -rn 'run_extractors\|run_rules' packages/evolve-daily/ --include='*.ts'
# (空 — TS 代码不引用这些函数)

# TS 代码仅引用旧 analyzer 路径
$ grep -rn 'analyzer' packages/evolve-daily/src/index.ts
# 15: ".pi/agent/scripts/pi-session-analyzer/analyze.py"
```

**影响**:

| 期望 | 实际 |
|------|------|
| daily-reports 包含 `compact_stats` | ❌ 永远不会出现 |
| daily-reports 包含 `context_stats` | ❌ 永远不会出现 |
| daily-reports 包含 `subagent_stats` | ❌ 永远不会出现 |
| daily-reports 包含 `tool_errors_stats` | ❌ 永远不会出现 |
| daily-reports 包含 `workflow_stats` | ❌ 永远不会出现 |
| daily-reports 包含 `goal_quality_stats` | ❌ 永远不会出现 |
| 14 条 miner rules 运行并产出 issues | ❌ 永远不会运行 |
| Skill /evolve 的 Section 3e 分析 | ❌ 无数据可用 |

**修复方案**（三选一，按推荐度排序）:

1. **A: 创建新的 pipeline 入口脚本**（推荐）
   - 在 `packages/evolve-daily/analyzer/` 下创建 `run_daily.py`
   - 解析 sessions → `run_extractors()` → `run_rules()` → 写 JSON
   - TS 代码改为调用此脚本（或作为旧 analyzer 的后处理步骤）
   - 优点：完全独立，不修改已有系统

2. **B: 将新 extractors 集成到旧 analyzer**
   - 将 6 个新 extractor 复制到 `~/.pi/agent/scripts/pi-session-analyzer/extractors/`
   - 修改 `analyze.py` 添加新 extractor 调用
   - 将 14 条 rules 集成到 miner.py
   - 优点：统一 pipeline
   - 缺点：修改已部署的共享脚本

3. **C: 两阶段 pipeline**
   - 旧 analyzer 先运行（产出基础报告）
   - 新 pipeline 读取 sessions，运行新 extractors/rules
   - 合并结果到同一 JSON
   - 优点：不破坏旧功能
   - 缺点：sessions 解析两次

---

## Low — 3 个

### L-1: Skills 期望的 report 字段与实际产出不匹配

`evolve/SKILL.md` Section 3e 和 `evolve-report/SKILL.md` 的新维度展示逻辑，检查以下字段是否存在：

- `compact_stats` — 永远不存在
- `context_stats` — 永远不存在
- `subagent_stats` — 永远不存在
- `tool_error_stats` — 永远不存在（注意：旧 analyzer 有 `error_stats`，key 不同）
- `workflow_stats` — 永远不存在
- `goal_quality_stats` — 永远不存在
- `todo_stats` — 永远不存在

**影响**: Skills 的 "Extended Metrics" / "New Dimension Analysis" 部分永远不会显示内容。不会报错（skills 先检查字段存在性），但用户体验是"新功能不存在"。

**特别注意**: `tool_error_stats` vs `error_stats`。旧 analyzer 产出的 key 是 `error_stats`（结构不同），skill 期望的是 `tool_error_stats`。即使旧 analyzer 运行成功，skill 也不会读取到任何错误分析数据——字段名不匹配。

### L-2: PROBLEM_REGISTRY 声明了未实现的 TS detector

`problems.ts` 中定义了 6 个 Problem，但 `src/detectors/` 只有 4 个：

| Problem ID | Detector 文件 | 状态 |
|------------|--------------|------|
| `compact-frequency` | `compact.ts` | ✅ |
| `context-utilization` | — | ❌ 缺失 |
| `subagent-efficiency` | `subagent-result.ts` | ✅ |
| `tool-param-validation` | `param-error.ts` | ✅ |
| `workflow-phase-duration` | — | ❌ 缺失 |
| `goal-task-quality` | `goal-quality.ts` | ✅ |

`index.ts` 中硬编码了 4 个 detector 创建，`context-utilization` 和 `workflow-phase-duration` 永远不会被创建。

**影响**: PROBLEM_REGISTRY 的 `detector.events` 和 `detector.match` 字段对这 2 个 problem 是文档性质的死配置。运行时不会报错（因为 detector 不注册就不会被匹配），但 PROBLEM_REGISTRY 作为元数据是误导性的。

### L-3: workflow.py 三个统计字段永远为 0（确认 BLR L-2）

`workflow.py` 中 `review_findings_total`、`retrospect_written`、`retrospect_expected` 三个变量初始化为 0，extract 函数中无任何赋值。输出中这三个字段永远是 0：

```python
"review_findings": {
    "total_must_fix": 0,      # 永远 0
    "avg_per_workflow": 0.0,   # 永远 0.0
    "by_phase": {},            # 永远空
},
"retrospect_coverage": {
    "written": 0,              # 永远 0
    "total_expected": 0,       # 永远 0
    "coverage_rate": 0.0,      # 永远 0.0
},
```

**影响**: 当前无 rule 依赖这些字段，对规则挖掘无影响。但对未来扩展和 report 展示是误导性数据。

---

## Info — 1 个

### I-1: BLR 的两个 MUST_FIX 已在当前代码中修复

BLR 的 MF-1（goal_quality 双重嵌套）和 MF-2（不存在的 goal-high-cancel 规则引用）已在 commit `857838b` 中修复：

- `goal_quality.py` 现在返回扁平 dict（`extract()` 返回 `{"goals_total": ..., "task_stats": {...}, ...}`），`run_extractors()` 包装后为 `{"goal_quality_stats": {"goals_total": ..., ...}}`。Rules 通过 `daily_report.get("goal_quality_stats", {})` 访问，路径正确。
- `problems.ts` 的 `goal-task-quality` 的 `minerRules` 已移除 `goal-high-cancel`。

**数据路径验证（6 个 extractor → 14 条 rule）**:

| Extractor | `run_extractors` 包装 key | Rule 访问路径 | 一致性 |
|-----------|--------------------------|--------------|--------|
| `compact.py` | `compact_stats` | `daily_report.get("compact_stats")` | ✅ |
| `context.py` | `context_stats` | `daily_report.get("context_stats")` | ✅ |
| `subagent.py` | `subagent_stats` | `daily_report.get("subagent_stats")` | ✅ |
| `tool_errors.py` | `tool_errors_stats` | `daily_report.get("tool_errors_stats")` | ✅ |
| `workflow.py` | `workflow_stats` | `daily_report.get("workflow_stats")` | ✅ |
| `goal_quality.py` | `goal_quality_stats` | `daily_report.get("goal_quality_stats")` | ✅ |

**L2 Detector ↔ L3 Extractor 事件源一致性**:

| TS Detector | 事件类型 | Python Extractor | 事件源 | 一致性 |
|-------------|---------|-----------------|--------|--------|
| `compact.ts` | `role === "compactionSummary"` | `compact.py` | `msg.get("role") == "compactionSummary"` | ✅ 完全一致 |
| `subagent-result.ts` | `toolName === "subagent"` | `subagent.py` | `msg.get("toolName") == "subagent"` | ✅ 完全一致 |
| `param-error.ts` | `isError === true` + tracked tools | `tool_errors.py` | `msg.get("isError", False)` | ✅ 逻辑一致（TS 限定工具集，Python 全量扫描） |
| `goal-quality.ts` | `toolName === "goal_manager"` | `goal_quality.py` | `customType == "goal-state"` | ✅ 不同事件类型（L2 实时 vs L3 历史），设计合理 |

**Goal 状态字符串一致性验证**:

- Goal status: `"complete"`（goal extension 的 `state.ts` 使用此值）
- Task status: `"completed"`（goal extension 的 tasks 使用此值）
- Python extractor: `status == "complete"` for goals, `t.get("status") == "completed"` for tasks → ✅ 一致

**错误隔离验证**:

| 模块 | 隔离机制 | 评价 |
|------|---------|------|
| TS detector | `try/catch` per detector，error 时 `console.error` | ✅ 单个 detector 失败不影响其他 |
| Python extractor | `try/except` per extractor，失败返回 `{}` | ✅ 空结果 → rules 不触发 |
| Python rule | `try/except` per rule，失败 skip | ✅ 单个 rule 失败不影响其他 |
| Analyzer invocation | `try/catch` + `unlinkSync` 清理 | ✅ 失败清理 partial output |

---

## 结论

**Verdict: FAIL, MUST_FIX=1**

核心问题是新 Python 模块（6 extractors + 14 rules）是设计良好但完全孤立的库代码。它们实现了正确的数据结构和规则逻辑（BLR 验证），但缺少与运行时系统的集成入口。

L2 TS detectors 的集成是正确的（4 个 detector 正确注册、事件匹配、appendEntry 调用无误）。L3 pipeline 的内部逻辑是正确的（extractor → rule 数据路径全部一致）。缺失的是 L1 入口到 L3 的桥接。

这不同于 BLR 发现的"数据正确性静默失效"——这里是"整个功能模块静默不运行"。对于用户而言，安装 evolve-daily 后，L2 实时追踪能正常工作，但 L3 批量分析和 skills 的新维度展示完全无效。
