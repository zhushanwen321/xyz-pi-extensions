// src/__tests__/spawn-args.test.ts
import { describe, expect, it } from "vitest";

import { buildSpawnArgs } from "../core/session-runner.ts";

describe("buildSpawnArgs", () => {
  const baseParams = {
    model: undefined as string | undefined,
    thinkingLevel: undefined as string | undefined,
    agentTools: undefined as string[] | undefined,
    appendSystemPromptPath: undefined as string | undefined,
    sessionDir: "/sessions/dir",
    forkSource: undefined as string | undefined,
  };

  it("基础参数：--mode json -p --session-dir + task", () => {
    const args = buildSpawnArgs(baseParams, "Task: do something");
    expect(args).toEqual([
      "--mode", "json", "-p", "--session-dir", "/sessions/dir",
      "Task: do something",
    ]);
  });

  it("有 model → 追加 --model provider/id", () => {
    const args = buildSpawnArgs(
      { ...baseParams, model: "openai/gpt-4o" },
      "Task: x",
    );
    expect(args).toContain("--model");
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("openai/gpt-4o");
  });

  it("model + thinkingLevel → model 后缀 :level", () => {
    const args = buildSpawnArgs(
      { ...baseParams, model: "anthropic/claude", thinkingLevel: "high" },
      "Task: x",
    );
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("anthropic/claude:high");
  });

  it("thinkingLevel 无 model → 不追加（thinking 依赖 model 后缀）", () => {
    const args = buildSpawnArgs(
      { ...baseParams, model: undefined, thinkingLevel: "high" },
      "Task: x",
    );
    expect(args).not.toContain("--model");
  });

  it("agentTools → --tools 逗号分隔", () => {
    const args = buildSpawnArgs(
      { ...baseParams, agentTools: ["read", "bash", "edit"] },
      "Task: x",
    );
    const idx = args.indexOf("--tools");
    expect(args[idx + 1]).toBe("read,bash,edit");
  });

  it("appendSystemPromptPath → --append-system-prompt <path>", () => {
    const args = buildSpawnArgs(
      { ...baseParams, appendSystemPromptPath: "/tmp/prompt.md" },
      "Task: x",
    );
    const idx = args.indexOf("--append-system-prompt");
    expect(args[idx + 1]).toBe("/tmp/prompt.md");
  });

  it("forkSource → --fork <path>", () => {
    const args = buildSpawnArgs(
      { ...baseParams, forkSource: "/sessions/parent.jsonl" },
      "Task: x",
    );
    const idx = args.indexOf("--fork");
    expect(args[idx + 1]).toBe("/sessions/parent.jsonl");
  });

  it("全参数组合顺序正确，task 始终最后", () => {
    const args = buildSpawnArgs(
      {
        model: "openai/gpt-4o",
        thinkingLevel: "low",
        agentTools: ["read"],
        appendSystemPromptPath: "/tmp/p.md",
        sessionDir: "/s",
        forkSource: "/parent.jsonl",
      },
      "final task",
    );
    expect(args[args.length - 1]).toBe("final task");
    expect(args).toContain("--fork");
    expect(args).toContain("--tools");
  });

  it("空 tools 数组不追加 --tools", () => {
    const args = buildSpawnArgs(
      { ...baseParams, agentTools: [] },
      "Task: x",
    );
    expect(args).not.toContain("--tools");
  });
});
