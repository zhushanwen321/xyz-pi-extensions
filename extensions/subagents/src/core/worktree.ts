// src/core/worktree.ts
//
// worktree 隔离：isolation:worktree 的 agent 在临时副本中执行，
// 完成后 commit 到新 branch（或 preserveOnFailure 保留物理目录）。
//
// 状态：createWorktree/cleanupWorktree 是 P3 叶子（git worktree 创建/提交逻辑）；
//       pruneWorktrees/cleanupOrphanedWorktreeDirs 已深化为 best-effort 清理
//       （session_start/shutdown 调用，不能阻塞 session 启动）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { WorktreeOutcome } from "../types.ts";

/** worktree 临时目录前缀（prune 扫描用）。 */
const WORKTREE_DIR_PREFIX = "pi-agent-";

/** createWorktree 返回。 */
export interface WorktreeResult {
  /** 临时 worktree 物理路径（传给 createAgentSession 的 cwd）。 */
  workPath: string;
  /** worktree 目录名（清理时定位）。 */
  dirName: string;
  /** 创建时的 baseline commit SHA（diff/恢复用）。 */
  baseSha: string;
}

/**
 * 在 baseDir（生产=os.tmpdir()）下创建 git worktree 副本。
 *
//   ╔════════════════════════════════════════════════════════════════╗
//   ║  git -C cwd worktree add --detach <baseDir>/pi-agent-<agentId>   ║
//   ║      agentId = randomBytes(4).toString("hex")（路径注入防御）    ║
//   ║  baseSha = git rev-parse HEAD                                    ║
//   ║  失败（非 git / worktree add 失败）→ return undefined（调用方    ║
//   ║  必须 throw，不静默回退到 cwd，否则污染用户工作区）              ║
//   ╚════════════════════════════════════════════════════════════════╝
 */
export function createWorktree(cwd: string, agentId: string, baseDir: string): WorktreeResult | undefined {
  //  1. assert cwd 是 git 仓库
  //  2. agentId 拼成 dirName = `pi-agent-${agentId}`
  //  3. git worktree add --detach baseDir/dirName
  //  4. 捕获 baseSha
  //  5. 任一步失败 → undefined
  void cwd; void agentId; void baseDir;
  throw new Error("not implemented");
}

/**
 * 清理 worktree：有变更则 commit 到新 branch，否则直接 remove。
 *
//   ╔════════════════════════════════════════════════════════════════╗
//   ║  cd workPath; git status → hasChanges?                          ║
//   ║    是 → git add -A + git commit -m "<task 前 200 字>"            ║
//   ║        → git branch subagent/<agentId>                          ║
//   ║        → WorktreeOutcome { branch, hasChanges:true }            ║
//   ║        commit/branch 失败 → preserveOnFailure: { workPath,      ║
//   ║           baseSha, hasChanges:true }（不静默丢弃变更）          ║
//   ║    否 → WorktreeOutcome { hasChanges:false }                    ║
//   ║  finally: git worktree remove workPath（best-effort）            ║
//   ╚════════════════════════════════════════════════════════════════╝
 */
export function cleanupWorktree(cwd: string, worktree: WorktreeResult, commitMsg: string): WorktreeOutcome {
  //  1. git -C workPath status --porcelain 判断 hasChanges
  //  2. 有变更：commit + branch；失败则保留 workPath（preserveOnFailure）
  //  3. 无变更：返回 hasChanges:false
  //  4. finally: git worktree remove（best-effort，失败不阻断）
  void cwd; void worktree; void commitMsg;
  throw new Error("not implemented");
}

/**
 * 崩溃恢复：扫描 tmpdir 下残留的 pi-agent-* 目录并清理。
 * kill -9 / 断电时 session_shutdown 未触发，靠下次 session_start 兜底。
 *
 * best-effort：git worktree remove 失败或目录不存在均不抛——这是清理路径，
 * 不能阻塞 session 启动。真正的 worktree 创建/提交逻辑在 createWorktree/cleanupWorktree。
 */
export function pruneWorktrees(_cwd: string): void {
  const tmpDir = os.tmpdir();
  let entries: string[];
  try {
    entries = fs.readdirSync(tmpDir);
  } catch {
    return; // tmpdir 不可读，无事可做
  }

  for (const name of entries) {
    if (!name.startsWith(WORKTREE_DIR_PREFIX)) continue;
    const fullPath = path.join(tmpDir, name);
    // best-effort：非目录跳过，rmdir 失败忽略（可能非空或权限不足）
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isDirectory()) continue;
      fs.rmSync(fullPath, { recursive: true, force: true });
    } catch {
      // 清理失败不阻断 session 启动
    }
  }
}

/** 清理孤儿 worktree 物理目录（session_shutdown 调用）。best-effort，不抛。 */
export function cleanupOrphanedWorktreeDirs(): void {
  const tmpDir = os.tmpdir();
  let entries: string[];
  try {
    entries = fs.readdirSync(tmpDir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (!name.startsWith(WORKTREE_DIR_PREFIX)) continue;
    const fullPath = path.join(tmpDir, name);
    try {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}
