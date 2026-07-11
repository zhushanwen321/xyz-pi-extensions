// src/runtime/worktree-manager.ts
//
// git worktree 生命周期管理：创建、清理、patch 回传、孤儿 reaper。
//
// 设计约束：
//   - gitRun 是唯一 git 命令出口，统一超时/错误包装
//   - recordId 白名单 `^[\w-]+$` 防止路径注入
//   - clean tree 前置校验防止创建脏 worktree
//   - checkout 放 os.tmpdir()（脱离 .git/），兼容普通 repo 与 bare+worktree 结构
//   - mainCwd 存入 handle，不靠路径反推
//   - scan 遍历全局注册表按 pid 死活判孤儿（绝不删有活进程的 worktree）
//   - Object.freeze 保证 WorktreeHandle 不可变
//
// [全局注册表重构] scan 不再依赖当前 cwd 是否 git repo，改为遍历
// WorktreeRegistry（<agentDir>/subagents/worktrees.json）。判据从终态 marker
// 状态机降为 pid 死活一条——进程崩溃无人写终态时也能正确回收。

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { encodeCwd } from "./path-encoding.ts";
import type { PatchResult,WorktreeHandle } from "./types.ts";
import { DirtyWorktreeError } from "./types.ts";
import { bestEffort } from "./best-effort.ts";
import { isProcessAlive } from "./alive-store.ts";
import { SPAWN_GRACE_MS,type WorktreeEntry,WorktreeRegistry } from "./worktree-registry.ts";

// recordId 白名单：字母数字下划线短横线
const SAFE_ID_RE = /^[\w-]+$/;

// 默认 git 命令超时（ms）
const GIT_TIMEOUT_MS = 30_000;

export class WorktreeManager {
  // 全局注册表：跨 repo 记录所有活 worktree，reaper 遍历此表判孤儿。
  private readonly registry: WorktreeRegistry;

  constructor(agentDir: string) {
    this.registry = new WorktreeRegistry(agentDir);
  }

  /**
   * 为子 agent 创建隔离 worktree。
   *
   * @param mainCwd 主仓库根目录
   * @param recordId 执行记录 ID（必须匹配 `^[\w-]+$`）
   * @returns 冻结的 WorktreeHandle
   */
  create(mainCwd: string, recordId: string): WorktreeHandle {
    if (!SAFE_ID_RE.test(recordId)) {
      throw new DirtyWorktreeError(
        `recordId contains unsafe characters: "${recordId}" (must match ^[\\w-]+$)`,
      );
    }

    this.assertCleanTree(mainCwd);

    const baseCommit = this.gitRun(["rev-parse", "HEAD"], { cwd: mainCwd });
    const branch = `pi-sub-${recordId}`;
    // checkout 放 tmpdir，脱离 .git/ 目录结构。
    // 这样 git 自行把元数据注册到 <commonDir>/worktrees/<branch>/，
    // 普通repo（.git/worktrees）与 bare+worktree（.bare/worktrees）都能正确工作。
    // [MF3] 按 encodeCwd(mainCwd) 作用域——消除不同 repo / 不同 session 并发跑 sync
    // fork subagent 时落到同一 /tmp/pi-sub-run-1 的冲突（recordId 是 per-session 自增，无 repo 作用域）。
    const worktreePath = path.join(os.tmpdir(), "pi-subagents", encodeCwd(mainCwd), branch);

    // 前置清理残留 checkout 目录：上次 create 的 MF#3 回滚可能因目录非空未删干净 tmpdir，
    // 或跨进程竞态。路径在 tmpdir/pi-subagents/<enc>/<branch> 下，按设计只有本扩展创建，清理安全。
    if (fs.existsSync(worktreePath)) {
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch (cleanErr) {
        bestEffort(cleanErr, "pre-create checkout cleanup");
      }
    }

    this.gitRun(["worktree", "add", "-b", branch, worktreePath, "HEAD"], {
      cwd: mainCwd,
    });

    // 注册到全局表（pid=0 占位）。session-runner first header 时补 pid。
    // 放在 worktree add 成功后、symlink 前——确保只有真正创建了 worktree 才登记。
    this.registry.add({
      repo: mainCwd,
      branch,
      checkout: worktreePath,
      pid: 0,
      createdAt: Date.now(),
    });

    // [MF#3] worktree+分支+注册表条目已落盘，后续步骤（symlink）抛错时必须全部回滚，
    // 否则 worktree+分支永久泄漏。create 后所有步骤包 try/catch。
    try {
      // 软链 node_modules（复用主仓库依赖）
      const mainNodeModules = path.join(mainCwd, "node_modules");
      const worktreeNodeModules = path.join(worktreePath, "node_modules");
      if (fs.existsSync(mainNodeModules) && !fs.existsSync(worktreeNodeModules)) {
        fs.symlinkSync(mainNodeModules, worktreeNodeModules);
      }

      return Object.freeze({
        path: worktreePath,
        branch,
        baseCommit,
        mainCwd,
      });
    } catch (err) {
      // 回滚已创建的 worktree+分支+注册表条目，best-effort 吞清理异常（原始 err 仍外抛）
      try {
        this.gitRun(["worktree", "remove", "--force", worktreePath], { cwd: mainCwd });
      } catch (cleanErr) {
        bestEffort(cleanErr, "worktree remove (create rollback MF#3)");
      }
      try {
        this.gitRun(["branch", "-D", branch], { cwd: mainCwd });
      } catch (cleanErr) {
        bestEffort(cleanErr, "branch delete (create rollback MF#3)");
      }
      this.registry.remove(branch);
      throw err;
    }
  }

  /**
   * 注册子进程 pid（session-runner first header 时调）。
   * create 时 pid 未知写 0 占位，子进程 spawn 拿到 pid 后由此补全。
   * reaper 据 pid 死活判孤儿，pid=0 条目用 SPAWN_GRACE 宽限。
   */
  registerPid(branch: string, pid: number): void {
    this.registry.updatePid(branch, pid);
  }

  /**
   * 清理 worktree：git worktree remove --force + git branch -D + 注册表移除。
   * 三步各自独立 try/catch——任一步失败不阻断其余（如 remove 失败仍尝试 branch -D + 注册表移除），
   * 避免单步失败导致后续资源泄漏。
   *
   * @param handle 要清理的 worktree handle（含 mainCwd，不靠路径反推）
   */
  cleanup(handle: WorktreeHandle): void {
    try {
      this.gitRun(["worktree", "remove", "--force", handle.path], {
        cwd: handle.mainCwd,
      });
    } catch (err) {
      bestEffort(err, "worktree remove (cleanup)");
    }

    try {
      this.gitRun(["branch", "-D", handle.branch], {
        cwd: handle.mainCwd,
      });
    } catch (err) {
      bestEffort(err, "branch delete (cleanup)");
    }

    this.registry.remove(handle.branch);
  }

  /**
   * 收集 worktree 的改动为 patch。
   *
   * [MF#3] patchFile 由调用方指定（写在 worktree 之外，避免被 cleanup 删除）。
   * [MF#2] 先 git add -A 暂存全部改动（含未跟踪新文件），再 git diff --cached baseCommit
   * 对比暂存区与 base commit。旧实现 `git diff HEAD baseCommit` 是树 vs 树对比：
   * worktree HEAD 初始即 baseCommit，子 agent 不提交时 HEAD 仍 == baseCommit → diff 恒空 → 改动丢失。
   *
   * @param handle worktree handle
   * @param patchFile patch 输出路径（须在 worktree 之外）
   * @returns patch 结果（patchFile 路径 + failed/written 标记）。
   *   written=true 仅当 diff 非空且写盘成功；空 diff 或写失败均 written=false，
   *   调用方据此回填 record.patchFile，避免悬空路径（`git apply` 不存在的文件）。
   */
  collectPatch(handle: WorktreeHandle, patchFile: string): PatchResult {
    // git add -A：暂存全部改动（含未跟踪新文件），使后续 --cached diff 能捕获新建文件
    try {
      this.gitRun(["add", "-A"], { cwd: handle.path });
    } catch (err) {
      // add 失败不致命：继续尝试 diff，最差得到部分 diff（仅已跟踪文件的改动）
      bestEffort(err, "git add -A (collectPatch)");
    }
    const diff = this.gitRun(
      ["diff", "--cached", handle.baseCommit],
      { cwd: handle.path },
    );

    if (diff.length === 0) {
      // 无改动：不写文件，written=false（与有改动写成功区分）
      return Object.freeze({ patchFile, failed: false, written: false });
    }

    try {
      fs.writeFileSync(patchFile, diff, "utf-8");
      return Object.freeze({ patchFile, failed: false, written: true });
    } catch {
      return Object.freeze({ patchFile, failed: true, written: false });
    }
  }

  /**
   * 扫描并清理 pi-sub-* 孤儿 worktree。
   *
   * 遍历全局注册表（<agentDir>/subagents/worktrees.json），按 pid 死活判孤儿。
   * 不依赖当前 cwd 是否 git repo——注册表里记了 repo 路径，直接 git -C <repo> 跨 repo 清理。
   *
   * 判据（唯一不删条件 = 进程还活着）：
   *   pid > 0 且 isProcessAlive(pid)   → 跳过（活进程，绝不删）
   *   pid > 0 且进程已死                → 孤儿（正常退出未 cleanup / 崩溃残留）
   *   pid == 0 且超 SPAWN_GRACE_MS      → 孤儿（create 后崩溃，pid 永未补全）
   *   pid == 0 且未超宽限               → 跳过（可能正在 spawn）
   */
  scan(): void {
    const entries = this.registry.load();
    const now = Date.now();

    for (const entry of entries) {
      if (!this.isOrphan(entry, now)) {
        continue;
      }
      this.cleanupOrphan(entry);
    }
  }

  /** pid 死活判孤儿。pid=0 走 SPAWN_GRACE 宽限。 */
  private isOrphan(entry: WorktreeEntry, now: number): boolean {
    if (entry.pid === 0) {
      // create→spawn 窗口：超过宽限期仍未补 pid = create 后崩溃
      return now - entry.createdAt > SPAWN_GRACE_MS;
    }
    return !isProcessAlive(entry.pid);
  }

  /** 清理单个孤儿条目：worktree remove + branch -D + 注册表移除，三步各自 best-effort。 */
  private cleanupOrphan(entry: WorktreeEntry): void {
    try {
      this.gitRun(["worktree", "remove", "--force", entry.checkout], { cwd: entry.repo });
    } catch (err) {
      bestEffort(err, "worktree remove (orphan reaper)");
    }
    try {
      this.gitRun(["branch", "-D", entry.branch], { cwd: entry.repo });
    } catch (err) {
      bestEffort(err, "branch delete (orphan reaper)");
    }
    this.registry.remove(entry.branch);
  }

  // ============================================================
  // 内部工具
  // ============================================================

  /**
   * git 命令执行器。统一超时 + 错误包装。
   */
  private gitRun(args: string[], opts: { cwd: string; timeout?: number }): string {
    try {
      return execFileSync("git", args, {
        cwd: opts.cwd,
        timeout: opts.timeout ?? GIT_TIMEOUT_MS,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch (err: unknown) {
      if (err instanceof Error) {
        throw new Error(`git ${args[0]} failed: ${err.message}`);
      }
      throw new Error(`git ${args[0]} failed: unknown error`);
    }
  }

  /**
   * 校验工作目录是 clean tree。
   */
  private assertCleanTree(cwd: string): void {
    const status = this.gitRun(["status", "--porcelain"], { cwd });
    if (status.length > 0) {
      throw new DirtyWorktreeError(
        `Working tree is dirty in ${cwd}:\n${status}`,
      );
    }
  }

}
