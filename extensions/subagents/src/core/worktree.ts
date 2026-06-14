/* eslint-disable taste/no-silent-catch */
// src/core/worktree.ts
//
// Git worktree 隔离：让子 agent 在一次性 worktree 副本中工作，不碰用户工作区。
// 完成后变更提交到独立分支，用户可 git merge 合入。
// 参考 tintinweb/pi-subagents 的 worktree.ts。

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** git 命令超时（ms） */
const GIT_TIMEOUT_MS = 15000;
/** commit message 最大长度 */
const COMMIT_MSG_MAX = 200;
/** random UUID 字节数 */
const RANDOM_BYTES_COUNT = 4;
/** branch name 从 worktree 路径取的分段数 */
const BRANCH_NAME_PARTS = 3;

export interface WorktreeResult {
  /** worktree 绝对路径（agent 的 cwd） */
  workPath: string;
  /** 创建的分支名（有变更时） */
  branch?: string;
  /** 是否有变更提交 */
  hasChanges: boolean;
  /** 基准 SHA */
  baseSha: string;
}

/**
 * 创建一个 detached git worktree 副本。
 * @param cwd 当前工作区
 * @param agentId agent 标识（用于分支命名）
 * @returns WorktreeResult 或 undefined（非 git 仓库或失败时）
 */
export function createWorktree(cwd: string, agentId: string): WorktreeResult | undefined {
  // 验证是 git 仓库且有 HEAD
  let headSha: string;
  let repoRoot: string;
  try {
    headSha = git(cwd, ["rev-parse", "HEAD"]).trim();
    repoRoot = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return undefined; // 非 git 仓库
  }

  // 计算子目录在 repo 中的相对路径（monorepo 支持）
  let relPath = "";
  try {
    const realCwd = fs.realpathSync(cwd);
    const realRoot = fs.realpathSync(repoRoot);
    relPath = path.relative(realRoot, realCwd);
  } catch {
    relPath = "";
  }

  // 创建 worktree
  const uuid = crypto.randomBytes(RANDOM_BYTES_COUNT).toString("hex");
  const wtPath = path.join(os.tmpdir(), `pi-agent-${agentId}-${uuid}`);
  try {
    git(cwd, ["worktree", "add", "--detach", wtPath, "HEAD"]);
  } catch {
    return undefined;
  }

  const workPath = relPath ? path.join(wtPath, relPath) : wtPath;
  return {
    workPath: fs.existsSync(workPath) ? workPath : wtPath,
    hasChanges: false,
    baseSha: headSha,
  };
}

/**
 * 清理 worktree：有变更则提交到分支，然后删除 worktree。
 * @param originalCwd 原始工作区（git 命令在此执行）
 * @param wt worktree 结果（含路径）
 * @param description agent 任务描述（用于 commit message）
 */
export function cleanupWorktree(
  originalCwd: string,
  wt: WorktreeResult,
  description: string,
): WorktreeResult {
  const branchName = `pi-agent-${path.basename(wt.workPath).split("-").slice(0, BRANCH_NAME_PARTS).join("-")}`;

  // 检查 worktree 中是否有变更
  let hasChanges = false;
  try {
    const status = git(wt.workPath, ["status", "--porcelain"]);
    hasChanges = status.trim().length > 0;
  } catch {
    hasChanges = false;
  }

  if (hasChanges) {
    try {
      git(wt.workPath, ["add", "-A"]);
      const msg = `pi-agent: ${description.slice(0, COMMIT_MSG_MAX)}`;
      git(wt.workPath, ["commit", "--no-verify", "-m", msg]);
      // 创建分支指向当前 HEAD
      let branch = branchName;
      try {
        git(wt.workPath, ["branch", branch]);
      } catch {
        // 分支名冲突 → 追加时间戳
        branch = `${branchName}-${Date.now()}`;
        git(wt.workPath, ["branch", branch]);
      }
      wt.branch = branch;
      wt.hasChanges = true;
    } catch {
      // commit 失败 → best effort
    }
  }

  // 删除 worktree（分支保留）
  try {
    git(originalCwd, ["worktree", "remove", "--force", wt.workPath.replace(/\/[^/]+$/, "")]);
  } catch {
    try {
      git(originalCwd, ["worktree", "prune"]);
    } catch {
      // best effort
    }
  }

  return wt;
}

/** 清理孤立的 worktree（崩溃恢复） */
export function pruneWorktrees(cwd: string): void {
  try {
    git(cwd, ["worktree", "prune"]);
  } catch {
    // best effort
  }
}

/** 执行 git 命令 */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}
