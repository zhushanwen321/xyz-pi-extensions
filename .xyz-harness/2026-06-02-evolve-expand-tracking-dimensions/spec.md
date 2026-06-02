---
title: "Evolve 扩展追踪维度 Spec"
status: approved
verdict: pass
date: 2026-06-02
---

# Evolve 扩展追踪维度

## 1. 背景与目标

Evolve 系统已有 8 维 extractor（tools/tokens/errors/users/skills/cross_project/satisfaction/skill_state）和 skill-state 实时追踪。但以下关键维度**未被追踪**，导致无法量化 AI Agent 使用过程中的效率瓶颈。

本 Spec 定义 6 个新追踪维度的具体信号、指标、采集方式和分析规则。

### 1.1 Problem Registry 的定位

Problem Registry 是**问题索引 + 阈值配置 + 建议模板**，不驱动 L2/L3 的实际逻辑。

```
ProblemRegistry（TypeScript）
├─ L2 引用：engine.ts 读取 registry 获取 problem ID 和 steering 模板
│  但 detector 的匹配逻辑和状态管理是独立代码，不从 registry 声明式生成
│
├─ L3 引用：Python 侧有独立的 config.py 存储相同的阈值配置
│  extractor 和 rule 是独立代码，不从 registry 自动生成
│
└─ L4 引用：/evolve skill 读取 registry 的建议模板生成建议
```

**实际用途**：
1. 文档化 — 列出所有追踪目标的 ID、名称、分类、严重度阈值
2. 阈值共享 — L3 miner 和 L4 建议生成引用相同的阈值定义
3. 建议模板 — L4 生成建议时的标题/描述模板

**不做的事情**：
- 不驱动 L2 检测器的创建（每个 detector 是独立的事件处理器）
- 不驱动 L3 extractor 的注册（每个 extractor 是独立的 Python 文件）

---

## 2. 追踪维度详细设计

### 2.1 Compact 追踪

**问题**：频繁 compact 说明上下文管理效率低。但 compact 后信息丢失难以量化（AI 丢失原始上下文后无法自报丢失了什么）。

**信号源**：session JSONL 中 `message.role === "compactionSummary"` 的消息。这是 Pi 原生 compact 后注入的摘要消息。

**可追踪的数据**：

| 指标 | 信号 | 计算方式 |
|------|------|----------|
| compact 次数 | `compactionSummary` 消息计数 | count(messages where role === "compactionSummary") |
| compact 触发时的 turn 索引 | compactionSummary 在消息序列中的位置 | 消息序号 / 2（粗略 turn 数） |
| compact 前的消息数 | compactionSummary 之前的消息总数 | index of compactionSummary |
| 是否与 context-engineering 重叠 | compactionSummary 前后是否有 context-engineering 的 custom entry | 检查 custom entries |

**不能追踪的**：
- compact 前后的精确 token 数（session JSONL 不记录每条消息的 token 数）
- 信息丢失量（compact 后 AI 已丢失原始上下文，无法对比）

**产出数据结构**（daily-reports JSON 新增字段）：

```json
{
  "compact_stats": {
    "total_compacts": 12,
    "compacts_per_session": {"avg": 1.5, "max": 4, "distribution": [0, 0, 3, 5, 2, 1, 0]},
    "compact_turn_indices": [15, 28, 42, 55, ...],
    "sessions_with_compact": 8,
    "total_sessions": 12
  }
}
```

**Miner 规则**：

| 规则 ID | 条件 | 严重度 | 建议 |
|---------|------|--------|------|
| `compact-high-frequency` | avg_compacts_per_session ≥ 3 | medium | "优化上下文管理，减少不必要的工具输出长度" |
| `compact-early-trigger` | ≥ 30% 的 compact 发生在 turn < 10 | high | "检查 session 初始加载的 token 消耗（CLAUDE.md/skill 是否过大）" |

---

### 2.2 上下文窗口利用率

**问题**：token 使用率长期偏高会触发频繁 compact，降低效率。但精确 token 数不可得。

**信号源**：
- session JSONL 中的 `model_change` 事件 → 模型 context limit
- session JSONL 中消息内容的字符数 → 粗略估算 token

**可追踪的数据**：

| 指标 | 信号 | 计算方式 |
|------|------|----------|
| 当前模型 | `model_change.modelId` | 直接读取 |
| 模型 context limit | 模型配置表 | 从 modelId 映射 |
| 累积消息字符数 | 所有消息 content 的字符数之和 | sum(message content length) |
| 估算 token 使用率 | 字符数 / 4 / context_limit | 粗略估算（中文约 1.5 token/char，英文约 0.25 token/char） |
| compact 前的估算利用率 | compactionSummary 前的累积字符数 / context_limit | 间接指标 |

**精度说明**：字符数/token 的换算比例因语言和模型差异很大。这个指标只用于**趋势观察**，不用于精确决策。

**产出数据结构**：

```json
{
  "context_stats": {
    "models_used": ["claude-sonnet-4", "deepseek-v3"],
    "context_limits": {"claude-sonnet-4": 200000, "deepseek-v3": 64000},
    "avg_estimated_utilization": 0.45,
    "peak_estimated_utilization": 0.82,
    "utilization_distribution": {
      "0-30%": 5,
      "30-60%": 8,
      "60-90%": 3,
      "90%+": 1
    },
    "compact_at_high_utilization": 10,
    "total_compacts": 12
  }
}
```

**Miner 规则**：

| 规则 ID | 条件 | 严重度 | 建议 |
|---------|------|--------|------|
| `context-high-utilization` | peak_estimated_utilization ≥ 80% | medium | "上下文压力大，考虑优化工具输出长度或更早 compact" |
| `context-compact-correlation` | compact_at_high_utilization / total_compacts ≥ 0.8 | low | "compact 主要由上下文压力触发，属正常行为" |

---

### 2.3 Subagent 调度效率

**问题**：Subagent 是复杂任务的关键路径。失败率高、输出质量低、重试频繁都会严重影响效率。

**信号源**：session JSONL 中 `message.role === "toolResult"` + `toolName === "subagent"` 的消息。

**可追踪的数据**：

| 指标 | 信号 | 计算方式 |
|------|------|----------|
| 调用次数 | toolResult(subagent) 计数 | count |
| 成功/失败 | `isError` 字段 | isError === true → 失败 |
| 结果内容长度 | content[0].text 的字符数 | 字符数 |
| 任务类型分类 | 从 assistant 消息中提取 task prompt 的关键词 | 正则匹配 "review"/"implement"/"test"/"analyze" |
| 是否需要重试 | 同一 turn 内多次 subagent 调用 | 相邻 toolResult(subagent) 计数 |

**不能直接追踪的**：
- 精确执行耗时（session JSONL 不记录 tool call 的开始时间）
- exit code（需要从结果内容中解析）

**产出数据结构**：

```json
{
  "subagent_stats": {
    "total_calls": 15,
    "success_count": 13,
    "failure_count": 2,
    "failure_rate": 0.13,
    "avg_result_length": 2500,
    "retry_count": 3,
    "retry_rate": 0.20,
    "by_task_type": {
      "code_review": {"count": 5, "failure": 0},
      "implementation": {"count": 8, "failure": 1},
      "testing": {"count": 2, "failure": 1}
    }
  }
}
```

**Miner 规则**：

| 规则 ID | 条件 | 严重度 | 建议 |
|---------|------|--------|------|
| `subagent-failure-rate` | failure_rate ≥ 0.20 | medium | "优化 subagent task prompt，增加更明确的成功标准和前置条件" |
| `subagent-high-retry` | retry_rate ≥ 0.15 | medium | "subagent 重试频繁，检查任务拆分是否合理" |
| `subagent-type-failure` | 某类任务失败率 ≥ 0.30 | high | "某类 subagent 任务失败率高，需要专项优化 task prompt" |

---

### 2.4 工具参数校验失败

**问题**：参数错误（wrong args）和运行时错误（correct args, execution failed）是两类不同问题。参数错误说明 AI 不理解工具用法，运行时错误说明环境或状态问题。

**信号源**：session JSONL 中 `toolResult.isError === true` 的消息。

**错误分类规则**：

```python
PARAM_ERROR_PATTERNS = [
    r"required.*parameter", r"missing.*argument", r"invalid.*type",
    r"schema.*validation", r"unexpected.*token", r"parameter.*missing",
    r"argument.*required", r"invalid.*argument", r"unknown.*parameter",
    r"missing.*required",
]

RUNTIME_ERROR_PATTERNS = [
    r"enoent", r"permission denied", r"non-zero exit", r"timeout",
    r"syntaxerror", r"typeerror", r"connection refused", r"out of memory",
    r"could not find the exact text", r"no such file",
]
```

**可追踪的数据**：

| 指标 | 信号 | 计算方式 |
|------|------|----------|
| 总错误数 | isError === true 的 toolResult 总数 | count |
| 参数错误数 | 错误消息匹配 PARAM_ERROR_PATTERNS | count |
| 运行时错误数 | 错误消息匹配 RUNTIME_ERROR_PATTERNS | count |
| 未分类错误数 | 不匹配任何模式 | count |
| 各工具错误分布 | 按 toolName 分组 | group by toolName |
| 各工具的参数/运行时错误比 | 按 toolName + 错误类型分组 | cross tab |
| 自行修正率 | 错误后 turn 内同工具成功调用的比例 | 需要 turn 级分析 |

**产出数据结构**：

```json
{
  "tool_error_stats": {
    "total_errors": 45,
    "param_errors": 10,
    "runtime_errors": 30,
    "unclassified_errors": 5,
    "param_error_rate": 0.22,
    "runtime_error_rate": 0.67,
    "self_correction_rate": 0.65,
    "by_tool": {
      "edit": {"total": 15, "param": 5, "runtime": 8, "unclassified": 2, "self_correction": 0.60},
      "bash": {"total": 30, "param": 5, "runtime": 22, "unclassified": 3, "self_correction": 0.68}
    },
    "top_param_errors": [
      {"tool": "edit", "pattern": "Could not find the exact text", "count": 8},
      {"tool": "bash", "pattern": "command not found", "count": 3}
    ]
  }
}
```

**Miner 规则**：

| 规则 ID | 条件 | 严重度 | 建议 |
|---------|------|--------|------|
| `param-error-rate` | param_error_rate ≥ 0.25 | high | "参数错误率高，优化工具描述中的参数说明和示例" |
| `tool-specific-param-error` | 某工具 param_errors ≥ 5 | medium | "{tool} 参数错误频繁，检查 AI 对该工具的理解" |
| `low-self-correction` | self_correction_rate ≤ 0.50 | medium | "错误后自行修正率低，AI 缺乏错误恢复策略" |
| `edit-match-failure` | edit 的 "Could not find exact text" ≥ 10 | high | "edit 匹配失败率高，优化 whitespace-fixer 或 edit 使用策略" |

---

### 2.5 Coding-Workflow 各阶段耗时与复盘

**问题**：5 阶段工作流的每个阶段耗时、gate 通过率、review 发现问题数是衡量工作流效率的关键指标。

**信号源**：
- session JSONL 中 `toolResult.toolName === "coding-workflow-phase-start"` → 阶段开始
- session JSONL 中 `toolResult.toolName === "coding-workflow-gate"` → gate 检查
- `.xyz-harness/<topic>/` 目录下的 review 和 retrospect 文件

**可追踪的数据**：

| 指标 | 信号 | 计算方式 |
|------|------|----------|
| 各阶段开始时间 | phase-start 调用的 message timestamp | 直接读取 |
| 各阶段 gate 时间 | gate 调用的 message timestamp | 直接读取 |
| 各阶段耗时 | 相邻 gate - phase-start 的时间差 | timestamp 差值 |
| gate 通过/失败 | gate result 的 passed 字段 | 直接读取 |
| gate 重试次数 | 同一阶段的 gate 调用次数 - 1 | count - 1 |
| review 发现问题数 | review 文件中的 must-fix 计数 | 解析 YAML frontmatter |
| 复盘文件存在性 | retrospect 文件是否存在 | 文件系统检查 |
| 复盘文件内容维度 | retrospect 文件的 section 数量 | 解析 markdown headers |

**产出数据结构**：

```json
{
  "workflow_stats": {
    "workflows_completed": 2,
    "workflows_abandoned": 0,
    "avg_total_duration_minutes": 180,
    "phase_stats": {
      "spec":   {"avg_minutes": 45, "gate_pass_rate": 0.8, "avg_retries": 0.3},
      "plan":   {"avg_minutes": 30, "gate_pass_rate": 0.7, "avg_retries": 0.5},
      "dev":    {"avg_minutes": 60, "gate_pass_rate": 0.5, "avg_retries": 1.2},
      "test":   {"avg_minutes": 30, "gate_pass_rate": 0.9, "avg_retries": 0.1},
      "pr":     {"avg_minutes": 15, "gate_pass_rate": 1.0, "avg_retries": 0.0}
    },
    "review_findings": {
      "total_must_fix": 8,
      "avg_per_workflow": 4,
      "by_phase": {"spec": 1, "plan": 2, "dev": 4, "test": 1}
    },
    "retrospect_coverage": {
      "written": 8,
      "total_expected": 10,
      "coverage_rate": 0.8
    }
  }
}
```

**数据采集方式**：

workflow 数据**不通过 L2 追踪引擎采集**（因为 coding-workflow 扩展已经产生了完整的 session 数据），而是**直接由 L3 Python extractor 从 session JSONL 中解析**：

1. 扫描 session 中所有 `toolResult.toolName` 为 `coding-workflow-*` 的消息
2. 从 `phase-start` 和 `gate` 调用的时间戳计算阶段耗时
3. 从 `.xyz-harness/` 目录读取 review 和 retrospect 文件

**Miner 规则**：

| 规则 ID | 条件 | 严重度 | 建议 |
|---------|------|--------|------|
| `workflow-slow-phase` | 某阶段 avg_minutes > total * 0.5 | medium | "{phase} 阶段耗时占比过高，考虑拆分任务或优化流程" |
| `workflow-gate-retry` | 某阶段 avg_retries ≥ 2 | medium | "{phase} 阶段 gate 重试频繁，检查 gate 检查项是否合理" |
| `workflow-low-review-coverage` | review_findings.avg_per_workflow < 2 | low | "review 发现问题少，可能 review 质量需要提升" |
| `workflow-missing-retrospect` | retrospect_coverage.rate < 0.7 | low | "复盘文档覆盖率低，强制执行 retrospect 流程" |

---

### 2.6 Goal 任务拆分质量与 Todo 任务质量

**问题**：Goal 的任务拆分粒度、evidence 质量、完成率直接决定目标驱动循环的有效性。

**信号源**：
- session JSONL 中 `message.role === "toolResult"` + `toolName === "goal_manager"` 的消息
- session entries 中 `customType === "goal-state"` 的状态快照
- session JSONL 中 `message.role === "toolResult"` + `toolName === "todo"` 的消息

**可追踪的数据**：

| 指标 | 信号 | 计算方式 |
|------|------|----------|
| Goal 总数 | goal-state entries 计数 | count |
| 任务总数 | 所有 goal-state 的 tasks 数组长度之和 | sum |
| 各状态任务数 | tasks 中 status 分布 | group by status |
| 任务完成率 | completed / total | ratio |
| 任务取消率 | cancelled / total | ratio |
| evidence 存在率 | tasks 中 evidence 字段非空的比例 | count(non-null) / total |
| evidence 质量评分 | evidence 字段的内容分析 | 长度 + 具体性评分 |
| stall 次数 | goal-state 的 stallCount | 直接读取 |
| 终态分布 | goal-state 最终 status | 取最后一条 entry 的 status |
| token 消耗 | goal-state 的 tokensUsed | 直接读取 |
| Todo 总数 | todo tool 调用中 add 的条目计数 | count |
| Todo 完成率 | todo tool 调用中 status=completed 的比例 | ratio |
| Todo 放弃率 | session 结束时仍为 pending 的 todo 比例 | 需要 session 结束时快照 |

**Evidence 质量评分规则**：

```python
def score_evidence(evidence: str) -> float:
    """0.0-1.0 评分。"""
    if not evidence:
        return 0.0
    score = 0.0
    if len(evidence) >= 20: score += 0.3      # 长度
    if re.search(r'[/\\]', evidence): score += 0.2  # 包含路径
    if re.search(r'test|spec|check', evidence, re.I): score += 0.2  # 测试相关
    if re.search(r'pass|fail|success|error', evidence, re.I): score += 0.2  # 结果
    if re.search(r'\d+', evidence): score += 0.1  # 包含数字
    return min(score, 1.0)
```

**产出数据结构**：

```json
{
  "goal_quality_stats": {
    "goals_total": 5,
    "goals_completed": 3,
    "goals_budget_limited": 1,
    "goals_cancelled": 1,
    "completion_rate": 0.60,
    "avg_tasks_per_goal": 5.2,
    "task_stats": {
      "total": 26,
      "completed": 18,
      "cancelled": 4,
      "pending": 4,
      "completion_rate": 0.69,
      "cancel_rate": 0.15
    },
    "evidence_stats": {
      "tasks_with_evidence": 16,
      "evidence_rate": 0.89,
      "avg_evidence_score": 0.65,
      "low_quality_evidence_count": 3
    },
    "stall_stats": {
      "goals_with_stall": 2,
      "stall_rate": 0.40,
      "avg_stall_count": 2.5
    },
    "token_stats": {
      "avg_tokens_per_goal": 50000,
      "avg_tokens_per_task": 9600
    }
  },
  "todo_stats": {
    "total_todos": 25,
    "completed": 18,
    "abandoned": 4,
    "completion_rate": 0.72,
    "abandon_rate": 0.16
  }
}
```

**Miner 规则**：

| 规则 ID | 条件 | 严重度 | 建议 |
|---------|------|--------|------|
| `goal-low-completion` | task_completion_rate ≤ 0.50 | high | "任务完成率低，优化 Goal 任务拆分粒度" |
| `goal-high-cancel` | task_cancel_rate ≥ 0.30 | medium | "任务取消率高，检查任务定义是否合理" |
| `goal-low-evidence` | evidence_rate ≤ 0.70 | high | "Evidence 缺失率高，强化 Evidence 要求" |
| `goal-low-evidence-quality` | avg_evidence_score ≤ 0.40 | medium | "Evidence 质量低，需要包含具体文件路径和验证方式" |
| `goal-stall-frequent` | stall_rate ≥ 0.30 | medium | "Stall 频繁，检查 Goal 前置条件是否充分" |
| `todo-high-abandon` | abandon_rate ≥ 0.25 | low | "Todo 放弃率高，分析被放弃的 Todo 内容" |

---

## 3. 数据流：追踪信息如何加入每日报告

### 3.1 完整数据流

```
Session JSONL（唯一原始数据源）
    │
    ├─ L2 Tracking Engine（实时，session 内）
    │   ├─ compact detector → feedback-records/*.jsonl
    │   ├─ subagent detector → feedback-records/*.jsonl
    │   ├─ param-error detector → feedback-records/*.jsonl
    │   └─ goal-quality detector → feedback-records/*.jsonl
    │
    └─ L3 Python Analyzer（离线，每日一次）
        │
        ├─ 现有 8 个 extractor（不变）
        │
        ├─ 新增 6 个 extractor：
        │   ├─ compact.py → 读 session JSONL，统计 compactionSummary
        │   ├─ context.py → 读 session JSONL，计算估算利用率
        │   ├─ subagent.py → 读 session JSONL，统计 subagent 调用
        │   ├─ tool_errors.py → 读 session JSONL，分类错误类型
        │   ├─ workflow.py → 读 session JSONL + .xyz-harness/ 文件
        │   └─ goal_quality.py → 读 session JSONL + goal-state entries
        │
        ├─ 新增 10+ 条 miner 规则
        │
        └─ 产出 → daily-reports/YYYY-MM-DD.json
                    │
                    ├─ compact_stats
                    ├─ context_stats
                    ├─ subagent_stats
                    ├─ tool_error_stats（参数/运行时分离）
                    ├─ workflow_stats
                    ├─ goal_quality_stats
                    ├─ todo_stats
                    └─ actionable_issues（新增 10+ 条规则）
                        │
                        ▼
                    /evolve skill（LLM 分析）
                        │
                        ├─ 读取 daily-reports（含新维度数据）
                        ├─ 读取 feedback-records（层 0 实时反馈）
                        ├─ 读取 history.jsonl（建议效果回顾）
                        │
                        └─ 生成 suggestions/pending.json
```

### 3.2 daily-reports JSON 新增字段汇总

```json
{
  "_meta": { ... },
  "tool_stats": { ... },
  "token_stats": { ... },
  "error_stats": { ... },
  "user_patterns": { ... },
  "skill_stats": { ... },
  "cross_project": { ... },
  "satisfaction": { ... },
  "skill_state": { ... },

  "compact_stats": { ... },
  "context_stats": { ... },
  "subagent_stats": { ... },
  "tool_error_stats": { ... },
  "workflow_stats": { ... },
  "goal_quality_stats": { ... },
  "todo_stats": { ... },

  "actionable_issues": [ ... ],
  "skill_health": [ ... ]
}
```

### 3.3 /evolve skill 如何消费新数据

在 `/evolve` skill 的分析步骤中增加：

```markdown
#### 3e. 新维度分析

读取 daily-reports 中的新增字段，按优先级分析：

1. **工具参数错误**（tool_error_stats）
   - param_error_rate > 25% → 高优先级建议
   - 某工具参数错误集中 → 针对性建议

2. **Goal 任务质量**（goal_quality_stats）
   - task_completion_rate < 50% → 任务拆分优化建议
   - evidence 质量低 → Evidence 要求强化建议

3. **Subagent 效率**（subagent_stats）
   - failure_rate > 20% → task prompt 优化建议
   - retry_rate > 15% → 任务拆分优化建议

4. **Compact 效率**（compact_stats + context_stats）
   - compacts_per_session ≥ 3 → 上下文管理优化建议
   - 上下文利用率持续偏高 → 工具输出优化建议

5. **工作流效率**（workflow_stats）
   - 某阶段耗时占比 > 50% → 流程优化建议
   - gate 重试频繁 → gate 检查项优化建议

6. **Todo 使用**（todo_stats）
   - abandon_rate > 25% → Todo 使用模式优化建议
```

---

## 4. 新增文件清单

### TypeScript（packages/evolve/src/）

| 文件 | 说明 |
|------|------|
| `problems.ts` | ProblemRegistry 索引 + 阈值配置 + 建议模板 |
| `detectors/compact.ts` | Compact 频率检测器（监听 message_end） |
| `detectors/subagent-result.ts` | Subagent 结果检测器（监听 tool_result） |
| `detectors/param-error.ts` | 参数错误检测器（监听 tool_result） |
| `detectors/goal-quality.ts` | Goal 质量检测器（监听 tool_result） |

### Python（packages/evolve/analyzer/）

| 文件 | 说明 |
|------|------|
| `extractors/compact.py` | 统计 compactionSummary |
| `extractors/context.py` | 计算估算上下文利用率 |
| `extractors/subagent.py` | 统计 subagent 调用效率 |
| `extractors/tool_errors.py` | 分类参数/运行时错误 |
| `extractors/workflow.py` | 分析工作流阶段耗时 |
| `extractors/goal_quality.py` | 分析 Goal/Todo 任务质量 |
| `rules/compact_high_frequency.py` | compact 过于频繁 |
| `rules/compact_early_trigger.py` | compact 过早触发 |
| `rules/context_high_utilization.py` | 上下文利用率过高 |
| `rules/subagent_failure_rate.py` | subagent 失败率高 |
| `rules/subagent_high_retry.py` | subagent 重试频繁 |
| `rules/param_error_rate.py` | 参数错误率高 |
| `rules/edit_match_failure.py` | edit 匹配失败率高 |
| `rules/low_self_correction.py` | 错误自修复率低 |
| `rules/workflow_slow_phase.py` | 某阶段耗时过长 |
| `rules/workflow_gate_retry.py` | gate 重试频繁 |
| `rules/goal_low_completion.py` | Goal 任务完成率低 |
| `rules/goal_low_evidence.py` | Evidence 缺失率高 |
| `rules/goal_stall_frequent.py` | Stall 频繁 |
| `rules/todo_high_abandon.py` | Todo 放弃率高 |

## 5. 验收标准

1. daily-reports JSON 包含 7 个新维度的统计数据
2. actionable_issues 包含 10+ 条新规则生成的问题
3. /evolve skill 能分析新维度数据并生成优化建议
4. 每个 extractor 独立运行，失败时不影响其他 extractor
5. 新增追踪维度只需添加 1 个 Python extractor + 1 个 Python rule + 1 个 TypeScript detector
