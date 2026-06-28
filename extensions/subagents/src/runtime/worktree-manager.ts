// src/runtime/worktree-manager.ts
//
// git worktree 生命周期管理：创建、清理、patch 回传、孤儿 reaper。
//
// 设计约束：
//   - gitRun 是唯一 git 命令出口，统一超时/错误包装
//   - recordId 白名单 `^[\w-]+$` 防止路径注入
//   - clean tree 前置校验防止创建脏 worktree
//   - scan 只删终态且无活 .alive 的孤儿（绝不删有活进程的 worktree）
//   - Object.freeze 保证 WorktreeHandle 不可变

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { PatchResult,WorktreeHandle } from "../types.ts";
import { DirtyWorktreeError } from "../types.ts";
import { isProcessAlive,readAliveMarker } from "./execution/alive-store.ts";

// recordId 白名单：字母数字下划线短横线
const SAFE_ID_RE = /^[\w-]+$/;

// 默认 git 命令超时（ms）
const GIT_TIMEOUT_MS = 30_000;

export class WorktreeManager {
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
    const worktreePath = path.join(mainCwd, ".git", "worktrees", branch);

    this.gitRun(["worktree", "add", "-b", branch, worktreePath, "HEAD"], {
      cwd: mainCwd,
    });

    // 软链 node_modules（复用主仓库依赖）
    const mainNodeModules = path.join(mainCwd, "node_modules");
    const worktreeNodeModules = path.join(worktreePath, "node_modules");
    if (fs.existsSync(mainNodeModules) && !fs.existsSync(worktreeNodeModules)) {
      fs.symlinkSync(mainNodeModules, worktreeNodeModules);
    }

    const handle: WorktreeHandle = Object.freeze({
      path: worktreePath,
      branch,
      baseCommit,
    });

    return handle;
  }

  /**
   * 清理 worktree：git worktree remove --force + git branch -D 成对执行。
   *
   * @param handle 要清理的 worktree handle
   */
  cleanup(handle: WorktreeHandle): void {
    const mainCwd = this.inferMainCwd(handle.path);

    this.gitRun(["worktree", "remove", "--force", handle.path], {
      cwd: mainCwd,
    });

    this.gitRun(["branch", "-D", handle.branch], {
      cwd: mainCwd,
    });
  }

  /**
   * 收集 worktree 的暂存区 patch。
   *
   * @param handle worktree handle
   * @returns patch 结果（patchFile 路径 + failed 标记）
   * @throws Error git diff 失败且无输出时
   */
  collectPatch(handle: WorktreeHandle): PatchResult {
    const patchFile = path.join(handle.path, `.${handle.branch}.patch`);

    const diff = this.gitRun(
      ["diff", "--cached", handle.baseCommit],
      { cwd: handle.path },
    );

    if (diff.length === 0) {
      return Object.freeze({ patchFile, failed: false });
    }

    try {
      fs.writeFileSync(patchFile, diff, "utf-8");
      return Object.freeze({ patchFile, failed: false });
    } catch {
      return Object.freeze({ patchFile, failed: true });
    }
  }

  /**
   * 扫描并清理 pi-sub-* 孤儿 worktree。
   *
   * 孤儿判据：终态标记（.finalized / .cancelled）且无活 .alive marker。
   * 绝不删有活 .alive 的 worktree（D-024）。
   *
   * @param mainCwd 主仓库根目录
   * @param agentDir agent 目录（session 文件所在）
   */
  scan(mainCwd: string, agentDir: string): void {
    const gitDir = this.gitRun(["rev-parse", "--git-dir"], { cwd: mainCwd });
    const worktreesRoot = path.resolve(mainCwd, gitDir, "worktrees");

    if (!fs.existsSync(worktreesRoot)) {
      return;
    }

    let entries: string[];
    try {
      entries = fs.readdirSync(worktreesRoot).filter((name) => name.startsWith("pi-sub-"));
    } catch {
      return;
    }

    for (const name of entries) {
      const wtPath = path.join(worktreesRoot, name);
      const recordId = name.slice("pi-sub-".length);
      const sessionFile = this.findSessionFile(agentDir, recordId);
      if (sessionFile === undefined) {
        continue; // 没有 session 文件，可能是主流程创建但还没跑完，不删
      }

      const hasFinalized = fs.existsSync(`${sessionFile}.finalized`);
      const hasCancelled = fs.existsSync(`${sessionFile}.cancelled`);
      if (!hasFinalized && !hasCancelled) {
        continue; // 非终态，不删
      }

      const aliveMarker = readAliveMarker(sessionFile);
      if (aliveMarker !== undefined && isProcessAlive(aliveMarker.pid)) {
        continue; // 有活进程，绝不删（D-024）
      }

      // 是孤儿，执行清理
      const branch = `pi-sub-${recordId}`;
      try {
        this.gitRun(["worktree", "remove", "--force", wtPath], { cwd: mainCwd });
      } catch {
        // best-effort：worktree remove 失败不阻断
      }
      try {
        this.gitRun(["branch", "-D", branch], { cwd: mainCwd });
      } catch {
        // best-effort：branch delete 失败不阻断
      }
    }
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

  /**
   * 从 worktree path 推断主仓库路径。
   * .git/worktrees/<branch> 的 parent.parent 是主仓库的 .git 目录的 parent。
   */
  private inferMainCwd(worktreePath: string): string {
    // worktreePath = <mainCwd>/.git/worktrees/<branch>
    // 需要往上走 3 层
    return path.resolve(worktreePath, "..", "..", "..");
  }

  /**
   * 在 agentDir 下查找 recordId 对应的 session 文件。
   * 匹配 `<id>.jsonl` 模式。
   */
  private findSessionFile(agentDir: string, recordId: string): string | undefined {
    const candidate = path.join(agentDir, `${recordId}.jsonl`);
    return fs.existsSync(candidate) ? candidate : undefined;
  }
}
