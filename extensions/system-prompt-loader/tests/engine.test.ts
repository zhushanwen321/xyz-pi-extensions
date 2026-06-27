import { describe, expect, it } from "vitest";

import {
  buildSuffix,
  dedupAndSort,
  parseFrontmatter,
  partitionRules,
} from "../src/engine.ts";
import type { RuleFile, SourceMeta } from "../src/types.ts";

/**
 * W3a engine.ts 纯函数验证测试（覆盖 UC-4 + UC-2 buildSuffix 部分）。
 *
 * engine.ts 是 4 纯函数（骨架已完整实现，零 fs/Pi import）。纯验证测试，不改 engine.ts。
 *
 * 覆盖 AC / 用例：
 * - T4.1 / AC-4.1（kind 优先级 first-wins：explicit kindRank 0 < walk-files 1）
 * - T4.2 / AC-4.2（条件/无条件分流）
 * - T4.3 / AC-4.3（空 globs=无条件，BC-16）
 * - T4.4 / AC-4.4（空内容过滤 BC-11——engine 层验 parseFrontmatter 返回空 content，真实跳过在 discovery W4）
 * - T4.5 / AC-4.10（source 内 root→CWD 序 + first-wins）
 * - T2.3 / AC-4.5（确定性输出，localeCompare）
 * - T2.4 / AC-4.6（注入格式 Rules 区 + Conditional 区，BC-7）
 * - AC-4.7（engine.ts 零 fs/Pi import——grep 校验 W7）
 * - AC-4.8（localeCompare 在 partitionRules——grep 校验 W7）
 * - AC-4.9（LOC ≤~85——wc 复核 W7）
 *
 * 关键约束：dedupAndSort **不含 localeCompare**（localeCompare 在 partitionRules，CA-4/[BACKFED]）。
 */

/** 构造 RuleFile 辅助（减少样板） */
function rf(
  path: string,
  opts: {
    realPath?: string;
    content?: string;
    globs?: string[];
    sourceId?: number;
  } = {},
): RuleFile {
  return {
    path,
    realPath: opts.realPath ?? `/${path}`,
    content: opts.content ?? "body",
    ...(opts.globs ? { globs: opts.globs } : {}),
    sourceId: opts.sourceId ?? 0,
  };
}

/** 构造 sourceMeta 辅助：sourceId → (kindRank, declIdx) */
function meta(entries: Array<[number, number]>): SourceMeta {
  const m = new Map();
  for (const [sourceId, kindRank] of entries) {
    m.set(sourceId, { kindRank, declIdx: sourceId });
  }
  return m;
}

/** buildSuffix 返回 string | null；测试中有输入时断言非空并返回 string 供 .indexOf 用。 */
function expectSuffix(
  unconditional: RuleFile[],
  conditional: RuleFile[],
): string {
  const out = buildSuffix(unconditional, conditional);
  expect(out).not.toBeNull();
  return out as string;
}

describe("T4.1 / AC-4.1 kind 优先级 first-wins", () => {
  it("同 realPath 被 explicit(kindRank 0) + walk-files(kindRank 1) 命中 → 保留 explicit", () => {
    const rules = [
      rf("dup.md", { realPath: "/dup.md", content: "from-walkfiles", sourceId: 1 }),
      rf("dup.md", { realPath: "/dup.md", content: "from-explicit", sourceId: 0 }),
    ];
    // sourceId 0 = explicit (kindRank 0)，sourceId 1 = walk-files (kindRank 1)
    const m = meta([
      [0, 0],
      [1, 1],
    ]);
    const deduped = dedupAndSort(rules, m);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].content).toBe("from-explicit");
  });

  it("不同 realPath 不去重，各自保留", () => {
    const rules = [
      rf("a.md", { sourceId: 0 }),
      rf("b.md", { sourceId: 1 }),
    ];
    const m = meta([
      [0, 0],
      [1, 1],
    ]);
    expect(dedupAndSort(rules, m)).toHaveLength(2);
  });

  it("glob(kindRank 3) 最低优先级，被 walk-dirs(2) 命中时保留 walk-dirs", () => {
    const rules = [
      rf("x.md", { realPath: "/x.md", content: "from-glob", sourceId: 1 }),
      rf("x.md", { realPath: "/x.md", content: "from-walkdirs", sourceId: 0 }),
    ];
    const m = meta([
      [0, 2],
      [1, 3],
    ]);
    const deduped = dedupAndSort(rules, m);
    expect(deduped[0].content).toBe("from-walkdirs");
  });
});

describe("T4.5 / AC-4.10 source 内 root→CWD 序 + first-wins", () => {
  it("同一 walk source 内：root 级(数组在前)排前，CWD 级排后", () => {
    // 模拟 collectWalkFiles 的 root→CWD 产出序（root 在数组前）
    const rules = [
      rf("CLAUDE.md", { realPath: "/root/CLAUDE.md", content: "root-level", sourceId: 0 }),
      rf("CLAUDE.md", { realPath: "/root/proj/CLAUDE.md", content: "cwd-level", sourceId: 0 }),
    ];
    const m = meta([[0, 1]]); // 同 source, walk-files kindRank 1
    const deduped = dedupAndSort(rules, m);
    // 不同 realPath → 都保留，序保持（root 先）
    expect(deduped).toHaveLength(2);
    expect(deduped[0].content).toBe("root-level");
    expect(deduped[1].content).toBe("cwd-level");
  });

  it("同 realPath 多级命中 → first-wins 保留数组首个（root 级，因 collect 产出 root→CWD 序）", () => {
    // 同一物理文件经 symlink/嵌套出现两次，realpath 相同
    const rules = [
      rf("link.md", { realPath: "/abs/link.md", content: "first-occurrence", sourceId: 0 }),
      rf("dup.md", { realPath: "/abs/link.md", content: "second-occurrence", sourceId: 0 }),
    ];
    const m = meta([[0, 1]]);
    const deduped = dedupAndSort(rules, m);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].content).toBe("first-occurrence");
  });

  it("跨 source 声明序与 source 内序是两层（declIdx 排序在前，source 内序保持）", () => {
    const rules = [
      rf("glob-rule.md", { sourceId: 2, realPath: "/g.md" }),
      rf("walk-rule.md", { sourceId: 1, realPath: "/w.md" }),
      rf("explicit-rule.md", { sourceId: 0, realPath: "/e.md" }),
    ];
    const m = meta([
      [0, 0],
      [1, 1],
      [2, 3],
    ]);
    const deduped = dedupAndSort(rules, m);
    // 排序：explicit(0) → walk(1) → glob(3)
    expect(deduped.map((r) => r.path)).toEqual([
      "explicit-rule.md",
      "walk-rule.md",
      "glob-rule.md",
    ]);
  });
});

describe("T4.2 / AC-4.2 条件/无条件分流", () => {
  it("有 globs → conditional；无 globs → unconditional", () => {
    const rules = [
      rf("u.md", { sourceId: 0 }),
      rf("c.md", { globs: ["**/test/**"], sourceId: 0 }),
    ];
    const { unconditional, conditional } = partitionRules(rules);
    expect(unconditional.map((r) => r.path)).toEqual(["u.md"]);
    expect(conditional.map((r) => r.path)).toEqual(["c.md"]);
  });

  it("全无条件规则 → conditional 空", () => {
    const rules = [rf("a.md"), rf("b.md")];
    const { unconditional, conditional } = partitionRules(rules);
    expect(unconditional).toHaveLength(2);
    expect(conditional).toHaveLength(0);
  });

  it("全条件规则 → unconditional 空", () => {
    const rules = [
      rf("a.md", { globs: ["x"] }),
      rf("b.md", { globs: ["y"] }),
    ];
    const { unconditional, conditional } = partitionRules(rules);
    expect(unconditional).toHaveLength(0);
    expect(conditional).toHaveLength(2);
  });
});

describe("T4.3 / AC-4.3 parseFrontmatter 空 globs=无条件（BC-16）", () => {
  it("frontmatter `paths: []` 空数组 → 无 globs（判为无条件）", () => {
    const parsed = parseFrontmatter("---\npaths: []\n---\nbody content");
    expect(parsed.globs).toBeUndefined();
    expect(parsed.content).toBe("body content");
  });

  it("无 frontmatter → 无 globs", () => {
    const parsed = parseFrontmatter("just plain content");
    expect(parsed.globs).toBeUndefined();
    expect(parsed.content).toBe("just plain content");
  });

  it("frontmatter paths 非空 → 有 globs（条件规则）", () => {
    const parsed = parseFrontmatter('---\npaths: ["**/test/**", "**/spec/**"]\n---\nbody');
    expect(parsed.globs).toEqual(["**/test/**", "**/spec/**"]);
  });

  it("block 数组格式 paths 也正确解析", () => {
    const parsed = parseFrontmatter("---\npaths:\n  - a/b\n  - c/d\n---\nbody");
    expect(parsed.globs).toEqual(["a/b", "c/d"]);
  });

  it("空 globs 的 RuleFile 进 unconditional（partitionRules 视角）", () => {
    // parseFrontmatter 对 paths:[] 返回无 globs → partitionRules 归 unconditional
    const parsed = parseFrontmatter("---\npaths: []\n---\nbody");
    const rule = rf("empty-globs.md", {
      content: parsed.content,
      ...(parsed.globs ? { globs: parsed.globs } : {}),
    });
    const { unconditional, conditional } = partitionRules([rule]);
    expect(unconditional).toHaveLength(1);
    expect(conditional).toHaveLength(0);
  });
});

describe("T4.4 / AC-4.4 空内容（BC-11，engine 层边界）", () => {
  // 注：真实"空内容跳过"过滤在 discovery 的 loadSingleRuleFile/loadRulesFromDir
  // （!parsed.content → null/continue）。engine 层验 parseFrontmatter 对空内容
  // 返回 content:""（让上层据此过滤），buildSuffix 不产生额外规则。

  it("仅空白的内容 → parseFrontmatter 返回空 content（trim 后空）", () => {
    const parsed = parseFrontmatter("   \n  \n  ");
    expect(parsed.content).toBe("");
  });

  it("frontmatter 后无正文 → content 为空", () => {
    const parsed = parseFrontmatter('---\npaths: ["x"]\n---\n');
    expect(parsed.content).toBe("");
  });

  it("buildSuffix 对空 content 的 RuleFile 仍拼接（真实过滤在 discovery）", () => {
    // engine 不负责过滤空内容——它如实拼接。故此处仅验 parseFrontmatter 返回空。
    // 真实"不进输出"在 W4 discovery 测试验证（loadSingleRuleFile 返回 null）。
    const parsed = parseFrontmatter("");
    expect(parsed.content).toBe("");
  });
});

describe("T2.4 / AC-4.6 注入格式（BC-7）", () => {
  it("Rules 区：## Rules + ### path + 空行 + 正文，--- 分隔多条", () => {
    const unconditional = [
      rf("a.md", { content: "content A" }),
      rf("b.md", { content: "content B" }),
    ];
    const out = buildSuffix(unconditional, []);
    expect(out).toContain("## Rules\n");
    expect(out).toContain("### a.md\n\ncontent A");
    expect(out).toContain("### b.md\n\ncontent B");
    expect(out).toContain("---"); // 分隔符
  });

  it("Conditional 区：## Conditional Rules + - `path` (applies to: globs)", () => {
    const conditional = [
      rf("c.md", { content: "ignored in conditional", globs: ["**/test/**", "**/spec/**"] }),
    ];
    const out = expectSuffix([], conditional);
    expect(out).toContain("## Conditional Rules\n");
    expect(out).toContain("- `c.md` (applies to: **/test/**, **/spec/**)");
    // 路径用反引号包裹（非裸文本）
    expect(out).toContain("`c.md`");
  });

  it("两区都有 → Rules 区在前，Conditional 区在后", () => {
    const unconditional = [rf("u.md", { content: "uncond" })];
    const conditional = [rf("c.md", { globs: ["x"] })];
    const out = expectSuffix(unconditional, conditional);
    const rulesIdx = out.indexOf("## Rules");
    const condIdx = out.indexOf("## Conditional Rules");
    expect(rulesIdx).toBeLessThan(condIdx);
  });

  it("空集合 → null（BC-13 零副作用）", () => {
    expect(buildSuffix([], [])).toBeNull();
  });

  it("仅 unconditional 有规则 → 不含 Conditional 区", () => {
    const out = expectSuffix([rf("a.md")], []);
    expect(out).toContain("## Rules");
    expect(out).not.toContain("## Conditional Rules");
  });

  it("仅 conditional 有规则 → 不含 Rules 区", () => {
    const out = expectSuffix([], [rf("c.md", { globs: ["x"] })]);
    expect(out).not.toContain("## Rules\n");
    expect(out).toContain("## Conditional Rules");
  });
});

describe("T2.3 / AC-4.5 确定性输出（localeCompare，KV-cache 稳定）", () => {
  // 注意：buildSuffix 本身不排序——排序在 partitionRules（按 path localeCompare）。
  // 确定性是 partitionRules→buildSuffix 管线的属性，故下列测试走完整管线。

  /** 完整管线：partitionRules（排序+分流）→ buildSuffix */
  function pipeline(rules: RuleFile[]): string {
    const { unconditional, conditional } = partitionRules(rules);
    const out = buildSuffix(unconditional, conditional);
    expect(out).not.toBeNull();
    return out as string;
  }

  it("同输入多次管线 → 输出完全一致（localeCompare 排序，与输入序无关）", () => {
    const rules = [
      rf("zeta.md", { content: "z" }),
      rf("alpha.md", { content: "a" }),
      rf("mid.md", { content: "m" }),
    ];
    const run1 = pipeline(rules);
    const run2 = pipeline([...rules]);
    const run3 = pipeline([...rules].reverse()); // 输入乱序
    expect(run1).toBe(run2);
    expect(run1).toBe(run3);
  });

  it("无条件规则按 path 字典序排序", () => {
    const rules = [
      rf("zeta.md"),
      rf("alpha.md"),
      rf("mid.md"),
    ];
    const out = pipeline(rules);
    const alphaIdx = out.indexOf("### alpha.md");
    const midIdx = out.indexOf("### mid.md");
    const zetaIdx = out.indexOf("### zeta.md");
    expect(alphaIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(zetaIdx);
  });

  it("条件规则按 path 字典序排序", () => {
    const rules = [
      rf("zeta.md", { globs: ["z"] }),
      rf("alpha.md", { globs: ["a"] }),
    ];
    const out = pipeline(rules);
    const alphaIdx = out.indexOf("`alpha.md`");
    const zetaIdx = out.indexOf("`zeta.md`");
    expect(alphaIdx).toBeLessThan(zetaIdx);
  });

  it("确定性：dedupAndSort + partitionRules + buildSuffix 全链路同输入一致", () => {
    // 注意：同 realPath 规则去重 first-wins 依赖 collect 产出序（root→CWD，确定性），
    // 故本测用不同 realPath 的规则避免去重，验"分流+排序+拼接"的确定性。
    const rules = [
      rf("b.md", { realPath: "/b.md", globs: ["b"], sourceId: 0 }),
      rf("a.md", { realPath: "/a.md", sourceId: 0 }),
      rf("a2.md", { realPath: "/a2.md", globs: ["a2"], sourceId: 0 }),
    ];
    const m = meta([[0, 0]]);
    const run = (input: RuleFile[]): string => {
      const d = dedupAndSort(input, m);
      const { unconditional, conditional } = partitionRules(d);
      const out = buildSuffix(unconditional, conditional);
      expect(out).not.toBeNull();
      return out as string;
    };
    expect(run(rules)).toBe(run([...rules]));
    expect(run(rules)).toBe(run([...rules].reverse()));
  });
});
