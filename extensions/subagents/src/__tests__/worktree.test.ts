// src/__tests__/worktree.test.ts
//
// worktree.ts 的集成测试：真实创建 git 仓库 + git worktree，验证隔离/清理行为。
//   cleanupWorktree 通过 WorktreeResult.wtRoot 精确定位 worktree 顶层目录，
//   覆盖顶层仓库 cwd 和 monorepo 子目录 cwd 两种场景。

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
});

describe("pruneWorktrees", () => {
  it("does not throw in a non-git directory", () => {
    expect(() => pruneWorktrees(tmpDir)).not.toThrow();
  });
});
