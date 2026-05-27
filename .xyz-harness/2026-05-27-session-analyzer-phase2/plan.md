---
verdict: pass
complexity: L1
---

# Pi Session Analyzer Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 miner.py、reporter.py、analyze.py 三个模块,使 pi-session-analyzer 成为一个可 CLI 调用的完整分析工具。

**Architecture:** 三个新模块按 pipeline 顺序编排:CLI (analyze.py) → 7 Extractors (已有) → Miner (miner.py) → Reporter (reporter.py)。各模块通过 dict 传递数据,接口由函数签名 + 返回 key 定义。

**Tech Stack:** Python 3.10+, stdlib only

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `~/.pi/agent/scripts/pi-session-analyzer/miner.py` | create | BG1 | 模式聚合:跨信号问题挖掘 + Skill 健康度评分 |
| `~/.pi/agent/scripts/pi-session-analyzer/reporter.py` | create | BG2 | 报告生成:JSON + Markdown 双格式输出 |
| `~/.pi/agent/scripts/pi-session-analyzer/analyze.py` | create | BG3 | CLI 入口:argparse 参数解析 + pipeline 编排 |
| `~/.pi/agent/scripts/pi-session-analyzer/tests/test_miner.py` | create | BG1 | miner 单元测试 |
| `~/.pi/agent/scripts/pi-session-analyzer/tests/test_reporter.py` | create | BG2 | reporter 单元测试 |
| `~/.pi/agent/scripts/pi-session-analyzer/tests/test_analyze.py` | create | BG3 | analyze CLI 集成测试 |

## Interface Contracts

### Module: miner

#### Function: mine_patterns

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| mine_patterns | (tool_stats: dict, token_stats: dict, error_stats: dict, user_patterns: dict, skill_stats: dict, cross_project: dict, satisfaction: dict, is_sample: bool = False, sample_size: int \| None = None, total_sessions: int = 0) -> dict | dict with keys: `_meta`, `tool_stats`, `token_stats`, `error_stats`, `user_patterns`, `skill_stats`, `cross_project`, `satisfaction`, `actionable_issues`, `skill_health` | sessions=0 → actionable_issues=[], skill_health=[] | FR-2, AC-3, AC-4 |
| generate_actionable_issues | (aggregated: dict) -> list[dict] | list of {description, impact_sessions, total_sessions, severity, suggestion} | 无匹配规则 → suggestion=None | FR-2, AC-3 |
| score_skill_health | (skill_stats: dict, cross_project: dict) -> list[dict] | list of {name, status, triggers, projects, file_size_kb} | 无 installed skills → [] | FR-2, AC-4 |

#### Data: AggregatedResult._meta

| Field | Type | Description |
|-------|------|-------------|
| is_sample | bool | 是否抽样分析 |
| sample_size | int \| None | 抽样数量 |
| total_sessions | int | 实际分析的 session 数 |
| analysis_period | {since: str, until: str} | 分析时间范围 |

#### Data: ActionableIssue

| Field | Type | Description |
|-------|------|-------------|
| description | str | 问题描述 |
| impact_sessions | int | 受影响 session 数 |
| total_sessions | int | 总 session 数 |
| severity | "high" \| "medium" \| "low" | 严重程度 |
| suggestion | str \| None | 建议操作(兜底时为 None) |

#### Data: SkillHealthEntry

| Field | Type | Description |
|-------|------|-------------|
| name | str | skill 名称 |
| status | "KEEP" \| "REFINE" \| "DORMANT" | 健康度判定 |
| triggers | int | 触发次数 |
| projects | int | 触发项目数 |
| file_size_kb | float | SKILL.md 文件大小(KB) |

### Module: reporter

#### Function: to_json

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| to_json | (aggregated_result: dict) -> dict | dict (可 json.dumps 序列化) | 数值字段缺失 → "N/A" | FR-3, AC-2 |

#### Function: to_markdown

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| to_markdown | (aggregated_result: dict) -> str | Markdown 字符串 | _meta.is_sample=True → 标题改为"抽样分析报告" | FR-3, FR-4, AC-2 |

### Module: analyze

#### Function: main

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| main | () -> None | None (sys.exit) | 目录不存在 → stderr + exit 1 | FR-1 |

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1 | analyze.main | CLI args → parse_all_sessions → extractors → miner → reporter → output | Task 3 |
| AC-2 | reporter.to_json / to_markdown | aggregated_result → format output | Task 2 |
| AC-3 | miner.generate_actionable_issues | error_stats + tool_stats → issue list | Task 1 |
| AC-4 | miner.score_skill_health | skill_stats + cross_project → health list | Task 1 |
| AC-5 | analyze.main (full pipeline) | 670 files → parse → extract → mine → report | Task 3 |
| AC-6 | (post-impl operation) | analyze.py --output → report file | Task 4 |
| AC-7 | (post-impl operation) | crontab setup | Task 4 |

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 CLI 正常工作 | adopted | Task 3 |
| AC-2 报告内容完整 | adopted | Task 2 |
| AC-3 Top-N 问题列表有效 | adopted | Task 1 |
| AC-4 Skill 健康度评分有效 | adopted | Task 1 |
| AC-5 全量分析 < 120s | adopted | Task 3 |
| AC-6 回顾性报告产出 | adopted | Task 4 |
| AC-7 Cron 配置正确 | adopted | Task 4 |

---

## Task List

| # | Task | Type | Depends on | Group |
|---|------|------|-----------|-------|
| 1 | miner.py - 模式聚合 | backend | - | BG1 |
| 2 | reporter.py - 报告生成 | backend | 1 | BG2 |
| 3 | analyze.py - CLI 入口 | backend | 2 | BG3 |
| 4 | 回顾性分析 + Cron 配置 | backend | 3 | BG4 |

---

### Task 1: miner.py - 模式聚合

**Type:** backend

**Files:**
- Create: `~/.pi/agent/scripts/pi-session-analyzer/miner.py`
- Create: `~/.pi/agent/scripts/pi-session-analyzer/tests/test_miner.py`

**已有代码接口(extractor 返回 key):**
- `tools.py` → `analyze_tool_usage()` → {total_calls, by_tool, edit_retry_rate, duplicate_reads, bash_command_types, tool_sequences}
- `tokens.py` → `analyze_token_usage()` → {total_input, total_output, total_cache_read, avg_per_session, avg_per_turn, by_project, by_model, hotspots, cost_total}
- `errors.py` → `analyze_errors()` → {total_errors, by_tool, bash_failure_rate, edit_match_failure_rate, top_error_patterns, self_correction_rate, by_project}
- `users.py` → `analyze_user_patterns()` → {total_user_messages, avg_per_session, corrections, repeated_requests, supplementary_instructions}
- `skills.py` → `analyze_skill_usage()` → {installed_skills, triggered_skills, never_triggered, skill_file_sizes, total_skill_reads, by_project}
- `cross_project.py` → `analyze_cross_project()` → {project_count, projects, common_tool_sequences, project_type_distribution}
- `satisfaction.py` → `analyze_satisfaction()` → {total_sessions, single_turn_completion_rate, avg_turns_per_session, avg_tool_calls_per_session, session_duration_stats, by_project}

- [ ] **Step 1: 创建 miner.py 骨架 + generate_actionable_issues**

`miner.py` 包含 3 个公有函数:`mine_patterns()`, `generate_actionable_issues()`, `score_skill_health()`。

`generate_actionable_issues(aggregated)` 实现建议操作自动推导规则(spec FR-2 的 7+1 规则表)。算法:
1. 收集候选问题:遍历 by_tool 错误率、bash/edit 失败率、duplicate_reads、repeated_requests、never_triggered、skill_file_sizes
2. 对每个候选问题,按规则表从上到下匹配第一条规则,生成 suggestion
3. 计算每个问题的 impact_sessions 和 severity(impact > 30% → high, > 10% → medium, else low)
4. 按 severity + impact_sessions 降序排列,取 Top 10

- [ ] **Step 2: 实现 score_skill_health**

`score_skill_health(skill_stats, cross_project)` 判定逻辑:
- triggers == 0 → DORMANT
- triggers > 0 但仅在一个项目触发且 file_size_kb > 10 → REFINE
- triggers > 0 且 file_size_kb > 20 → REFINE
- triggers > 0 且 file_size_kb <= 20 且触发项目数 >= 2 → KEEP

注意:DORMANT 判定基于 `skill_stats.triggered_skills` 是否包含该 skill。对于 triggered_skills 中存在但最近 60 天未触发的 skill,需要交叉检查 `skill_stats.triggered_skills[name].sessions` 中的 session 时间戳。若最新触发时间距今 > 60 天,也标记为 DORMANT。

score_skill_health 接收 skill_stats(含 triggered_skills 的 session 列表和项目列表),从 session 列表推算最近触发时间。

- [ ] **Step 3: 实现 mine_patterns 胶水函数**

`mine_patterns(...)` 接收 7 个 extractor 的输出 + is_sample/sample_size/total_sessions 元信息,组装成统一 dict 返回。内部调用 generate_actionable_issues 和 score_skill_health。

- [ ] **Step 4: 创建 test_miner.py**

用 mock 数据测试:
- `test_generate_actionable_issues_high_error_rate`:构造某工具错误率 > 30%,验证生成对应建议
- `test_generate_actionable_issues_no_match`:构造所有条件都不满足的数据,验证 suggestion=None
- `test_score_skill_health_dormant`:triggers=0 → DORMANT
- `test_score_skill_health_keep`:triggers>0, file_size<20KB, 多项目 → KEEP
- `test_score_skill_health_refine_size`:triggers>0, file_size>20KB → REFINE
- `test_mine_patterns_meta`:验证 _meta 字段正确传递
- `test_mine_patterns_empty_sessions`:total_sessions=0 → actionable_issues=[], skill_health=[]

- [ ] **Step 5: 运行测试确认通过**

```bash
cd ~/.pi/agent/scripts/pi-session-analyzer && python3 -m pytest tests/test_miner.py -v
```

---

### Task 2: reporter.py - 报告生成

**Type:** backend

**Depends on:** Task 1

**Files:**
- Create: `~/.pi/agent/scripts/pi-session-analyzer/reporter.py`
- Create: `~/.pi/agent/scripts/pi-session-analyzer/tests/test_reporter.py`

- [ ] **Step 1: 实现 to_json**

`to_json(aggregated_result)` → 返回可直接 `json.dumps()` 的 dict。
- 对所有 float 值做 `round(v, 2)` 避免浮点精度问题
- 对 None / NaN 值替换为 "N/A"
- 直接返回 aggregated_result(已经包含 _meta + 各 extractor 输出 + miner 结果)

- [ ] **Step 2: 实现 to_markdown — 概要章节**

`to_markdown(aggregated_result)` 返回完整 Markdown 报告字符串。
- 标题：根据 `_meta.is_sample` 选择“抽样分析报告”或“分析报告”
- 概要章节：时间范围、session 数、项目数、总工具调用、总 token、错误率
- 所有章节中，数值字段为 None/NaN/空 时统一显示 “N/A”
- float 值统一 round 到 2 位小数
- 百分比值显示为 “12.34%” 格式

- [ ] **Step 3: 实现 to_markdown - 工具使用 + Token + 错误 + 用户章节**

四个数据章节,每个章节用表格 + 列表展示关键指标:
- 工具使用:调用频次排名表、失败率 Top 5、重复操作列表
- Token:总量、按项目分布表、按模型分布表、Top 5 热点 session
- 错误:bash/edit 失败率、Top 5 错误模式、自我纠正率
- 用户:否定式反馈频率、跨 session 重复指令 Top 5

- [ ] **Step 4: 实现 to_markdown - Skill + 跨项目 + Top-N 章节**

- Skill 健康度:已安装 vs 已触发数、未触发 skill 列表、健康度表格
- 跨项目:项目数量/类型分布、通用操作序列
- Top-N 问题:按优先级排列的列表

- [ ] **Step 5: 创建 test_reporter.py**

- `test_to_json_valid`:输出可 json.dumps 且包含所有顶层 key
- `test_to_json_na_handling`:None/NaN 值被替换为 "N/A"
- `test_to_markdown_sample_title`:is_sample=True 时标题包含"抽样"
- `test_to_markdown_full_title`:is_sample=False 时标题不包含"抽样"
- `test_to_markdown_all_sections`:输出包含所有 8 个章节标题(## 级别)
- `test_to_markdown_empty_data`:sessions=0 时不崩溃,输出有效 Markdown

- [ ] **Step 6: 运行测试确认通过**

```bash
cd ~/.pi/agent/scripts/pi-session-analyzer && python3 -m pytest tests/test_reporter.py -v
```

---

### Task 3: analyze.py - CLI 入口

**Type:** backend

**Depends on:** Task 2

**Files:**
- Create: `~/.pi/agent/scripts/pi-session-analyzer/analyze.py`
- Create: `~/.pi/agent/scripts/pi-session-analyzer/tests/test_analyze.py`

- [ ] **Step 1: 创建 analyze.py 骨架**

argparse 参数定义(与 spec FR-1 参数表一致):
- `--since` (default="7d")
- `--until` (default=None, 即 now)
- `--project` (default=None)
- `--sample` (type=int, default=None)
- `--output` (default=None, 即 stdout)
- `--format` (choices=["markdown", "json"], default="markdown")
- `--verbose` (store_true)

- [ ] **Step 2: 实现 main() pipeline**

```python
def main():
    args = parse_args()
    sessions = parse_all_sessions(since=args.since, until=args.until, project=args.project)
    # --sample handling: min(N, len(sessions))
    # 调用 7 个 extractor
    # 调用 miner.mine_patterns(..., is_sample=is_sample, sample_size=sample_size, total_sessions=len(sessions))
    # 根据 args.format 选择 reporter.to_json 或 to_markdown
    # 写入 args.output 或 stdout
```

错误处理:
- sessions 目录不存在:`Path(config.SESSIONS_DIR).exists()` 检查 → stderr + exit 1
- 无匹配 session:stderr 提示 + 输出空报告 + exit 0
- --sample N > len(sessions):stderr warning + 降级全量

- [ ] **Step 3: 添加 `if __name__ == "__main__"` 和 verbose 日志**

verbose 模式下在 stderr 打印:
- 解析了 N 个文件
- 提取完成
- 报告生成完成

- [ ] **Step 4: 创建 tests 目录和 test_analyze.py**

集成测试用 subprocess 运行 analyze.py:
- `test_help_flag`:`python3 analyze.py --help` → exit 0
- `test_since_7d_markdown`:`python3 analyze.py --since 7d` → stdout 非空 + 包含 Markdown 标题
- `test_json_output`:`python3 analyze.py --since 7d --format json` → 有效 JSON
- `test_output_file`:`python3 analyze.py --since 7d --output /tmp/test_report.md` → 文件存在且非空
- `test_sample_mode`:`python3 analyze.py --sample 5 --since 30d --format json` → JSON 中 _meta.is_sample=True

- [ ] **Step 5: 运行测试确认通过**

```bash
cd ~/.pi/agent/scripts/pi-session-analyzer && python3 -m pytest tests/test_analyze.py -v
```

- [ ] **Step 6: 运行全部测试**

```bash
cd ~/.pi/agent/scripts/pi-session-analyzer && python3 -m pytest tests/ -v
```

---

### Task 4: 回顾性分析 + Cron 配置

**Type:** backend

**Depends on:** Task 3

**Files:**
- 无新代码文件(操作执行)

- [ ] **Step 1: 运行抽样验证**

```bash
cd ~/.pi/agent/scripts/pi-session-analyzer && python3 analyze.py --sample 20 --since 90d --format markdown --output /tmp/sample_report.md
```

检查输出报告的 8 个章节是否都有内容,数据是否合理。

- [ ] **Step 2: 运行全量分析**

```bash
time python3 analyze.py --since 365d --format markdown --output ~/.pi/agent/evolution-data/reports/retrospective-$(date +%Y-%m-%d).md
```

验证:
- 执行时间 < 120 秒
- 报告包含至少 3 个可操作洞察
- 同时生成 JSON 版本:`python3 analyze.py --since 365d --format json --output ~/.pi/agent/evolution-data/reports/retrospective-$(date +%Y-%m-%d).json`

- [ ] **Step 3: 配置 cron**

```bash
(crontab -l 2>/dev/null; echo "0 8 * * 1 cd ~/.pi/agent/scripts/pi-session-analyzer && python3 analyze.py --since 7d --format markdown --output ~/.pi/agent/evolution-data/reports/weekly-\$(date +\\%Y-\\%m-\\%d).md") | crontab -
```

验证:`crontab -l` 包含新条目。

---

## Execution Groups

#### BG1: miner 模式聚合

**Description:** 实现 miner.py 的三个核心函数和对应单元测试。

**Tasks:** Task 1

**Files (预估):** 2 个文件(2 create)

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | taskComplexity: medium |
| 注入上下文 | Task 1 描述、spec FR-2、7 个 extractor 返回 key 列表、建议操作规则表 |
| 读取文件 | miner.py(新建), extractors/*.py(读取返回 key), config.py |
| 修改/创建文件 | miner.py, tests/test_miner.py |

**Dependencies:** 无

#### BG2: reporter 报告生成

**Description:** 实现 reporter.py 的双格式输出和对应单元测试。

**Tasks:** Task 2

**Files (预估):** 2 个文件(2 create)

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | taskComplexity: medium |
| 注入上下文 | Task 2 描述、spec FR-3/FR-4、reporter 函数签名、Markdown 报告结构 |
| 读取文件 | reporter.py(新建), miner.py(读取返回结构) |
| 修改/创建文件 | reporter.py, tests/test_reporter.py |

**Dependencies:** BG1(需要 miner.py 的返回结构定义)

#### BG3: analyze CLI 入口

**Description:** 实现 analyze.py 的 CLI 参数解析和 pipeline 编排。

**Tasks:** Task 3

**Files (预估):** 2 个文件(2 create)

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | taskComplexity: medium |
| 注入上下文 | Task 3 描述、spec FR-1、参数表、错误处理规则、parser.py 公开 API |
| 读取文件 | analyze.py(新建), parser.py, miner.py, reporter.py, config.py |
| 修改/创建文件 | analyze.py, tests/test_analyze.py |

**Dependencies:** BG2(需要 reporter.py 和 miner.py)

#### BG4: 回顾性分析 + Cron

**Description:** 运行验证、全量分析、配置 cron。

**Tasks:** Task 4

**Files (预估):** 0 个新文件(纯操作执行)

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | taskComplexity: low |
| 注入上下文 | Task 4 描述、AC-5/AC-6/AC-7 验证命令 |
| 读取文件 | analyze.py(验证可执行) |
| 修改/创建文件 | 无(产出报告文件和 cron 条目) |

**Dependencies:** BG3(需要 analyze.py 完成并可执行)

## Dependency Graph & Wave Schedule

```
BG1 (miner) → BG2 (reporter) → BG3 (analyze CLI) → BG4 (验证+cron)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | miner 模式聚合,无依赖 |
| Wave 2 | BG2 | reporter,依赖 miner 返回结构 |
| Wave 3 | BG3 | analyze CLI,依赖 reporter + miner |
| Wave 4 | BG4 | 全量验证 + cron 配置 |
