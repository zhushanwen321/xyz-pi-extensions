// packages/evolve-daily/src/detectors/compact.ts

import type { ProblemDefinition } from "../problems";

export interface CompactTrackedItem {
  id: string;
  problemId: "compact-frequency";
  sessionId: string;
  tokensBefore: number;
  detected: boolean;
  status: "pending" | "completed" | "error" | "dismissed";
  detail?: string;
}

export function createCompactDetector(problem: ProblemDefinition) {
  return {
    problemId: problem.id,

    /**
     * 从 session_compact 事件创建 tracked item。
     * compact 不通过通用的 tool_execution_end handler，
     * 而是独立监听 pi.on("session_compact") 事件。
     */
    createItem(event: {
      compactionEntry?: { tokensBefore?: number };
    }): CompactTrackedItem {
      return {
        id: `compact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        problemId: problem.id as "compact-frequency",
        sessionId: "",
        tokensBefore: event.compactionEntry?.tokensBefore ?? 0,
        detected: true,
        status: "pending",
      };
    },

    steering(item: CompactTrackedItem): string {
      return problem.detector.steering
        .replace("{{id}}", item.id)
        .replace("{{tokensBefore}}", String(item.tokensBefore));
    },
  };
}
