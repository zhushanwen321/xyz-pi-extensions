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
//   - scan 只删终态且无活 .alive 的孤儿（绝不删有活进程的 worktree）
//   - Object.freeze 保证 WorktreeHandle 不可变

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { encodeCwd,getSubagentSessionDir,worktreeMappingFile } from "../core/path-encoding.ts";
import type { PatchResult,WorktreeHandle } from "../types.ts";
import { DirtyWorktreeError } from "../types.ts";
import { bestEffort } from "../utils/best-effort.ts";
import { isProcessAlive,readAliveMarker } from "./execution/alive-store.ts";

// recordId 白名单：字母数字下划线短横线
const SAFE_ID_RE = /^[\w-]+$/;

// 默认 git 命令超时（ms）
const GIT_TIMEOUT_MS = 30_000;

// .alive 软超时（24h）：PID 复用兜底（D-021）
const ALIVE_SOFT_TIMEOUT_MS = 86_400_000; // 24h in ms

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
    // checkout 放 tmpdir，脱离 .git/ 目录结构。
    // 这样 git 自行把元数据注册到 <commonDir>/worktrees/<branch>/，
    // 普通repo（.git/worktrees）与 bare+worktree（.bare/worktrees）都能正确工作。
    // [MF3] 按 encodeCwd(mainCwd) 作用域——消除不同 repo / 不同 session 并发跑 sync
    // fork subagent 时落到同一 /tmp/pi-sub-run-1 的冲突（recordId 是 per-session 自增，无 repo 作用域）。
    const worktreePath = path.join(os.tmpdir(), "pi-subagents", encodeCwd(mainCwd), branch);

    this.gitRun(["worktree", "add", "-b", branch, worktreePath, "HEAD"], {
      cwd: mainCwd,
    });

    // [MF#3] worktree+分支已落盘，后续步骤（symlink）抛错时必须回滚，否则孤儿 reaper
    // 因无 .session 映射永久跳过 → worktree+分支永久泄漏。create 后所有步骤包 try/catch。
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
      // 回滚已创建的 worktree+分支，best-effort 吞清理异常（原始 err 仍外抛）
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
      throw err;
    }
  }

  /**
   * 清理 worktree：git worktree remove --force + git branch -D 成对执行。
   *
   * @param handle 要清理的 worktree handle（含 mainCwd，不靠路径反推）
   */
  cleanup(handle: WorktreeHandle): void {
    this.gitRun(["worktree", "remove", "--force", handle.path], {
      cwd: handle.mainCwd,
    });

    this.gitRun(["branch", "-D", handle.branch], {
      cwd: handle.mainCwd,
    });
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
   * @returns patch 结果（patchFile 路径 + failed 标记）
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
    // --git-common-dir：普通repo 返回 .git，bare+worktree 返回 .bare。
    // 这是 git worktree 元数据注册表的共享根，两种结构都能正确解析。
    const commonDir = this.gitRun(["rev-parse", "--git-common-dir"], { cwd: mainCwd });
    const worktreesRoot = path.resolve(mainCwd, commonDir, "worktrees");

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
      const wtEntryDir = path.join(worktreesRoot, name);
      const recordId = name.slice("pi-sub-".length);
      const sessionFile = this.findSessionFile(agentDir, mainCwd, recordId);
      if (sessionFile === undefined) {
        continue; // 没有 session 文件，可能是主流程创建但还没跑完，不删
      }

      const hasFinalized = fs.existsSync(`${sessionFile}.finalized`);
      const hasCancelled = fs.existsSync(`${sessionFile}.cancelled`);
      if (!hasFinalized && !hasCancelled) {
        continue; // 非终态，不删
      }

      const aliveMarker = readAliveMarker(sessionFile);
      if (aliveMarker !== undefined) {
        const isAlive = isProcessAlive(aliveMarker.pid);
        const isSoftTimeout = Date.now() - aliveMarker.startedAt > ALIVE_SOFT_TIMEOUT_MS;
        if (isAlive && !isSoftTimeout) {
          continue; // 有活进程且未超 24h，绝不删（D-024）
        }
        // PID 复用兜底：超过 24h 即使 pid 活也视为孤儿（D-021）
      }

      // 是孤儿，执行清理
      const branch = `pi-sub-${recordId}`;
      // 从注册表 gitdir 文件读 checkout 路径（gitdir 内容 = <checkout>/.git）。
      // 不能直接用注册表目录 wtEntryDir，那是 git 内部路径，不是 checkout。
      const checkoutPath = this.readCheckoutPath(wtEntryDir);
      if (checkoutPath !== undefined) {
        try {
          this.gitRun(["worktree", "remove", "--force", checkoutPath], { cwd: mainCwd });
        } catch (err) {
          bestEffort(err, "worktree remove (orphan reaper)");
        }
      } else {
        // gitdir 文件缺失（元数据损坏）或 checkout 路径异常：prune 兑底清理残留元数据
        try {
          this.gitRun(["worktree", "prune"], { cwd: mainCwd });
        } catch (err) {
          bestEffort(err, "worktree prune (orphan reaper)");
        }
      }
      try {
        this.gitRun(["branch", "-D", branch], { cwd: mainCwd });
      } catch (err) {
        bestEffort(err, "branch delete (orphan reaper)");
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
   * 从 worktree 注册表条目读 checkout 路径。
   * gitdir 文件内容 = <checkout>/.git，去后缀得 checkout 绝对路径。
   * 返回 undefined 表示元数据损坏或路径异常。
   */
  private readCheckoutPath(wtEntryDir: string): string | undefined {
    const gitdirFile = path.join(wtEntryDir, "gitdir");
    let gitdirContent: string;
    try {
      gitdirContent = fs.readFileSync(gitdirFile, "utf-8").trim();
    } catch {
      return undefined;
    }
    // gitdir = <checkout>/.git
    if (!gitdirContent.endsWith("/.git")) {
      return undefined;
    }
    return gitdirContent.slice(0, -"/.git".length);
  }

  /**
   * 在 agentDir 下查找 recordId 对应的 session 文件。
   *
   * [MF#4] session 文件由 SDK 命名为 <date>-<uuid>.jsonl，recordId 仅存在于文件内部
   * identity entry——旧实现查 <recordId>.jsonl 恒不存在 → reaper 永不清理孤儿 worktree。
   * 改读 session-runner.run() 落盘的 branch→sessionFile 映射 sidecar（<branch>.session）。
   */
  private findSessionFile(agentDir: string, mainCwd: string, recordId: string): string | undefined {
    const sessionsDir = getSubagentSessionDir(agentDir, mainCwd);
    const branch = `pi-sub-${recordId}`;
    const mappingFile = worktreeMappingFile(sessionsDir, branch);
    if (!fs.existsSync(mappingFile)) {
      return undefined;
    }
    try {
      const sessionFile = fs.readFileSync(mappingFile, "utf-8").trim();
      return sessionFile.length > 0 ? sessionFile : undefined;
    } catch {
      return undefined;
    }
  }
}
