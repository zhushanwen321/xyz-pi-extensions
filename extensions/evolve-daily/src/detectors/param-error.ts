// packages/evolve-daily/src/detectors/param-error.ts

import type { ProblemDefinition } from "../problems";

// ── ID generation constants ──────────────────────────

const RANDOM_ID_RADIX = 36;
const RANDOM_ID_SLICE_START = 2;
const RANDOM_ID_SLICE_END = 7;
const ERROR_PREVIEW_MAX_LENGTH = 200;

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

const TRACKED_TOOLS = new Set(["edit", "bash", "read", "write"]);

export function createParamErrorDetector(problem: ProblemDefinition) {
  return {
    problemId: problem.id,
    events: problem.detector.events,

    match(event: { type: string; toolName?: string; isError?: boolean }): boolean {
      if (event.type !== "tool_result") return false;
      if (event.isError !== true) return false;
      return TRACKED_TOOLS.has(event.toolName ?? "");
    },

    createItem(event: {
      type: string;
      toolName?: string;
      isError?: boolean;
      content?: string;
    }): ParamErrorTrackedItem {
      const errorMessage = event.content ?? "";
      return {
        id: `param-error-${Date.now()}-${Math.random().toString(RANDOM_ID_RADIX).slice(RANDOM_ID_SLICE_START, RANDOM_ID_SLICE_END)}`,
        problemId: problem.id as "tool-param-validation",
        sessionId: "",
        toolName: event.toolName ?? "unknown",
        errorType: classifyError(errorMessage),
        errorPreview: errorMessage.slice(0, ERROR_PREVIEW_MAX_LENGTH),
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
