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

    createItem(event: {
      type: string;
      message?: { role: string };
      turnIndex?: number;
      messagesBefore?: number;
    }): CompactTrackedItem {
      return {
        id: `compact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        problemId: problem.id as "compact-frequency",
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
