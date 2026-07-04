// src/__tests__/worktree-manager.test.ts
//
// WorktreeManager 单元测试。
// mock execFileSync（git 命令）+ WorktreeRegistry（注册表）+ alive-store（进程探活）。
//
// [全局注册表重构] scan 不再读 sidecar / 不再依赖 cwd 是否 git repo。
// 判据从「终态 marker 状态机」改为「pid 死活」。
// 测试重点覆盖原方案缺失的崩溃残留场景（P0）。

import { beforeEach, describe, expect, it, vi } from "vitest";

import { DirtyWorktreeError } from "../types.ts";

// ── mock modules ──

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(),
    rmSync: vi.fn(),
    symlinkSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
  existsSync: vi.fn(),
  rmSync: vi.fn(),
  symlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("../runtime/execution/alive-store.ts", () => ({
  isProcessAlive: vi.fn(),
}));

// WorktreeRegistry mock：内存数组模拟，add/updatePid/remove/load 全部可追踪
const { mockLoad, mockAdd, mockUpdatePid, mockRemove, registryEntries } = vi.hoisted(() => {
  type Entry = { repo: string; branch: string; checkout: string; pid: number; createdAt: number };
  const entries: Entry[] = [];
  return {
    registryEntries: entries,
    mockLoad: vi.fn((): Entry[] => entries.slice()),
    mockAdd: vi.fn((e: Entry): void => {
      const idx = entries.findIndex((x) => x.branch === e.branch);
      if (idx >= 0) entries[idx] = e;
      else entries.push(e);
    }),
    mockUpdatePid: vi.fn((branch: string, pid: number): void => {
      const e = entries.find((x) => x.branch === branch);
      if (e) e.pid = pid;
    }),
    mockRemove: vi.fn((branch: string): void => {
      const idx = entries.findIndex((x) => x.branch === branch);
      if (idx >= 0) entries.splice(idx, 1);
    }),
  };
});

vi.mock("../runtime/worktree-registry.ts", () => ({
  WorktreeRegistry: class {
    add = mockAdd;
    updatePid = mockUpdatePid;
    remove = mockRemove;
    load = mockLoad;
  },
  SPAWN_GRACE_MS: 60_000,
}));

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { encodeCwd } from "../core/path-encoding.ts";
import { isProcessAlive } from "../runtime/execution/alive-store.ts";
import { WorktreeManager } from "../runtime/worktree-manager.ts";

const mockExec = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockIsProcessAlive = vi.mocked(isProcessAlive);

const MAIN_CWD = "/home/user/project";
const AGENT_DIR = "/home/user/.pi/agent";
const RECORD_ID = "bg-42-abc";
const BASE_COMMIT = "abc123def456";

/** create 路径期望（tmpdir/pi-subagents/<enc(mainCwd)> 下） */
function expectedCreatePath(recordId: string): string {
  return path.join(os.tmpdir(), "pi-subagents", encodeCwd(MAIN_CWD), `pi-sub-${recordId}`);
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
  mockExec.mockImplementation((_cmd: string, args?: readonly string[]) => {
    if (args?.[0] === "status") return "";
    if (args?.[0] === "rev-parse" && args?.[1] === "HEAD") return BASE_COMMIT;
    if (args?.[0] === "worktree") return "";
    if (args?.[0] === "branch") return "";
    return "";
  });
  // worktreePath 不存在（无需前置清理）；node_modules 存在
  mockExistsSync.mockImplementation((p: unknown) => {
    const s = String(p);
    if (s.includes("pi-sub-")) return false; // checkout 目录不存在
    if (s.includes("node_modules")) return true;
    return false;
  });
}

/** 向注册表注入一条活条目（模拟 create 后的状态）。 */
function injectEntry(overrides: Partial<{ branch: string; pid: number; checkout: string; repo: string; createdAt: number }> = {}): void {
  registryEntries.push({
    repo: overrides.repo ?? MAIN_CWD,
    branch: overrides.branch ?? "pi-sub-orphan1",
    checkout: overrides.checkout ?? path.join(os.tmpdir(), "pi-sub-orphan1"),
    pid: overrides.pid ?? 0,
    createdAt: overrides.createdAt ?? Date.now(),
  });
}

describe("WorktreeManager", () => {
  let mgr: WorktreeManager;

  beforeEach(() => {
    vi.clearAllMocks();
    registryEntries.length = 0;
    mgr = new WorktreeManager(AGENT_DIR);
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

    it("成功后写入注册表（pid=0 占位）", () => {
      setupCleanTree();

      mgr.create(MAIN_CWD, RECORD_ID);

      expect(mockAdd).toHaveBeenCalledTimes(1);
      const entry = mockAdd.mock.calls[0][0] as { repo: string; branch: string; pid: number };
      expect(entry.repo).toBe(MAIN_CWD);
      expect(entry.branch).toBe(`pi-sub-${RECORD_ID}`);
      expect(entry.pid).toBe(0);
    });

    it("脏树抛 DirtyWorktreeError 且不写注册表", () => {
      mockExec.mockImplementation((_cmd: string, args?: readonly string[]) => {
        if (args?.[0] === "status") return "M src/index.ts\n";
        return "";
      });

      expect(() => mgr.create(MAIN_CWD, RECORD_ID)).toThrow(DirtyWorktreeError);
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it("recordId 含特殊字符抛 DirtyWorktreeError", () => {
      expect(() => mgr.create(MAIN_CWD, "../evil-path")).toThrow(DirtyWorktreeError);
      expect(() => mgr.create(MAIN_CWD, "hello world")).toThrow(DirtyWorktreeError);
      expect(() => mgr.create(MAIN_CWD, "")).toThrow(DirtyWorktreeError);
      expect(() => mgr.create(MAIN_CWD, "a;b")).toThrow(DirtyWorktreeError);
    });

    it("recordId 单字符 / 连续短横线合法", () => {
      setupCleanTree();
      expect(mgr.create(MAIN_CWD, "a").branch).toBe("pi-sub-a");
      expect(mgr.create(MAIN_CWD, "--test--").branch).toBe("pi-sub---test--");
    });

    it("残留 checkout 目录存在时前置清理（fs.rmSync）", () => {
      setupCleanTree();
      // worktreePath 已存在 → 触发前置 rmSync
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s.includes("pi-sub-bg-42-abc")) return true; // checkout 残留
        if (s.includes("node_modules")) return true;
        return false;
      });

      mgr.create(MAIN_CWD, RECORD_ID);

      expect(fs.rmSync).toHaveBeenCalledWith(
        expectedCreatePath(RECORD_ID),
        { recursive: true, force: true },
      );
    });

    it("symlink 失败时回滚 worktree + 分支 + 注册表", () => {
      setupCleanTree();
      // symlink 抛错触发 MF#3 回滚
      vi.mocked(fs.symlinkSync).mockImplementation(() => {
        throw new Error("symlink permission denied");
      });

      expect(() => mgr.create(MAIN_CWD, RECORD_ID)).toThrow("symlink permission denied");

      // 回滚：worktree remove + branch delete + registry remove
      expect(mockExec).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["worktree", "remove", "--force"]),
        expect.anything(),
      );
      expect(mockExec).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["branch", "-D"]),
        expect.anything(),
      );
      expect(mockRemove).toHaveBeenCalledWith(`pi-sub-${RECORD_ID}`);
    });
  });

  describe("registerPid", () => {
    it("委托 registry.updatePid", () => {
      mgr.registerPid("pi-sub-bg-1", 12345);
      expect(mockUpdatePid).toHaveBeenCalledWith("pi-sub-bg-1", 12345);
    });
  });

  describe("cleanup", () => {
    it("worktree remove + branch -D + 注册表移除（cwd 用 handle.mainCwd）", () => {
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
      expect(mockRemove).toHaveBeenCalledWith(handle.branch);
    });

    it("worktree remove 失败时 branch -D + 注册表移除仍执行（best-effort 分离）", () => {
      // 第一条 git（worktree remove）抛错，第二条（branch -D）应仍执行
      let callCount = 0;
      mockExec.mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error("worktree locked");
        return "";
      });
      const handle = makeHandle();

      // 不应抛错
      expect(() => mgr.cleanup(handle)).not.toThrow();

      // branch -D 仍被调用
      expect(mockExec).toHaveBeenCalledWith(
        "git",
        ["branch", "-D", handle.branch],
        expect.anything(),
      );
      // 注册表仍被移除
      expect(mockRemove).toHaveBeenCalledWith(handle.branch);
    });
  });

  describe("collectPatch", () => {
    it("有改动返回 patch 文件", () => {
      mockExec.mockReturnValue("diff --git a/src\n+// new");

      const handle = makeHandle();
      const patchFile = path.join(os.tmpdir(), `outside-${RECORD_ID}.patch`);

      const result = mgr.collectPatch(handle, patchFile);

      expect(result.failed).toBe(false);
      expect(result.written).toBe(true);
      expect(mockExec).toHaveBeenCalledWith("git", ["add", "-A"], expect.anything());
      expect(mockExec).toHaveBeenCalledWith(
        "git",
        ["diff", "--cached", BASE_COMMIT],
        expect.anything(),
      );
    });

    it("无改动返回 failed=false, written=false（不写文件）", () => {
      mockExec.mockReturnValue("");
      const result = mgr.collectPatch(makeHandle(), "/tmp/x.patch");
      expect(result.failed).toBe(false);
      expect(result.written).toBe(false);
    });
  });

  // ============================================================
  // scan：全局注册表 + pid 死活判据（核心重构）
  // ============================================================
  describe("scan", () => {
    it("pid 已死的条目被清理（正常退出未 cleanup / 崩溃残留）", () => {
      injectEntry({ branch: "pi-sub-dead", pid: 11111 });
      mockIsProcessAlive.mockReturnValue(false); // pid 死

      mgr.scan();

      expect(mockExec).toHaveBeenCalledWith(
        "git",
        ["worktree", "remove", "--force", expect.any(String)],
        expect.objectContaining({ cwd: MAIN_CWD }),
      );
      expect(mockExec).toHaveBeenCalledWith(
        "git",
        ["branch", "-D", "pi-sub-dead"],
        expect.objectContaining({ cwd: MAIN_CWD }),
      );
      expect(mockRemove).toHaveBeenCalledWith("pi-sub-dead");
    });

    it("pid 活的条目不删（绝不删活进程）", () => {
      injectEntry({ branch: "pi-sub-alive", pid: 22222 });
      mockIsProcessAlive.mockReturnValue(true); // pid 活

      mgr.scan();

      const removeCalls = mockExec.mock.calls.filter(
        (c) => c[1]?.[0] === "worktree" && c[1]?.[1] === "remove",
      );
      expect(removeCalls).toHaveLength(0);
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it("崩溃残留：无终态 + pid 死 → 清理（原 P0 缺陷场景）", () => {
      // 这是原 reaper 永远泄漏的场景：进程崩溃无人写终态 marker
      injectEntry({ branch: "pi-sub-crash", pid: 33333 });
      mockIsProcessAlive.mockReturnValue(false); // 崩溃后进程已死

      mgr.scan();

      expect(mockExec).toHaveBeenCalledWith(
        "git",
        ["branch", "-D", "pi-sub-crash"],
        expect.anything(),
      );
      expect(mockRemove).toHaveBeenCalledWith("pi-sub-crash");
    });

    it("pid=0 + 未超 SPAWN_GRACE → 跳过（可能正在 spawn）", () => {
      injectEntry({ branch: "pi-sub-spawning", pid: 0, createdAt: Date.now() });

      mgr.scan();

      const removeCalls = mockExec.mock.calls.filter(
        (c) => c[1]?.[0] === "worktree" && c[1]?.[1] === "remove",
      );
      expect(removeCalls).toHaveLength(0);
    });

    it("pid=0 + 超 SPAWN_GRACE → 清理（create 后崩溃）", () => {
      const sixtyOneMinAgo = Date.now() - 61 * 60 * 1000;
      injectEntry({ branch: "pi-sub-spawn-crash", pid: 0, createdAt: sixtyOneMinAgo });

      mgr.scan();

      expect(mockExec).toHaveBeenCalledWith(
        "git",
        ["branch", "-D", "pi-sub-spawn-crash"],
        expect.anything(),
      );
      expect(mockRemove).toHaveBeenCalledWith("pi-sub-spawn-crash");
    });

    it("跨 repo 清理：条目 repo 字段作为 git -C 目标", () => {
      const OTHER_REPO = "/home/user/other-repo";
      injectEntry({ branch: "pi-sub-cross", pid: 44444, repo: OTHER_REPO });
      mockIsProcessAlive.mockReturnValue(false);

      mgr.scan();

      // git 命令的 cwd 应为 OTHER_REPO，非 MAIN_CWD
      expect(mockExec).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["branch", "-D", "pi-sub-cross"]),
        expect.objectContaining({ cwd: OTHER_REPO }),
      );
    });

    it("空注册表时无操作", () => {
      // registryEntries 已在 beforeEach 清空
      mgr.scan();
      expect(mockExec).not.toHaveBeenCalled();
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it("worktree remove 失败时 branch -D + 注册表移除仍执行（best-effort）", () => {
      injectEntry({ branch: "pi-sub-stubborn", pid: 55555 });
      mockIsProcessAlive.mockReturnValue(false);
      mockExec.mockImplementation(() => {
        throw new Error("worktree locked");
      });

      mgr.scan();

      // branch -D 仍被调用（两次 git 调用各自独立）
      const branchDeleteCalls = mockExec.mock.calls.filter(
        (c) => c[1]?.[0] === "branch" && c[1]?.[1] === "-D",
      );
      expect(branchDeleteCalls).toHaveLength(1);
      expect(mockRemove).toHaveBeenCalledWith("pi-sub-stubborn");
    });
  });
});
