---
review:
  type: plan_review
  round: 2
  timestamp: "2026-05-27T12:30:00"
  target: ".xyz-harness/2026-05-27-session-analyzer-phase2"
  verdict: pass
  summary: "第2轮审查：2条 MUST FIX 均已修复，未引入新阻塞问题，通过。"

statistics:
  total_issues: 5
  must_fix: 0
  must_fix_resolved: 2
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:score_skill_health 判定逻辑"
    title: "DORMANT 判定缺少时间维度，不满足 AC-4 的 '60+ 天未触发' 要求"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "plan Task 1 Step 2 新增了完整的时间维度判定描述：从 triggered_skills[name].sessions 提取 session 时间戳，最新触发距今 > 60 天也标记为 DORMANT。同时修改了 score_skill_health 的输入描述，明确接收含 session 时间戳的 skill_stats。"
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 2 Step 1 vs Step 2-4"
    title: "to_markdown 未明确缺失值处理策略，违反 AC-2"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "plan Task 2 Step 2 新增了缺失值处理说明：'所有章节中，数值字段为 None/NaN/空 时统一显示 N/A'。"
  - id: 3
    severity: LOW
    location: "plan.md:Task 1 Step 4"
    title: "test_miner.py 缺少对 AC-4 时间维度判定逻辑的测试覆盖"
    status: open
    raised_in_round: 1
    resolved_in_round: null
    reason: "步骤 4 的测试用例列表仍然只有 test_score_skill_health_dormant (triggers=0 → DORMANT)，未补充时间维度测试。建议在实现时增加 test_score_skill_health_dormant_by_time 测试。"
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

# 计划评审 v2

## 评审记录
- 评审时间：2026-05-27 12:30
- 评审类型：计划评审（第 2 轮）
- 评审对象：`.xyz-harness/2026-05-27-session-analyzer-phase2/plan.md`
- 上一轮 verdict：**fail**（2 条 MUST FIX）

---

## 1. MUST FIX 修复验证

### MUST FIX #1: DORMANT 时间维度（AC-4）

**修复内容检查：**

| 检查点 | 结果 | 证据 |
|--------|------|------|
| 新增时间维度判定描述 | ✅ 已添加 | Task 1 Step 2：明确描述了从 session 时间戳判定 60 天规则 |
| 判定逻辑具体 | ✅ 充分 | "最新触发时间距今 > 60 天,也标记为 DORMANT" |
| score_skill_health 输入适配 | ✅ 已描述 | "接收 skill_stats(含 triggered_skills 的 session 列表和项目列表)" |
| 与其他判定规则的优先级 | ✅ 正确 | 时间维度 DORMANT 是交叉检查逻辑，不与其他 REFINE/KEEP 规则冲突 |

**实现可行性：** 从 `skill_stats.triggered_skills[name].sessions` 提取 session 时间戳（需确保 sessions 数据包含 timestamp 字段），取最大值，与 `_meta.analysis_period.until` 比较。如果已有数据不含 timestamp，实现时需要补充读取 session 文件元信息——通过 `stat` 或文件名的日期部分获取。

**结论：已修复。** Plan 层逻辑完备。

---

### MUST FIX #2: to_markdown 缺失值处理（AC-2）

**修复内容检查：**

| 检查点 | 结果 | 证据 |
|--------|------|------|
| to_markdown 新增缺失值处理 | ✅ 已添加 | Task 2 Step 2-4 的通用描述："数值字段为 None/NaN/空 时统一显示 N/A" |
| 范围明确 | ✅ 充分 | "所有章节中"——覆盖了概要、工具、Token、错误、用户、Skill、跨项目、Top-N 全部章节 |
| float 处理 | ✅ 一致 | "float 值统一 round 到 2 位小数"——与 to_json 行为一致 |
| 百分比格式 | ✅ 明确 | "12.34%" 格式 |

**结论：已修复。** to_markdown 与 to_json 在缺失值处理上行为一致，满足 AC-2。

---

## 2. 修复引入的新问题检查

### 2.1 score_skill_health 接口契约一致性

Interface Contracts 中 `score_skill_health` 的签名仍然是：
```
(skill_stats: dict, cross_project: dict) -> list[dict]
```

plan Step 2 的描述要求 `skill_stats` 包含 session 时间戳信息。两者不矛盾——dict 类型足够灵活，但 plan 未在 Interface Contracts 字段表中展开说明 `skill_stats` 或其子字段新增的 `sessions` 键。

**影响评估：** 低。BG1 subagent 会同时读取 plan 的 Step 2 描述和 Interface Contracts，结合 `skills.py` extractor 的实际返回值理解所需数据。BG2/BG3/BG4 不直接操作 `skill_stats` 内部结构，不受影响。

**建议（非阻塞）：** 如果希望在文档层面更精确，可以在 `score_skill_health` 的 Edge Cases 中注明：
> "session 时间戳缺失 → 回退到纯 triggers==0 判定，不应用时间维度规则"

当前 plan 没有这个回退说明，如果 extractor 数据中缺少时间戳，实现可能会出错。

### 2.2 性能影响评估

新增的时间维度判定需要遍历 `triggered_skills[name].sessions` 计算最新触发时间。对于大量触发器 skill 的场景，每个 skill 的 sessions 列表可能包含数百个 entry：

- 复杂度：O(N × M)，N = triggered_skills 数，M = 各 skill 平均 sessions 数
- 实际量级：通常 N < 50，M < 100，单次遍历微秒级，不影响 AC-5 的 120s 预算
- **结论：无性能风险。**

### 2.3 no regression

其他未经修改的 Task（3、4）和 Execution Group（BG3、BG4）保持原样，不受修复影响。

---

## 3. 剩余未处理问题（非阻塞）

以下问题来自 v1，本次未修复，但不影响 pass 判定：

| # | 优先级 | 说明 | 处理建议 |
|---|--------|------|---------|
| 3 | LOW | 测试用例缺少时间维度 DORMANT 覆盖 | 实现时在 test_miner.py 中补充 `test_score_skill_health_dormant_by_time` |
| 4 | LOW | BG3 subagent 上下文缺少 config.py 常量说明 | 实现时在 BG3 task prompt 中明确 `SESSIONS_DIR` 路径 |
| 5 | INFO | duplicate_reads 无对应推导规则 | 实现时按兜底规则处理，suggestion=None |

---

## 4. 结论

| 维度 | 结果 |
|------|------|
| MUST FIX #1 修复 | ✅ 通过 — 时间维度 DORMANT 逻辑已补充 |
| MUST FIX #2 修复 | ✅ 通过 — to_markdown 缺失值处理已明确 |
| 修复引入新问题 | ⚠️ 发现 1 个建议性提示（接口契约未展开 sessions 字段），非阻塞 |
| 整体 verdict | ✅ **pass** |

**verdict: pass**

2 条 MUST FIX 均已正确修复，未引入新阻塞问题。建议在编码实现时留意：
1. 确保 `skills.py` extractor 返回的 `triggered_skills[name].sessions` 包含 session 时间戳
2. 补充时间维度 DORMANT 的单元测试
