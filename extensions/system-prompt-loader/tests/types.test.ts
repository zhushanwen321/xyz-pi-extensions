import { describe, expect, expectTypeOf, it } from "vitest";

import {
  type ConfigSource,
  kindRankOf,
  type LoaderConfig,
  NOISE_DIRS,
  type RuleFile,
  type SourceMeta,
  type ValidateResult,
} from "../src/types.ts";

/**
 * W1 types.ts 类型守卫测试。
 *
 * types.ts 是纯类型定义模块（骨架 79 行已对齐 §3 签名表），无运行时逻辑。
 * 唯二有运行时行为的导出：`kindRankOf`（kind→kindRank 映射，FR-3.1）+ `NOISE_DIRS`（readonly Set）。
 * 其余为类型层断言（用 expectTypeOf + @ts-expect-error 让 tsc 兜底）。
 *
 * 覆盖 AC：
 * - AC-1.1（ConfigSource 判别联合 4 kind 各必填字段穷尽）
 * - AC-1.2（LoaderConfig.sources 可空数组）
 * - AC-1.3（types.ts 无出向 import——grep 校验，见 W7）
 * - RuleFile.sourceId 字段存在（CA-4，FR-3.1 排序键）
 * - SourceMeta = Map<number,{kindRank,declIdx}>
 * - NoiseDirs 含 16 项（D-5）
 * - kindRankOf 4 kind 映射正确（explicit=0<walk-files=1<walk-dirs=2<glob=3）
 *
 * 间接支撑用例（无独立运行时断言）：T1.1（ConfigSource 4 kind 是收集前提）、T4.1（sourceId 是排序键）。
 */

describe("AC-1.1 ConfigSource 判别联合 4 kind", () => {
  it("kind: explicit 必填 path: string", () => {
    const s: ConfigSource = { kind: "explicit", path: "/x" };
    expectTypeOf(s).toMatchTypeOf<ConfigSource>();
    expect(s.kind).toBe("explicit");
  });

  it("kind: walk-files 必填 filenames: string[]", () => {
    const s: ConfigSource = { kind: "walk-files", filenames: ["CLAUDE.md"] };
    expectTypeOf(s).toMatchTypeOf<ConfigSource>();
    expect(s.kind).toBe("walk-files");
  });

  it("kind: walk-dirs 必填 dirnames: string[]", () => {
    const s: ConfigSource = { kind: "walk-dirs", dirnames: ["rules"] };
    expectTypeOf(s).toMatchTypeOf<ConfigSource>();
    expect(s.kind).toBe("walk-dirs");
  });

  it("kind: glob 必填 patterns: string[]", () => {
    const s: ConfigSource = { kind: "glob", patterns: ["**/*.md"] };
    expectTypeOf(s).toMatchTypeOf<ConfigSource>();
    expect(s.kind).toBe("glob");
  });

  it("判别联合：kind 缺失/未知 → 编译期拒绝（@ts-expect-error 兜底）", () => {
    // 非法 kind——tsc 编译失败，@ts-expect-error 吞掉错误使其通过
    // @ts-expect-error unknown kind not in union
    const bad1: ConfigSource = { kind: "unknown", path: "/x" };
    // @ts-expect-error explicit missing required path
    const bad2: ConfigSource = { kind: "explicit" };
    // @ts-expect-error walk-files requires filenames (not dirnames)
    const bad3: ConfigSource = { kind: "walk-files", dirnames: ["x"] };
    expect(bad1).toBeDefined();
    expect(bad2).toBeDefined();
    expect(bad3).toBeDefined();
  });

  it("kind 类型穷尽：ConfigSource['kind'] 恰为 4 值联合", () => {
    expectTypeOf<ConfigSource["kind"]>()
      .toEqualTypeOf<"explicit" | "walk-files" | "walk-dirs" | "glob">();
  });
});

describe("AC-1.2 LoaderConfig.sources 可空数组", () => {
  it("sources 可为 []", () => {
    const cfg: LoaderConfig = { sources: [] };
    expectTypeOf(cfg).toMatchTypeOf<LoaderConfig>();
    expect(cfg.sources).toHaveLength(0);
  });

  it("sources 可含多类 source", () => {
    const cfg: LoaderConfig = {
      sources: [
        { kind: "explicit", path: "/a" },
        { kind: "glob", patterns: ["**/*.md"] },
      ],
    };
    expect(cfg.sources).toHaveLength(2);
  });
});

describe("RuleFile.sourceId（CA-4 / FR-3.1 排序键）", () => {
  it("含 path/realPath/content/sourceId 四必填字段", () => {
    const r: RuleFile = {
      path: "x.md",
      realPath: "/abs/x.md",
      content: "body",
      sourceId: 0,
    };
    expectTypeOf(r).toMatchTypeOf<RuleFile>();
    expect(r.sourceId).toBe(0);
  });

  it("globs 可选（无条件规则无 globs）", () => {
    const conditional: RuleFile = {
      path: "c.md",
      realPath: "/abs/c.md",
      content: "body",
      globs: ["**/test/**"],
      sourceId: 1,
    };
    const unconditional: RuleFile = {
      path: "u.md",
      realPath: "/abs/u.md",
      content: "body",
      sourceId: 2,
    };
    expect(conditional.globs).toEqual(["**/test/**"]);
    expect(unconditional.globs).toBeUndefined();
  });
});

describe("SourceMeta = Map<number,{kindRank,declIdx}>", () => {
  it("类型可正确构造与读写", () => {
    const meta: SourceMeta = new Map([
      [0, { kindRank: 0, declIdx: 0 }],
      [1, { kindRank: 3, declIdx: 1 }],
    ]);
    expectTypeOf(meta).toMatchTypeOf<SourceMeta>();
    expect(meta.get(0)).toEqual({ kindRank: 0, declIdx: 0 });
    expect(meta.get(1)).toEqual({ kindRank: 3, declIdx: 1 });
  });
});

describe("ValidateResult 判别联合", () => {
  it("ok:true 与 ok:false + reason 两种形态", () => {
    const ok: ValidateResult = { ok: true };
    const fail: ValidateResult = { ok: false, reason: "boom" };
    expectTypeOf(ok).toMatchTypeOf<ValidateResult>();
    expectTypeOf(fail).toMatchTypeOf<ValidateResult>();
    expect(ok.ok).toBe(true);
    expect(fail.ok).toBe(false);
    expect(fail.reason).toBe("boom");
  });
});

describe("NOISE_DIRS（D-5，16 项噪声目录）", () => {
  it("含 16 个噪声目录 basename", () => {
    const expected = [
      ".git",
      ".hg",
      ".svn",
      "node_modules",
      "bower_components",
      "jspm_packages",
      ".venv",
      "venv",
      "env",
      "__pycache__",
      "dist",
      "build",
      ".next",
      ".turbo",
      ".cache",
      "out",
    ];
    expect(NOISE_DIRS.size).toBe(16);
    for (const dir of expected) {
      expect(NOISE_DIRS.has(dir), `NOISE_DIRS should contain ${dir}`).toBe(true);
    }
  });

  it("是 readonly（不可 add——类型层，运行时不强制但 Set 暴露 add 仅类型禁）", () => {
    // ReadonlySet 类型——编译期阻止 add/delete/clear
    expectTypeOf(NOISE_DIRS).toMatchTypeOf<ReadonlySet<string>>();
    expect(NOISE_DIRS.has("node_modules")).toBe(true);
    expect(NOISE_DIRS.has("src")).toBe(false);
  });
});

describe("kindRankOf（FR-3.1 优先级源序：explicit=0<walk-files=1<walk-dirs=2<glob=3）", () => {
  it("explicit → 0（最高优先级）", () => {
    expect(kindRankOf("explicit")).toBe(0);
  });

  it("walk-files → 1", () => {
    expect(kindRankOf("walk-files")).toBe(1);
  });

  it("walk-dirs → 2", () => {
    expect(kindRankOf("walk-dirs")).toBe(2);
  });

  it("glob → 3（最低优先级）", () => {
    expect(kindRankOf("glob")).toBe(3);
  });

  it("4 kind 严格递增（first-wins 优先级语义正确）", () => {
    expect(kindRankOf("explicit")).toBeLessThan(kindRankOf("walk-files"));
    expect(kindRankOf("walk-files")).toBeLessThan(kindRankOf("walk-dirs"));
    expect(kindRankOf("walk-dirs")).toBeLessThan(kindRankOf("glob"));
  });
});
