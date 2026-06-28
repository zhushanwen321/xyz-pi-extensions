// src/__tests__/worktree-manager.test.ts
//
// WorktreeManager 单元测试。
// mock execFileSync（git 命令）+ fs（文件操作）+ alive-store（进程探活）。

import { beforeEach,describe, expect, it, vi } from "vitest";

import { DirtyWorktreeError } from "../types.ts";

// ── mock modules ──

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    symlinkSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  symlinkSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock("../runtime/execution/alive-store.ts", () => ({
  readAliveMarker: vi.fn(),
  isProcessAlive: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

import { isProcessAlive,readAliveMarker } from "../runtime/execution/alive-store.ts";
import { WorktreeManager } from "../runtime/worktree-manager.ts";

const mockExec = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);
const mockReadAliveMarker = vi.mocked(readAliveMarker);
const mockIsProcessAlive = vi.mocked(isProcessAlive);

const MAIN_CWD = "/home/user/project";
const AGENT_DIR = "/home/user/.pi/agent/subagents";
const RECORD_ID = "bg-42-abc";
const BASE_COMMIT = "abc123def456";

function setupCleanTree(): void {
  // git status --porcelain → clean
  mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
    if (args?.[0] === "status") return "";
    if (args?.[0] === "rev-parse" && args?.[1] === "HEAD") return BASE_COMMIT;
    if (args?.[0] === "rev-parse" && args?.[1] === "--git-dir") return ".git";
    if (args?.[0] === "worktree") return "";
    if (args?.[0] === "branch") return "";
    return "";
  });
  // node_modules 存在
  mockExistsSync.mockImplementation((p: unknown) => {
    const s = String(p);
    if (s.includes("node_modules") && !s.includes("pi-sub-")) return true;
    return false;
  });
}

describe("WorktreeManager", () => {
  let mgr: WorktreeManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mgr = new WorktreeManager();
  });

  describe("create", () => {
    it("正常流程返回冻结 handle", () => {
      setupCleanTree();

      const handle = mgr.create(MAIN_CWD, RECORD_ID);

      expect(handle.path).toBe(
        `${MAIN_CWD}/.git/worktrees/pi-sub-${RECORD_ID}`,
      );
      expect(handle.branch).toBe(`pi-sub-${RECORD_ID}`);
      expect(handle.baseCommit).toBe(BASE_COMMIT);
      expect(Object.isFrozen(handle)).toBe(true);
    });

    it("脏树抛 DirtyWorktreeError", () => {
      mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
        if (args?.[0] === "status") return "M src/index.ts\n";
        return "";
      });

      expect(() => mgr.create(MAIN_CWD, RECORD_ID)).toThrow(DirtyWorktreeError);
    });

    it("recordId 含特殊字符抛 DirtyWorktreeError", () => {
      expect(() => mgr.create(MAIN_CWD, "../evil-path")).toThrow(
        DirtyWorktreeError,
      );
      expect(() => mgr.create(MAIN_CWD, "hello world")).toThrow(
        DirtyWorktreeError,
      );
    });

    it("调用 git worktree add 正确参数", () => {
      setupCleanTree();

      mgr.create(MAIN_CWD, RECORD_ID);

      expect(mockExec).toHaveBeenCalledWith(
        "git",
        [
          "worktree",
          "add",
          "-b",
          `pi-sub-${RECORD_ID}`,
          `${MAIN_CWD}/.git/worktrees/pi-sub-${RECORD_ID}`,
          "HEAD",
        ],
        expect.objectContaining({ cwd: MAIN_CWD }),
      );
    });
  });

  describe("cleanup", () => {
    it("调用 git worktree remove + branch -D", () => {
      mockExec.mockReturnValue("");

      const handle = Object.freeze({
        path: `${MAIN_CWD}/.git/worktrees/pi-sub-${RECORD_ID}`,
        branch: `pi-sub-${RECORD_ID}`,
        baseCommit: BASE_COMMIT,
      });

      mgr.cleanup(handle);

      expect(mockExec).toHaveBeenCalledWith(
        "git",
        ["worktree", "remove", "--force", handle.path],
        expect.objectContaining({ cwd: MAIN_CWD }),
      );
      expect(mockExec).toHaveBeenCalledWith(
        "git",
        ["branch", "-D", handle.branch],
        expect.objectContaining({ cwd: MAIN_CWD }),
      );
    });
  });

  describe("collectPatch", () => {
    it("有暂存改动返回 patch 文件", () => {
      const patchContent = "diff --git a/src/index.ts\n+// new line";
      mockExec.mockReturnValue(patchContent);

      const handle = Object.freeze({
        path: `${MAIN_CWD}/.git/worktrees/pi-sub-${RECORD_ID}`,
        branch: `pi-sub-${RECORD_ID}`,
        baseCommit: BASE_COMMIT,
      });

      const result = mgr.collectPatch(handle);

      expect(result.failed).toBe(false);
      expect(result.patchFile).toContain(".patch");
      expect(result.patchFile).toContain(`pi-sub-${RECORD_ID}`);
    });

    it("无改动返回 failed=false", () => {
      mockExec.mockReturnValue("");

      const handle = Object.freeze({
        path: `${MAIN_CWD}/.git/worktrees/pi-sub-${RECORD_ID}`,
        branch: `pi-sub-${RECORD_ID}`,
        baseCommit: BASE_COMMIT,
      });

      const result = mgr.collectPatch(handle);

      expect(result.failed).toBe(false);
    });
  });

  describe("scan", () => {
    it("清理终态且无活 .alive 的孤儿", () => {
      // worktrees 目录存在
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s.endsWith("worktrees")) return true;
        if (s.includes(".finalized")) return true;
        return false;
      });

      mockReaddirSync.mockReturnValue(["pi-sub-orphan1", "other-dir"] as unknown as ReturnType<typeof fs.readdirSync>);

      // session 文件存在
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s.endsWith("worktrees")) return true;
        if (s.includes(".finalized")) return true;
        if (s.includes("orphan1.jsonl")) return true;
        return false;
      });

      // 无 alive marker
      mockReadAliveMarker.mockReturnValue(undefined);

      mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
        if (args?.[0] === "rev-parse" && args?.[1] === "--git-dir") return ".git";
        if (args?.[0] === "worktree") return "";
        if (args?.[0] === "branch") return "";
        return "";
      });

      mgr.scan(MAIN_CWD, AGENT_DIR);

      expect(mockExec).toHaveBeenCalledWith(
        "git",
        ["worktree", "remove", "--force", expect.stringContaining("pi-sub-orphan1")],
        expect.objectContaining({ cwd: MAIN_CWD }),
      );
      expect(mockExec).toHaveBeenCalledWith(
        "git",
        ["branch", "-D", "pi-sub-orphan1"],
        expect.objectContaining({ cwd: MAIN_CWD }),
      );
    });

    it("有活 .alive 不删", () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s.endsWith("worktrees")) return true;
        if (s.includes(".finalized")) return true;
        if (s.includes("orphan1.jsonl")) return true;
        return false;
      });

      mockReaddirSync.mockReturnValue(["pi-sub-orphan1"] as unknown as ReturnType<typeof fs.readdirSync>);

      mockReadAliveMarker.mockReturnValue({
        pid: 12345,
        id: "orphan1",
        startedAt: Date.now(),
      });
      mockIsProcessAlive.mockReturnValue(true);

      mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
        if (args?.[0] === "rev-parse" && args?.[1] === "--git-dir") return ".git";
        return "";
      });

      mgr.scan(MAIN_CWD, AGENT_DIR);

      // 不应调用 worktree remove
      const removeCalls = mockExec.mock.calls.filter(
        (c) => c[1]?.[0] === "worktree" && c[1]?.[1] === "remove",
      );
      expect(removeCalls).toHaveLength(0);
    });
  });
});
