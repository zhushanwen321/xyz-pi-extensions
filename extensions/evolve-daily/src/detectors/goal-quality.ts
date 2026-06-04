// packages/evolve-daily/src/detectors/goal-quality.ts

import type { ProblemDefinition } from "../problems";

// ── ID generation constants ──────────────────────────

const RANDOM_ID_RADIX = 36;
const RANDOM_ID_SLICE_START = 2;
const RANDOM_ID_SLICE_END = 7;

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

    createItem(event: {
      type: string;
      toolName?: string;
      details?: { tasks?: Array<{ status: string }> };
    }): GoalQualityTrackedItem {
      const tasks = event.details?.tasks ?? [];
      const completed = tasks.filter((t) => t.status === "completed").length;
      const cancelled = tasks.filter((t) => t.status === "cancelled").length;
      const total = tasks.length;

      return {
        id: `goal-quality-${Date.now()}-${Math.random().toString(RANDOM_ID_RADIX).slice(RANDOM_ID_SLICE_START, RANDOM_ID_SLICE_END)}`,
        problemId: problem.id as "goal-task-quality",
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
