import { describe, expect, it } from "vitest";

import { SubagentRuntime } from "../runtime.ts";

function makeRuntime(): { rt: SubagentRuntime; entries: Array<{ customType: string; data: unknown }> } {
  const entries: Array<{ customType: string; data: unknown }> = [];
  const rt = new SubagentRuntime({ cwd: "/tmp", homeDir: "/tmp", agentDir: "/tmp/.pi/agent" });
  // 注入 mock pi 捕获 appendEntry
  (rt as unknown as { injectPi: (pi: unknown) => void }).injectPi({
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
    events: { emit: () => {} },
  });
  return { rt, entries };
}

describe("SubagentRuntime.applyCategoryConfirm", () => {
  it("writes overrides + sets categoryConfirmed in single persistState", () => {
    const { rt, entries } = makeRuntime();
    rt.applyCategoryConfirm({
      action: "confirmed",
      overrides: { coding: { model: "anthropic/claude-haiku-4-5" } },
    });
    expect(rt.sessionState.categoryConfirmed).toBe(true);
    expect(rt.sessionState.perCategory.coding).toEqual({ model: "anthropic/claude-haiku-4-5" });
    // 原子：只产生一条 subagent-model-state entry
    const stateEntries = entries.filter((e) => e.customType === "subagent-model-state");
    expect(stateEntries.length).toBe(1);
  });

  it("use-default: sets categoryConfirmed but writes no perCategory", () => {
    const { rt } = makeRuntime();
    rt.applyCategoryConfirm({ action: "use-default", overrides: {} });
    expect(rt.sessionState.categoryConfirmed).toBe(true);
    expect(rt.sessionState.perCategory).toEqual({});
  });
});
