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
      // DISABLED: goal tool was renamed goal_manager → goal_control, and the new
      // GoalControlDetails schema ({action, goalId, status, slug}) no longer
      // exposes task data. Task-quality metrics (completion/cancel rate) have no
      // data source, so matching would only produce 0/0 items that falsely trip
      // the "high" severity rule. Re-enable once task progress is re-injected
      // (see goal refactor #7 / ADR).
      void event;
      return false;
    },

    createItem(event: {
      type: string;
      toolName?: string;
      details?: unknown;
    }): GoalQualityTrackedItem {
      // details.tasks 已不存在于 GoalControlDetails；defensive 读取，缺数据时记 0。
      const details = (event.details ?? {}) as { tasks?: Array<{ status: string }> };
      const tasks = details.tasks ?? [];
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
