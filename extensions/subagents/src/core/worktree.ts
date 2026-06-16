/* eslint-disable taste/no-silent-catch */
// src/core/worktree.ts
//
// Git worktree 隔离：让子 agent 在一次性 worktree 副本中工作，不碰用户工作区。
// 完成后变更提交到独立分支，用户可 git merge 合入。
// 参考 tintinweb/pi-subagents 的 worktree.ts（V2 双臂防御模式来自 PR #68）。

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
/** tmpdir 下 pi-agent-* 前缀，用于扫描残留 worktree 物理目录（V5） */
const PI_AGENT_TMP_PREFIX = "pi-agent-";

export interface WorktreeResult {
  /** worktree 绝对路径（agent 的 cwd）。monorepo 子目录场景下指向子目录。 */
  workPath: string;
  /** worktree 顶层目录（`git worktree add` 的目标路径）。cleanup 时用它移除 worktree。 */
  wtRoot: string;
  /** 分支名候选（V6：createWorktree 时固定，cleanup 直接用，不从路径反推） */
  branchName: string;
  /** 创建的分支名（有变更时，cleanupWorktree 写入） */
  branch?: string;
  /** 是否有变更提交 */
  hasChanges: boolean;
  /** 基准 SHA（V2：cleanup 时对比 currentSha 判断 agent 是否自提交） */
  baseSha: string;
}

/**
 * 创建一个 detached git worktree 副本。
 * @param cwd 当前工作区
 * @param agentId agent 标识（用于分支命名 + tmpdir 目录名；应由调用方随机化 — V7）
 * @param baseDir worktree 物理目录的父目录（默认 os.tmpdir()）。
 *   P5: 测试传独立子目录避免与其它并行测试的 pi-agent-* 残留互相干扰。
 * @returns WorktreeResult 或 undefined（非 git 仓库或失败时）
 */
export function createWorktree(cwd: string, agentId: string, baseDir: string = os.tmpdir()): WorktreeResult | undefined {
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

  // 创建 worktree（agentId 用于目录名，已由调用方随机化 — V7）
  // Round 1 MF#1: 目录名嵌入 process.pid，cleanupOrphanedWorktreeDirs 据此校验归属，
  // 避免删除并发 session（多窗口 Pi / CI 并行 job 共享 os.tmpdir()）正在使用的 worktree。
  const uuid = crypto.randomBytes(RANDOM_BYTES_COUNT).toString("hex");
  const wtPath = path.join(baseDir, `${PI_AGENT_TMP_PREFIX}${process.pid}-${agentId}-${uuid}`);
  try {
    git(cwd, ["worktree", "add", "--detach", wtPath, "HEAD"]);
  } catch {
    return undefined;
  }

  const workPath = relPath ? path.join(wtPath, relPath) : wtPath;
  return {
    workPath: fs.existsSync(workPath) ? workPath : wtPath,
    wtRoot: wtPath,
    // V6：分支名候选在创建时固定（pi-agent-${agentId}），cleanup 直接用，不从路径反推
    branchName: `${PI_AGENT_TMP_PREFIX}${agentId}`,
    hasChanges: false,
    baseSha: headSha,
  };
}

/**
 * 清理 worktree：检测变更 → 提交到分支 → 删除 worktree。
 *
 * V2 双臂逻辑（参考 tintinweb PR #68）：
 *   - working tree 脏 → add + commit + branch（既有逻辑）
 *   - working tree 干净但 HEAD 前进（agent 自提交）→ 直接在当前 HEAD 创建分支（尊重 agent 的 commit）
 *   - working tree 干净且 HEAD 未动 → 确实无变更，直接删
 *
 * @param originalCwd 原始工作区（git 命令在此执行）
 * @param wt worktree 结果（含路径）
 * @param description agent 任务描述（用于 commit message）
 */
export function cleanupWorktree(
  originalCwd: string,
  wt: WorktreeResult,
  description: string,
): WorktreeResult {
  // 检测变更：先看 working tree 状态
  let workingTreeDirty = false;
  try {
    const status = git(wt.workPath, ["status", "--porcelain"]);
    workingTreeDirty = status.trim().length > 0;
  } catch {
    workingTreeDirty = false;
  }

  // Round 5 MF#1: commit/branch 失败标志——true 时跳过 worktree remove（见下方），
  // 保留物理目录让用户可手动 `git checkout` 恢复 agent 隔离执行的成果。
  let preserveOnFailure = false;

  if (workingTreeDirty) {
    // 分支 A：working tree 有未提交变更 → add + commit + branch
    try {
      git(wt.workPath, ["add", "-A"]);
      const msg = `pi-agent: ${description.slice(0, COMMIT_MSG_MAX)}`;
      git(wt.workPath, ["commit", "--no-verify", "-m", msg]);
      wt.branch = createBranchAtHead(wt.workPath, wt.branchName);
      wt.hasChanges = true;
    } catch {
      // Round 6 MF#10: commit/branch 失败时若 git add 已执行（变更已 add 未 commit），
      // 必须设 hasChanges=true——调用方依赖 result.worktree.hasChanges 判断是否追加
      // merge 指令；若保持 false，主 agent 会误以为无变更、不提示 merge，agent 成果丢失。
      // 分支创建可能也未完成，但变更已在 worktree 内待用户手动 `git checkout` 恢复。
      wt.hasChanges = true;
      preserveOnFailure = true;
    }
  } else {
    // working tree 干净：需区分"确实无变更" vs "agent 已自提交"（V2）
    let currentSha = "";
    try {
      currentSha = git(wt.workPath, ["rev-parse", "HEAD"]).trim();
    } catch {
      currentSha = wt.baseSha; // 探测失败时保守处理（当作无变更）
    }

    if (currentSha !== wt.baseSha) {
      // 分支 B：agent 自提交了（HEAD 前进），尊重其 commit → 在当前 HEAD 创建分支
      wt.branch = createBranchAtHead(wt.workPath, wt.branchName);
      wt.hasChanges = true;
    } else {
      // 分支 C：确实无变更
      wt.hasChanges = false;
    }
  }

  // 删除 worktree（分支保留）。V8：wtRoot 在 createWorktree 总是设置，
  // 删除死代码 `?? wt.workPath.replace(/\/[^/]+$/, "")`（那正是旧 bug 逻辑）。
  // Round 5 MF#1: commit/branch 失败的脏 worktree 不应被 remove（会物理删除 agent 变更）。
  // preserveOnFailure=true 时跳过——用户可在 os.tmpdir() 下 pi-agent-* 找回目录。
  if (!preserveOnFailure) {
    try {
      git(originalCwd, ["worktree", "remove", "--force", wt.wtRoot]);
    } catch {
      try {
        git(originalCwd, ["worktree", "prune"]);
      } catch {
        // best effort
      }
    }
  }

  return wt;
}

/**
 * 在 worktree 当前 HEAD 创建分支。分支名冲突时追加时间戳避免覆盖既有工作。
 * V6：branchName 由 createWorktree 固定（含完整 agentId），不丢失。
 */
function createBranchAtHead(workPath: string, branchName: string): string {
  try {
    git(workPath, ["branch", branchName]);
    return branchName;
  } catch {
    // 分支名冲突 → 追加时间戳
    const unique = `${branchName}-${Date.now()}`;
    git(workPath, ["branch", unique]);
    return unique;
  }
}

/**
 * 清理孤立的 worktree（崩溃恢复）。
 * V5：除了 `git worktree prune`（清理注册表无效条目），还扫描 baseDir 下
 * pi-agent-* 物理目录并删除（崩溃后残留的物理目录）。
 *
 * Round 6 MF#7: 增加 baseDir 参数限制扫描范围，避免与其它并行测试的
 * pi-agent-* 残留互相干扰（默认 os.tmpdir() 在 CI 共享，全局扫描副作用大）。
 */
export function pruneWorktrees(cwd: string, baseDir: string = os.tmpdir()): void {
  try {
    git(cwd, ["worktree", "prune"]);
  } catch {
    // best effort
  }
  cleanupOrphanedWorktreeDirs(baseDir);
}

/**
 * 扫描 baseDir 下 pi-agent-* 物理目录并删除（V5 崩溃恢复）。
 * 只删与 PI_AGENT_TMP_PREFIX 匹配的目录，不影响其他临时文件。
 * Round 6 MF#7: 接受 baseDir 参数，生产 = os.tmpdir()，测试可传独立子目录避免干扰。
 *
 * Round 1 MF#1: 删除前校验目录归属，防止并发 session（多窗口 Pi / CI 并行 job 共享
 * os.tmpdir()）误删对方正在使用的 worktree。目录名由 createWorktree 嵌入创建进程 pid：
 *   - pid === 当前进程 → 本进程残留，安全删除（正常 session_shutdown 兜底）
 *   - pid 属于其他进程且该进程仍存活 → 并发 session 在用，跳过
 *   - pid 属于其他进程且已退出 → 崩溃残留，安全删除
 *   - 无法解析 pid（旧格式 pi-agent-${agentId}-${uuid}）→ 归属不明，保守跳过
 */
export function cleanupOrphanedWorktreeDirs(baseDir: string = os.tmpdir()): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(baseDir);
  } catch {
    return;
  }
  const currentPid = process.pid;
  for (const entry of entries) {
    if (!entry.startsWith(PI_AGENT_TMP_PREFIX)) continue;
    const fullPath = path.join(baseDir, entry);
    try {
      const ownerPid = parseOwnerPid(entry);
      if (ownerPid === undefined) continue; // 旧格式/无法解析 → 归属不明，保守跳过
      if (ownerPid !== currentPid && isPidAlive(ownerPid)) continue; // 其他存活 session 在用
      fs.rmSync(fullPath, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

/** 从 pi-agent-* 目录名解析创建进程 pid。格式：pi-agent-${pid}-${agentId}-${uuid}。
 *  旧格式（pi-agent-${agentId}-${uuid}，无 pid 前缀）返回 undefined。 */
function parseOwnerPid(entry: string): number | undefined {
  const rest = entry.slice(PI_AGENT_TMP_PREFIX.length);
  const dash = rest.indexOf("-");
  if (dash <= 0) return undefined;
  const pidStr = rest.slice(0, dash);
  if (!/^\d+$/.test(pidStr)) return undefined;
  return Number(pidStr);
}

/** 检查 pid 进程是否存活（signal 0 仅探测不发信号）。
 *  ESRCH=进程不存在，EPERM=进程存在但无权限（视为存活，保守不删）。 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 执行 git 命令。
 *
 * 清除 GIT_* 环境变量（GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE 等）：
 * subagent 可能在 git 钩子上下文（如 pre-commit）中被调用，此时父进程设置了
 * 这些变量指向当前仓库。worktree 隔离创建的是全新独立仓库，若继承这些变量，
 * 子 git 命令会误操作父仓库（如 commit 失败、worktree add 到错误位置）。 */
function git(cwd: string, args: string[]): string {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return execFileSync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
}
