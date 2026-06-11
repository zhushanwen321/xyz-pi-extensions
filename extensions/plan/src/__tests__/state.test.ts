import { describe, it, expect, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_PLAN_STATE,
  type PlanState,
  type PlanPhase,
  type PlanSessionMap,
  getPlanState,
  persistPlanState,
  reconstructPlanState,
} from "../state.js";

describe("PlanState", () => {
  it("DEFAULT_PLAN_STATE has correct defaults", () => {
    expect(DEFAULT_PLAN_STATE.isActive).toBe(false);
    expect(DEFAULT_PLAN_STATE.phase).toBe("idle");
    expect(DEFAULT_PLAN_STATE.planFilePath).toBe("");
    expect(DEFAULT_PLAN_STATE.requirement).toBe("");
    expect(DEFAULT_PLAN_STATE.templateName).toBe("");
  });

  it("PlanPhase type includes all required phases", () => {
    const phases: PlanPhase[] = ["idle", "brainstorming", "writing", "complete"];
    expect(phases).toHaveLength(4);
  });

  it("getPlanState returns cached state if exists", () => {
    const sessions: PlanSessionMap = new Map();
    const cached: PlanState = { ...DEFAULT_PLAN_STATE, isActive: true, phase: "brainstorming" };
    sessions.set("session-1", cached);

    const mockCtx = {
      sessionManager: { getEntries: () => [] },
    } as unknown as ExtensionContext;

    const result = getPlanState(sessions, "session-1", mockCtx);
    expect(result).toBe(cached);
  });

  it("getPlanState reconstructs from sessionManager if not cached", () => {
    const sessions: PlanSessionMap = new Map();
    const mockCtx = {
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "plan-state",
            data: { isActive: true, phase: "writing", planFilePath: "/tmp/plan-test.md", requirement: "test", templateName: "feature-plan" },
          },
        ],
      },
    } as unknown as ExtensionContext;

    const result = getPlanState(sessions, "session-2", mockCtx);
    expect(result.isActive).toBe(true);
    expect(result.phase).toBe("writing");
    expect(sessions.get("session-2")).toBe(result);
  });
});

describe("State persistence", () => {
  it("persistPlanState calls appendEntry with correct data", () => {
    const mockPi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
    const state: PlanState = {
      isActive: true,
      phase: "brainstorming",
      planFilePath: "/tmp/plan-test.md",
      requirement: "test requirement",
      templateName: "feature-plan",
    };

    persistPlanState(mockPi, state);

    expect(mockPi.appendEntry).toHaveBeenCalledWith("plan-state", {
      isActive: true,
      phase: "brainstorming",
      planFilePath: "/tmp/plan-test.md",
      requirement: "test requirement",
      templateName: "feature-plan",
    });
  });

  it("reconstructPlanState returns DEFAULT_PLAN_STATE when no entries", () => {
    const mockCtx = {
      sessionManager: { getEntries: () => [] },
    } as unknown as ExtensionContext;

    const state = reconstructPlanState(mockCtx);
    expect(state).toEqual(DEFAULT_PLAN_STATE);
  });

  it("reconstructPlanState restores state from entries", () => {
    const mockCtx = {
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "plan-state",
            data: {
              isActive: true,
              phase: "writing",
              planFilePath: "/tmp/plan-test.md",
              requirement: "test",
              templateName: "feature-plan",
            },
          },
        ],
      },
    } as unknown as ExtensionContext;

    const state = reconstructPlanState(mockCtx);
    expect(state.isActive).toBe(true);
    expect(state.phase).toBe("writing");
    expect(state.planFilePath).toBe("/tmp/plan-test.md");
  });
});
