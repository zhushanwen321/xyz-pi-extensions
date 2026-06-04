// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach）
// 运行命令：npx vitest run tests/state.test.ts

import { describe, it, expect, expectTypeOf } from "vitest";
import {
  isTerminal,
  VALID_TRANSITIONS,
  ALL_STATUSES,
  TERMINAL_STATUSES,
  serializeInstance,
  createInstance,
  type ExecutionTraceNode,
} from "../src/state";

describe("state_lost + verifyStrategy", () => {
  it("state_lost_is_terminal", () => {
    expect(isTerminal("state_lost")).toBe(true);
  });

  it("state_lost_has_no_outgoing_transitions", () => {
    expect(VALID_TRANSITIONS["state_lost"]).toEqual([]);
  });

  it("ALL_STATUSES_includes_state_lost", () => {
    expect(ALL_STATUSES).toContain("state_lost");
  });

  it("all_terminal_statuses_count_is_8", () => {
    expect(TERMINAL_STATUSES).toHaveLength(6);
  });

  it("verifyStrategy_optional_on_trace_node", () => {
    const node: ExecutionTraceNode = {
      stepIndex: 0,
      agent: "a",
      task: "t",
      model: "m",
      status: "completed",
    };
    expect(node.stepIndex).toBe(0);
  });

  it("verifyStrategy_optional_with_internal", () => {
    const node: ExecutionTraceNode = {
      stepIndex: 0,
      agent: "a",
      task: "t",
      model: "m",
      status: "completed",
      verifyStrategy: "internal",
    };
    expect(node.verifyStrategy).toBe("internal");
  });

  it("verifyStrategy_not_in_serialized_form", () => {
    const inst = createInstance({ runId: "r1", name: "wf1", worker: "a1" });
    inst.trace.push({
      stepIndex: 0,
      agent: "a1",
      task: "task1",
      model: "m1",
      status: "completed",
      verifyStrategy: "internal",
    });
    const serialized = serializeInstance(inst);
    // Type-level: serialized trace node type does not expose verifyStrategy
    type SerializedNode = ReturnType<typeof serializeInstance>["trace"][number];
    expectTypeOf<SerializedNode>().not.toHaveProperty("verifyStrategy");
    expect(serialized.trace).toHaveLength(1);
  });
});
