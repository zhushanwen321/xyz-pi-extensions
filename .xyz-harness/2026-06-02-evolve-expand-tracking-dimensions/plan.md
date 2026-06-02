---
verdict: pass
complexity: L1
---

# Evolve 扩展追踪维度 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 evolve 系统新增 6 个追踪维度（compact、上下文利用率、subagent 效率、工具参数错误、工作流阶段耗时、Goal/Todo 质量），通过 Python extractor 产出 daily-reports JSON 新字段，通过 TypeScript detector 实现实时追踪。

**Architecture:** L1 架构——所有变更在 Python extractor 和 TypeScript detector 两个层面，无前端、无新 API。Python extractor 从 session JSONL 提取数据，TypeScript detector 在 session 内实时检测。两者通过 Problem ID 关联，但代码独立。

**Tech Stack:** TypeScript（Pi Extension API）、Python 3.10+（JSONL 解析）、typebox（参数 schema）

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `packages/evolve-daily/src/index.ts` | modify | BG1 | 注册 detector 到 Pi 事件系统 |
| `packages/evolve-daily/src/problems.ts` | create | BG1 | ProblemRegistry 索引 + 阈值配置 + 建议模板 |
| `packages/evolve-daily/src/detectors/compact.ts` | create | BG1 | Compact 频率检测器 |
| `packages/evolve-daily/src/detectors/subagent-result.ts` | create | BG1 | Subagent 结果检测器 |
| `packages/evolve-daily/src/detectors/param-error.ts` | create | BG1 | 参数错误检测器 |
| `packages/evolve-daily/src/detectors/goal-quality.ts` | create | BG1 | Goal 质量检测器 |
| `packages/evolve-daily/analyzer/extractors/compact.py` | create | BG2 | 统计 compactionSummary |
| `packages/evolve-daily/analyzer/extractors/context.py` | create | BG2 | 计算估算上下文利用率 |
| `packages/evolve-daily/analyzer/extractors/subagent.py` | create | BG2 | 统计 subagent 调用效率 |
| `packages/evolve-daily/analyzer/extractors/tool_errors.py` | create | BG2 | 分类参数/运行时错误 |
| `packages/evolve-daily/analyzer/extractors/workflow.py` | create | BG2 | 分析工作流阶段耗时 |
| `packages/evolve-daily/analyzer/extractors/goal_quality.py` | create | BG2 | 分析 Goal/Todo 任务质量 |
| `packages/evolve-daily/analyzer/rules/compact_high_frequency.py` | create | BG2 | compact 过于频繁 |
| `packages/evolve-daily/analyzer/rules/compact_early_trigger.py` | create | BG2 | compact 过早触发 |
| `packages/evolve-daily/analyzer/rules/context_high_utilization.py` | create | BG2 | 上下文利用率过高 |
| `packages/evolve-daily/analyzer/rules/subagent_failure_rate.py` | create | BG2 | subagent 失败率高 |
| `packages/evolve-daily/analyzer/rules/subagent_high_retry.py` | create | BG2 | subagent 重试频繁 |
| `packages/evolve-daily/analyzer/rules/param_error_rate.py` | create | BG2 | 参数错误率高 |
| `packages/evolve-daily/analyzer/rules/edit_match_failure.py` | create | BG2 | edit 匹配失败率高 |
| `packages/evolve-daily/analyzer/rules/low_self_correction.py` | create | BG2 | 错误自修复率低 |
| `packages/evolve-daily/analyzer/rules/workflow_slow_phase.py` | create | BG2 | 某阶段耗时过长 |
| `packages/evolve-daily/analyzer/rules/workflow_gate_retry.py` | create | BG2 | gate 重试频繁 |
| `packages/evolve-daily/analyzer/rules/goal_low_completion.py` | create | BG2 | Goal 任务完成率低 |
| `packages/evolve-daily/analyzer/rules/goal_low_evidence.py` | create | BG2 | Evidence 缺失率高 |
| `packages/evolve-daily/analyzer/rules/goal_stall_frequent.py` | create | BG2 | Stall 频繁 |
| `packages/evolve-daily/analyzer/rules/todo_high_abandon.py` | create | BG2 | Todo 放弃率高 |
| `packages/evolve-daily/skills/evolve/SKILL.md` | modify | BG3 | 增加新维度分析步骤 |
| `packages/evolve-daily/skills/evolve-report/SKILL.md` | modify | BG3 | 增加新维度展示 |

## Interface Contracts

### Module: ProblemRegistry (TypeScript)

#### Data: ProblemDefinition

| Field | Type | Description |
|-------|------|-------------|
| id | string | 唯一标识，如 "compact-frequency" |
| name | string | 人类可读名称 |
| category | "skill" \| "tool" \| "user" \| "workflow" \| "context" \| "subagent" | 分类维度 |
| severity | SeverityRule | 严重度规则 |
| detector | DetectorConfig | 检测器配置 |
| analysis | AnalysisConfig | 分析维度配置 |
| suggestion | SuggestionTemplate | 建议模板 |

#### Data: SeverityRule

| Field | Type | Description |
|-------|------|-------------|
| metric | "error_count" \| "frequency" \| "rate" \| "custom" | 基于什么指标判定 |
| thresholds | { medium: number; high: number } | 阈值 |
| custom | (data: Record<string, unknown>) => "low" \| "medium" \| "high" | 自定义判定函数（可选） |

### Module: Python Extractors

#### Class: BaseExtractor (Protocol)

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| extract | (sessions: list[dict]) -> dict | dict | 空 session 列表 → 空 dict | AC-1~AC-6 |

#### Data: CompactStats

| Field | Type | Description |
|-------|------|-------------|
| total_compacts | int | compact 总次数 |
| compacts_per_session | dict | avg/max/distribution |
| compact_turn_indices | list[int] | compact 触发时的 turn 索引 |
| sessions_with_compact | int | 有 compact 的 session 数 |
| total_sessions | int | 总 session 数 |

#### Data: ContextStats

| Field | Type | Description |
|-------|------|-------------|
| models_used | list[str] | 使用的模型列表 |
| context_limits | dict[str, int] | 模型 → context limit 映射 |
| avg_estimated_utilization | float | 平均估算利用率 |
| peak_estimated_utilization | float | 峰值估算利用率 |
| utilization_distribution | dict | 利用率分布 |
| compact_at_high_utilization | int | 高利用率时的 compact 次数 |
| total_compacts | int | compact 总次数 |

#### Data: SubagentStats

| Field | Type | Description |
|-------|------|-------------|
| total_calls | int | 调用总次数 |
| success_count | int | 成功次数 |
| failure_count | int | 失败次数 |
| failure_rate | float | 失败率 |
| avg_result_length | float | 平均结果长度 |
| retry_count | int | 重试次数 |
| retry_rate | float | 重试率 |
| by_task_type | dict | 按任务类型分组统计 |

#### Data: ToolErrorStats

| Field | Type | Description |
|-------|------|-------------|
| total_errors | int | 总错误数 |
| param_errors | int | 参数错误数 |
| runtime_errors | int | 运行时错误数 |
| unclassified_errors | int | 未分类错误数 |
| param_error_rate | float | 参数错误率 |
| runtime_error_rate | float | 运行时错误率 |
| self_correction_rate | float | 自行修正率 |
| by_tool | dict | 各工具错误分布 |
| top_param_errors | list | 参数错误 Top N |

#### Data: WorkflowStats

| Field | Type | Description |
|-------|------|-------------|
| workflows_completed | int | 完成的工作流数 |
| workflows_abandoned | int | 放弃的工作流数 |
| avg_total_duration_minutes | float | 平均总耗时 |
| phase_stats | dict | 各阶段统计 |
| review_findings | dict | review 发现统计 |
| retrospect_coverage | dict | 复盘覆盖率 |

#### Data: GoalQualityStats

| Field | Type | Description |
|-------|------|-------------|
| goals_total | int | Goal 总数 |
| goals_completed | int | 完成的 Goal 数 |
| goals_budget_limited | int | 预算耗尽的 Goal 数 |
| goals_cancelled | int | 取消的 Goal 数 |
| completion_rate | float | 完成率 |
| avg_tasks_per_goal | float | 平均每 Goal 任务数 |
| task_stats | dict | 任务统计 |
| evidence_stats | dict | Evidence 统计 |
| stall_stats | dict | Stall 统计 |
| token_stats | dict | Token 统计 |

#### Data: TodoStats

| Field | Type | Description |
|-------|------|-------------|
| total_todos | int | Todo 总数 |
| completed | int | 完成数 |
| abandoned | int | 放弃数 |
| completion_rate | float | 完成率 |
| abandon_rate | float | 放弃率 |

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1 compact_stats in daily-reports | CompactExtractor.extract | session JSONL → compact.py → daily-reports | Task 8 |
| AC-2 context_stats in daily-reports | ContextExtractor.extract | session JSONL → context.py → daily-reports | Task 9 |
| AC-3 subagent_stats in daily-reports | SubagentExtractor.extract | session JSONL → subagent.py → daily-reports | Task 10 |
| AC-4 tool_error_stats in daily-reports | ToolErrorsExtractor.extract | session JSONL → tool_errors.py → daily-reports | Task 11 |
| AC-5 workflow_stats in daily-reports | WorkflowExtractor.extract | session JSONL + .xyz-harness/ → workflow.py → daily-reports | Task 12 |
| AC-6 goal_quality_stats + todo_stats in daily-reports | GoalQualityExtractor.extract | session JSONL + goal-state entries → goal_quality.py → daily-reports | Task 13 |
| AC-7 10+ actionable_issues | Miner rules | daily-reports → rules → actionable_issues | Task 14 |
| AC-8 /evolve skill 分析新维度 | evolve SKILL.md | daily-reports → LLM → suggestions | Task 15 |
| AC-9 extractor 独立运行 | extractors/__init__.py | try/except 隔离 | Task 7 |
| AC-10 新增维度只需 1+1+1 | 架构设计 | ProblemDefinition + extractor + detector | Task 1~6 |

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 compact_stats | adopted | Task 8 |
| AC-2 context_stats | adopted | Task 9 |
| AC-3 subagent_stats | adopted | Task 10 |
| AC-4 tool_error_stats | adopted | Task 11 |
| AC-5 workflow_stats | adopted | Task 12 |
| AC-6 goal_quality_stats + todo_stats | adopted | Task 13 |
| AC-7 actionable_issues (10+ rules) | adopted | Task 14 |
| AC-8 /evolve skill 分析新维度 | adopted | Task 15 |
| AC-9 extractor 独立运行 | adopted | Task 7 |
| AC-10 新增维度只需 1+1+1 | adopted | Task 1~6 (架构设计 + 注册) |

## Execution Groups

#### BG1: TypeScript Detectors + ProblemRegistry

**Description:** TypeScript 侧的 ProblemRegistry 索引和 4 个新检测器。这些文件是 L2 实时追踪的核心，但本次实现中它们主要是声明式配置，实际的事件监听由 engine.ts 统一管理。

**Tasks:** Task 1, Task 2, Task 3, Task 4, Task 5, Task 6

**Files (预估):** 6 个文件（5 create + 1 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | medium |
| 注入上下文 | spec.md §2.1~2.4, §4 (Problem Registry 定位), 003-evolve-redesign-4-layer.md §4 |
| 读取文件 | packages/evolve-daily/src/index.ts, packages/skill-state/src/state.ts |
| 修改/创建文件 | packages/evolve-daily/src/problems.ts, packages/evolve-daily/src/detectors/*.ts, packages/evolve-daily/src/index.ts |

**Execution Flow (BG1 内部):** 串行派遣，每个 Task 走完整 subagent 链后再开始下一个 Task。

  Task 1:
    1. general-purpose → 写 problems.ts (ProblemRegistry)
    2. general-purpose → 代码审查

  Task 2:
    1. general-purpose → 写 compact.ts detector
    2. general-purpose → 代码审查

  Task 3:
    1. general-purpose → 写 subagent-result.ts detector
    2. general-purpose → 代码审查

  Task 4:
    1. general-purpose → 写 param-error.ts detector
    2. general-purpose → 代码审查

  Task 5:
    1. general-purpose → 写 goal-quality.ts detector
    2. general-purpose → 代码审查

  Task 6 (depends on Task 1-5):
    1. general-purpose → 在 index.ts 中注册 detector 到 Pi 事件系统
    2. general-purpose → 代码审查

**Dependencies:** 无

**设计细节:** 直接写在此处。每个 detector 是独立的事件处理器，通过 Problem ID 关联到 ProblemRegistry。

#### BG2: Python Extractors + Miner Rules

**Description:** Python 侧的 6 个新 extractor 和 14 条新 miner 规则。这些是 L3 统计分析的核心，从 session JSONL 提取数据并产出 daily-reports JSON 新字段。

**Tasks:** Task 7, Task 8, Task 9, Task 10, Task 11, Task 12, Task 13, Task 14

**Files (预估):** 20 个文件（20 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | medium |
| 注入上下文 | spec.md §2.1~2.6 (各维度详细设计), §3 (数据流), 003-evolve-redesign-4-layer.md §5 (L3 架构) |
| 读取文件 | packages/evolve-daily/analyzer/extractors/*.py (现有), packages/evolve-daily/analyzer/miner.py, packages/evolve-daily/analyzer/config.py |
| 修改/创建文件 | packages/evolve-daily/analyzer/extractors/*.py (新增), packages/evolve-daily/analyzer/rules/*.py |

**Execution Flow (BG2 内部):** 串行派遣，每个 Task 走完整 subagent 链后再开始下一个 Task。

  Task 7:
    1. general-purpose → 写 extractors/__init__.py (自动发现 + 空结果降级)
    2. general-purpose → 代码审查

  Task 8:
    1. general-purpose → 写 extractors/compact.py
    2. general-purpose → 代码审查

  Task 9:
    1. general-purpose → 写 extractors/context.py
    2. general-purpose → 代码审查

  Task 10:
    1. general-purpose → 写 extractors/subagent.py
    2. general-purpose → 代码审查

  Task 11:
    1. general-purpose → 写 extractors/tool_errors.py
    2. general-purpose → 代码审查

  Task 12:
    1. general-purpose → 写 extractors/workflow.py
    2. general-purpose → 代码审查

  Task 13:
    1. general-purpose → 写 extractors/goal_quality.py
    2. general-purpose → 代码审查

  Task 14:
    1. general-purpose → 写 14 条 miner rules
    2. general-purpose → 代码审查

**Dependencies:** BG1 (ProblemRegistry 的 ID 定义需要一致)

**设计细节:** 直接写在此处。每个 extractor 是独立的 Python 文件，实现 BaseExtractor 协议。

#### BG3: Skill 文件更新

**Description:** 更新 /evolve 和 /evolve-report skill 文件，增加新维度的分析和展示步骤。

**Tasks:** Task 15, Task 16

**Files (预估):** 2 个文件（2 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | low |
| 注入上下文 | spec.md §3.3 (/evolve skill 如何消费新数据) |
| 读取文件 | packages/evolve-daily/skills/evolve/SKILL.md, packages/evolve-daily/skills/evolve-report/SKILL.md |
| 修改/创建文件 | 同上 |

**Execution Flow (BG3 内部):** 串行派遣。

  Task 15:
    1. general-purpose → 修改 evolve SKILL.md
    2. general-purpose → 代码审查

  Task 16:
    1. general-purpose → 修改 evolve-report SKILL.md
    2. general-purpose → 代码审查

**Dependencies:** BG2 (需要知道 daily-reports JSON 的新字段结构)

**设计细节:** 直接写在此处。

## Dependency Graph & Wave Schedule

```
BG1 (TypeScript Detectors) ──→ BG2 (Python Extractors) ──→ BG3 (Skill 更新)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | TypeScript 侧，无依赖 |
| Wave 2 | BG2 | Python 侧，依赖 BG1 的 ProblemRegistry ID 定义 |
| Wave 3 | BG3 | Skill 更新，依赖 BG2 的 daily-reports JSON 结构 |

**并行约束:**
- BG1 和 BG2 串行（BG2 依赖 BG1 的 ID 定义）
- BG3 在 BG2 完成后执行

---

## Tasks

### Task 1: ProblemRegistry 索引

**Type:** backend

**Files:**
- Create: `packages/evolve-daily/src/problems.ts`

- [ ] **Step 1: 写 problems.ts**

```typescript
// packages/evolve-daily/src/problems.ts

export interface ProblemDefinition {
  id: string;
  name: string;
  category: "skill" | "tool" | "user" | "workflow" | "context" | "subagent";
  severity: SeverityRule;
  detector: DetectorConfig;
  analysis: AnalysisConfig;
  suggestion: SuggestionTemplate;
}

export interface SeverityRule {
  metric: "error_count" | "frequency" | "rate" | "custom";
  thresholds: { medium: number; high: number };
  custom?: (data: Record<string, unknown>) => "low" | "medium" | "high";
}

export interface DetectorConfig {
  events: Array<"tool_call" | "tool_result" | "user_message" | "turn_end" | "message_end">;
  match: MatchCondition;
  template: Partial<TrackedItem>;
  steering: string;
  stateMachine?: StateMachineOverride;
}

export interface MatchCondition {
  eventType?: string;
  toolName?: string | string[];
  pathPattern?: string;
  isError?: boolean;
  contentRegex?: string;
  custom?: string;
}

export interface AnalysisConfig {
  extractor: string;
  minerRules: string[];
}

export interface SuggestionTemplate {
  title: string;
  description: string;
  defaultSeverity: "low" | "medium" | "high";
}

export const PROBLEM_REGISTRY: ProblemDefinition[] = [
  {
    id: "compact-frequency",
    name: "Compact 频率",
    category: "context",
    severity: {
      metric: "custom",
      custom: (data) => {
        const rate = data.compactsPerSession as number;
        if (rate >= 3) return "high";
        if (rate >= 2) return "medium";
        return "low";
      },
    },
    detector: {
      events: ["message_end"],
      match: { custom: "compactDetector" },
      template: { category: "context-pressure" },
      steering: "检测到 Compact 触发(id={{id}})。请评估是否丢失了关键上下文。如有丢失，update status=error, detail='丢失的内容'。如无影响，update status=completed。",
    },
    analysis: {
      extractor: "compact",
      minerRules: ["compact-high-frequency", "compact-early-trigger"],
    },
    suggestion: {
      title: "优化 Compact 频率",
      description: "Compact 频率过高，说明上下文管理效率低",
      defaultSeverity: "medium",
    },
  },
  {
    id: "context-utilization",
    name: "上下文窗口利用率",
    category: "context",
    severity: {
      metric: "rate",
      thresholds: { medium: 0.7, high: 0.9 },
    },
    detector: {
      events: ["turn_end"],
      match: { custom: "contextUtilizationMatcher" },
      template: { category: "context-pressure" },
      steering: "当前上下文利用率 {{usageRate}}(id={{id}})。如接近上限，update status=completed, detail='需要 compact'。如充足，update status=dismissed。",
    },
    analysis: {
      extractor: "context",
      minerRules: ["context-high-utilization"],
    },
    suggestion: {
      title: "优化上下文利用率",
      description: "上下文利用率持续偏高，会触发频繁 compact",
      defaultSeverity: "medium",
    },
  },
  {
    id: "subagent-efficiency",
    name: "Subagent 调度效率",
    category: "subagent",
    severity: {
      metric: "rate",
      thresholds: { medium: 0.2, high: 0.4 },
    },
    detector: {
      events: ["tool_result"],
      match: { toolName: "subagent", custom: "subagentResultMatcher" },
      template: { category: "subagent" },
      steering: "Subagent 任务完成(id={{id}})。exitCode={{exitCode}}, 耗时={{duration}}。如结果满意，update status=completed。如需重做，update status=error, detail='问题原因'。",
    },
    analysis: {
      extractor: "subagent",
      minerRules: ["subagent-failure-rate", "subagent-high-retry"],
    },
    suggestion: {
      title: "优化 Subagent 调度效率",
      description: "Subagent 失败率或重试率过高",
      defaultSeverity: "medium",
    },
  },
  {
    id: "tool-param-validation",
    name: "工具参数校验失败",
    category: "tool",
    severity: {
      metric: "rate",
      thresholds: { medium: 0.1, high: 0.25 },
    },
    detector: {
      events: ["tool_result"],
      match: { isError: true, custom: "paramErrorMatcher" },
      template: { category: "tool-error" },
      steering: "检测到 {{toolName}} 参数错误(id={{id}})。错误: {{errorPreview}}。如已理解原因，update status=completed, detail='错误原因和修正方式'。如不确定，update status=error。",
    },
    analysis: {
      extractor: "tool_errors",
      minerRules: ["param-error-rate", "edit-match-failure", "low-self-correction"],
    },
    suggestion: {
      title: "降低工具参数错误率",
      description: "参数错误率高，说明 AI 不理解工具用法",
      defaultSeverity: "high",
    },
  },
  {
    id: "workflow-phase-duration",
    name: "工作流阶段耗时",
    category: "workflow",
    severity: {
      metric: "custom",
      custom: (data) => {
        const maxPhaseRatio = data.maxPhaseDurationRatio as number;
        if (maxPhaseRatio > 0.7) return "high";
        if (maxPhaseRatio > 0.5) return "medium";
        return "low";
      },
    },
    detector: {
      events: ["tool_result"],
      match: { toolName: ["coding-workflow-gate", "coding-workflow-phase-start"] },
      template: { category: "workflow" },
      steering: "工作流阶段 {{phase}} 完成(id={{id}})。gate={{gateResult}}, 耗时={{duration}}。如阶段顺利，update status=completed。如有问题，update status=error, detail='问题描述'。",
    },
    analysis: {
      extractor: "workflow",
      minerRules: ["workflow-slow-phase", "workflow-gate-retry"],
    },
    suggestion: {
      title: "优化工作流阶段效率",
      description: "某阶段耗时占比过高或 gate 重试频繁",
      defaultSeverity: "medium",
    },
  },
  {
    id: "goal-task-quality",
    name: "Goal 任务拆分质量",
    category: "workflow",
    severity: {
      metric: "custom",
      custom: (data) => {
        const completionRate = data.taskCompletionRate as number;
        const cancelRate = data.taskCancelRate as number;
        if (completionRate < 0.5 || cancelRate > 0.4) return "high";
        if (completionRate < 0.7 || cancelRate > 0.2) return "medium";
        return "low";
      },
    },
    detector: {
      events: ["tool_result"],
      match: { toolName: "goal_manager", custom: "goalQualityMatcher" },
      template: { category: "workflow" },
      steering: "Goal 任务更新(id={{id}})。任务完成率={{completionRate}}。如目标达成，update status=completed, detail='目标完成情况'。如遇到困难，update status=error, detail='困难描述'。",
    },
    analysis: {
      extractor: "goal_quality",
      minerRules: ["goal-low-completion", "goal-high-cancel", "goal-low-evidence", "goal-low-evidence-quality", "goal-stall-frequent", "todo-high-abandon"],
    },
    suggestion: {
      title: "优化 Goal 任务拆分质量",
      description: "任务完成率低或 Evidence 质量低",
      defaultSeverity: "high",
    },
  },
];

export function getProblemById(id: string): ProblemDefinition | undefined {
  return PROBLEM_REGISTRY.find((p) => p.id === id);
}

export function getProblemsByCategory(category: string): ProblemDefinition[] {
  return PROBLEM_REGISTRY.filter((p) => p.category === category);
}
```

- [ ] **Step 2: 运行类型检查**

Run: `pnpm --filter @zhushanwen/pi-evolve typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/evolve-daily/src/problems.ts
git commit -m "feat: add ProblemRegistry with 6 problem definitions"
```

### Task 2: Compact Detector

**Type:** backend

**Files:**
- Create: `packages/evolve-daily/src/detectors/compact.ts`

- [ ] **Step 1: 写 compact.ts**

```typescript
// packages/evolve-daily/src/detectors/compact.ts

import type { ProblemDefinition } from "../problems";

export interface CompactTrackedItem {
  id: string;
  problemId: "compact-frequency";
  sessionId: string;
  turnIndex: number;
  messagesBefore: number;
  detected: boolean;
  status: "pending" | "completed" | "error" | "dismissed";
  detail?: string;
}

export function createCompactDetector(problem: ProblemDefinition) {
  return {
    problemId: problem.id,
    events: problem.detector.events,
    
    match(event: { type: string; message?: { role: string } }): boolean {
      if (event.type !== "message_end") return false;
      if (!event.message) return false;
      return event.message.role === "compactionSummary";
    },
    
    createItem(event: { type: string; message?: { role: string }; turnIndex?: number; messagesBefore?: number }): CompactTrackedItem {
      return {
        id: `compact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        problemId: problem.id,
        sessionId: "",
        turnIndex: event.turnIndex ?? 0,
        messagesBefore: event.messagesBefore ?? 0,
        detected: true,
        status: "pending",
      };
    },
    
    steering(item: CompactTrackedItem): string {
      return problem.detector.steering
        .replace("{{id}}", item.id)
        .replace("{{turnIndex}}", String(item.turnIndex));
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/evolve-daily/src/detectors/compact.ts
git commit -m "feat: add compact frequency detector"
```

### Task 3: Subagent Result Detector

**Type:** backend

**Files:**
- Create: `packages/evolve-daily/src/detectors/subagent-result.ts`

- [ ] **Step 1: 写 subagent-result.ts**

```typescript
// packages/evolve-daily/src/detectors/subagent-result.ts

import type { ProblemDefinition } from "../problems";

export interface SubagentTrackedItem {
  id: string;
  problemId: "subagent-efficiency";
  sessionId: string;
  taskType: string;
  isError: boolean;
  resultLength: number;
  status: "pending" | "completed" | "error" | "dismissed";
  detail?: string;
}

const TASK_TYPE_PATTERNS: Record<string, RegExp> = {
  code_review: /review|审查|检查/i,
  implementation: /implement|实现|编写|创建/i,
  testing: /test|测试|验证/i,
  analysis: /analyze|分析|研究/i,
};

function classifyTaskType(taskPrompt: string): string {
  for (const [type, pattern] of Object.entries(TASK_TYPE_PATTERNS)) {
    if (pattern.test(taskPrompt)) return type;
  }
  return "unknown";
}

export function createSubagentDetector(problem: ProblemDefinition) {
  return {
    problemId: problem.id,
    events: problem.detector.events,
    
    match(event: { type: string; toolName?: string; isError?: boolean }): boolean {
      if (event.type !== "tool_result") return false;
      return event.toolName === "subagent";
    },
    
    createItem(event: { type: string; toolName?: string; isError?: boolean; content?: string; taskPrompt?: string }): SubagentTrackedItem {
      return {
        id: `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        problemId: problem.id,
        sessionId: "",
        taskType: classifyTaskType(event.taskPrompt ?? ""),
        isError: event.isError ?? false,
        resultLength: event.content?.length ?? 0,
        status: "pending",
      };
    },
    
    steering(item: SubagentTrackedItem): string {
      return problem.detector.steering
        .replace("{{id}}", item.id)
        .replace("{{exitCode}}", item.isError ? "error" : "0")
        .replace("{{duration}}", "unknown");
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/evolve-daily/src/detectors/subagent-result.ts
git commit -m "feat: add subagent result detector"
```

### Task 4: Param Error Detector

**Type:** backend

**Files:**
- Create: `packages/evolve-daily/src/detectors/param-error.ts`

- [ ] **Step 1: 写 param-error.ts**

```typescript
// packages/evolve-daily/src/detectors/param-error.ts

import type { ProblemDefinition } from "../problems";

export interface ParamErrorTrackedItem {
  id: string;
  problemId: "tool-param-validation";
  sessionId: string;
  toolName: string;
  errorType: "param" | "runtime" | "unclassified";
  errorPreview: string;
  status: "pending" | "completed" | "error" | "dismissed";
  detail?: string;
}

const PARAM_ERROR_PATTERNS = [
  /required.*parameter/i,
  /missing.*argument/i,
  /invalid.*type/i,
  /schema.*validation/i,
  /unexpected.*token/i,
  /parameter.*missing/i,
  /argument.*required/i,
  /invalid.*argument/i,
  /unknown.*parameter/i,
  /missing.*required/i,
];

const RUNTIME_ERROR_PATTERNS = [
  /enoent/i,
  /permission denied/i,
  /non-zero exit/i,
  /timeout/i,
  /syntaxerror/i,
  /typeerror/i,
  /connection refused/i,
  /out of memory/i,
  /could not find the exact text/i,
  /no such file/i,
];

function classifyError(errorMessage: string): "param" | "runtime" | "unclassified" {
  for (const pattern of PARAM_ERROR_PATTERNS) {
    if (pattern.test(errorMessage)) return "param";
  }
  for (const pattern of RUNTIME_ERROR_PATTERNS) {
    if (pattern.test(errorMessage)) return "runtime";
  }
  return "unclassified";
}

export function createParamErrorDetector(problem: ProblemDefinition) {
  return {
    problemId: problem.id,
    events: problem.detector.events,
    
    match(event: { type: string; toolName?: string; isError?: boolean }): boolean {
      if (event.type !== "tool_result") return false;
      if (event.isError !== true) return false;
      return ["edit", "bash", "read", "write"].includes(event.toolName ?? "");
    },
    
    createItem(event: { type: string; toolName?: string; isError?: boolean; content?: string }): ParamErrorTrackedItem {
      const errorMessage = event.content ?? "";
      return {
        id: `param-error-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        problemId: problem.id,
        sessionId: "",
        toolName: event.toolName ?? "unknown",
        errorType: classifyError(errorMessage),
        errorPreview: errorMessage.slice(0, 200),
        status: "pending",
      };
    },
    
    steering(item: ParamErrorTrackedItem): string {
      return problem.detector.steering
        .replace("{{id}}", item.id)
        .replace("{{toolName}}", item.toolName)
        .replace("{{errorPreview}}", item.errorPreview);
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/evolve-daily/src/detectors/param-error.ts
git commit -m "feat: add param error detector"
```

### Task 5: Goal Quality Detector

**Type:** backend

**Files:**
- Create: `packages/evolve-daily/src/detectors/goal-quality.ts`

- [ ] **Step 1: 写 goal-quality.ts**

```typescript
// packages/evolve-daily/src/detectors/goal-quality.ts

import type { ProblemDefinition } from "../problems";

export interface GoalQualityTrackedItem {
  id: string;
  problemId: "goal-task-quality";
  sessionId: string;
  goalId: string;
  taskCount: number;
  completedCount: number;
  cancelledCount: number;
  taskCompletionRate: number;
  taskCancelRate: number;
  status: "pending" | "completed" | "error" | "dismissed";
  detail?: string;
}

export function createGoalQualityDetector(problem: ProblemDefinition) {
  return {
    problemId: problem.id,
    events: problem.detector.events,
    
    match(event: { type: string; toolName?: string }): boolean {
      if (event.type !== "tool_result") return false;
      return event.toolName === "goal_manager";
    },
    
    createItem(event: { type: string; toolName?: string; details?: { tasks?: Array<{ status: string }> } }): GoalQualityTrackedItem {
      const tasks = event.details?.tasks ?? [];
      const completed = tasks.filter((t) => t.status === "completed").length;
      const cancelled = tasks.filter((t) => t.status === "cancelled").length;
      const total = tasks.length;
      
      return {
        id: `goal-quality-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        problemId: problem.id,
        sessionId: "",
        goalId: "",
        taskCount: total,
        completedCount: completed,
        cancelledCount: cancelled,
        taskCompletionRate: total > 0 ? completed / total : 0,
        taskCancelRate: total > 0 ? cancelled / total : 0,
        status: "pending",
      };
    },
    
    steering(item: GoalQualityTrackedItem): string {
      return problem.detector.steering
        .replace("{{id}}", item.id)
        .replace("{{completionRate}}", String(item.taskCompletionRate));
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/evolve-daily/src/detectors/goal-quality.ts
git commit -m "feat: add goal quality detector"
```

### Task 6: Detector Registration to Pi Event System

**Type:** backend

**Files:**
- Modify: `packages/evolve-daily/src/index.ts`

- [ ] **Step 1: 在 index.ts 中注册 detector 到 Pi 事件系统**

在现有的 `session_start` 处理器中，添加对 `pi.on("tool_execution_end")` 的监听，将 4 个 detector 注册到事件系统：

```typescript
// packages/evolve-daily/src/index.ts

import { createCompactDetector } from "./detectors/compact";
import { createSubagentDetector } from "./detectors/subagent-result";
import { createParamErrorDetector } from "./detectors/param-error";
import { createGoalQualityDetector } from "./detectors/goal-quality";
import { PROBLEM_REGISTRY } from "./problems";

export default function evolveDailyExtension(pi: ExtensionAPI) {
  // 现有逻辑：session_start 时调用 Python analyzer
  pi.on("session_start", async (ctx) => {
    // ... 现有代码 ...
  });

  // 新增：注册 L2 实时追踪 detectors
  const detectors = [
    createCompactDetector(PROBLEM_REGISTRY.find(p => p.id === "compact-frequency")!),
    createSubagentDetector(PROBLEM_REGISTRY.find(p => p.id === "subagent-efficiency")!),
    createParamErrorDetector(PROBLEM_REGISTRY.find(p => p.id === "tool-param-validation")!),
    createGoalQualityDetector(PROBLEM_REGISTRY.find(p => p.id === "goal-task-quality")!),
  ];

  pi.on("tool_execution_end", async (event) => {
    for (const detector of detectors) {
      if (detector.match(event)) {
        const item = detector.createItem(event);
        // 写入 feedback-records
        await ctx.appendEntry("evolve-feedback", {
          problemId: item.problemId,
          itemId: item.id,
          status: item.status,
          detail: item.detail,
          timestamp: new Date().toISOString(),
        });
      }
    }
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/evolve-daily/src/index.ts
git commit -m "feat: register detectors to Pi event system"
```

### Task 7: Extractor 自动发现机制

**Type:** backend

**Files:**
- Create: `packages/evolve-daily/analyzer/extractors/__init__.py`

- [ ] **Step 1: 写 __init__.py (自动发现 + 空结果降级)**

```python
# packages/evolve-daily/analyzer/extractors/__init__.py

import pkgutil
import importlib
from typing import Any, Protocol

class BaseExtractor(Protocol):
    """Extractor 协议：所有 extractor 必须实现 extract 方法。"""
    def extract(self, sessions: list[dict]) -> dict:
        ...

def discover_extractors() -> dict[str, BaseExtractor]:
    """自动发现所有 extractor 模块。"""
    extractors = {}
    for importer, modname, ispkg in pkgutil.iter_modules(__path__):
        if modname.startswith("_"):
            continue
        try:
            module = importlib.import_module(f".{modname}", __package__)
            if hasattr(module, "extract"):
                extractors[modname] = module
        except Exception as e:
            print(f"[evolve] Warning: Failed to load extractor {modname}: {e}")
    return extractors

def run_extractors(sessions: list[dict]) -> dict:
    """运行所有 extractor，每个 extractor 独立运行，失败时返回空结果。"""
    results = {}
    extractors = discover_extractors()
    for name, extractor in extractors.items():
        try:
            results[f"{name}_stats"] = extractor.extract(sessions)
        except Exception as e:
            print(f"[evolve] Warning: Extractor {name} failed: {e}")
            results[f"{name}_stats"] = {}
    return results
```

- [ ] **Step 2: Commit**

```bash
git add packages/evolve-daily/analyzer/extractors/__init__.py
git commit -m "feat: add extractor auto-discovery with graceful degradation"
```

### Task 8: Compact Extractor

**Type:** backend

**Files:**
- Create: `packages/evolve-daily/analyzer/extractors/compact.py`

- [ ] **Step 1: 写 compact.py**

```python
# packages/evolve-daily/analyzer/extractors/compact.py

"""统计 session 中的 compactionSummary 消息。"""

from typing import Any

def extract(sessions: list[dict]) -> dict:
    """从 session 列表中提取 compact 统计。"""
    total_compacts = 0
    compact_turn_indices = []
    sessions_with_compact = 0
    total_sessions = len(sessions)
    
    for session in sessions:
        messages = session.get("messages", [])
        session_compacts = 0
        
        for i, msg in enumerate(messages):
            if msg.get("role") == "compactionSummary":
                total_compacts += 1
                session_compacts += 1
                # turn 索引 = 消息序号 / 2（粗略）
                compact_turn_indices.append(i // 2)
        
        if session_compacts > 0:
            sessions_with_compact += 1
    
    # 计算分布
    avg_compacts = total_compacts / max(total_sessions, 1)
    max_compacts = max(
        sum(1 for msg in s.get("messages", []) if msg.get("role") == "compactionSummary")
        for s in sessions
    ) if sessions else 0
    
    # 分布：[0次, 1次, 2次, 3次, 4次, 5次, 6次+]
    distribution = [0] * 7
    for session in sessions:
        count = sum(1 for msg in session.get("messages", []) if msg.get("role") == "compactionSummary")
        if count >= 6:
            distribution[6] += 1
        else:
            distribution[count] += 1
    
    return {
        "total_compacts": total_compacts,
        "compacts_per_session": {
            "avg": avg_compacts,
            "max": max_compacts,
            "distribution": distribution,
        },
        "compact_turn_indices": compact_turn_indices,
        "sessions_with_compact": sessions_with_compact,
        "total_sessions": total_sessions,
    }
```

- [ ] **Step 2: Commit**

```bash
git add packages/evolve-daily/analyzer/extractors/compact.py
git commit -m "feat: add compact extractor"
```

### Task 9: Context Extractor

**Type:** backend

**Files:**
- Create: `packages/evolve-daily/analyzer/extractors/context.py`

- [ ] **Step 1: 写 context.py**

```python
# packages/evolve-daily/analyzer/extractors/context.py

"""计算估算的上下文窗口利用率。"""

from typing import Any

# 模型 context limit 映射（已知模型）
MODEL_CONTEXT_LIMITS = {
    "claude-sonnet-4": 200000,
    "claude-haiku-3.5": 200000,
    "deepseek-v3": 64000,
    "deepseek-r1": 64000,
    "gpt-4o": 128000,
    "gpt-4o-mini": 128000,
}

def estimate_tokens_from_chars(char_count: int, text_sample: str = "") -> int:
    """粗略估算 token 数。
    
    如果有 text_sample，按中英文字符比例估算。
    否则使用保守的混合比例 0.5 token/char。
    """
    if char_count == 0:
        return 0
    if text_sample:
        chinese_chars = sum(1 for c in text_sample if '\u4e00' <= c <= '\u9fff')
        ratio = chinese_chars / len(text_sample)
        # 混合比例：中文 1.5 token/char，英文 0.25 token/char
        return int(char_count * (ratio * 1.5 + (1 - ratio) * 0.25))
    # 无样本时使用保守的混合比例
    return int(char_count * 0.5)

def extract(sessions: list[dict]) -> dict:
    """从 session 列表中提取上下文利用率统计。"""
    models_used = set()
    context_limits = {}
    utilization_samples = []
    compact_at_high_utilization = 0
    total_compacts = 0
    
    for session in sessions:
        messages = session.get("messages", [])
        current_model = None
        cumulative_chars = 0
        
        for msg in messages:
            # 检查 model_change 事件
            if msg.get("type") == "model_change":
                model_id = msg.get("modelId", "")
                if model_id:
                    current_model = model_id
                    models_used.add(model_id)
                    if model_id in MODEL_CONTEXT_LIMITS:
                        context_limits[model_id] = MODEL_CONTEXT_LIMITS[model_id]
            
            # 累积消息字符数
            content = msg.get("content", "")
            if isinstance(content, str):
                cumulative_chars += len(content)
            elif isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and "text" in item:
                        cumulative_chars += len(item["text"])
            
            # compact 事件
            if msg.get("role") == "compactionSummary":
                total_compacts += 1
                if current_model and current_model in MODEL_CONTEXT_LIMITS:
                    limit = MODEL_CONTEXT_LIMITS[current_model]
                    estimated_tokens = estimate_tokens_from_chars(cumulative_chars)
                    utilization = estimated_tokens / limit
                    if utilization >= 0.7:
                        compact_at_high_utilization += 1
                    utilization_samples.append(utilization)
                # compact 后重置累积
                cumulative_chars = 0
        
        # session 结束时记录最终利用率
        if current_model and current_model in MODEL_CONTEXT_LIMITS and cumulative_chars > 0:
            limit = MODEL_CONTEXT_LIMITS[current_model]
            estimated_tokens = estimate_tokens_from_chars(cumulative_chars)
            utilization = estimated_tokens / limit
            utilization_samples.append(utilization)
    
    # 计算统计
    avg_utilization = sum(utilization_samples) / max(len(utilization_samples), 1)
    peak_utilization = max(utilization_samples) if utilization_samples else 0
    
    # 分布
    distribution = {"0-30%": 0, "30-60%": 0, "60-90%": 0, "90%+": 0}
    for u in utilization_samples:
        if u < 0.3:
            distribution["0-30%"] += 1
        elif u < 0.6:
            distribution["30-60%"] += 1
        elif u < 0.9:
            distribution["60-90%"] += 1
        else:
            distribution["90%+"] += 1
    
    return {
        "models_used": list(models_used),
        "context_limits": context_limits,
        "avg_estimated_utilization": avg_utilization,
        "peak_estimated_utilization": peak_utilization,
        "utilization_distribution": distribution,
        "compact_at_high_utilization": compact_at_high_utilization,
        "total_compacts": total_compacts,
    }
```

- [ ] **Step 2: Commit**

```bash
git add packages/evolve-daily/analyzer/extractors/context.py
git commit -m "feat: add context utilization extractor"
```

### Task 10: Subagent Extractor

**Type:** backend

**Files:**
- Create: `packages/evolve-daily/analyzer/extractors/subagent.py`

- [ ] **Step 1: 写 subagent.py**

```python
# packages/evolve-daily/analyzer/extractors/subagent.py

"""统计 subagent 调用效率。"""

import re
from typing import Any

TASK_TYPE_PATTERNS = {
    "code_review": re.compile(r"review|审查|检查", re.I),
    "implementation": re.compile(r"implement|实现|编写|创建", re.I),
    "testing": re.compile(r"test|测试|验证", re.I),
    "analysis": re.compile(r"analyze|分析|研究", re.I),
}

def classify_task_type(task_prompt: str) -> str:
    """根据 task prompt 内容分类任务类型。"""
    for task_type, pattern in TASK_TYPE_PATTERNS.items():
        if pattern.search(task_prompt):
            return task_type
    return "unknown"

def extract(sessions: list[dict]) -> dict:
    """从 session 列表中提取 subagent 统计。"""
    total_calls = 0
    success_count = 0
    failure_count = 0
    result_lengths = []
    retry_count = 0
    by_task_type: dict[str, dict[str, int]] = {}
    
    for session in sessions:
        messages = session.get("messages", [])
        prev_subagent_call = None
        
        for msg in messages:
            if msg.get("role") != "toolResult":
                continue
            if msg.get("toolName") != "subagent":
                continue
            
            total_calls += 1
            is_error = msg.get("isError", False)
            content = msg.get("content", "")
            if isinstance(content, list):
                content = " ".join(item.get("text", "") for item in content if isinstance(item, dict))
            
            result_lengths.append(len(content))
            
            if is_error:
                failure_count += 1
            else:
                success_count += 1
            
            # 检测重试（同一 session 内连续的 subagent 调用）
            if prev_subagent_call is not None:
                retry_count += 1
            prev_subagent_call = msg
            
            # 任务类型分类（从 assistant 消息中提取 task prompt）
            task_type = "unknown"
            for prev_msg in messages[:messages.index(msg)]:
                if prev_msg.get("role") == "assistant":
                    prev_content = prev_msg.get("content", "")
                    if isinstance(prev_content, list):
                        prev_content = " ".join(item.get("text", "") for item in prev_content if isinstance(item, dict))
                    if "subagent" in prev_content.lower():
                        task_type = classify_task_type(prev_content)
                        break
            
            if task_type not in by_task_type:
                by_task_type[task_type] = {"count": 0, "failure": 0}
            by_task_type[task_type]["count"] += 1
            if is_error:
                by_task_type[task_type]["failure"] += 1
    
    avg_result_length = sum(result_lengths) / max(len(result_lengths), 1)
    
    return {
        "total_calls": total_calls,
        "success_count": success_count,
        "failure_count": failure_count,
        "failure_rate": failure_count / max(total_calls, 1),
        "avg_result_length": avg_result_length,
        "retry_count": retry_count,
        "retry_rate": retry_count / max(total_calls, 1),
        "by_task_type": by_task_type,
    }
```

- [ ] **Step 2: Commit**

```bash
git add packages/evolve-daily/analyzer/extractors/subagent.py
git commit -m "feat: add subagent efficiency extractor"
```

### Task 11: Tool Errors Extractor

**Type:** backend

**Files:**
- Create: `packages/evolve-daily/analyzer/extractors/tool_errors.py`

- [ ] **Step 1: 写 tool_errors.py**

```python
# packages/evolve-daily/analyzer/extractors/tool_errors.py

"""分类参数错误和运行时错误。"""

import re
from typing import Any

PARAM_ERROR_PATTERNS = [
    re.compile(r"required.*parameter", re.I),
    re.compile(r"missing.*argument", re.I),
    re.compile(r"invalid.*type", re.I),
    re.compile(r"schema.*validation", re.I),
    re.compile(r"unexpected.*token", re.I),
    re.compile(r"parameter.*missing", re.I),
    re.compile(r"argument.*required", re.I),
    re.compile(r"invalid.*argument", re.I),
    re.compile(r"unknown.*parameter", re.I),
    re.compile(r"missing.*required", re.I),
]

RUNTIME_ERROR_PATTERNS = [
    re.compile(r"enoent", re.I),
    re.compile(r"permission denied", re.I),
    re.compile(r"non-zero exit", re.I),
    re.compile(r"timeout", re.I),
    re.compile(r"syntaxerror", re.I),
    re.compile(r"typeerror", re.I),
    re.compile(r"connection refused", re.I),
    re.compile(r"out of memory", re.I),
    re.compile(r"could not find the exact text", re.I),
    re.compile(r"no such file", re.I),
]

def classify_error(error_message: str) -> str:
    """分类错误类型：param/runtime/unclassified。"""
    for pattern in PARAM_ERROR_PATTERNS:
        if pattern.search(error_message):
            return "param"
    for pattern in RUNTIME_ERROR_PATTERNS:
        if pattern.search(error_message):
            return "runtime"
    return "unclassified"

def extract(sessions: list[dict]) -> dict:
    """从 session 列表中提取工具错误统计。"""
    total_errors = 0
    param_errors = 0
    runtime_errors = 0
    unclassified_errors = 0
    by_tool: dict[str, dict[str, int]] = {}
    top_param_errors: dict[str, int] = {}
    
    for session in sessions:
        messages = session.get("messages", [])
        
        for msg in messages:
            if msg.get("role") != "toolResult":
                continue
            if not msg.get("isError", False):
                continue
            
            total_errors += 1
            tool_name = msg.get("toolName", "unknown")
            content = msg.get("content", "")
            if isinstance(content, list):
                content = " ".join(item.get("text", "") for item in content if isinstance(item, dict))
            
            error_type = classify_error(content)
            
            if error_type == "param":
                param_errors += 1
            elif error_type == "runtime":
                runtime_errors += 1
            else:
                unclassified_errors += 1
            
            # 按工具统计
            if tool_name not in by_tool:
                by_tool[tool_name] = {"total": 0, "param": 0, "runtime": 0, "unclassified": 0, "self_correction": 0}
            by_tool[tool_name]["total"] += 1
            by_tool[tool_name][error_type] += 1
            
            # 参数错误 Top N
            if error_type == "param":
                # 提取错误模式
                for pattern in PARAM_ERROR_PATTERNS:
                    match = pattern.search(content)
                    if match:
                        key = f"{tool_name}: {match.group()}"
                        top_param_errors[key] = top_param_errors.get(key, 0) + 1
                        break
    
    # 计算自行修正率：对每个错误，检查同一 session 中同工具的后续调用是否成功
    # 简化实现：遍历消息序列，记录每个错误后是否有同工具的成功调用
    error_count_with_correction = 0
    for session in sessions:
        messages = session.get("messages", [])
        for i, msg in enumerate(messages):
            if msg.get("role") != "toolResult":
                continue
            if not msg.get("isError", False):
                continue
            tool = msg.get("toolName", "")
            # 检查后续消息中是否有同工具的成功调用
            for j in range(i + 1, len(messages)):
                next_msg = messages[j]
                if next_msg.get("role") == "toolResult" and next_msg.get("toolName") == tool:
                    if not next_msg.get("isError", False):
                        error_count_with_correction += 1
                    break
    self_correction_rate = error_count_with_correction / max(total_errors, 1)
    
    # Top 参数错误
    top_param_errors_list = [
        {"tool": k.split(": ")[0], "pattern": k.split(": ")[1], "count": v}
        for k, v in sorted(top_param_errors.items(), key=lambda x: -x[1])[:10]
    ]
    
    return {
        "total_errors": total_errors,
        "param_errors": param_errors,
        "runtime_errors": runtime_errors,
        "unclassified_errors": unclassified_errors,
        "param_error_rate": param_errors / max(total_errors, 1),
        "runtime_error_rate": runtime_errors / max(total_errors, 1),
        "self_correction_rate": self_correction_rate,
        "by_tool": by_tool,
        "top_param_errors": top_param_errors_list,
    }
```

- [ ] **Step 2: Commit**

```bash
git add packages/evolve-daily/analyzer/extractors/tool_errors.py
git commit -m "feat: add tool errors extractor"
```

### Task 12: Workflow Extractor

**Type:** backend

**Files:**
- Create: `packages/evolve-daily/analyzer/extractors/workflow.py`

- [ ] **Step 1: 写 workflow.py**

```python
# packages/evolve-daily/analyzer/extractors/workflow.py

"""分析 coding-workflow 各阶段耗时。"""

import os
import re
from typing import Any
from datetime import datetime

def extract(sessions: list[dict]) -> dict:
    """从 session 列表中提取工作流统计。"""
    workflows_completed = 0
    workflows_abandoned = 0
    phase_durations: dict[str, list[float]] = {
        "spec": [], "plan": [], "dev": [], "test": [], "pr": []
    }
    gate_results: dict[str, dict[str, int]] = {}
    review_findings_total = 0
    retrospect_written = 0
    retrospect_expected = 0
    
    for session in sessions:
        messages = session.get("messages", [])
        workflow_started = False
        current_phase = None
        phase_start_time = None
        gate_count = 0
        
        for msg in messages:
            if msg.get("role") != "toolResult":
                continue
            
            tool_name = msg.get("toolName", "")
            
            # workflow init
            if tool_name == "coding-workflow-init":
                workflow_started = True
                gate_count = 0
            
            # phase start
            if tool_name == "coding-workflow-phase-start":
                current_phase = msg.get("details", {}).get("phase", "")
                phase_start_time = msg.get("timestamp", "")
            
            # gate check
            if tool_name == "coding-workflow-gate":
                gate_count += 1
                gate_passed = msg.get("details", {}).get("passed", False)
                gate_phase = msg.get("details", {}).get("phase", "unknown")
                
                if gate_phase not in gate_results:
                    gate_results[gate_phase] = {"passed": 0, "failed": 0}
                if gate_passed:
                    gate_results[gate_phase]["passed"] += 1
                else:
                    gate_results[gate_phase]["failed"] += 1
                
                # 计算阶段耗时
                if current_phase and phase_start_time and gate_passed:
                    gate_time = msg.get("timestamp", "")
                    if gate_time and phase_start_time:
                        try:
                            start = datetime.fromisoformat(phase_start_time.replace("Z", "+00:00"))
                            end = datetime.fromisoformat(gate_time.replace("Z", "+00:00"))
                            duration_minutes = (end - start).total_seconds() / 60
                            if current_phase in phase_durations:
                                phase_durations[current_phase].append(duration_minutes)
                        except (ValueError, TypeError):
                            pass
                    
                    # gate 通过后重置
                    current_phase = None
                    phase_start_time = None
        
        if workflow_started:
            if gate_count >= 5:  # 至少完成 5 个阶段
                workflows_completed += 1
            else:
                workflows_abandoned += 1
    
    # 计算各阶段统计
    phase_stats = {}
    for phase, durations in phase_durations.items():
        if durations:
            avg_minutes = sum(durations) / len(durations)
            phase_stats[phase] = {
                "avg_minutes": avg_minutes,
                "gate_pass_rate": gate_results.get(phase, {}).get("passed", 0) / max(
                    gate_results.get(phase, {}).get("passed", 0) + gate_results.get(phase, {}).get("failed", 0), 1
                ),
                "avg_retries": max(0, len(durations) - 1) / max(len(durations), 1),
            }
        else:
            phase_stats[phase] = {"avg_minutes": 0, "gate_pass_rate": 0, "avg_retries": 0}
    
    # 总耗时
    total_durations = [sum(d) for d in zip(*[phase_durations[p] for p in phase_durations if phase_durations[p]])] if any(phase_durations.values()) else []
    avg_total_duration = sum(total_durations) / max(len(total_durations), 1) if total_durations else 0
    
    return {
        "workflows_completed": workflows_completed,
        "workflows_abandoned": workflows_abandoned,
        "avg_total_duration_minutes": avg_total_duration,
        "phase_stats": phase_stats,
        "review_findings": {
            "total_must_fix": review_findings_total,
            "avg_per_workflow": review_findings_total / max(workflows_completed, 1),
            "by_phase": {},
        },
        "retrospect_coverage": {
            "written": retrospect_written,
            "total_expected": retrospect_expected,
            "coverage_rate": retrospect_written / max(retrospect_expected, 1),
        },
    }
```

- [ ] **Step 2: Commit**

```bash
git add packages/evolve-daily/analyzer/extractors/workflow.py
git commit -m "feat: add workflow phase extractor"
```

### Task 13: Goal Quality Extractor

**Type:** backend

**Files:**
- Create: `packages/evolve-daily/analyzer/extractors/goal_quality.py`

- [ ] **Step 1: 写 goal_quality.py**

```python
# packages/evolve-daily/analyzer/extractors/goal_quality.py

"""分析 Goal 任务拆分质量和 Todo 使用质量。"""

import re
from typing import Any

def score_evidence(evidence: str) -> float:
    """Evidence 质量评分 0.0-1.0。"""
    if not evidence:
        return 0.0
    score = 0.0
    if len(evidence) >= 20:
        score += 0.3
    if re.search(r'[/\\]', evidence):
        score += 0.2
    if re.search(r'test|spec|check', evidence, re.I):
        score += 0.2
    if re.search(r'pass|fail|success|error', evidence, re.I):
        score += 0.2
    if re.search(r'\d+', evidence):
        score += 0.1
    return min(score, 1.0)

def extract(sessions: list[dict]) -> dict:
    """从 session 列表中提取 Goal/Todo 质量统计。"""
    goals_total = 0
    goals_completed = 0
    goals_budget_limited = 0
    goals_cancelled = 0
    all_tasks: list[dict] = []
    all_evidence: list[str] = []
    stall_count = 0
    total_tokens = 0
    
    todo_total = 0
    todo_completed = 0
    todo_abandoned = 0
    
    for session in sessions:
        messages = session.get("messages", [])
        
        for msg in messages:
            # Goal state entries
            if msg.get("customType") == "goal-state":
                goals_total += 1
                state = msg.get("data", {})
                status = state.get("status", "")
                
                if status == "complete":
                    goals_completed += 1
                elif status == "budget_limited":
                    goals_budget_limited += 1
                elif status == "cancelled":
                    goals_cancelled += 1
                
                tasks = state.get("tasks", [])
                for task in tasks:
                    all_tasks.append(task)
                    evidence = task.get("evidence", "")
                    if evidence:
                        all_evidence.append(evidence)
                
                stall_count += state.get("stallCount", 0)
                total_tokens += state.get("tokensUsed", 0)
            
            # Todo tool calls
            if msg.get("role") == "toolResult" and msg.get("toolName") == "todo":
                content = msg.get("content", "")
                if isinstance(content, list):
                    content = " ".join(item.get("text", "") for item in content if isinstance(item, dict))
                
                # 解析 todo 操作
                if "add" in content.lower() or "添加" in content:
                    todo_total += 1
                if "completed" in content.lower() or "完成" in content:
                    todo_completed += 1
                if "delete" in content.lower() or "删除" in content:
                    todo_abandoned += 1
    
    # 任务统计
    total_tasks = len(all_tasks)
    completed_tasks = sum(1 for t in all_tasks if t.get("status") == "completed")
    cancelled_tasks = sum(1 for t in all_tasks if t.get("status") == "cancelled")
    pending_tasks = sum(1 for t in all_tasks if t.get("status") == "pending")
    
    # Evidence 统计
    tasks_with_evidence = len(all_evidence)
    evidence_scores = [score_evidence(e) for e in all_evidence]
    avg_evidence_score = sum(evidence_scores) / max(len(evidence_scores), 1)
    low_quality_count = sum(1 for s in evidence_scores if s < 0.4)
    
    return {
        "goal_quality_stats": {
            "goals_total": goals_total,
            "goals_completed": goals_completed,
            "goals_budget_limited": goals_budget_limited,
            "goals_cancelled": goals_cancelled,
            "completion_rate": goals_completed / max(goals_total, 1),
            "avg_tasks_per_goal": total_tasks / max(goals_total, 1),
            "task_stats": {
                "total": total_tasks,
                "completed": completed_tasks,
                "cancelled": cancelled_tasks,
                "pending": pending_tasks,
                "completion_rate": completed_tasks / max(total_tasks, 1),
                "cancel_rate": cancelled_tasks / max(total_tasks, 1),
            },
            "evidence_stats": {
                "tasks_with_evidence": tasks_with_evidence,
                "evidence_rate": tasks_with_evidence / max(total_tasks, 1),
                "avg_evidence_score": avg_evidence_score,
                "low_quality_evidence_count": low_quality_count,
            },
            "stall_stats": {
                "goals_with_stall": 1 if stall_count > 0 else 0,
                "stall_rate": (1 if stall_count > 0 else 0) / max(goals_total, 1),
                "avg_stall_count": stall_count / max(goals_total, 1),
            },
            "token_stats": {
                "avg_tokens_per_goal": total_tokens / max(goals_total, 1),
                "avg_tokens_per_task": total_tokens / max(total_tasks, 1),
            },
        },
        "todo_stats": {
            "total_todos": todo_total,
            "completed": todo_completed,
            "abandoned": todo_abandoned,
            "completion_rate": todo_completed / max(todo_total, 1),
            "abandon_rate": todo_abandoned / max(todo_total, 1),
        },
    }
```

- [ ] **Step 2: Commit**

```bash
git add packages/evolve-daily/analyzer/extractors/goal_quality.py
git commit -m "feat: add goal quality extractor"
```

### Task 14: Miner Rules (14 条)

**Type:** backend

**Files:**
- Create: `packages/evolve-daily/analyzer/rules/compact_high_frequency.py`
- Create: `packages/evolve-daily/analyzer/rules/compact_early_trigger.py`
- Create: `packages/evolve-daily/analyzer/rules/context_high_utilization.py`
- Create: `packages/evolve-daily/analyzer/rules/subagent_failure_rate.py`
- Create: `packages/evolve-daily/analyzer/rules/subagent_high_retry.py`
- Create: `packages/evolve-daily/analyzer/rules/param_error_rate.py`
- Create: `packages/evolve-daily/analyzer/rules/edit_match_failure.py`
- Create: `packages/evolve-daily/analyzer/rules/low_self_correction.py`
- Create: `packages/evolve-daily/analyzer/rules/workflow_slow_phase.py`
- Create: `packages/evolve-daily/analyzer/rules/workflow_gate_retry.py`
- Create: `packages/evolve-daily/analyzer/rules/goal_low_completion.py`
- Create: `packages/evolve-daily/analyzer/rules/goal_low_evidence.py`
- Create: `packages/evolve-daily/analyzer/rules/goal_stall_frequent.py`
- Create: `packages/evolve-daily/analyzer/rules/todo_high_abandon.py`

- [ ] **Step 1: 写 14 条 miner rules**

每条 rule 是一个独立的 Python 文件，实现 `check(daily_report: dict) -> list[dict]` 接口，返回 actionable issues 列表。

示例（compact_high_frequency.py）：

```python
# packages/evolve-daily/analyzer/rules/compact_high_frequency.py

"""规则：compact 过于频繁。"""

def check(daily_report: dict) -> list[dict]:
    """检查 compact 频率是否过高。"""
    issues = []
    compact_stats = daily_report.get("compact_stats", {})
    avg_compacts = compact_stats.get("compacts_per_session", {}).get("avg", 0)
    
    if avg_compacts >= 3:
        issues.append({
            "id": "compact-high-frequency",
            "severity": "medium",
            "title": "Compact 频率过高",
            "description": f"每 session 平均 compact {avg_compacts:.1f} 次，说明上下文管理效率低",
            "suggestion": "优化上下文管理，减少不必要的工具输出长度",
            "metric": avg_compacts,
            "threshold": 3,
        })
    
    return issues
```

其余 13 条规则类似，每个文件实现 `check` 函数，检查对应的阈值并返回 issues。

- [ ] **Step 2: Commit**

```bash
git add packages/evolve-daily/analyzer/rules/
git commit -m "feat: add 14 miner rules for new tracking dimensions"
```

### Task 15: 更新 /evolve Skill

**Type:** backend

**Files:**
- Modify: `packages/evolve-daily/skills/evolve/SKILL.md`

- [ ] **Step 1: 在 evolve SKILL.md 的分析步骤中增加新维度**

在分析步骤中增加：

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

- [ ] **Step 2: Commit**

```bash
git add packages/evolve-daily/skills/evolve/SKILL.md
git commit -m "feat: add new dimension analysis to evolve skill"
```

### Task 16: 更新 /evolve-report Skill

**Type:** backend

**Files:**
- Modify: `packages/evolve-daily/skills/evolve-report/SKILL.md`

- [ ] **Step 1: 在 evolve-report SKILL.md 中增加新维度展示**

在报告展示步骤中增加新维度的数据展示格式。

- [ ] **Step 2: Commit**

```bash
git add packages/evolve-daily/skills/evolve-report/SKILL.md
git commit -m "feat: add new dimension display to evolve-report skill"
```

---

## ADR Evaluation

检查 `docs/adr/` 目录，当前已有 ADR-001（Subagent Architecture）、ADR-002（Goal 7 State Machine）、ADR-003（Evidence-Based Completion）。

扫描 plan.md 中的新决策：

1. **Python extractor 自动发现机制** — 使用 pkgutil.iter_modules 实现插件式注册。这是一般做法，无替代方案，不满足 ADR 条件。
2. **错误分类规则（PARAM_ERROR_PATTERNS / RUNTIME_ERROR_PATTERNS）** — 基于正则匹配的启发式分类。有替代方案（LLM 分类），但正则更简单高效。满足"真实权衡"条件，但不满足"难以逆转"条件（规则可以随时修改）。不创建 ADR。
3. **Evidence 质量评分规则** — 基于长度和关键词的启发式评分。有替代方案（LLM 评分），但启发式更简单。同上，不创建 ADR。

**结论：无新 ADR 需要创建。**
