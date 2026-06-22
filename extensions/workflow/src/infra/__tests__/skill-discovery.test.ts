// 测试框架：vitest
// 运行命令：npx vitest run src/infra/__tests__/skill-discovery.test.ts
//
// T-3: resolveSkillPath() 单元测试——对称 agent-discovery.test.ts 的覆盖模式。
//
// 覆盖：
//   1. Project-level skill（.agents/skills/<name>/）发现
//   2. Global skill（~/.pi/agent/skills/<name>/）发现
//   3. npm 包 skill（~/.pi/agent/npm/node_modules/<pkg>/skills/<name>/）发现
//   4. 优先级：project > global > npm
//   5. 不存在的 skill → undefined
//   6. npm 目录不存在不抛错
//
// 注意：skill-discovery.ts 有模块级 skillCandidatesCache，测试间需 resetModules
// 避免缓存污染。每个用例 doMock + 动态 import 获得新鲜模块实例。

import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

const HOME = "/fake/home";
const CWD = "/fake/cwd";

/** project skill 目录路径 */
function projectSkillDir(name: string): string {
  return path.resolve(CWD, ".agents/skills", name);
}
/** global skill 目录路径 */
function globalSkillDir(name: string): string {
  return path.join(HOME, ".pi/agent/skills", name);
}
/** npm skill 目录路径 */
function npmSkillDir(pkg: string, name: string): string {
  return path.join(HOME, ".pi/agent/npm/node_modules", pkg, "skills", name);
}

/**
 * 加载一个新鲜的 skill-discovery 模块实例（带 mock 的 os/fs）。
 * 每次 doMock + resetModules 保证模块级缓存不跨用例污染。
 */
async function loadResolver(opts: {
  existsDirs: Set<string>;
  npmPackages: string[];
}): Promise<{ resolveSkillPath: (name: string) => string | undefined }> {
  const { existsDirs, npmPackages } = opts;
  vi.resetModules();
  vi.doMock("node:os", () => ({ homedir: () => HOME }));
  vi.doMock("node:fs", () => ({
    existsSync: (p: string) => existsDirs.has(p),
    readdirSync: () => {
      if (npmPackages.length === 0) {
        const err: NodeJS.ErrnoException = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return npmPackages;
    },
  }));
  const mod = await import("../skill-discovery.js");
  return { resolveSkillPath: mod.resolveSkillPath };
}

describe("resolveSkillPath", () => {
  it("TC-S-01: 发现 project-level skill（.agents/skills/<name>/）", async () => {
    vi.stubGlobal("process", { ...process, cwd: () => CWD });
    try {
      const existsDirs = new Set([projectSkillDir("my-skill")]);
      const { resolveSkillPath } = await loadResolver({ existsDirs, npmPackages: [] });
      expect(resolveSkillPath("my-skill")).toBe(projectSkillDir("my-skill"));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("TC-S-02: 发现 global skill（~/.pi/agent/skills/<name>/）", async () => {
    vi.stubGlobal("process", { ...process, cwd: () => CWD });
    try {
      const existsDirs = new Set([globalSkillDir("global-skill")]);
      const { resolveSkillPath } = await loadResolver({ existsDirs, npmPackages: [] });
      expect(resolveSkillPath("global-skill")).toBe(globalSkillDir("global-skill"));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("TC-S-03: 发现 npm 包 skill（~/.pi/agent/npm/node_modules/<pkg>/skills/<name>/）", async () => {
    vi.stubGlobal("process", { ...process, cwd: () => CWD });
    try {
      const existsDirs = new Set([npmSkillDir("pi-coding-workflow", "npm-skill")]);
      const { resolveSkillPath } = await loadResolver({
        existsDirs,
        npmPackages: ["pi-coding-workflow"],
      });
      expect(resolveSkillPath("npm-skill")).toBe(
        npmSkillDir("pi-coding-workflow", "npm-skill"),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("TC-S-04: 优先级 project > global > npm", async () => {
    vi.stubGlobal("process", { ...process, cwd: () => CWD });
    try {
      const existsDirs = new Set([
        projectSkillDir("shared"),
        globalSkillDir("shared"),
        npmSkillDir("pkg", "shared"),
      ]);
      const { resolveSkillPath } = await loadResolver({ existsDirs, npmPackages: ["pkg"] });
      expect(resolveSkillPath("shared")).toBe(projectSkillDir("shared"));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("TC-S-05: project 不存在 → 回退 global", async () => {
    vi.stubGlobal("process", { ...process, cwd: () => CWD });
    try {
      const existsDirs = new Set([globalSkillDir("fallback"), npmSkillDir("pkg", "fallback")]);
      const { resolveSkillPath } = await loadResolver({ existsDirs, npmPackages: ["pkg"] });
      expect(resolveSkillPath("fallback")).toBe(globalSkillDir("fallback"));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("TC-S-06: 不存在的 skill → undefined", async () => {
    vi.stubGlobal("process", { ...process, cwd: () => CWD });
    try {
      const existsDirs = new Set<string>();
      const { resolveSkillPath } = await loadResolver({ existsDirs, npmPackages: ["pkg"] });
      expect(resolveSkillPath("nonexistent")).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("TC-S-07: npm 目录不存在不抛错（返回 undefined 或回退路径）", async () => {
    vi.stubGlobal("process", { ...process, cwd: () => CWD });
    try {
      // npmPackages 为空 → readdirSync 抛 ENOENT → catch 兜底，不抛错
      const existsDirs = new Set([globalSkillDir("only-global")]);
      const { resolveSkillPath } = await loadResolver({ existsDirs, npmPackages: [] });
      expect(resolveSkillPath("only-global")).toBe(globalSkillDir("only-global"));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
