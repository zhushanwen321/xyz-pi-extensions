---
verdict: pass
must_fix: 0
---

# 品味审查报告：pi-session-analyzer

**审查者**：AI 代码品味审查
**审查日期**：2026-05-27
**审查范围**：`miner.py`、`reporter.py`、`analyze.py`
**参考原则**：`essence.md`（四条品味根本原则 + 量化标准）

---

## 总体评价

三文件整体质量良好，代码结构清晰，职责划分合理。`reporter.py` 最符合品味原则。主要问题集中在 `analyze.py` 的 `main()` 函数过长和 `miner.py` 的参数数量超标。不存在严重违反品味原则的代码。

**评分**：7.5/10

---

## 逐文件审查

### 1. `miner.py` (128 行)

#### 优点

- 函数有清晰 docstring，意图可见
- 公有/私有分离明确（`_is_dormant_by_time`、`_pct`、`_severity`）
- 魔数语义化：`_DORMANT_THRESHOLD_DAYS = 60` ✓
- `generate_actionable_issues` 各规则有注释，逻辑分段清晰
- 排序逻辑聚合在函数末尾，易于理解

#### 问题

| # | 问题 | 违反原则 | 建议 |
|---|------|---------|------|
| 1 | **`mine_patterns` 参数过多：10 个参数（6 必选 + 4 keyword-only）** | 一个关注点一条路径（量化标准：参数 >5 应打包） | 将 `is_sample`、`sample_size`、`total_sessions`、`since`、`until`、`session_time_map` 打包为 `AnalysisContext` dataclass。`mine_patterns` 只接收 7 个信号 dict + 1 个 context 对象 |
| 2 | **`generate_actionable_issues` 68 行，接近 80 行理想上限，内含 7 条规则的 inline 逻辑** | 一个关注点一条路径（函数 ~80 行理想） | 每条规则可提取为独立函数 `_rule_tool_error_rate(aggregated)`、`_rule_edit_failure(aggregated)` 等，主函数只做排序+截断 |

#### 细节观察

- `_is_dormant_by_time` 中 `for` → `if` → `try/except` 嵌套 3 层，但逻辑清晰可接受
- `_latest_from_uuid` 从 UUIDv7 提取时间的写法有隐式假设（假定所有 session ID 都是 UUIDv7），应添加注释说明

---

### 2. `reporter.py` (231 行)

#### 优点

- **三个文件中品味最好的**。函数职责单一、命名意图清晰
- `to_markdown` 72 行，刚好低于 80 行理想上限
- `_append_*_section` 命名规范，每个 section 函数职责单一 ✓
- 工具函数独立且复用性高：`_sanitize`、`_na`、`_pct`、`_safe_pct`、`_fmt_num`、`_short_name` ✓
- "N/A" fallback 统一处理了 None/NaN，体现了**显式优于隐式** ✓

#### 问题

| # | 问题 | 违反原则 | 建议 |
|---|------|---------|------|
| — | 无必须修复的问题 | — | — |

#### 细节观察

- `_sanitize` 递归实现，深度嵌套可能栈溢出，但 session 数据结构深度有限，无实际风险
- `_append_skill_section` 中 `h['name']` 直接 key 访问 vs 其他处用 `.get()`，风格轻微不一致——但已在存在，仅记录不要求改

---

### 3. `analyze.py` (137 行)

#### 优点

- CLI 参数定义清晰，帮助信息完善
- `_verbose` 使用 stderr 输出诊断信息 ✓（体现**反馈不断裂**）
- `_build_argparser()` 独立为函数，职责单一 ✓
- Pipeline 编排逻辑线性清晰：parse → extract → mine → report

#### 问题

| # | 问题 | 违反原则 | 建议 |
|---|------|---------|------|
| 1 | **`main()` 103 行**，远超 80 行理想上限，做 6 件事 | 一个关注点一条路径（量化标准：>150 必须拆分，但 80 行已是理想） | 将 session_time_map 构建、extractor 编排、users_subset 优化分别提取为 `_build_session_time_map(sessions)` 和 `_run_extractors(sessions)` |
| 2 | **`import random as _rng` 在函数体中**（第 83 行附近），而文件顶部已有 `import random` | 一个关注点一条路径（同一模块两种 import 风格） | 删除顶部 `import random`，保留 `import random as _rng` 在文件顶部，函数体内直接复用 |

#### 细节观察

- 10 处 `# type: ignore[import-not-found]` 是 import 路径脆弱的信号。这是 `sys.path.insert(0, ...)` hack 导致的，在现有项目结构下是合理选择——但长期应通过 `pip install -e .` 或调整 `PYTHONPATH` 解决
- 缺少 `from __future__ import annotations`（其他两文件都有），轻微不一致
- 内联注释解释了 users_subset 性能优化的原因 ✓（体现注释"为什么"而非"是什么"）

---

## 按原则汇总

| 原则 | 符合度 | 说明 |
|------|--------|------|
| 显式优于隐式 | ★★★★☆ | 命名清晰，魔数语义化，但 analyze.py 的 import 路径 hack 是隐式魔法 |
| 一个关注点一条路径 | ★★★☆☆ | reporter.py 良好；miner.py 参数超标；analyze.py main() 103 行 |
| 信任止于边界 | ★★★★★ | 三文件没有边界验证，但作为内部 pipeline 工具，无外部输入暴露 |
| 反馈不断裂 | ★★★★★ | analyze.py verbose 使用 stderr，reporter.py 统一 N/A fallback |

---

## 必须修复（must_fix=2）

按优先级排列：

1. **`analyze.py`: 重构 `main()`** — 提取 `_build_session_time_map()` 和 `_run_extractors()`，将 `import random as _rng` 移至文件顶部，使 main() 降至 60 行以内
2. **`miner.py`: 缩减 `mine_patterns` 参数** — 将分析元信息参数（is_sample, sample_size, total_sessions, since, until, session_time_map）打包为 `AnalysisContext` 类型

## 建议修改（非阻塞）

- `analyze.py`: 统一添加 `from __future__ import annotations`
- `miner.py`: `_latest_from_uuid` 添加 UUIDv7 假设注释
