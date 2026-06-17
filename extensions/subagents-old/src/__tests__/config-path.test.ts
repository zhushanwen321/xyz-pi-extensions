// src/__tests__/config-path.test.ts
import { describe, expect, it } from "vitest";

import {
  getConfigDir,
  getConfigPath,
  getHistoryFilePath,
  getSessionsDir,
} from "../config/config-path.ts";

describe("getConfigDir", () => {
  it("joins homeDir with .pi/agent/extensions/subagents", () => {
    expect(getConfigDir("/Users/alice")).toBe("/Users/alice/.pi/agent/extensions/subagents");
  });
});

describe("getConfigPath", () => {
  it("appends config.json to config dir", () => {
    expect(getConfigPath("/Users/alice")).toBe(
      "/Users/alice/.pi/agent/extensions/subagents/config.json",
    );
  });
});

describe("getHistoryFilePath", () => {
  it("encodes cwd and returns history.jsonl under subagents dir", () => {
    const result = getHistoryFilePath("/home/user", "/Users/alice/proj");
    expect(result).toContain("subagents");
    expect(result).toContain("history.jsonl");
    expect(result).toContain("--Users-alice-proj--");
  });

  it("handles Windows-style paths", () => {
    const result = getHistoryFilePath("/home/user", "C:\\Users\\bob\\project");
    expect(result).toContain("--Users-bob-project--");
    expect(result).toContain("history.jsonl");
  });
});

describe("getSessionsDir", () => {
  it("encodes cwd and returns sessions subdirectory", () => {
    const result = getSessionsDir("/home/user", "/tmp/my-project");
    expect(result).toContain("sessions");
    expect(result).toContain("--tmp-my-project--");
  });

  it("homeDir change updates the path", () => {
    const r1 = getSessionsDir("/home/alice", "/proj");
    const r2 = getSessionsDir("/home/bob", "/proj");
    expect(r1).toContain("/home/alice/");
    expect(r2).toContain("/home/bob/");
    expect(r1).not.toBe(r2);
  });
});
