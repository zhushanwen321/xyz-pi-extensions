// code-skeleton/runtime/worktree-manager.ts — ⑤骨架（#4 NEW 核心深模块）
// git worktree 生命周期 + patch 回传 + reaper。D-019: 无 GitPort，git 调用收口私有 gitRun。
// D-020: PatchCollector 合并为 collectPatch 方法（无独立 patch-collector 文件）。
// D-015: 无分支保留选项（D-015 删），cleanup 恒 remove --force + branch -D。

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorktreeHandle, PatchResult, DirtyWorktreeError } from "../types.ts";
import { DirtyWorktreeError as DirtyErr } from "../types.ts";
import { readAliveMarker, isProcessAlive } from "./execution/alive-store.ts";

/** git 命令默认超时（ms）。 */
const GIT_TIMEOUT_MS = 10000;

/** recordId 白名单（④安全缓解骨架约束）：防 shell 元字符注入。 */
const RECORD_ID_RE = /^[\w-]+$/;

/**
 * WorktreeManager —— git worktree 生命周期深模块（#4）。
 * 持有 gitRun helper（D-019 收口 git CLI，无 GitPort）。
 *
 * 数据流：SubagentService.execute(worktree:true) → create → WorktreeHandle 回填 record
 *         finalizeRecord(D-017 ⓪) → collectPatch → (D-022 成功)cleanup
 *         index.session_start → scan(reaper)
 */
export class WorktreeManager {
  /**
   * 创建 git worktree（#4）。
   * 步骤：recordId 白名单 → clean 校验 → baseCommit 缓存 → worktree add → node_modules 软链 → setupHook。
   *
   * 失败路径：recordId 非法→抛 / 脏树→DirtyWorktreeError / worktree add 失败→抛（调用方 finalizeFailed）
   */
  create(mainCwd: string, recordId: string): WorktreeHandle {
    // 1. recordId 白名单（④安全：防 shell 元字符注入）
    if (!RECORD_ID_RE.test(recordId)) {
      throw new Error(`invalid recordId '${recordId}' (must match ^[\\w-]+$)`);
    }
    // 2. clean tree 前置校验（脏→抛，首版不自动 stash）
    const status = this.gitRun(["status", "--porcelain"], { cwd: mainCwd });
    if (status.trim().length > 0) {
      throw new DirtyErr(mainCwd);
    }
    // 3. baseCommit 缓存（git rev-parse HEAD）
    const baseCommit = this.gitRun(["rev-parse", "HEAD"], { cwd: mainCwd }).trim();
    // 4. git worktree add -b <branch> <path> HEAD
    const branch = `pi-sub-${recordId}`;
    const worktreePath = path.join(mainCwd, ".git-worktrees", recordId);
    this.gitRun(["worktree", "add", "-b", branch, worktreePath, "HEAD"], { cwd: mainCwd });
    // 5. node_modules 软链（AC-4.10/4.11 性能：worktree 内复用主 cwd node_modules）
    this.symlinkNodeModules(worktreePath, mainCwd);
    // 6. setupHook（可选，首版 stub——处理 .env 等）
    this.runSetupHook(worktreePath);
    return Object.freeze({ path: worktreePath, branch, baseCommit }) as WorktreeHandle;
  }

  /**
   * 清理 worktree（#4/D-015）。恒 remove --force + branch -D 成对（无分支保留选项（D-015 删））。
   * 调用点：finalizeRecord(D-017 ③，collectPatch 成功时) / cancelBackground。
   */
  cleanup(handle: WorktreeHandle): void {
    // AC-4: worktree remove + branch -D 成对（②§11 grep 验）
    this.gitRun(["worktree", "remove", "--force", handle.path], { cwd: path.dirname(handle.path) });
    this.gitRun(["branch", "-D", handle.branch], { cwd: path.dirname(handle.path) });
  }

  /**
   * reaper 扫孤儿 worktree（#4/#9）。session_start 调。
   * D-024 孤儿判据：worktree 关联 session 有终态标记（.cancelled/.finalized/.crashed 之一）
   *   且无活 .alive；绝不删有活 .alive 的 worktree（复用 #13 readAliveMarker+isProcessAlive）。
   *
   * 竞态：跨实例 reaper 看不到实例 A 内存 running record → 必须用 .alive 活性证据作删除前置守卫（D-024）。
   */
  scan(mainCwd: string, agentDir: string): void {
    void agentDir; // 预留：agentDir 用于定位 session sidecar（骨架 stub）
    const list = this.gitRun(["worktree", "list", "--porcelain"], { cwd: mainCwd });
    // 遍历每个 pi-sub-* worktree，查终态标记 + .alive 探活
    for (const line of list.split("\n")) {
      const wtPath = line.startsWith("worktree ") ? line.slice("worktree ".length) : "";
      if (!wtPath.startsWith(path.join(mainCwd, ".git-worktrees"))) continue;
      const sessionFile = this.resolveSessionFileForWorktree(wtPath); // 叶子逻辑 stub
      if (!sessionFile) continue;
      const alive = readAliveMarker(sessionFile);
      if (alive && isProcessAlive(alive.pid)) {
        continue; // D-024: 活 .alive → 绝不删（安全网）
      }
      // 终态标记 且无活 .alive → 清理（D-024）。无标记无 .alive → 保守跳过（可能跨实例正跑）
      if (this.hasTerminalMarker(sessionFile)) {
        this.gitRun(["worktree", "remove", "--force", wtPath], { cwd: mainCwd });
      }
    }
  }

  /**
   * 收集 patch（#7/D-020 合并自 PatchCollector）。finalizeRecord D-017 ⓪调。
   * git diff --cached <baseCommit> → 写 .patch 文件。不解析 patch。
   * D-022: failed=true 时调用方须跳过 cleanup（保留 worktree 供手动恢复）。
   *
   * 失败路径：git diff 抛错→failed=true（best-effort，D-022 数据黑洞防护）
   */
  collectPatch(handle: WorktreeHandle): PatchResult {
    try {
      const patch = this.gitRun(
        ["diff", "--cached", handle.baseCommit],
        { cwd: handle.path },
      );
      const patchFile = `${handle.path}.patch`;
      fs.writeFileSync(patchFile, patch, "utf-8");
      return { patchFile, failed: false };
    } catch (_e) {
      void _e;
      return { patchFile: undefined, failed: true }; // D-022: 调用方跳过 cleanup
    }
  }

  /**
   * 私有 gitRun（D-019: 无 GitPort，收口 git CLI）。
   * execFileSync("git") + 统一超时/错误包装。真引 node:child_process（adapter Tier 2 证伪）。
   *
   * 竞态/不变式：recordId 已白名单校验（create 入口），此处 args 信任（防注入在入口收口）。
   */
  private gitRun(args: string[], opts: { cwd: string; timeout?: number }): string {
    return execFileSync("git", args, {
      cwd: opts.cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: opts.timeout ?? GIT_TIMEOUT_MS,
    });
  }

  /** node_modules 软链（AC-4.10/4.11）。worktreePath/node_modules → mainCwd/node_modules。 */
  private symlinkNodeModules(worktreePath: string, mainCwd: string): void {
    const target = path.join(mainCwd, "node_modules");
    const link = path.join(worktreePath, "node_modules");
    if (fs.existsSync(target) && !fs.existsSync(link)) {
      fs.symlinkSync(target, link, "dir");
    }
  }

  /** setupHook stub（首版：处理 .env 等，签名固定）。叶子逻辑。 */
  private runSetupHook(_worktreePath: string): void {
    throw new Error("setupHook not implemented (skeleton stub — ⑥Wave 实现)");
  }

  /** worktree → session 文件解析（叶子 stub，⑥实现）。 */
  private resolveSessionFileForWorktree(_wtPath: string): string | undefined {
    throw new Error("resolveSessionFileForWorktree not implemented (skeleton stub)");
  }

  /** 查 session 是否有终态标记（.cancelled/.finalized/.crashed，叶子 stub）。 */
  private hasTerminalMarker(_sessionFile: string): boolean {
    throw new Error("hasTerminalMarker not implemented (skeleton stub)");
  }
}

// 显式标记 DirtyWorktreeError 引用（防 unused import 误报，类型 re-export 用）
void (null as unknown as DirtyWorktreeError);
