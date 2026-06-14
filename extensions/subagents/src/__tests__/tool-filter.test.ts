// src/__tests__/tool-filter.test.ts
import { describe, expect,it } from "vitest";

import { filterTools, isExcludedBySuffix } from "../resolution/tool-filter.ts";

describe("isExcludedBySuffix", () => {
  it("matches plain name", () => {
    expect(isExcludedBySuffix("workflow_run", ["workflow_run"])).toBe(true);
  });
  it("matches scoped name by suffix", () => {
    expect(isExcludedBySuffix("@zhushanwen/workflow_run", ["workflow_run"])).toBe(true);
  });
  it("does not match unrelated", () => {
    expect(isExcludedBySuffix("read", ["workflow_run"])).toBe(false);
  });
});

describe("filterTools", () => {
  const allTools = [
    { name: "read" }, { name: "bash" }, { name: "grep" },
    { name: "@zhushanwen/workflow_run" }, { name: "structured-output" },
  ];

  it("builtinTools whitelist filters builtin tools", () => {
    const result = filterTools({
      allTools,
      config: { builtinTools: ["read"], extensions: false },
    });
    expect(result.allowedTools).toEqual(["read"]);
    expect(result.excludedTools.length).toBeGreaterThan(0);
  });

  it("builtinTools undefined = all builtin tools allowed", () => {
    const result = filterTools({ allTools, config: { extensions: false } });
    expect(result.allowedTools).toContain("read");
    expect(result.allowedTools).not.toContain("@zhushanwen/workflow_run");
  });

  it("extensions=false excludes all extension tools (only builtin pass)", () => {
    const result = filterTools({
      allTools,
      config: { builtinTools: ["read"], extensions: false },
    });
    expect(result.allowedTools).toEqual(["read"]);
  });

  it("excludeTools removes specific tools", () => {
    const result = filterTools({
      allTools,
      config: { excludeTools: ["bash"] },
    });
    expect(result.allowedTools).not.toContain("bash");
  });

  it("always excludes EXCLUDED_TOOL_NAMES (workflow_* etc.)", () => {
    const result = filterTools({ allTools, config: {} });
    expect(result.allowedTools).not.toContain("@zhushanwen/workflow_run");
  });
});
