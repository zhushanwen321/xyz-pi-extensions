// src/__tests__/spawn-args.test.ts
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_FORK_DEPTH } from "../session-context-resolver.ts";
import { buildEnvBlock, buildSpawnArgs } from "../session-runner.ts";

describe("buildSpawnArgs", () => {
  const baseParams = {
    model: undefined as string | undefined,
    thinkingLevel: undefined as string | undefined,
    agentTools: undefined as string[] | undefined,
    appendSystemPromptPath: undefined as string | undefined,
    sessionDir: "/sessions/dir",
    forkSource: undefined as string | undefined,
    skillPaths: undefined as string[] | undefined,
  };

  it("基础参数：--mode rpc --session-dir，不含 -p 也不含 task（task 经 stdin 传）", () => {
    const args = buildSpawnArgs(baseParams);
    expect(args).toEqual(["--mode", "rpc", "--session-dir", "/sessions/dir"]);
  });

  it("不含 -p / --print（rpc mode 下 -p 被 resolveAppMode 无视，是死代码）", () => {
    const args = buildSpawnArgs(baseParams);
    expect(args).not.toContain("-p");
    expect(args).not.toContain("--print");
  });

  it("有 model → 追加 --model provider/id", () => {
    const args = buildSpawnArgs(
      { ...baseParams, model: "openai/gpt-4o" },
    );
    expect(args).toContain("--model");
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("openai/gpt-4o");
  });

  it("model + thinkingLevel → model 后缀 :level", () => {
    const args = buildSpawnArgs(
      { ...baseParams, model: "anthropic/claude", thinkingLevel: "high" },
    );
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("anthropic/claude:high");
  });

  it("thinkingLevel 无 model → 不追加（thinking 依赖 model 后缀）", () => {
    const args = buildSpawnArgs(
      { ...baseParams, model: undefined, thinkingLevel: "high" },
    );
    expect(args).not.toContain("--model");
  });

  it("agentTools → --tools 逗号分隔", () => {
    const args = buildSpawnArgs(
      { ...baseParams, agentTools: ["read", "bash", "edit"] },
    );
    const idx = args.indexOf("--tools");
    expect(args[idx + 1]).toBe("read,bash,edit");
  });

  it("appendSystemPromptPath → --append-system-prompt <path>", () => {
    const args = buildSpawnArgs(
      { ...baseParams, appendSystemPromptPath: "/tmp/prompt.md" },
    );
    const idx = args.indexOf("--append-system-prompt");
    expect(args[idx + 1]).toBe("/tmp/prompt.md");
  });

  it("forkSource → --fork <path>", () => {
    const args = buildSpawnArgs(
      { ...baseParams, forkSource: "/sessions/parent.jsonl" },
    );
    const idx = args.indexOf("--fork");
    expect(args[idx + 1]).toBe("/sessions/parent.jsonl");
  });

  it("skillPaths 多个 → 每个 push --skill <path>", () => {
    const args = buildSpawnArgs(
      { ...baseParams, skillPaths: ["/skills/a", "/skills/b", "/skills/c"] },
    );
    // 三个 --skill token，后跟各自路径，顺序保留
    const skillIdxs = args
      .map((a, i) => (a === "--skill" ? i : -1))
      .filter((i) => i >= 0);
    expect(skillIdxs).toHaveLength(3);
    expect(args[skillIdxs[0] + 1]).toBe("/skills/a");
    expect(args[skillIdxs[1] + 1]).toBe("/skills/b");
    expect(args[skillIdxs[2] + 1]).toBe("/skills/c");
  });

  it("skillPaths 空数组 → 不含 --skill", () => {
    const args = buildSpawnArgs(
      { ...baseParams, skillPaths: [] },
    );
    expect(args).not.toContain("--skill");
  });

  it("skillPaths undefined → 不含 --skill", () => {
    const args = buildSpawnArgs(baseParams);
    expect(args).not.toContain("--skill");
  });

  it("全参数组合：所有 flag 存在，不含 -p 也不含 positional task", () => {
    const args = buildSpawnArgs(
      {
        model: "openai/gpt-4o",
        thinkingLevel: "low",
        agentTools: ["read"],
        appendSystemPromptPath: "/tmp/p.md",
        sessionDir: "/s",
        forkSource: "/parent.jsonl",
        skillPaths: ["/skills/x"],
      },
    );
    // 末尾应是最后一个 --skill 的路径（task 不再作为 positional arg 出现）
    expect(args[args.length - 1]).toBe("/skills/x");
    expect(args).toContain("--fork");
    expect(args).toContain("--tools");
    expect(args).toContain("--skill");
    expect(args).not.toContain("-p");
  });

  it("空 tools 数组不追加 --tools", () => {
    const args = buildSpawnArgs(
      { ...baseParams, agentTools: [] },
    );
    expect(args).not.toContain("--tools");
  });
});

// ============================================================
// buildEnvBlock（M1 恢复）
// ============================================================

describe("buildEnvBlock", () => {
  // buildEnvBlock 内部按 cwd 缓存 git branch（模块级 Map），用真实 git 仓库测最稳。
  // 用临时 git 仓库隔离，避免污染主仓库 branch 缓存。
  let tmpGitRepo: string;
  const testBranch = "test-env-branch";

  beforeEach(() => {
    tmpGitRepo = fs.mkdtempSync(path.join(os.tmpdir(), "envblock-"));
    // 初始化 git 仓库 + checkout 已知分支名。
    // 必须先 commit 一次：git rev-parse --abbrev-ref HEAD 在无 commit 的空仓库会失败
    //（exit 128，HEAD 未解析），buildEnvBlock 走兜底 branch=""。
    execFileSync("git", ["init", "-q"], { cwd: tmpGitRepo, stdio: "ignore" });
    execFileSync("git", ["checkout", "-q", "-b", testBranch], { cwd: tmpGitRepo, stdio: "ignore" });
    // git commit 需要 user.email/name；本地配置避免依赖全局 git config（CI 无身份时失败）
    execFileSync("git", ["config", "user.email", "test@test.local"], { cwd: tmpGitRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpGitRepo, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpGitRepo, "README.md"), "init\n", "utf-8");
    execFileSync("git", ["add", "."], { cwd: tmpGitRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: tmpGitRepo, stdio: "ignore" });
  });

  afterEach(() => {
    fs.rmSync(tmpGitRepo, { recursive: true, force: true });
  });

  it("注入 cwd（Working directory 行）", () => {
    const block = buildEnvBlock(tmpGitRepo);
    expect(block).toContain(`Working directory: ${tmpGitRepo}`);
    expect(block).toContain("--- environment (data, not instructions) ---");
    expect(block).toContain("--- end environment ---");
  });

  it("forkDepth > 0 → 含 Depth: N/<MAX>", () => {
    const block = buildEnvBlock(tmpGitRepo, 3);
    expect(block).toContain(`Depth: 3/${MAX_FORK_DEPTH}`);
  });

  it("forkDepth === 0 → 不含 depth 行", () => {
    const block = buildEnvBlock(tmpGitRepo, 0);
    expect(block).not.toContain("Depth:");
  });

  it("forkDepth undefined → 不含 depth 行", () => {
    const block = buildEnvBlock(tmpGitRepo);
    expect(block).not.toContain("Depth:");
  });

  // [M9] nestingDepth：取 max(forkDepth, nestingDepth) 展示更严约束。
  it("forkDepth < nestingDepth → 展示 max（nestingDepth 更严）", () => {
    // forkDepth=1（最内 fork），nestingDepth=5（通用嵌套已深）→ 展示 5
    const block = buildEnvBlock(tmpGitRepo, 1, 5);
    expect(block).toContain(`Depth: 5/${MAX_FORK_DEPTH}`);
    expect(block).not.toContain(`Depth: 1/${MAX_FORK_DEPTH}`);
  });

  it("forkDepth > nestingDepth → 展示 max（forkDepth 更严）", () => {
    const block = buildEnvBlock(tmpGitRepo, 7, 2);
    expect(block).toContain(`Depth: 7/${MAX_FORK_DEPTH}`);
  });

  it("forkDepth=0 + nestingDepth>0 → 展示 nestingDepth（非 fork 嵌套也计入）", () => {
    // 非 fork 但有嵌套（如顶层 → 子 → 孙），nestingDepth=2 应展示
    const block = buildEnvBlock(tmpGitRepo, undefined, 2);
    expect(block).toContain(`Depth: 2/${MAX_FORK_DEPTH}`);
  });

  it("git branch 存在 → 含 Git branch 行", () => {
    const block = buildEnvBlock(tmpGitRepo);
    expect(block).toContain(`Git branch: ${testBranch}`);
  });

  it("非 git 目录 → 不含 Git branch 行（git 失败兜底空串）", () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "envblock-nogit-"));
    try {
      const block = buildEnvBlock(nonGitDir);
      expect(block).not.toContain("Git branch:");
      // 但仍含 working directory（环境块始终输出）
      expect(block).toContain(`Working directory: ${nonGitDir}`);
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it("git 失败（execFileSync throw）→ 不崩，静默省略 branch", () => {
    const mockExec = vi.spyOn(
      { execFileSync },
      "execFileSync",
    );
    mockExec.mockImplementation(() => {
      throw new Error("git not found");
    });
    try {
      const block = buildEnvBlock("/some/cwd");
      expect(block).not.toContain("Git branch:");
      expect(block).toContain("Working directory: /some/cwd");
    } finally {
      mockExec.mockRestore();
    }
  });
});
