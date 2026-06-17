// src/__tests__/runtime-eventbus.test.ts
import { describe, expect, it, vi } from "vitest";

import { SubagentRuntime } from "../runtime.ts";

function makeRuntime(): SubagentRuntime {
  return new SubagentRuntime({ cwd: "/tmp", homeDir: "/tmp", agentDir: "/tmp/.pi/agent" });
}

describe("SubagentRuntime — event bus (FR-3.4)", () => {
  it("onChange returns an unsubscribe function", () => {
    const rt = makeRuntime();
    const fn = vi.fn();
    const unsub = rt.onChange(fn);
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("notifyChange invokes all subscribers", () => {
    const rt = makeRuntime();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    rt.onChange(fn1);
    rt.onChange(fn2);
    rt.notifyChange();
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops invocation", () => {
    const rt = makeRuntime();
    const fn = vi.fn();
    const unsub = rt.onChange(fn);
    rt.notifyChange();
    unsub();
    rt.notifyChange();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("multiple unsubscribes do not throw", () => {
    const rt = makeRuntime();
    const fn = vi.fn();
    const unsub = rt.onChange(fn);
    unsub();
    expect(() => unsub()).not.toThrow();
  });
});
