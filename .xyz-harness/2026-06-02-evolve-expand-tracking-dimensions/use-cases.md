---
verdict: pass
---

# Use Cases — Evolve 扩展追踪维度

## UC-1: 分析 Compact 频率

**Actor:** AI Agent（通过 /evolve skill）

**Preconditions:** 已有 session JSONL 数据

**Main Flow:**
1. Python analyzer 运行 compact extractor
2. Extractor 扫描所有 session 的 compactionSummary 消息
3. 计算 total_compacts、compacts_per_session、compact_turn_indices
4. 输出到 daily-reports JSON 的 compact_stats 字段

**Alternative Paths:**
- 无 session 数据 → 返回空统计
- extractor 异常 → 返回空统计，不中断其他 extractor

**Postconditions:** daily-reports JSON 包含 compact_stats

**Module Boundaries:** L3 Python Analyzer → daily-reports JSON

---

## UC-2: 识别上下文压力

**Actor:** AI Agent（通过 /evolve skill）

**Preconditions:** 已有 session JSONL 数据，包含 model_change 事件

**Main Flow:**
1. Python analyzer 运行 context extractor
2. Extractor 提取 model_change 事件获取模型和 context limit
3. 累积消息字符数，估算 token 使用率
4. 计算 avg_estimated_utilization、peak_estimated_utilization
5. 输出到 daily-reports JSON 的 context_stats 字段

**Alternative Paths:**
- 无 model_change 事件 → 使用默认 context limit
- 字符数/token 换算不精确 → 标注为"趋势观察指标"

**Postconditions:** daily-reports JSON 包含 context_stats

**Module Boundaries:** L3 Python Analyzer → daily-reports JSON

---

## UC-3: 追踪 Subagent 效率

**Actor:** AI Agent（通过 /evolve skill）

**Preconditions:** 已有 session JSONL 数据

**Main Flow:**
1. Python analyzer 运行 subagent extractor
2. Extractor 扫描 toolResult(subagent) 消息
3. 统计调用次数、成功/失败、结果长度
4. 分类任务类型（code_review/implementation/testing/analysis）
5. 输出到 daily-reports JSON 的 subagent_stats 字段

**Alternative Paths:**
- 无 subagent 调用 → 返回空统计
- 任务类型无法分类 → 归类为 "unknown"

**Postconditions:** daily-reports JSON 包含 subagent_stats

**Module Boundaries:** L3 Python Analyzer → daily-reports JSON

---

## UC-4: 分类工具错误类型

**Actor:** AI Agent（通过 /evolve skill）

**Preconditions:** 已有 session JSONL 数据

**Main Flow:**
1. Python analyzer 运行 tool_errors extractor
2. Extractor 扫描 isError=true 的 toolResult 消息
3. 使用正则匹配分类参数错误和运行时错误
4. 统计各工具的错误分布
5. 输出到 daily-reports JSON 的 tool_error_stats 字段

**Alternative Paths:**
- 错误消息不匹配任何模式 → 归类为 "unclassified"
- 正则匹配误分类 → 接受启发式结果

**Postconditions:** daily-reports JSON 包含 tool_error_stats

**Module Boundaries:** L3 Python Analyzer → daily-reports JSON

---

## UC-5: 分析工作流阶段效率

**Actor:** AI Agent（通过 /evolve skill）

**Preconditions:** 已有 session JSONL 数据，包含 coding-workflow 调用

**Main Flow:**
1. Python analyzer 运行 workflow extractor
2. Extractor 扫描 coding-workflow-phase-start 和 coding-workflow-gate 调用
3. 从时间戳计算各阶段耗时
4. 统计 gate 通过率和重试次数
5. 输出到 daily-reports JSON 的 workflow_stats 字段

**Alternative Paths:**
- 无 workflow 调用 → 返回空统计
- 时间戳格式异常 → 跳过该阶段耗时计算

**Postconditions:** daily-reports JSON 包含 workflow_stats

**Module Boundaries:** L3 Python Analyzer → daily-reports JSON

---

## UC-6: 评估 Goal 任务质量

**Actor:** AI Agent（通过 /evolve skill）

**Preconditions:** 已有 session JSONL 数据，包含 goal-state entries

**Main Flow:**
1. Python analyzer 运行 goal_quality extractor
2. Extractor 扫描 goal-state entries 和 todo tool 调用
3. 统计任务完成率、取消率、Evidence 质量
4. 计算 Evidence 质量评分（长度 + 具体性）
5. 输出到 daily-reports JSON 的 goal_quality_stats 和 todo_stats 字段

**Alternative Paths:**
- 无 goal-state entries → 返回空统计
- Evidence 为空 → 评分 0.0

**Postconditions:** daily-reports JSON 包含 goal_quality_stats 和 todo_stats

**Module Boundaries:** L3 Python Analyzer → daily-reports JSON

---

## UC-7: 生成优化建议

**Actor:** AI Agent（通过 /evolve skill）

**Preconditions:** daily-reports JSON 包含新维度数据

**Main Flow:**
1. /evolve skill 读取 daily-reports JSON
2. 按优先级分析各维度数据
3. 检查阈值，生成 actionable issues
4. LLM 分析 actionable issues，生成优化建议
5. 输出到 suggestions/pending.json

**Alternative Paths:**
- 无新维度数据 → 跳过新维度分析
- LLM 分析失败 → 使用规则化建议模板

**Postconditions:** suggestions/pending.json 包含新维度的优化建议

**Module Boundaries:** daily-reports JSON → L4 Skills → suggestions

---

## UC 覆盖映射

| UC | Spec AC | 覆盖说明 |
|----|---------|----------|
| UC-1 | AC-1 | compact_stats 在 daily-reports 中 |
| UC-2 | AC-2 | context_stats 在 daily-reports 中 |
| UC-3 | AC-3 | subagent_stats 在 daily-reports 中 |
| UC-4 | AC-4 | tool_error_stats 在 daily-reports 中 |
| UC-5 | AC-5 | workflow_stats 在 daily-reports 中 |
| UC-6 | AC-6 | goal_quality_stats + todo_stats 在 daily-reports 中 |
| UC-7 | AC-7, AC-8 | actionable_issues + /evolve skill 分析 |
