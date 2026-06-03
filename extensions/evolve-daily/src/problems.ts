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
    name: "Compact Frequency",
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
        "Compact triggered (id={{id}}). Evaluate whether critical context was lost. If lost, update status=error, detail='what was lost'. If unaffected, update status=completed.",
    },
    analysis: {
      extractor: "compact",
      minerRules: ["compact-high-frequency", "compact-early-trigger"],
    },
    suggestion: {
      title: "Optimize Compact Frequency",
      description: "High compact frequency indicates inefficient context management",
      defaultSeverity: "medium",
    },
  },
  {
    id: "context-utilization",
    name: "Context Window Utilization",
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
        "Current context utilization {{usageRate}} (id={{id}}). If near limit, update status=completed, detail='needs compact'. If sufficient, update status=dismissed.",
    },
    analysis: {
      extractor: "context",
      minerRules: ["context-high-utilization"],
    },
    suggestion: {
      title: "Optimize Context Utilization",
      description: "Persistently high context utilization triggers frequent compacts",
      defaultSeverity: "medium",
    },
  },
  {
    id: "subagent-efficiency",
    name: "Subagent Scheduling Efficiency",
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
        "Subagent task completed (id={{id}}). exitCode={{exitCode}}, duration={{duration}}. If satisfactory, update status=completed. If retry needed, update status=error, detail='reason'.",
    },
    analysis: {
      extractor: "subagent",
      minerRules: ["subagent-failure-rate", "subagent-high-retry"],
    },
    suggestion: {
      title: "Optimize Subagent Scheduling",
      description: "High subagent failure or retry rate",
      defaultSeverity: "medium",
    },
  },
  {
    id: "tool-param-validation",
    name: "Tool Parameter Validation Failure",
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
        "Detected {{toolName}} parameter error (id={{id}}). Error: {{errorPreview}}. If cause understood, update status=completed, detail='cause and fix'. If unclear, update status=error.",
    },
    analysis: {
      extractor: "tool_errors",
      minerRules: ["param-error-rate", "edit-match-failure", "low-self-correction"],
    },
    suggestion: {
      title: "Reduce Tool Parameter Error Rate",
      description: "High parameter error rate suggests the AI does not understand tool usage",
      defaultSeverity: "high",
    },
  },
  {
    id: "workflow-phase-duration",
    name: "Workflow Phase Duration",
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
        "Workflow phase {{phase}} completed (id={{id}}). gate={{gateResult}}, duration={{duration}}. If smooth, update status=completed. If issues, update status=error, detail='issue description'.",
    },
    analysis: {
      extractor: "workflow",
      minerRules: ["workflow-slow-phase", "workflow-gate-retry"],
    },
    suggestion: {
      title: "Optimize Workflow Phase Efficiency",
      description: "Disproportionate phase duration or frequent gate retries",
      defaultSeverity: "medium",
    },
  },
  {
    id: "goal-task-quality",
    name: "Goal Task Decomposition Quality",
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
        "Goal task updated (id={{id}}). Completion rate={{completionRate}}. If objective met, update status=completed, detail='completion summary'. If blocked, update status=error, detail='blocker description'.",
    },
    analysis: {
      extractor: "goal_quality",
      minerRules: [
        "goal-low-completion",
        "goal-low-evidence",
        "goal-stall-frequent",
        "todo-high-abandon",
      ],
    },
    suggestion: {
      title: "Optimize Goal Task Decomposition",
      description: "Low task completion rate or poor evidence quality",
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
