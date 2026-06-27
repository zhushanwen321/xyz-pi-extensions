import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isMarkdown, matchGlob } from "../src/glob.ts";

/**
 * 包装版 RegExp：mock 拦截并计数构造，但仍委托给真实 RegExp
 * （否则 `new RegExp(...)` 返回无 .test 的 mock，破坏 matchGlob 行为）。
 *
 * 用 Object.assign 把真实 RegExp 的静态成员（prototype/$1 等）拷到构造函数上，
 * 让 spy 替换后的 global.RegExp 仍能参与 `/x/` 字面量与 instanceof。构造体本身
 * 委托 RealRegExp，行为等价。
 */
const RealRegExp = RegExp;
type RegExpConstructor = typeof RegExp;
function wrapRegExpCounting() {
  const calls: string[] = [];
  // 构造函数：计数 + 委托真实实现（保留 .test/.exec 行为）。
  const countingCtor = function RegExp(pattern: string | RegExp, flags?: string) {
    calls.push(String(pattern));
    return new RealRegExp(pattern as string, flags);
  } as RegExpConstructor;
  // 合并静态成员，避免 instanceof / 字面量路径行为变化。
  const MockedRegExp: RegExpConstructor = Object.assign(countingCtor, RealRegExp);
  const spy = vi.spyOn(global, "RegExp").mockImplementation(MockedRegExp);
  return { calls, spy };
}

/**
 * W2 glob.ts 纯函数验证测试（覆盖 UC-3，T3.1-T3.6 全 6 用例）。
 *
 * glob.ts 是叶子纯函数（零 fs/Pi import，骨架已完整实现）。
 * 不改 glob.ts——本 Wave 是纯验证。
 *
 * 覆盖 AC：
 * - AC-3.1（`*`单层不跨/、`**`跨/、`?`单字符）
 * - AC-3.2（不支持语法字面匹配不报错）
 * - AC-3.3（链接路径不 realpath）
 * - AC-3.4（glob.ts 零 fs/Pi import——grep 校验，见 W7）
 * - AC-3.5（LOC ≤~50——wc 复核，见 W7）
 * - SV-1（RegExp 缓存复用，编译只 1 次）
 */

describe("T3.1 / AC-3.1 `*` 单层匹配（不跨 /）", () => {
  it("单层命中", () => {
    expect(matchGlob("docs/*.md", "docs/a.md")).toBe(true);
  });

  it("不跨目录分隔符（子目录不命中）", () => {
    expect(matchGlob("docs/*.md", "docs/sub/a.md")).toBe(false);
  });

  it("仅匹配所在层（同层多字符 ok）", () => {
    expect(matchGlob("docs/*.md", "docs/readme.md")).toBe(true);
    expect(matchGlob("*.md", "a.md")).toBe(true);
    expect(matchGlob("*.md", "ab.md")).toBe(true);
  });
});

describe("T3.2 / AC-3.1 `**` 多层匹配（跨 /）", () => {
  it("跨多层目录命中", () => {
    expect(matchGlob("**/*.md", "a/b/c.md")).toBe(true);
  });

  it("单层子目录命中", () => {
    expect(matchGlob("**/*.md", "a/b.md")).toBe(true);
  });

  it("深层文件命中", () => {
    expect(matchGlob("**/*.md", "x/y/z/deep.md")).toBe(true);
  });

  // 注：本扩展 glob 是简化自实现（D-4），`**`→`.*`，`**/` 仍需一个字面 `/`。
  // 故 `**/*.md` 不命中根层 `a.md`（无 `/`）——这是设计内行为，非缺陷。
  // 根层文件应用 `*.md`（T3.1 已覆盖）。
  it("根层无 / 文件不命中 `**/*.md`（**/ 需字面 /，D-4 简化语义）", () => {
    expect(matchGlob("**/*.md", "a.md")).toBe(false);
  });
});

describe("T3.3 / AC-3.1 `?` 单字符匹配", () => {
  it("单字符命中", () => {
    expect(matchGlob("a?.md", "ab.md")).toBe(true);
  });

  it("多字符不命中（? 恰匹配 1 字符）", () => {
    expect(matchGlob("a?.md", "abc.md")).toBe(false);
  });

  it("零字符不命中", () => {
    expect(matchGlob("a?.md", "a.md")).toBe(false);
  });
});

describe("T3.4 / AC-3.2 不支持语法按字面匹配（不报错）", () => {
  it("花括号 {} 按字面匹配（不支持 brace expansion）", () => {
    // {a,b} 不被解释为 alternation——按字面匹配文件名含字面 "{a,b}"
    expect(matchGlob("{a,b}.md", "{a,b}.md")).toBe(true);
    expect(matchGlob("{a,b}.md", "a.md")).toBe(false);
    expect(matchGlob("{a,b}.md", "b.md")).toBe(false);
  });

  it("字符类 [] 按字面匹配（不支持 character class）", () => {
    expect(matchGlob("[abc].md", "[abc].md")).toBe(true);
    expect(matchGlob("[abc].md", "a.md")).toBe(false);
  });

  it("否定 ! 按字面匹配（不支持 negation）", () => {
    expect(matchGlob("!skip.md", "!skip.md")).toBe(true);
  });

  it("所有调用不抛异常（不支持语法不报错）", () => {
    expect(() => matchGlob("{a,b}.md", "a.md")).not.toThrow();
    expect(() => matchGlob("[abc].md", "a.md")).not.toThrow();
    expect(() => matchGlob("!x", "x")).not.toThrow();
  });
});

describe("T3.5 / AC-3.3 链接路径不 realpath", () => {
  it("matchGlob 对任意字符串匹配，不访问 fs / 不 realpath", () => {
    // 不存在的 symlink 路径——若 matchGlob realpath 会抛 ENOENT。
    // 此处证明它纯字符串匹配，不触碰 fs。
    const fakeSymlinkPath = "/nonexistent/symlink-foo.md";
    expect(() => matchGlob("**/symlink-*.md", fakeSymlinkPath)).not.toThrow();
    expect(matchGlob("**/symlink-*.md", fakeSymlinkPath)).toBe(true);
    expect(matchGlob("**/symlink-*.md", "/other/bar.md")).toBe(false);
  });

  it("含 .. 的链接路径也按字面匹配（不规范化）", () => {
    expect(matchGlob("**/*.md", "a/../b.md")).toBe(true);
  });
});

describe("T3.6 / SV-1 RegExp 缓存复用（编译只 1 次）", () => {
  // 每个测试用唯一 pattern 避免 module-level regexCache 跨用例污染，
  // 使首次 matchGlob 必然触发 1 次编译，缓存命中后不再编译。

  let counter: ReturnType<typeof wrapRegExpCounting>;

  beforeEach(() => {
    counter = wrapRegExpCounting();
  });

  afterEach(() => {
    counter.spy.mockRestore();
  });

  it("同 pattern 多次 matchGlob → RegExp 构造只 1 次", () => {
    const uniquePattern = `cache-probe-${Math.random()}.md`;

    // 首次：编译 + 缓存
    matchGlob(uniquePattern, "x.md");
    const callsAfterFirst = counter.calls.length;
    expect(callsAfterFirst).toBe(1);

    // 后续 N 次：应命中缓存，不新增 RegExp 构造
    for (let i = 0; i < 10; i++) {
      matchGlob(uniquePattern, "x.md");
    }
    expect(counter.calls.length).toBe(1);
  });

  it("不同 pattern → 各编译 1 次（缓存按 pattern key）", () => {
    const p1 = `probe-a-${Math.random()}.md`;
    const p2 = `probe-b-${Math.random()}.md`;

    matchGlob(p1, "x.md");
    expect(counter.calls.length).toBe(1);

    matchGlob(p2, "x.md");
    expect(counter.calls.length).toBe(2); // 新 pattern 新增 1 次编译

    // 重复 p1/p2 不再编译
    matchGlob(p1, "x.md");
    matchGlob(p2, "x.md");
    expect(counter.calls.length).toBe(2);
  });
});

describe("isMarkdown（BC-12 强制 .md）", () => {
  it(".md 后缀 → true", () => {
    expect(isMarkdown("a.md")).toBe(true);
    expect(isMarkdown("dir/readme.md")).toBe(true);
  });

  it("非 .md 后缀 → false", () => {
    expect(isMarkdown("a.txt")).toBe(false);
    expect(isMarkdown("a.markdown")).toBe(false);
    expect(isMarkdown("a")).toBe(false);
  });

  it(".MD 大写不命中（区分大小写）", () => {
    expect(isMarkdown("A.MD")).toBe(false);
  });
});
