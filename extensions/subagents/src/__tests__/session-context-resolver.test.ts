// src/__tests__/session-context-resolver.test.ts
//
// 覆盖 resolveSessionContext 全部 5 种输入组合 + ForkDepthExceededError 边界。
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { encodeCwd } from "../core/path-encoding.ts";
import { resolveSessionContext } from "../core/session-context-resolver.ts";
import { ForkDepthExceededError } from "../types.ts";

const AGENT_DIR = "/home/user/.pi/agent";
const MAIN_CWD = "/home/user/project";
const SESSION_FILE = "session-abc.jsonl";

function expectedSessionDir(mainCwd: string): string {
  return path.join(AGENT_DIR, "subagents", "sessions", encodeCwd(mainCwd));
}

describe("resolveSessionContext", () => {
  // ── 边界 1: fork=false, worktree=false ──
  it("fork=false, worktree=false → shouldFork=false, effectiveCwd=mainCwd", () => {
    const result = resolveSessionContext({
      fork: false,
      worktree: false,
      mainCwd: MAIN_CWD,
      agentDir: AGENT_DIR,
    });
    expect(result.shouldFork).toBe(false);
    expect(result.forkSource).toBeUndefined();
    expect(result.effectiveCwd).toBe(MAIN_CWD);
    expect(result.sessionDir).toBe(expectedSessionDir(MAIN_CWD));
  });

  // ── 边界 2: fork=true, worktree=false ──
  it("fork=true, worktree=false → shouldFork=true, forkSource=mainSessionFile", () => {
    const result = resolveSessionContext({
      fork: true,
      worktree: false,
      mainCwd: MAIN_CWD,
      mainSessionFile: SESSION_FILE,
      agentDir: AGENT_DIR,
    });
    expect(result.shouldFork).toBe(true);
    expect(result.forkSource).toBe(SESSION_FILE);
    expect(result.effectiveCwd).toBe(MAIN_CWD);
    expect(result.sessionDir).toBe(expectedSessionDir(MAIN_CWD));
  });

  // ── 边界 3: fork=false, worktree=true ──
  it("fork=false, worktree=true → effectiveCwd=tmpdir/pi-sub-<recordId>", () => {
    const recordId = "run-42";
    const result = resolveSessionContext({
      fork: false,
      worktree: true,
      mainCwd: MAIN_CWD,
      agentDir: AGENT_DIR,
      recordId,
    });
    expect(result.shouldFork).toBe(false);
    expect(result.forkSource).toBeUndefined();
    expect(result.effectiveCwd).toBe(path.join(os.tmpdir(), `pi-sub-${recordId}`));
    expect(result.sessionDir).toBe(expectedSessionDir(MAIN_CWD));
  });

  // ── 边界 4: fork=true, worktree=true ──
  it("fork=true, worktree=true → shouldFork=true + worktree effectiveCwd", () => {
    const recordId = "bg-7-abc";
    const result = resolveSessionContext({
      fork: true,
      worktree: true,
      mainCwd: MAIN_CWD,
      mainSessionFile: SESSION_FILE,
      agentDir: AGENT_DIR,
      recordId,
    });
    expect(result.shouldFork).toBe(true);
    expect(result.forkSource).toBe(SESSION_FILE);
    expect(result.effectiveCwd).toBe(path.join(os.tmpdir(), `pi-sub-${recordId}`));
    expect(result.sessionDir).toBe(expectedSessionDir(MAIN_CWD));
  });

  // ── 边界 5: fork=true + parentForkDepth>=10 → 抛错 ──
  it("fork=true + parentForkDepth=10 → throws ForkDepthExceededError", () => {
    expect(() =>
      resolveSessionContext({
        fork: true,
        mainCwd: MAIN_CWD,
        mainSessionFile: SESSION_FILE,
        parentForkDepth: 10,
        agentDir: AGENT_DIR,
      }),
    ).toThrow(ForkDepthExceededError);
  });

  it("fork=true + parentForkDepth=15 → throws ForkDepthExceededError", () => {
    expect(() =>
      resolveSessionContext({
        fork: true,
        mainCwd: MAIN_CWD,
        parentForkDepth: 15,
        agentDir: AGENT_DIR,
      }),
    ).toThrow(ForkDepthExceededError);
  });

  // ── depth=9 不抛 ──
  it("fork=true + parentForkDepth=9 → does NOT throw", () => {
    const result = resolveSessionContext({
      fork: true,
      mainCwd: MAIN_CWD,
      parentForkDepth: 9,
      agentDir: AGENT_DIR,
    });
    expect(result.shouldFork).toBe(true);
  });

  // ── sessionDir 始终用 mainCwd 编码（非 effectiveCwd）──
  it("sessionDir always encoded from mainCwd even when worktree overrides effectiveCwd", () => {
    const mainCwd = "/Users/alice/code/my-app";
    const result = resolveSessionContext({
      fork: false,
      worktree: true,
      mainCwd,
      agentDir: AGENT_DIR,
      recordId: "run-1",
    });
    // effectiveCwd 是 tmpdir 路径，但 sessionDir 仍基于 mainCwd
    expect(result.effectiveCwd).not.toBe(mainCwd);
    expect(result.sessionDir).toBe(expectedSessionDir(mainCwd));
  });

  // ── 默认值：fork/worktree 未传 → undefined → false ──
  it("fork/worktree omitted → shouldFork=false", () => {
    const result = resolveSessionContext({
      mainCwd: MAIN_CWD,
      agentDir: AGENT_DIR,
    });
    expect(result.shouldFork).toBe(false);
    expect(result.forkSource).toBeUndefined();
    expect(result.effectiveCwd).toBe(MAIN_CWD);
  });

  // ── cwd 覆盖 mainCwd（worktree=false 时）──
  it("explicit cwd overrides mainCwd when worktree=false", () => {
    const customCwd = "/tmp/custom-cwd";
    const result = resolveSessionContext({
      mainCwd: MAIN_CWD,
      cwd: customCwd,
      agentDir: AGENT_DIR,
    });
    expect(result.effectiveCwd).toBe(customCwd);
    // sessionDir 仍用 mainCwd
    expect(result.sessionDir).toBe(expectedSessionDir(MAIN_CWD));
  });
});
