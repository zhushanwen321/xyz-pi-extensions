// packages/evolve-daily/src/detectors/subagent-result.ts

import type { ProblemDefinition } from "../problems";

// ── ID generation constants ──────────────────────────

const RANDOM_ID_RADIX = 36;
const RANDOM_ID_SLICE_START = 2;
const RANDOM_ID_SLICE_END = 7;

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

    createItem(event: {
      type: string;
      toolName?: string;
      isError?: boolean;
      content?: string;
      taskPrompt?: string;
    }): SubagentTrackedItem {
      return {
        id: `subagent-${Date.now()}-${Math.random().toString(RANDOM_ID_RADIX).slice(RANDOM_ID_SLICE_START, RANDOM_ID_SLICE_END)}`,
        problemId: problem.id as "subagent-efficiency",
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
