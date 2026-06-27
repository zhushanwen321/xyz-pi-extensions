import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectSources, isInHomeTree } from "../src/discovery.ts";

/**
 * W4 discovery.ts 验证测试（覆盖 UC-1 discovery 链路：4 收集器 + findMarkdownFiles + expandPath）。
 *
 * discovery.ts 是 Adapter 层（fs 副作用）。用 os.tmpdir 构造隔离 fs fixture 真集成测试。
 * 本 Wave 重构了骨架：displayPath 2 参→4 参 kind 分化（AC-5.8/T1.18）+ SV-5 合并收敛 ≤200 行。
 *
 * 覆盖 AC / 用例：
 * - T1.1 / AC-5.1（4 类 source 各收集成功，realPath 唯一）
 * - T1.5 / AC-5.4 + BC-9（fs 错误静默跳过，不抛/不中断）
 * - T1.6 / AC-5.3（walk cwd 在 home 外退化只扫 cwd 一级）
 * - T1.7 / AC-5.2 + BC-2（walk 止点 home，不扫更高级）
 * - T1.8 / AC-5.6 + BC-6 + SV-4（symlink 环防护 visited Set，realPath key）
 * - T1.9 / AC-5.5 + NFR-AC-8 + SV-2（噪声目录排除）
 * - T1.10 / AC-5.7 + BC-12（仅 .md 加载）
 * - T1.16 / AC-2.5 + FR-2.1 + CA-8（`~`/绝对/相对路径展开，归 expandPath）
 * - T1.18 / AC-5.8 + BC-15（显示路径按 kind 构造）
 * - AC-5.11（source 内 root→CWD 序，walk 收集顺序）
 * - SV-5（discovery.ts ≤200 行——LOC 复核见 W4 提交）
 *
 * 关键约束：
 * - cwd 必须在 home 子树内（home/cwd），walk 才会向上遍历到 home（T1.6 例外测退化）
 * - realPath 是去重键（realpathSync 规范化），T1.1 断言唯一性
 */

/**
 * tmpdir fixture：构造 home/ + home/cwd 双层临时目录（使 cwd 在 home 子树，walk 可达 home）。
 * 提供 write/mkdir/symlink helper + cleanup。每个 test 独立 fixture。
 */
function useFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spl-disc-home-"));
  const cwd = path.join(home, "project");
  fs.mkdirSync(cwd, { recursive: true });
  const write = (rel: string, content: string): string => {
    const abs = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  };
  const writeAt = (absDir: string, name: string, content: string): string => {
    fs.mkdirSync(absDir, { recursive: true });
    const abs = path.join(absDir, name);
    fs.writeFileSync(abs, content);
    return abs;
  };
  const mkdir = (rel: string): string => {
    const abs = path.join(cwd, rel);
    fs.mkdirSync(abs, { recursive: true });
    return abs;
  };
  const symlink = (target: string, linkPath: string): void => {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(target, linkPath);
  };
  return {
    home,
    cwd,
    write,
    writeAt,
    mkdir,
    symlink,
    cleanup: () => {
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

describe("T1.1 / AC-5.1 四类 source 各收集成功，realPath 唯一", () => {
  let fx: ReturnType<typeof useFixture>;
  beforeEach(() => {
    fx = useFixture();
  });
  afterEach(() => fx.cleanup());

  it("explicit + walk-files + walk-dirs + glob 全存在 → 4 类各产出 RuleFile，realPath 唯一", () => {
    fx.write("explicit.md", "explicit body");
    fx.writeAt(fx.home, ".cursorules", "home cursorules"); // walk-files 在 home 级命中
    fx.write("docs/a.md", "docs body"); // walk-dirs 命中
    fx.write("global.md", "glob body"); // glob 命中

    const rules = collectSources(
      [
        { kind: "explicit", path: "explicit.md" },
        { kind: "walk-files", filenames: [".cursorules"] },
        { kind: "walk-dirs", dirnames: ["docs"] },
        { kind: "glob", patterns: ["global.md"] },
      ],
      fx.cwd,
      fx.home,
    );

    expect(rules).toHaveLength(4);
    // 4 类各 1 条（sourceId 0..3）
    const bySource = new Map(rules.map((r) => [r.sourceId, r]));
    expect(bySource.size).toBe(4);
    // realPath 全唯一（去重键，AC-5.1）
    const realPaths = rules.map((r) => r.realPath);
    expect(new Set(realPaths).size).toBe(4);
    // 内容正确
    expect(bySource.get(0)?.content).toBe("explicit body");
    expect(bySource.get(1)?.content).toBe("home cursorules");
    expect(bySource.get(2)?.content).toBe("docs body");
    expect(bySource.get(3)?.content).toBe("glob body");
  });

  it("AC-5.1: 每个 source 打声明序 sourceId（= 数组下标）", () => {
    fx.write("a.md", "a");
    fx.write("b.md", "b");
    const rules = collectSources(
      [
        { kind: "explicit", path: "a.md" },
        { kind: "explicit", path: "b.md" },
      ],
      fx.cwd,
      fx.home,
    );
    expect(rules.map((r) => r.sourceId)).toEqual([0, 1]);
  });
});

describe("T1.5 / AC-5.4 + BC-9 fs 错误静默跳过", () => {
  let fx: ReturnType<typeof useFixture>;
  beforeEach(() => {
    fx = useFixture();
  });
  afterEach(() => fx.cleanup());

  it("explicit path 不存在（ENOENT）→ 静默返回[]，不 throw", () => {
    expect(() =>
      collectSources([{ kind: "explicit", path: "nonexistent.md" }], fx.cwd, fx.home),
    ).not.toThrow();
    const rules = collectSources([{ kind: "explicit", path: "nonexistent.md" }], fx.cwd, fx.home);
    expect(rules).toEqual([]);
  });

  it("walk-files filenames 不存在 → 静默空", () => {
    const rules = collectSources(
      [{ kind: "walk-files", filenames: [".no-such-file"] }],
      fx.cwd,
      fx.home,
    );
    expect(rules).toEqual([]);
  });

  it("walk-dirs dirnames 不存在 → 静默空", () => {
    const rules = collectSources(
      [{ kind: "walk-dirs", dirnames: ["no-such-dir"] }],
      fx.cwd,
      fx.home,
    );
    expect(rules).toEqual([]);
  });

  it("BC-9: 一个坏 source 不中断其余 source 收集", () => {
    fx.write("good.md", "good body");
    const rules = collectSources(
      [
        { kind: "explicit", path: "bad.md" },
        { kind: "explicit", path: "good.md" },
      ],
      fx.cwd,
      fx.home,
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].content).toBe("good body");
  });

  it("EACCES（无读权限目录）静默跳过，不 throw", () => {
    const restricted = fx.mkdir("restricted");
    fx.write("restricted/secret.md", "secret");
    fs.chmodSync(restricted, 0o000);
    try {
      expect(() =>
        collectSources([{ kind: "walk-dirs", dirnames: ["restricted"] }], fx.cwd, fx.home),
      ).not.toThrow();
      const rules = collectSources(
        [{ kind: "walk-dirs", dirnames: ["restricted"] }],
        fx.cwd,
        fx.home,
      );
      expect(rules).toEqual([]);
    } finally {
      fs.chmodSync(restricted, 0o755); // 恢复以便 cleanup
    }
  });
});

describe("T1.6 / AC-5.3 walk cwd 在 home 外退化只扫 cwd 一级", () => {
  let fx: ReturnType<typeof useFixture>;
  beforeEach(() => {
    fx = useFixture();
  });
  afterEach(() => fx.cleanup());

  it("cwd 不在 home 子树 → walk 只扫 cwd 一级，不扫 home", () => {
    const outsideCwd = fs.mkdtempSync(path.join(os.tmpdir(), "spl-disc-out-"));
    try {
      fs.writeFileSync(path.join(outsideCwd, ".cursorules"), "outside cwd only");
      fx.writeAt(fx.home, ".cursorules", "at home (should NOT be found)");
      const rules = collectSources(
        [{ kind: "walk-files", filenames: [".cursorules"] }],
        outsideCwd,
        fx.home,
      );
      // 只找到 cwd 一级的文件，不向上走到 home
      expect(rules).toHaveLength(1);
      expect(rules[0].content).toBe("outside cwd only");
    } finally {
      fs.rmSync(outsideCwd, { recursive: true, force: true });
    }
  });
});

describe("T1.7 / AC-5.2 + BC-2 walk 止点 home，不扫更高级", () => {
  let fx: ReturnType<typeof useFixture>;
  beforeEach(() => {
    fx = useFixture();
  });
  afterEach(() => fx.cleanup());

  it("walk 从 cwd 向上到 home 止于 home，不扫 home 之外的祖先", () => {
    // cwd = home/project（深层），walk 应遍历 home/project → home，止于 home
    fx.writeAt(fx.cwd, ".cursorules", "at cwd");
    fx.writeAt(fx.home, ".cursorules", "at home root");
    const rules = collectSources(
      [{ kind: "walk-files", filenames: [".cursorules"] }],
      fx.cwd,
      fx.home,
    );
    // 命中 cwd + home 两级（root→CWD 序：home 在前，cwd 在后）
    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.content)).toEqual(["at home root", "at cwd"]);
  });

  it("AC-5.11: walk 收集顺序 root→CWD（home 在前，cwd 在后）", () => {
    fx.writeAt(fx.home, ".cursorules", "home");
    fx.writeAt(fx.cwd, ".cursorules", "cwd");
    const rules = collectSources(
      [{ kind: "walk-files", filenames: [".cursorules"] }],
      fx.cwd,
      fx.home,
    );
    expect(rules.map((r) => r.content)).toEqual(["home", "cwd"]);
  });
});

describe("T1.8 / AC-5.6 + BC-6 + SV-4 symlink 环防护", () => {
  let fx: ReturnType<typeof useFixture>;
  beforeEach(() => {
    fx = useFixture();
  });
  afterEach(() => fx.cleanup());

  it("symlink 环 a→b→a 不无限递归（visited Set realPath key）", () => {
    const dirA = fx.mkdir("a");
    const dirB = fx.mkdir("b");
    fx.write("a/inA.md", "in a");
    fx.write("b/inB.md", "in b");
    // 构造环：a/linkToB → b，b/linkToA → a
    fx.symlink(dirB, path.join(dirA, "linkToB"));
    fx.symlink(dirA, path.join(dirB, "linkToA"));

    // 用 glob 触发 findMarkdownFiles 递归——不应超时/栈溢出
    const rules = collectSources(
      [{ kind: "glob", patterns: ["**/*.md"] }],
      fx.cwd,
      fx.home,
    );
    // 命中 a/inA.md + b/inB.md（realPath 去重后不重复进入环）
    expect(rules).toHaveLength(2);
    // realPath 经 realpathSync 规范化（macOS /var→/private/var），用 realpathSync 解析预期再比对
    const expected = [
      fs.realpathSync(path.join(dirA, "inA.md")),
      fs.realpathSync(path.join(dirB, "inB.md")),
    ].sort();
    expect(rules.map((r) => r.realPath).sort()).toEqual(expected);
  });
});

describe("T1.9 / AC-5.5 + NFR-AC-8 + SV-2 噪声目录排除", () => {
  let fx: ReturnType<typeof useFixture>;
  beforeEach(() => {
    fx = useFixture();
  });
  afterEach(() => fx.cleanup());

  it("node_modules 内 .md 被排除（噪声目录 basename 匹配 D-5）", () => {
    fx.write("keep.md", "kept");
    fx.write("node_modules/pkg/dep.md", "excluded dep");
    fx.write(".git/inside.md", "excluded git");
    fx.write("dist/build.md", "excluded dist");
    // *.md 匹配根级 keep.md；**/*.md 匹配嵌套 .md（但噪声目录内的被排除）
    const rules = collectSources(
      [{ kind: "glob", patterns: ["*.md", "**/*.md"] }],
      fx.cwd,
      fx.home,
    );
    // 只保留 keep.md，噪声目录内的 .md 全排除
    expect(rules).toHaveLength(1);
    expect(rules[0].content).toBe("kept");
  });
});

describe("T1.10 / AC-5.7 + BC-12 仅 .md 加载", () => {
  let fx: ReturnType<typeof useFixture>;
  beforeEach(() => {
    fx = useFixture();
  });
  afterEach(() => fx.cleanup());

  it(".txt/.md 混合 → 只收集 .md（glob 候选 + loadRuleFileEntry）", () => {
    fx.write("rule.md", "md content");
    fx.write("notes.txt", "text content");
    fx.write("data.json", "{}");
    const rules = collectSources(
      [{ kind: "glob", patterns: ["*"] }],
      fx.cwd,
      fx.home,
    );
    // 只 rule.md（findMarkdownFiles 仅收 .md；glob patterns=* 匹配但不影响 .md 过滤）
    expect(rules.every((r) => r.realPath.endsWith(".md"))).toBe(true);
    expect(rules.map((r) => r.content)).toContain("md content");
  });

  it("explicit 单文件非 .md 也能加载（explicit 不强制 .md，仅 glob 强制 BC-12）", () => {
    fx.write("config.yaml", "yaml content");
    const rules = collectSources(
      [{ kind: "explicit", path: "config.yaml" }],
      fx.cwd,
      fx.home,
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].content).toBe("yaml content");
  });
});

describe("T1.16 / AC-2.5 + FR-2.1 + CA-8 `~`/绝对/相对路径展开", () => {
  let fx: ReturnType<typeof useFixture>;
  beforeEach(() => {
    fx = useFixture();
  });
  afterEach(() => fx.cleanup());

  it("`~/x` → home 展开（~ 展开归 discovery.expandPath，CA-8）", () => {
    fx.writeAt(fx.home, "tildefile.md", "tilde content");
    const rules = collectSources(
      [{ kind: "explicit", path: "~/tildefile.md" }],
      fx.cwd,
      fx.home,
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].content).toBe("tilde content");
  });

  it("`/abs/x` 绝对路径 → 直用", () => {
    fx.write("absfile.md", "abs content");
    const abs = path.join(fx.cwd, "absfile.md");
    const rules = collectSources(
      [{ kind: "explicit", path: abs }],
      fx.cwd,
      fx.home,
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].content).toBe("abs content");
  });

  it("`rel/x` 相对路径 → resolve(cwd, rel/x)", () => {
    fx.write("rel/x.md", "rel content");
    const rules = collectSources(
      [{ kind: "explicit", path: "rel/x.md" }],
      fx.cwd,
      fx.home,
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].content).toBe("rel content");
  });

  it("`~` 单独（裸 ~）→ home 本身", () => {
    // home 作为目录，内有 .md——explicit path="~" 应展开为 home 并当目录递归
    fx.writeAt(fx.home, "root.md", "home root md");
    const rules = collectSources(
      [{ kind: "explicit", path: "~" }],
      fx.cwd,
      fx.home,
    );
    expect(rules.length).toBeGreaterThanOrEqual(1);
    expect(rules.some((r) => r.content === "home root md")).toBe(true);
  });
});

describe("T1.18 / AC-5.8 + BC-15 显示路径按 kind 构造", () => {
  let fx: ReturnType<typeof useFixture>;
  beforeEach(() => {
    fx = useFixture();
  });
  afterEach(() => fx.cleanup());

  it("explicit：显示路径 = configuredPath 原样（~ 已展开的配置字符串）", () => {
    fx.writeAt(fx.home, "configured.md", "body");
    const rules = collectSources(
      [{ kind: "explicit", path: "~/configured.md" }],
      fx.cwd,
      fx.home,
    );
    expect(rules).toHaveLength(1);
    // explicit 用配置 path 原样（不展开、不 relative 化），可辨识即可
    expect(rules[0].path).toBe("~/configured.md");
  });

  it("walk-files：显示路径 = path.relative(cwd, 文件所在目录) 或 .", () => {
    fx.writeAt(fx.cwd, ".cursorules", "at cwd"); // 文件在 cwd → dirname=cwd → "."
    const rules = collectSources(
      [{ kind: "walk-files", filenames: [".cursorules"] }],
      fx.cwd,
      fx.home,
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].path).toBe("."); // 文件就在 cwd，relative(cwd,cwd)=""
  });

  it("walk-dirs：显示路径 = path.relative(cwd, 文件所在目录)", () => {
    fx.write("docs/a.md", "docs body"); // 文件在 cwd/docs → dirname=docs → "docs"
    const rules = collectSources(
      [{ kind: "walk-dirs", dirnames: ["docs"] }],
      fx.cwd,
      fx.home,
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].path).toBe("docs"); // relative(cwd, cwd/docs) = "docs"
  });

  it("glob：显示路径 = path.relative(cwd, 文件) 或 .（链接路径空间）", () => {
    fx.write("deep/glob.md", "glob body");
    const rules = collectSources(
      [{ kind: "glob", patterns: ["**/*.md"] }],
      fx.cwd,
      fx.home,
    );
    expect(rules).toHaveLength(1);
    // glob 用完整文件相对路径（含文件名）
    expect(rules[0].path).toBe("deep/glob.md");
  });

  it("kind 分化对比：同一文件经不同 kind 收集，显示路径不同", () => {
    // 同一文件 config.md，分别用 explicit 和 glob 收集
    fx.write("shared.md", "shared body");
    const explicitRules = collectSources(
      [{ kind: "explicit", path: "shared.md" }],
      fx.cwd,
      fx.home,
    );
    const globRules = collectSources(
      [{ kind: "glob", patterns: ["*.md"] }],
      fx.cwd,
      fx.home,
    );
    // explicit 用配置 path 原样 "shared.md"；glob 用 relative(cwd,file) = "shared.md"
    // 此例两者字面相同但来源不同（explicit 读 configuredPath，glob 读 relative）
    expect(explicitRules[0].path).toBe("shared.md");
    expect(globRules[0].path).toBe("shared.md");
    // 但若 explicit 用 ~/ 前缀，分化立现（见上 explicit 测试）
  });
});

describe("边界：collectSources 空入参 + cwd===home 单层遍历", () => {
  let fx: ReturnType<typeof useFixture>;
  beforeEach(() => {
    fx = useFixture();
  });
  afterEach(() => fx.cleanup());

  it("collectSources([], cwd, home) → 空数组（导出函数空入参边界）", () => {
    expect(collectSources([], fx.cwd, fx.home)).toEqual([]);
  });

  it("cwd===home：walk 单层遍历不退化、不向上越界", () => {
    // cwd 恰等于 home：isInHomeTree 真，walkDirs 遍历 [home] 单级，
    // 不退化（不像 T1.6 只扫 cwd 一级），也不向上越界到 home 之外。
    fx.writeAt(fx.home, ".cursorules", "at home root");
    // 不在 home 之外放任何文件，确保不误收
    const rules = collectSources(
      [{ kind: "walk-files", filenames: [".cursorules"] }],
      fx.home, // cwd === home
      fx.home,
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].content).toBe("at home root");
  });
});

describe("isInHomeTree home===\"/\" 边界（S1 回归保护）", () => {
  it("home=\"/\" 时任意绝对路径都在 home 子树内（home+sep=\"//\" 误判已修）", () => {
    expect(isInHomeTree("/Users/x", "/")).toBe(true);
    expect(isInHomeTree("/Users/x/proj", "/")).toBe(true);
    expect(isInHomeTree("/", "/")).toBe(true); // cwd===home
  });

  it("home=\"/h\" 正常子树判定不受影响", () => {
    expect(isInHomeTree("/h/proj", "/h")).toBe(true);
    expect(isInHomeTree("/h", "/h")).toBe(true);
    expect(isInHomeTree("/other", "/h")).toBe(false);
  });
});
