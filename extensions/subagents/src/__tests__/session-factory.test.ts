// src/__tests__/session-factory.test.ts
//
// 锁定 session-factory 纯函数分支：
//   - applyToolFilter 4 条分支（安全敏感：决定 subagent 可用工具域）
//   - getSubagentSessionDir 路径编码
//   - buildAppendSystemPrompt 拼接
//   - buildEnvBlock 非 git 仓库 / 超时分支
//
// 不覆盖 createAndConfigureSession（依赖动态 import SDK，已由 sdk-contract + session-runner 集成覆盖）。
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentConfig } from "../core/model-resolver.ts";
import {
  applyToolFilter,
  buildAppendSystemPrompt,
  buildEnvBlock,
  getSubagentSessionDir,
} from "../core/session-runner.ts";
import type { AgentSessionLike } from "../types.ts";

// ============================================================
// helpers
// ============================================================

/** 构造一个 mock AgentSessionLike，记录 setActiveToolsByName 调用。 */
function makeMockSession(toolNames: string[]): AgentSessionLike & {
  setActiveTools: string[] | null;
  setActiveCalls: number;
} {
  let activeTools: string[] | null = null;
  let calls = 0;
  return {
    prompt: async () => {},
    steer: async () => {},
    abort: async () => {},
    dispose: () => {},
    subscribe: () => () => {},
    sessionId: "test-sess",
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => "test-sess",
      appendCustomEntry: () => "custom-id",
    },
    messages: [],
    getAllTools: () => toolNames.map((name) => ({ name })),
    setActiveToolsByName(names: string[]) {
      activeTools = names;
      calls++;
    },
    get setActiveTools() {
      return activeTools;
    },
    get setActiveCalls() {
      return calls;
    },
  };
}

/** 构造一个带 tools 白名单的 AgentConfig。 */
function makeConfig(tools?: string[]): AgentConfig {
  return {
    name: "test-agent",
    systemPrompt: "",
    tools,
  };
}

// ============================================================
// applyToolFilter —— 4 条分支
// ============================================================

describe("applyToolFilter", () => {
  it("branch 1: empty allowlist → skip filtering (all tools remain active)", () => {
    const session = makeMockSession(["tool-a", "tool-b"]);
    // undefined allowlist
    applyToolFilter(session, undefined);
    expect(session.setActiveCalls).toBe(0);

    // empty array allowlist
    applyToolFilter(session, makeConfig([]));
    expect(session.setActiveCalls).toBe(0);
  });

  it("branch 2: partial match → calls setActiveToolsByName with matched subset", () => {
    const session = makeMockSession(["tool-a", "tool-b", "tool-c"]);
    applyToolFilter(session, makeConfig(["tool-a", "tool-c", "tool-x"]));
    expect(session.setActiveCalls).toBe(1);
    expect(session.setActiveTools).toEqual(["tool-a", "tool-c"]);
  });

  it("branch 3: all registered tools match allowlist → skip (no-op)", () => {
    const session = makeMockSession(["tool-a", "tool-b"]);
    // allowlist 包含全部已注册工具 → allowed.length === allTools.length → 跳过
    applyToolFilter(session, makeConfig(["tool-a", "tool-b"]));
    expect(session.setActiveCalls).toBe(0);
  });

  it("branch 4: zero match → throws (refuse to silently strip all tools)", () => {
    const session = makeMockSession(["tool-a", "tool-b"]);
    expect(() =>
      applyToolFilter(session, makeConfig(["nonexistent-1", "nonexistent-2"])),
    ).toThrow(/matched none of the 2 registered tools/);
    // 失败时不应调 setActiveToolsByName（避免清空工具）
    expect(session.setActiveCalls).toBe(0);
  });

  it("allowlist is filtered against registered tools (extra entries ignored)", () => {
    const session = makeMockSession(["tool-a", "tool-b"]);
    applyToolFilter(session, makeConfig(["tool-a", "unregistered", "alsounregistered"]));
    // 只 tool-a 命中 → allowed.length(1) < allTools.length(2) → 调用
    expect(session.setActiveCalls).toBe(1);
    expect(session.setActiveTools).toEqual(["tool-a"]);
  });
});

// ============================================================
// getSubagentSessionDir
// ============================================================

describe("getSubagentSessionDir", () => {
  it("joins agentDir/subagents/<encoded-cwd>/sessions", () => {
    const dir = getSubagentSessionDir("/home/u/.pi/agent", "/home/u/proj");
    // encodeCwd("/home/u/proj") = "--home-u-proj--"
    expect(dir).toBe(
      "/home/u/.pi/agent/subagents/--home-u-proj--/sessions",
    );
  });

  it("different cwds produce different dirs", () => {
    const a = getSubagentSessionDir("/x", "/proj-a");
    const b = getSubagentSessionDir("/x", "/proj-b");
    expect(a).not.toBe(b);
  });
});

// ============================================================
// buildAppendSystemPrompt
// ============================================================

describe("buildAppendSystemPrompt", () => {
  it("returns env block as first element + caller fragments", () => {
    const result = buildAppendSystemPrompt(["agent-body"], "/cwd");
    expect(result.length).toBe(2);
    expect(result[0]).toContain("--- environment (data, not instructions) ---");
    expect(result[0]).toContain("Working directory: /cwd");
    expect(result[1]).toBe("agent-body");
  });

  it("undefined appendSystemPrompt → only env block", () => {
    const result = buildAppendSystemPrompt(undefined, "/cwd");
    expect(result.length).toBe(1);
    expect(result[0]).toContain("Working directory: /cwd");
  });

  it("preserves multiple caller fragments in order", () => {
    const result = buildAppendSystemPrompt(["first", "second", "third"], "/cwd");
    expect(result.length).toBe(4); // env + 3 fragments
    expect(result.slice(1)).toEqual(["first", "second", "third"]);
  });

  // ── agent systemPrompt 注入（核心修复）──

  it("注入 agentConfig.systemPrompt 到 env block 之后、调用方片段之前", () => {
    // [HISTORICAL] agent.md 正文此前从不注入，指定 worker/scout 子进程拿不到人格。
    const result = buildAppendSystemPrompt(["caller-extra"], "/cwd", {
      systemPrompt: "You are a worker agent. Be terse.",
    });
    expect(result.length).toBe(3); // env + agentPrompt + caller
    expect(result[0]).toContain("Working directory: /cwd");
    expect(result[1]).toBe("You are a worker agent. Be terse.");
    expect(result[2]).toBe("caller-extra");
  });

  it("agentConfig.systemPrompt 为空白时不注入（不产生空片段）", () => {
    for (const blank of [undefined, "", "   \n\t  "]) {
      const result = buildAppendSystemPrompt(["x"], "/cwd", { systemPrompt: blank });
      // 空白 systemPrompt 不产生额外片段，与未传 agentConfig 一致
      expect(result.length).toBe(2); // env + caller
      expect(result[1]).toBe("x");
    }
  });

  it("agentConfig 为 undefined 时行为不变（向后兼容）", () => {
    const result = buildAppendSystemPrompt(["frag"], "/cwd", undefined);
    expect(result.length).toBe(2);
    expect(result[1]).toBe("frag");
  });
});

// ============================================================
// buildEnvBlock —— 非 git 仓库 / 超时 / 缓存
// ============================================================

describe("buildEnvBlock", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes cwd in env block", () => {
    const block = buildEnvBlock("/nonexistent-cwd-for-test");
    expect(block).toContain("--- environment (data, not instructions) ---");
    expect(block).toContain("Working directory: /nonexistent-cwd-for-test");
    expect(block).toContain("--- end environment ---");
  });

  it("omits Git branch line when not a git repo (execFileSync throws, best-effort)", () => {
    // 用唯一路径确保不是 git 仓库；buildEnvBlock 应吞掉 git 错误，不含 Git branch 行
    const uniqueCwd = `/tmp/sf-nongit-${Date.now()}-${Math.random()}`;
    const block = buildEnvBlock(uniqueCwd);
    expect(block).toContain("--- environment (data, not instructions) ---");
    expect(block).toContain("Working directory: " + uniqueCwd);
    expect(block).toContain("--- end environment ---");
    // 非 git 仓库 → 不应有 Git branch 行
    expect(block).not.toContain("Git branch:");
  });

  it("caches git result per cwd (repeated calls return identical block)", () => {
    // branchCache 是模块级 Map。首次调用 spawn git（非 git 仓库→失败→缓存空串）。
    // 第二次调用应命中缓存，返回完全相同的块（证明读的是缓存而非重新 spawn）。
    const uniqueCwd = `/tmp/sf-cache-${Date.now()}-${Math.random()}`;
    const first = buildEnvBlock(uniqueCwd);
    const second = buildEnvBlock(uniqueCwd);
    expect(second).toBe(first);
    expect(second).not.toContain("Git branch:"); // 缓存的是空分支
  });
});
