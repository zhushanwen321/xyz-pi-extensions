---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-27T12:00:00"
  target: ".xyz-harness/2026-05-27-session-analyzer-phase2"
  verdict: fail
  summary: "计划评审完成，第1轮，2条MUST FIX，需修改后重审"

statistics:
  total_issues: 5
  must_fix: 2
  must_fix_resolved: 0
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:score_skill_health 判定逻辑"
    title: "DORMANT 判定缺少时间维度，不满足 AC-4 的 '60+ 天未触发' 要求"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 2 Step 1 vs Step 2-4"
    title: "to_markdown 未明确缺失值处理策略，违反 AC-2"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "plan.md:Task 2, Step 2-4"
    title: "test_miner.py 缺少对 AC-4 时间维度判定逻辑的测试覆盖"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "plan.md:BG3 Subagent 配置"
    title: "config.py 中 SESSIONS_DIR 的来源和默认值在 plan 中未明确定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: INFO
    location: "plan.md:Task 1 Step 1"
    title: "duplicate_reads 指标无对应推导规则，兜底为 suggestion=None"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-27 12:00
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-05-27-session-analyzer-phase2/` 下的 spec.md + plan.md + e2e-test-plan.md + use-cases.md + non-functional-design.md

---

## 1. Spec 完整性

| 维度 | 结果 | 说明 |
|------|------|------|
| 目标明确性 | ✅ 通过 | "构建离线分析能力：读取 JSONL，提取 7 类信号，产出结构化分析报告" |
| 范围合理性 | ✅ 通过 | 明确只新增 miner/reporter/analyze 三个模块，不重写已有代码 |
| AC 可量化性 | ✅ 通过 | 7 条 AC 均可验证（命令输出校验、内容校验、性能基准、文件存在性） |
| 待决议项 | ✅ 无风险 | `[待决议]` 未出现 |

**补充观察：** spec 的 FR-2 中 score_skill_health 的判定规则只定义了 triggers==0 的 DORMANT 逻辑，但 AC-4 要求"60+ 天未触发"。这是 spec 内部 FR 与 AC 之间的歧义——plan 按 FR-2 实现会遗漏 AC-4 的时间维度要求（见 MUST FIX #1）。

---

## 2. Plan 可行性

| 维度 | 结果 | 说明 |
|------|------|------|
| 任务拆分粒度 | ✅ 合理 | 4 个 task，每个 task 对应一个模块或操作，可独立由 subagent 完成 |
| 依赖关系 | ✅ 正确 | BG1(miner) → BG2(reporter) → BG3(analyze) → BG4(operational) |
| 工作量估算 | ✅ 现实 | ~400-600 行新增代码，4 个 task 均能在预算内完成 |
| 遗漏 task | ✅ 无遗漏 | spec 的 6 个 FR 和 7 条 AC 全部被覆盖 |

**检查结果：** plan 覆盖了 spec 中所有需求项。test 文件（test_miner.py, test_reporter.py, test_analyze.py）是 plan 的实现细节，不属于 spec 必须显示列出的内容，不视为"额外工作"。

---

## 3. Spec 与 Plan 一致性

### AC 覆盖矩阵逐条验证

| Spec AC | Plan 对应项 | 覆盖状态 | 备注 |
|---------|------------|---------|------|
| AC-1 CLI 正常工作 | Task 3 (analyze.py) | ✅ | 完整覆盖参数表 + 错误处理 |
| AC-2 报告内容完整 | Task 2 (reporter.py) | ⚠️ 见 MUST FIX #2 | to_markdown 缺失值处理未明确 |
| AC-3 Top-N 问题有效 | Task 1 (miner.py) | ✅ | generate_actionable_issues + 排序取 Top 10 |
| AC-4 Skill 健康度有效 | Task 1 (miner.py) | ❌ 见 MUST FIX #1 | 缺少时间维度 DORMANT 判定 |
| AC-5 全量分析 < 120s | Task 3 (pipeline) + Task 4 (验证) | ✅ | 性能约束已在 Task 4 验证步骤中体现 |
| AC-6 回顾性报告产出 | Task 4 Step 2 | ✅ | 运行命令正确，输出路径正确 |
| AC-7 Cron 配置正确 | Task 4 Step 3 | ✅ | cron 命令 + 参数 + 验证步骤完整 |

### 其他一致性检查

- plan 中无 spec 未提及的额外工作（测试文件属实现细节，非"额外"）
- 7 个 extractor 的返回 key 列表与 spec 一致
- 脚本安装路径 `~/.pi/agent/scripts/pi-session-analyzer/` 一致
- 报告输出路径 `~/.pi/agent/evolution-data/reports/` 一致
- 技术栈约束（Python 3.10+, stdlib only）被遵守

---

## 4. Execution Groups 合理性

| 维度 | BG1 (miner) | BG2 (reporter) | BG3 (analyze) | BG4 (cron) |
|------|------------|---------------|--------------|-----------|
| 文件数 ≤ 10 | ✅ 2 文件 | ✅ 2 文件 | ✅ 2 文件 | ✅ 0 文件 |
| Task 数 ≤ 4 | ✅ 1 task | ✅ 1 task | ✅ 1 task | ✅ 1 task |
| 类型纯净 | ✅ 全后端 | ✅ 全后端 | ✅ 全后端 | ✅ 全后端 |
| 功能关联度 | ✅ miner + 测试 | ✅ reporter + 测试 | ✅ CLI + 测试 | ✅ 纯操作 |
| 依赖正确 | ✅ 无依赖 | ✅ 依赖 BG1 | ✅ 依赖 BG2 | ✅ 依赖 BG3 |
| Wave 可并行 | ✅ Wave 1 单独 | ✅ Wave 2 单独 | ✅ Wave 3 单独 | ✅ Wave 4 单独 |
| Subagent 配置完整 | ✅ Agent/Model/Context/Files 完整 | ✅ 同上 | ✅ 同上 | ✅ 同上 |
| 上下文充分性 | ✅ extractor 返回 key 列表 + 规则表 + spec FR-2 | ✅ miner 返回结构 + FR-3/FR-4 | ✅ parser/miner/reporter API + FR-1 | ✅ 验证命令 |
| 文件数预估准确 | ✅ 2 create | ✅ 2 create | ✅ 2 create | ✅ 无 |

**结论：** 4 个 Execution Group 划分合理，依赖链正确，Wave 编排合理。subagent 配置信息充分。

---

## 5. 接口契约审查

### Type 一致性检查

plan 中 Interface Contracts 定义的函数签名与已有 extractor 返回值类型对照：

| plan 函数 | 参数来源 | 类型兼容性 | 结论 |
|----------|---------|-----------|------|
| `mine_patterns` | 7 个 extractor 的 dict 输出 | ✅ 参数名与 extractor key 一一对应 | 通过 |
| `generate_actionable_issues` | aggregated dict | ✅ 内部访问字段与 FR-2 一致 | 通过 |
| `score_skill_health` | skill_stats, cross_project | ✅ 字段名与 skills.py 返回 key 一致 | 通过 |
| `to_json` | aggregated_result dict | ✅ 返回 dict，可直接 json.dumps | 通过 |
| `to_markdown` | aggregated_result dict | ✅ 返回 str | 通过 |
| `main()` | argparse 解析 + 调用链 | ✅ pipeline 顺序正确 | 通过 |

### ActionableIssue 类型定义

| 字段 | Spec 要求 | Plan 定义 | 一致? |
|------|----------|----------|-------|
| description | 问题描述 | description: str | ✅ |
| impact_sessions | 影响 session | impact_sessions: int | ✅ |
| total_sessions | 总 session 数 | total_sessions: int | ✅ |
| severity | high/medium/low | "high" \| "medium" \| "low" | ✅ |
| suggestion | 建议操作（可 null） | str \| None | ✅ |

### SkillHealthEntry 类型定义

| 字段 | Spec 要求 | Plan 定义 | 一致? |
|------|----------|----------|-------|
| name | skill 名称 | name: str | ✅ |
| status | 健康度判定 | "KEEP"\|"REFINE"\|"DORMANT" | ✅ |
| triggers | 触发次数 | triggers: int | ✅ |
| projects | 触发项目数 | projects: int | ✅ |
| file_size_kb | SKILL.md 大小 | file_size_kb: float | ✅ |

### _meta 类型定义

| 字段 | Spec 要求 | Plan 定义 | 一致? |
|------|----------|----------|-------|
| is_sample | 是否抽样 | is_sample: bool | ✅ |
| sample_size | 抽样数 | int \| None | ✅ |
| total_sessions | session 数 | total_sessions: int | ✅ |
| analysis_period | 时间范围 | {since, until} | ✅ |

**结论：** Interface Contracts 与 extractor 返回值、spec 定义一致。无类型不匹配。

---

## 6. 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | **MUST FIX** | plan.md:Task 1 Step 2 score_skill_health 判定逻辑 | **DORMANT 判定缺少时间维度，不满足 AC-4 要求。** spec AC-4 明确要求"60+ 天未触发"作为 DORMANT 判定条件。当前 plan 的判定逻辑只用 `triggers == 0` 来判断 DORMANT，仅覆盖"从未触发"的 skill，遗漏了"曾经触发但过去 60 天未触发"的 skill。严重程度：高——这会导致回顾性报告无法满足 AC-4 要求 | 在 score_skill_health 中添加时间维度判定：传入一个 `last_triggered_timestamps` 参数（来自 skill_stats），对 `triggers > 0 && last_triggered > 60 天前` 的 skill 也标记为 DORMANT。或在 `_meta` 中添加分析截至时间，由 score_skill_health 计算时间差 |
| 2 | **MUST FIX** | plan.md:Task 2 Step 1 vs Step 2-4 | **to_markdown 未明确缺失值处理策略，违反 AC-2。** spec AC-2 要求"无 None / NaN / 空值出现在报告中（缺失数据用 'N/A' 标记）"，约束同时约束 JSON 和 Markdown 格式。plan 中 to_json (Step 1) 明确了对 None/NaN 替换为 "N/A"，但 to_markdown (Step 2-4) 没有对应的缺失值处理说明。如果某个统计字段为 None，to_markdown 直接拼接会输出 Python 字符串 "None"，违反 AC-2。 | 在 to_markdown 的 Step 2-4 中明确：所有从 dict 中读取的数值/字符串字段，遇到 None/NaN 时替换为 "N/A"。可抽取一个辅助函数 `_safe(val, default="N/A")` 供 to_markdown 统一使用 |
| 3 | LOW | plan.md:test_miner.py Step 4 | **测试用例缺少对 AC-4 时间维度判定逻辑的覆盖。** 当前 test_miner.py 的 `test_score_skill_health_dormant` 只测了 `triggers=0` 的 case。如果 MUST FIX #1 修复后增加了时间维度判定，需要补充测试：最近 60 天前触发过的 skill 也应标记为 DORMANT。 | 在 test_miner.py 中增加测试用例：构造 `last_triggered_timestamp` 为 90 天前的 skill 数据，验证 score_skill_health 返回 DORMANT |
| 4 | LOW | plan.md:BG3 Subagent 配置 | **config.py 中 SESSIONS_DIR 的来源和默认值在 plan 中未明确定义。** spec FR-1 的 pipeline 代码中使用了 `config.SESSIONS_DIR`，但 config.py 是 Phase 1 已存在的文件，plan 没有说明该常量的默认值（应该是 `os.path.expanduser("~/.pi/agent/sessions/")`）。BG3 subagent 需要自行读取 config.py，存在误解风险。 | 在 BG3 的"注入上下文"或 Task 3 描述中添加：`config.SESSIONS_DIR` 的典型值（`~/.pi/agent/sessions/`），或明确说明 subagent 必须从 config.py 中读取该常量 |
| 5 | INFO | plan.md:Task 1 Step 1 generate_actionable_issues | **duplicate_reads 指标无对应推导规则，兜底为 suggestion=None。** spec FR-2 的规则表有 7+1 条规则，其中第 4 条"某工具被大量重复调用（同一 session 内同一目标重复 > 5 次）"是关于重复调用的通用规则，但 duplicate_reads 作为 tools extractor 的返回值，没有直接在规则表中体现。按兜底规则处理（suggestion=None）是合理的，但值得注意。 | 如果希望 duplicate_reads 也有建议操作，可在规则表中增加一条："某文件被重复读取 > 3 次 → 建议缓存常用文件内容到 session context"。当前兜底方案可接受。 |

---

## 7. 实现代码检查

按照评审方法论要求检查 plan 中是否包含实现代码：

- plan.md 包含：函数签名、类型定义、实现步骤描述、测试用例名称
- **无实际 Python 实现代码**（无 class/def 实现体，无控制流语句）
- 测试描述使用自然语言而非具体 assert 代码

**结论：通过。** plan 保持在设计文档层面，不包含实现代码。

---

## 结论

**verdict: fail**

2 条 MUST FIX 需要修复后才能通过：

1. **M1**: score_skill_health 缺失时间维度 DORMANT 判定，不满足 AC-4
2. **M2**: to_markdown 缺失值处理策略未明确，违反 AC-2

其余 3 条问题（2 LOW + 1 INFO）不影响通过判定，建议在修复 MUST FIX 时一并处理。

### Summary

计划评审完成，第1轮，2条MUST FIX，需修改后重审。总体结构和设计质量良好——spec 完整性、plan 可行性、Execution Groups 划分、Interface Contracts 定义均无明显缺陷。核心问题是 AC-4 的时间维度 DORMANT 判定被遗漏，以及 markdown 格式的缺失值防护。
