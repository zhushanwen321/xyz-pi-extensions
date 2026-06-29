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
import * as os from "node:os";
import * as path from "node:path";

import { isProcessAlive,readAliveMarker } from "../runtime/execution/alive-store.ts";
import { WorktreeManager } from "../runtime/worktree-manager.ts";

const mockExec = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockReadAliveMarker = vi.mocked(readAliveMarker);
const mockIsProcessAlive = vi.mocked(isProcessAlive);

const MAIN_CWD = "/home/user/project";
const AGENT_DIR = "/home/user/.pi/agent/subagents";
const RECORD_ID = "bg-42-abc";
const BASE_COMMIT = "abc123def456";
// scan 测试：孤儿 worktree 的 checkout 路径（tmpdir 下）
const ORPHAN_CHECKOUT = path.join(os.tmpdir(), "pi-sub-orphan1");

/** create 路径期望（os.tmpdir 下） */
function expectedCreatePath(recordId: string): string {
  return path.join(os.tmpdir(), `pi-sub-${recordId}`);
}

/** 构造完整 handle（含 mainCwd，供 cleanup/collectPatch 测试用） */
function makeHandle(checkoutPath: string = expectedCreatePath(RECORD_ID)) {
  return Object.freeze({
    path: checkoutPath,
    branch: `pi-sub-${RECORD_ID}`,
    baseCommit: BASE_COMMIT,
    mainCwd: MAIN_CWD,
  });
}

function setupCleanTree(): void {
  // git status --porcelain → clean
  mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
    if (args?.[0] === "status") return "";
    if (args?.[0] === "rev-parse" && args?.[1] === "HEAD") return BASE_COMMIT;
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

/** scan 公共 mock：rev-parse --git-common-dir 返回相对 .git */
function setupScanGitCommonDir(): void {
  mockExec.mockImplementation((cmd: string, args?: readonly string[]) => {
    if (args?.[0] === "rev-parse" && args?.[1] === "--git-common-dir") return ".git";
    if (args?.[0] === "worktree") return "";
    if (args?.[0] === "branch") return "";
    return "";
  });
}

/** scan 公共 mock：readFileSync 读 gitdir 文件返回 <checkout>/.git */
function setupScanGitdir(checkout: string): void {
  mockReadFileSync.mockImplementation((p: unknown) => {
    const s = String(p);
    if (s.includes("gitdir")) return `${checkout}/.git`;
    return "";
  });
}

describe("WorktreeManager", () => {
  let mgr: WorktreeManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mgr = new WorktreeManager();
  });

  describe("create", () => {
    it("正常流程返回冻结 handle（path 在 tmpdir，含 mainCwd）", () => {
      setupCleanTree();

      const handle = mgr.create(MAIN_CWD, RECORD_ID);

      expect(handle.path).toBe(expectedCreatePath(RECORD_ID));
      expect(handle.branch).toBe(`pi-sub-${RECORD_ID}`);
      expect(handle.baseCommit).toBe(BASE_COMMIT);
      expect(handle.mainCwd).toBe(MAIN_CWD);
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

    it("recordId 空字符串抛 DirtyWorktreeError", () => {
      expect(() => mgr.create(MAIN_CWD, "")).toThrow(DirtyWorktreeError);
    });

    it("recordId 单字符合法", () => {
      setupCleanTree();
      const handle = mgr.create(MAIN_CWD, "a");
      expect(handle.branch).toBe("pi-sub-a");
    });

    it("recordId 连续短横线合法", () => {
      setupCleanTree();
      const handle = mgr.create(MAIN_CWD, "--test--");
      expect(handle.branch).toBe("pi-sub---test--");
    });

    it("recordId 包含分号抛 DirtyWorktreeError", () => {
      expect(() => mgr.create(MAIN_CWD, "a;b")).toThrow(DirtyWorktreeError);
    });

    it("recordId 包含反引号抛 DirtyWorktreeError", () => {
      expect(() => mgr.create(MAIN_CWD, "`cmd`")).toThrow(DirtyWorktreeError);
    });

    it("调用 git worktree add 正确参数（目标路径在 tmpdir）", () => {
      setupCleanTree();

      mgr.create(MAIN_CWD, RECORD_ID);

      expect(mockExec).toHaveBeenCalledWith(
        "git",
        [
          "worktree",
          "add",
          "-b",
          `pi-sub-${RECORD_ID}`,
          expectedCreatePath(RECORD_ID),
          "HEAD",
        ],
        expect.objectContaining({ cwd: MAIN_CWD }),
      );
    });
  });

  describe("cleanup", () => {
    it("调用 git worktree remove + branch -D（cwd 用 handle.mainCwd）", () => {
      mockExec.mockReturnValue("");

      const handle = makeHandle();

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

      const handle = makeHandle();

      const result = mgr.collectPatch(handle);

      expect(result.failed).toBe(false);
      expect(result.patchFile).toContain(".patch");
      expect(result.patchFile).toContain(`pi-sub-${RECORD_ID}`);
    });

    it("无改动返回 failed=false", () => {
      mockExec.mockReturnValue("");

      const handle = makeHandle();

      const result = mgr.collectPatch(handle);

      expect(result.failed).toBe(false);
    });
  });

  describe("scan", () => {
    it("清理终态且无活 .alive 的孤儿（remove 传 checkout 路径）", () => {
      // worktrees 目录、.finalized、session 文件存在
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s.endsWith("worktrees")) return true;
        if (s.includes(".finalized")) return true;
        if (s.includes("orphan1.jsonl")) return true;
        return false;
      });

      mockReaddirSync.mockReturnValue(["pi-sub-orphan1", "other-dir"] as ReturnType<typeof fs.readdirSync>);

      // 无 alive marker
      mockReadAliveMarker.mockReturnValue(undefined);

      setupScanGitCommonDir();
      setupScanGitdir(ORPHAN_CHECKOUT);

      mgr.scan(MAIN_CWD, AGENT_DIR);

      // remove 传的是 checkout 路径（tmpdir 下），不是注册表目录
      expect(mockExec).toHaveBeenCalledWith(
        "git",
        ["worktree", "remove", "--force", ORPHAN_CHECKOUT],
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

      mockReaddirSync.mockReturnValue(["pi-sub-orphan1"] as ReturnType<typeof fs.readdirSync>);

      mockReadAliveMarker.mockReturnValue({
        pid: 12345,
        id: "orphan1",
        startedAt: Date.now(),
      });
      mockIsProcessAlive.mockReturnValue(true);

      setupScanGitCommonDir();

      mgr.scan(MAIN_CWD, AGENT_DIR);

      // 不应调用 worktree remove
      const removeCalls = mockExec.mock.calls.filter(
        (c) => c[1]?.[0] === "worktree" && c[1]?.[1] === "remove",
      );
      expect(removeCalls).toHaveLength(0);
    });

    it(".alive 超过 24h 软超时即使 pid 活也清理", () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s.endsWith("worktrees")) return true;
        if (s.includes(".finalized")) return true;
        if (s.includes("orphan1.jsonl")) return true;
        return false;
      });

      mockReaddirSync.mockReturnValue(["pi-sub-orphan1"] as ReturnType<typeof fs.readdirSync>);

      // .alive 超过 24h
      const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;
      mockReadAliveMarker.mockReturnValue({
        pid: 12345,
        id: "orphan1",
        startedAt: twentyFiveHoursAgo,
      });
      mockIsProcessAlive.mockReturnValue(true); // pid 仍然活

      setupScanGitCommonDir();
      setupScanGitdir(ORPHAN_CHECKOUT);

      mgr.scan(MAIN_CWD, AGENT_DIR);

      // 应调用 worktree remove（超过 24h 软超时）
      expect(mockExec).toHaveBeenCalledWith(
        "git",
        ["worktree", "remove", "--force", ORPHAN_CHECKOUT],
        expect.objectContaining({ cwd: MAIN_CWD }),
      );
    });

    it("gitdir 文件缺失时降级 worktree prune", () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s.endsWith("worktrees")) return true;
        if (s.includes(".finalized")) return true;
        if (s.includes("orphan1.jsonl")) return true;
        return false;
      });

      mockReaddirSync.mockReturnValue(["pi-sub-orphan1"] as ReturnType<typeof fs.readdirSync>);
      mockReadAliveMarker.mockReturnValue(undefined);

      setupScanGitCommonDir();
      // readFileSync 抛错（gitdir 元数据损坏）→ readCheckoutPath 返回 undefined → prune 兜底
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      mgr.scan(MAIN_CWD, AGENT_DIR);

      expect(mockExec).toHaveBeenCalledWith(
        "git",
        ["worktree", "prune"],
        expect.objectContaining({ cwd: MAIN_CWD }),
      );
    });

    it("readdirSync 抛错时静默返回", () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        return String(p).endsWith("worktrees");
      });

      mockReaddirSync.mockImplementation(() => {
        throw new Error("permission denied");
      });

      setupScanGitCommonDir();

      // 不应抛错
      expect(() => mgr.scan(MAIN_CWD, AGENT_DIR)).not.toThrow();
    });

    it("worktreesRoot 不存在时静默返回", () => {
      mockExistsSync.mockReturnValue(false);

      setupScanGitCommonDir();

      // 不应抛错，不应调用 readdirSync
      expect(() => mgr.scan(MAIN_CWD, AGENT_DIR)).not.toThrow();
      expect(mockReaddirSync).not.toHaveBeenCalled();
    });
  });
});
