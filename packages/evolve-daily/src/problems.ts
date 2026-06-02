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
  thresholds?: { medium: number; high: number };
  custom?: (data: Record<string, unknown>) => "low" | "medium" | "high";
}

export interface DetectorConfig {
  events: Array<"tool_call" | "tool_result" | "user_message" | "turn_end" | "message_end">;
  match: MatchCondition;
  template: Partial<TrackedItemTemplate>;
  steering: string;
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

/** Minimal template shape for ProblemDefinition.detector.template */
interface TrackedItemTemplate {
  category: string;
  status: string;
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
      steering:
        "检测到 Compact 触发(id={{id}})。请评估是否丢失了关键上下文。如有丢失，update status=error, detail='丢失的内容'。如无影响，update status=completed。",
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
      steering:
        "当前上下文利用率 {{usageRate}}(id={{id}})。如接近上限，update status=completed, detail='需要 compact'。如充足，update status=dismissed。",
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
      steering:
        "Subagent 任务完成(id={{id}})。exitCode={{exitCode}}, 耗时={{duration}}。如结果满意，update status=completed。如需重做，update status=error, detail='问题原因'。",
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
      steering:
        "检测到 {{toolName}} 参数错误(id={{id}})。错误: {{errorPreview}}。如已理解原因，update status=completed, detail='错误原因和修正方式'。如不确定，update status=error。",
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
      steering:
        "工作流阶段 {{phase}} 完成(id={{id}})。gate={{gateResult}}, 耗时={{duration}}。如阶段顺利，update status=completed。如有问题，update status=error, detail='问题描述'。",
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
      steering:
        "Goal 任务更新(id={{id}})。任务完成率={{completionRate}}。如目标达成，update status=completed, detail='目标完成情况'。如遇到困难，update status=error, detail='困难描述'。",
    },
    analysis: {
      extractor: "goal_quality",
      minerRules: [
        "goal-low-completion",
        "goal-high-cancel",
        "goal-low-evidence",
        "goal-low-evidence-quality",
        "goal-stall-frequent",
        "todo-high-abandon",
      ],
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
