// src/__tests__/worktree.test.ts
//
// worktree.ts 的集成测试：真实创建 git 仓库 + git worktree，验证隔离/清理行为。
//   cleanupWorktree 通过 WorktreeResult.wtRoot 精确定位 worktree 顶层目录，
//   覆盖顶层仓库 cwd 和 monorepo 子目录 cwd 两种场景。

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanupWorktree, createWorktree, pruneWorktrees } from "../core/worktree.ts";

/** 每个 case 独立的临时仓库根 */
let tmpDir: string;
/** 本 case 中通过 createWorktree 产生的 workPath，供 afterEach 兜底清理 */
const createdWorkPaths: string[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wt-test-"));
  createdWorkPaths.length = 0;
});

afterEach(() => {
  // 兜底清理：即便被测代码未成功移除 worktree，也保证不泄漏到 /tmp
  for (const wp of createdWorkPaths) {
    // 先按 workPath 本身当 worktree 根尝试移除（顶层仓库场景）
    let removed = false;
    try {
      execFileSync("git", ["-C", tmpDir, "worktree", "remove", "--force", wp], { stdio: "ignore", env: CLEAN_ENV });
      removed = true;
    } catch {
      // 非 worktree 根 → 回退到父目录（单层子目录场景）
    }
    if (!removed) {
      const parent = wp.replace(/\/[^/]+$/, "");
      try {
        execFileSync("git", ["-C", tmpDir, "worktree", "remove", "--force", parent], { stdio: "ignore", env: CLEAN_ENV });
      } catch {
        // best effort
      }
      try {
        fs.rmSync(parent, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    try {
      fs.rmSync(wp, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  try {
    execFileSync("git", ["-C", tmpDir, "worktree", "prune"], { stdio: "ignore", env: CLEAN_ENV });
  } catch {
    // 非 git 目录等，忽略
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 清除 GIT_* 环境变量：pre-commit hook 等上下文会注入 GIT_DIR/GIT_INDEX_FILE
 * 指向项目仓库，劫持测试在 tmpdir 里的 git 操作。 */
const CLEAN_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return env;
})();

/** 静默执行 git 命令（不需要输出） */
function gitQuiet(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore", env: CLEAN_ENV });
}

/** 执行 git 命令并返回 stdout */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], env: CLEAN_ENV });
}

/** 初始化顶层 git 仓库（含一次提交），返回仓库根 */
function initRepo(repoDir: string): string {
  gitQuiet(repoDir, ["init", "-q"]);
  gitQuiet(repoDir, ["config", "user.email", "test@pi-agent.test"]);
  gitQuiet(repoDir, ["config", "user.name", "Pi Agent Test"]);
  fs.writeFileSync(path.join(repoDir, "README.md"), "initial\n");
  gitQuiet(repoDir, ["add", "-A"]);
  gitQuiet(repoDir, ["commit", "-q", "-m", "init"]);
  return repoDir;
}

/** 初始化仓库 + 单层子目录（已提交），返回子目录绝对路径（模拟 monorepo 包目录） */
function initRepoWithSubdir(repoDir: string, sub: string): string {
  initRepo(repoDir);
  const subDir = path.join(repoDir, sub);
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, "pkg.txt"), "pkg\n");
  gitQuiet(repoDir, ["add", "-A"]);
  gitQuiet(repoDir, ["commit", "-q", "-m", `add ${sub}`]);
  return subDir;
}

function headSha(cwd: string): string {
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}

function branchExists(repo: string, name: string): boolean {
  try {
    execFileSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`], {
      stdio: "ignore",
      env: CLEAN_ENV,
    });
    return true;
  } catch {
    return false;
  }
}

describe("createWorktree", () => {
  it("creates a detached worktree from repo HEAD (top-level cwd)", () => {
    const repo = initRepo(tmpDir);
    const head = headSha(repo);

    const wt = createWorktree(repo, "unit-test");

    expect(wt).toBeDefined();
    expect(wt!.branch).toBeUndefined();
    expect(wt!.hasChanges).toBe(false);
    expect(wt!.baseSha).toBe(head);
    expect(fs.existsSync(wt!.workPath)).toBe(true);
    // 新 worktree 与 HEAD 同步：内部文件应与仓库一致
    expect(fs.existsSync(path.join(wt!.workPath, "README.md"))).toBe(true);

    createdWorkPaths.push(wt!.workPath);
  });

  it("returns undefined when cwd is not a git repository (covers non-git + git command failure)", () => {
    // tmpDir 此时是空目录、非 git：git rev-parse HEAD 失败 → undefined
    expect(createWorktree(tmpDir, "no-git")).toBeUndefined();
  });
});

describe("cleanupWorktree", () => {
  it("commits changes, creates a branch, and removes the worktree (monorepo subdir cwd)", () => {
    const subDir = initRepoWithSubdir(tmpDir, "pkg");

    const wt = createWorktree(subDir, "cleanup-test");
    expect(wt).toBeDefined();
    createdWorkPaths.push(wt!.workPath);

    // 在 worktree 内制造变更
    fs.writeFileSync(path.join(wt!.workPath, "newfile.txt"), "change\n");

    const result = cleanupWorktree(subDir, wt!, "test task cleanup");

    // 变更已提交
    expect(result.hasChanges).toBe(true);
    // 分支已创建，命名前缀符合约定
    expect(result.branch).toBeTruthy();
    expect(result.branch!).toMatch(/^pi-agent-/);
    expect(branchExists(tmpDir, result.branch!)).toBe(true);

    // worktree 已从 git 注册表移除
    const list = git(tmpDir, ["worktree", "list"]);
    expect(list).not.toContain(wt!.workPath);

    // worktree 物理目录已被删除（cleanup 删除的是 workPath 的父目录 = worktree 根）
    expect(fs.existsSync(wt!.workPath)).toBe(false);
  });

  it("reports no changes and no branch when worktree is untouched", () => {
    const subDir = initRepoWithSubdir(tmpDir, "pkg");

    const wt = createWorktree(subDir, "nochange");
    expect(wt).toBeDefined();
    createdWorkPaths.push(wt!.workPath);

    const result = cleanupWorktree(subDir, wt!, "no change task");

    expect(result.hasChanges).toBe(false);
    expect(result.branch).toBeUndefined();
    // 无变更时仍应移除 worktree
    expect(fs.existsSync(wt!.workPath)).toBe(false);
  });

  it("commits changes, creates a branch, and removes the worktree (top-level repo cwd)", () => {
    // 顶层仓库场景：relPath === ""，workPath === wtRoot。
    // 旧实现用 workPath.replace(/\/[^/]+$/, "") 推导根，会指向父目录导致 remove 失败、worktree 残留。
    // 现在通过 wtRoot 精确定位，此场景应正常清理。
    const repo = initRepo(tmpDir);

    const wt = createWorktree(repo, "toplevel-cleanup");
    expect(wt).toBeDefined();
    createdWorkPaths.push(wt!.workPath);

    // 顶层场景：workPath 应等于 wtRoot
    expect(wt!.workPath).toBe(wt!.wtRoot);

    fs.writeFileSync(path.join(wt!.workPath, "newfile.txt"), "change\n");

    const result = cleanupWorktree(repo, wt!, "toplevel task cleanup");

    expect(result.hasChanges).toBe(true);
    expect(result.branch).toBeTruthy();
    expect(result.branch!).toMatch(/^pi-agent-/);
    expect(branchExists(tmpDir, result.branch!)).toBe(true);

    const list = git(tmpDir, ["worktree", "list"]);
    expect(list).not.toContain(wt!.workPath);
    expect(fs.existsSync(wt!.workPath)).toBe(false);
  });

  // ── V2：agent 自提交后 status 干净但 HEAD 前进，不应销毁 commit ──────
  it("V2: preserves agent's self-commit when working tree is clean but HEAD advanced", () => {
    const repo = initRepo(tmpDir);
    const baseShaBefore = headSha(repo);

    const wt = createWorktree(repo, "v2-selfcommit");
    expect(wt).toBeDefined();
    expect(wt!.baseSha).toBe(baseShaBefore);
    createdWorkPaths.push(wt!.workPath);

    // 模拟 agent 在 worktree 内自己跑了 git commit（coding agent 常见行为，尤其带 zcommit skill）
    fs.writeFileSync(path.join(wt!.workPath, "agent-work.txt"), "done by agent\n");
    gitQuiet(wt!.workPath, ["add", "-A"]);
    gitQuiet(wt!.workPath, ["commit", "-q", "-m", "agent checkpoint: implemented feature X"]);
    // 此时 working tree 干净（agent 已全部 commit），但 HEAD 已前进
    const agentCommitSha = headSha(wt!.workPath);
    expect(agentCommitSha).not.toBe(baseShaBefore);

    const result = cleanupWorktree(repo, wt!, "v2 task");

    // V2 修复后：应检测到 HEAD 前进，保留 agent 的 commit 到分支
    expect(result.hasChanges).toBe(true);
    expect(result.branch).toBeTruthy();
    expect(branchExists(tmpDir, result.branch!)).toBe(true);
    // 分支应指向 agent 的 commit，而非 baseSha（尊重 agent 的 commit，不 reset）
    const branchSha = git(tmpDir, ["rev-parse", result.branch!]).trim();
    expect(branchSha).toBe(agentCommitSha);
    // worktree 已删
    expect(fs.existsSync(wt!.workPath)).toBe(false);
  });

  // ── V6：monorepo 子目录场景，分支名应含完整 agentId（不从 workPath.basename 反推） ──
  it("V6: branch name preserves full agentId in monorepo subdir scenario", () => {
    const subDir = initRepoWithSubdir(tmpDir, "deep-pkg");

    const wt = createWorktree(subDir, "myagent123");
    expect(wt).toBeDefined();
    createdWorkPaths.push(wt!.workPath);

    // branchName 候选应在创建时固定，含完整 agentId
    expect(wt!.branchName).toBe("pi-agent-myagent123");

    // 制造变更触发分支创建
    fs.writeFileSync(path.join(wt!.workPath, "change.txt"), "x\n");
    const result = cleanupWorktree(subDir, wt!, "v6 task");

    expect(result.hasChanges).toBe(true);
    // 分支名应以 pi-agent-myagent123 开头（V6：不因 monorepo basename 丢失 agentId）
    expect(result.branch).toMatch(/^pi-agent-myagent123/);
  });

  // ── Round 6 MF#10: commit/branch 失败时 hasChanges 必须 true（否则主 agent 误判无变更） ──────
  it("MF#10: commit fails → hasChanges=true so caller knows to surface merge instructions", () => {
    const subDir = initRepoWithSubdir(tmpDir, "pkg");

    const wt = createWorktree(subDir, "commit-fail");
    expect(wt).toBeDefined();
    createdWorkPaths.push(wt!.workPath);

    // 制造变更使 working tree dirty
    fs.writeFileSync(path.join(wt!.workPath, "newfile.txt"), "change\n");

    // 设置 commit.gpgsign=true 强制 GPG 签名；没有 GPG key 时 git commit 会失败。
    // 源码用 --no-verify 但 --no-verify 不绕过 GPG 签名（它只绕过 pre-commit/commit-msg hooks）。
    execFileSync("git", ["-C", wt!.workPath, "config", "commit.gpgsign", "true"], { env: CLEAN_ENV });

    const result = cleanupWorktree(subDir, wt!, "commit-fail task");

    // MF#10: 即使 commit 失败，hasChanges 必须为 true（变更已 add/待 commit）
    expect(result.hasChanges).toBe(true);
  });
});

describe("pruneWorktrees", () => {
  it("does not throw in a non-git directory", () => {
    expect(() => pruneWorktrees(tmpDir)).not.toThrow();
  });

  // ── V5：崩溃恢复 —— 残留的 pi-agent-* 物理目录应被清理 ──────
  // Round 6 MF#7: 用 test-local baseDir（tmpDir）替代 os.tmpdir()，避免与其它并行测试
  // 的 pi-agent-* 残留互相干扰——这是 flaky 根因。
  it("V5: removes orphaned pi-agent-* physical dirs from baseDir (crash recovery)", () => {
    // 模拟本进程残留（session_shutdown 兜底清理）：ownerPid === currentPid → 删除
    const orphanDir = path.join(tmpDir, `pi-agent-${process.pid}-crashed-abc123`);
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, "leftover.txt"), "crash\n");
    expect(fs.existsSync(orphanDir)).toBe(true);

    // 传 baseDir=tmpDir 让扫描范围限定在此 test-local 目录
    pruneWorktrees(tmpDir, tmpDir);

    // V5 修复后：物理目录应被删除
    expect(fs.existsSync(orphanDir)).toBe(false);
  });

  it("V5: does not remove unrelated baseDir entries", () => {
    const unrelatedDir = path.join(tmpDir, "other-tool-tmp");
    fs.mkdirSync(unrelatedDir, { recursive: true });
    const piAgentDir = path.join(tmpDir, `pi-agent-${process.pid}-keep-me`);
    fs.mkdirSync(piAgentDir, { recursive: true });

    try {
      pruneWorktrees(tmpDir, tmpDir);

      expect(fs.existsSync(unrelatedDir)).toBe(true); // 不受影响
      expect(fs.existsSync(piAgentDir)).toBe(false); // pi-agent-* 被清
    } finally {
      // 清理 unrelated dir
      try { fs.rmSync(unrelatedDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  // ── Round 1 MF#1: 并发 session 安全 + 崩溃恢复归属校验 ──────
  it("MF#1: removes crash-recovery dirs from a dead process", () => {
    // 模拟其他进程崩溃后退出（pid 已不存在）：归属进程已死 → 安全删除
    const deadPid = 99999999; // 超出 Linux pid_max（4194304），不可能存在
    const crashDir = path.join(tmpDir, `pi-agent-${deadPid}-crashed`);
    fs.mkdirSync(crashDir, { recursive: true });
    expect(fs.existsSync(crashDir)).toBe(true);

    pruneWorktrees(tmpDir, tmpDir);

    expect(fs.existsSync(crashDir)).toBe(false); // 归属进程已死 → 清
  });

  it("MF#1: preserves dirs owned by another live process (concurrent session safety)", () => {
    // 用父进程 pid 模拟另一个存活的并发 session（测试运行时父进程必然存活，ppid !== pid）
    const liveOtherPid = process.ppid;
    const otherDir = path.join(tmpDir, `pi-agent-${liveOtherPid}-concurrent`);
    fs.mkdirSync(otherDir, { recursive: true });

    try {
      pruneWorktrees(tmpDir, tmpDir);
      expect(fs.existsSync(otherDir)).toBe(true); // 其他存活 session → 保留
    } finally {
      try { fs.rmSync(otherDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("MF#1: skips legacy dirs without pid prefix (unknown ownership)", () => {
    // 旧格式（createWorktree 未嵌入 pid 时的残留）→ 归属不明，保守跳过不删
    const legacyDir = path.join(tmpDir, "pi-agent-legacy-no-pid");
    fs.mkdirSync(legacyDir, { recursive: true });

    try {
      pruneWorktrees(tmpDir, tmpDir);
      expect(fs.existsSync(legacyDir)).toBe(true); // 旧格式 → 保留
    } finally {
      try { fs.rmSync(legacyDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});

// ============================================================
// 宿主仓库防污染自检
// ============================================================
// worktree 测试在 tmpdir 创建真实 git 仓库。历史上曾因继承 GIT_DIR/GIT_INDEX_FILE
// 环境变量，测试中的 git commit 误打到宿主项目仓库，创建删除所有文件的破坏性 commit。
// CLEAN_ENV + hook 隔离是主动防御，这里是被动验证：全部测试跑完后，确认宿主仓库
// 和 tmpdir 没有 pi-agent-* 残留。若此断言失败，说明防御被绕过，需立即排查。
//
// 只检查测试可能创建的东西（pi-agent-* worktree / 临时目录），不断言整个仓库
// 状态，避免用户未提交的改动误报。
afterAll(() => {
  // 1. 宿主仓库无 pi-agent-* worktree 残留
  const repoRoot = (() => {
    try {
      return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"], env: CLEAN_ENV }).trim();
    } catch {
      return null;
    }
  })();
  if (repoRoot) {
    const worktreeList = execFileSync("git", ["worktree", "list"], { encoding: "utf-8", cwd: repoRoot, env: CLEAN_ENV });
    const leaked = worktreeList.split("\n").filter((l) => /pi-agent-/.test(l));
    expect(leaked, `宿主仓库残留 worktree:\n${leaked.join("\n")}`).toEqual([]);
  }

  // 2. tmpdir 无 pi-agent-* 临时目录残留（每个 case 的 afterEach 应已清理）
  const tmpFiles = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("pi-agent-"));
  expect(tmpFiles, `tmpdir 残留 pi-agent-* 目录: ${tmpFiles.join(", ")}`).toEqual([]);
});
