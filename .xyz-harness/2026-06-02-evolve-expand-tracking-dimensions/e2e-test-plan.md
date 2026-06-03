---
verdict: pass
---

# E2E Test Plan — Evolve 扩展追踪维度

## Test Scenarios

### TS-1: Compact 统计正确性

**AC:** AC-1

**Steps:**
1. 创建一个包含 3 个 compactionSummary 消息的 session JSONL
2. 运行 compact extractor
3. 验证 total_compacts == 3
4. 验证 compacts_per_session.avg == 3.0
5. 验证 compact_turn_indices 长度 == 3

### TS-2: 上下文利用率计算

**AC:** AC-2

**Steps:**
1. 创建一个包含 model_change 和长消息的 session JSONL
2. 运行 context extractor
3. 验证 models_used 包含正确的模型
4. 验证 avg_estimated_utilization 在合理范围内（0-1）
5. 验证 utilization_distribution 各桶之和 == session 数

### TS-3: Subagent 效率统计

**AC:** AC-3

**Steps:**
1. 创建一个包含 5 次 subagent 调用（2 失败）的 session JSONL
2. 运行 subagent extractor
3. 验证 total_calls == 5
4. 验证 failure_rate == 0.4
5. 验证 by_task_type 包含正确的分类

### TS-4: 工具参数错误分类

**AC:** AC-4

**Steps:**
1. 创建一个包含 10 个工具错误（6 参数错误、3 运行时错误、1 未分类）的 session JSONL
2. 运行 tool_errors extractor
3. 验证 param_errors == 6
4. 验证 runtime_errors == 3
5. 验证 unclassified_errors == 1
6. 验证 param_error_rate == 0.6

### TS-5: 工作流阶段统计

**AC:** AC-5

**Steps:**
1. 创建一个包含 coding-workflow-phase-start 和 coding-workflow-gate 调用的 session JSONL
2. 运行 workflow extractor
3. 验证 phase_stats 包含 spec/plan/dev/test/pr 五个阶段
4. 验证 gate_pass_rate 在 0-1 范围内

### TS-6: Goal 任务质量统计

**AC:** AC-6

**Steps:**
1. 创建一个包含 goal-state entries 的 session JSONL
2. 运行 goal_quality extractor
3. 验证 task_stats.completion_rate 在 0-1 范围内
4. 验证 evidence_stats.avg_evidence_score 在 0-1 范围内
5. 验证 todo_stats 包含正确的统计

### TS-7: Miner 规则触发

**AC:** AC-7

**Steps:**
1. 创建一个 daily-reports JSON，其中 compact_stats.compacts_per_session.avg = 5
2. 运行 compact_high_frequency rule
3. 验证返回 1 个 issue
4. 验证 issue.severity == "medium"

### TS-8: Extractor 独立运行

**AC:** AC-9

**Steps:**
1. 创建一个 extractor 实现，其 extract 方法抛出异常
2. 运行 run_extractors
3. 验证其他 extractor 正常运行
4. 验证失败的 extractor 返回空 dict

## Test Environment

- Python 3.10+
- pytest
- 临时 session JSONL 文件（测试 fixtures）
- 临时 daily-reports JSON 文件（测试 fixtures）
