import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, validateSource } from "../src/config.ts";
import type { LoaderConfig } from "../src/types.ts";

/**
 * W3b config.ts 验证测试（覆盖 UC-1 config 链路）。
 *
 * config.ts 骨架已完整实现 loadConfig/validateSource/deepMerge。纯验证测试，不改 config.ts。
 *
 * 覆盖 AC / 用例：
 * - T1.2 / AC-2.3（ENOENT→空配置零副作用）+ AC-2.4（sources 缺/空→零加载）
 * - T1.3 / AC-2.1（JSON 解析失败→loadConfig throw）
 * - T1.4 / AC-2.2（某 source 校验失败→validateSource {ok:false,reason}）
 * - T1.17 / AC-2.8（whole-config 结构错误→静默空配置，CA-14）
 * - AC-2.5 的 `~`/绝对/相对展开归 discovery（CA-8），config 不展开——见 W4
 * - AC-2.6（config→types 单向，无 config→engine——grep W7）
 * - AC-2.7（LOC ≤~60——wc W7）
 *
 * 注：safeNotify 降级/跳过闭环在 index 层（W5），本 Wave 验 config/validateSource 返回值本身。
 */

/** tmpdir fixture：每个 test 独立临时目录，放 config.json */
function useTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spl-cfg-"));
  const configPath = path.join(dir, "config.json");
  const write = (content: string, name = "config.json") => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  };
  return { dir, configPath, write, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe("T1.2 / AC-2.3 + AC-2.4 配置缺失/空", () => {
  let fx: ReturnType<typeof useTmpDir>;
  beforeEach(() => {
    fx = useTmpDir();
  });
  afterEach(() => fx.cleanup());

  it("AC-2.3: config.json 不存在（ENOENT）→ 空配置零副作用（不 throw）", () => {
    const missing = path.join(fx.dir, "never-exists.json");
    const cfg = loadConfig(missing);
    expect(cfg.sources).toEqual([]);
    // 不 throw、不 notify（notify 在 index 层，config 层只返回空配置）
  });

  it("AC-2.4: sources=[] → 空配置（零加载）", () => {
    const p = fx.write(JSON.stringify({ "system-prompt-loader": { sources: [] } }));
    const cfg = loadConfig(p);
    expect(cfg.sources).toEqual([]);
  });

  it("AC-2.4: sources 缺失 → 空配置", () => {
    const p = fx.write(JSON.stringify({ "system-prompt-loader": {} }));
    const cfg = loadConfig(p);
    expect(cfg.sources).toEqual([]);
  });
});

describe("T1.3 / AC-2.1 JSON 解析失败 → throw", () => {
  let fx: ReturnType<typeof useTmpDir>;
  beforeEach(() => {
    fx = useTmpDir();
  });
  afterEach(() => fx.cleanup());

  it("非法 JSON → loadConfig throw（SyntaxError）", () => {
    const p = fx.write("{invalid json");
    expect(() => loadConfig(p)).toThrow(SyntaxError);
  });

  it("截断 JSON → throw", () => {
    const p = fx.write('{"system-prompt-loader":');
    expect(() => loadConfig(p)).toThrow();
  });

  it("throw 后交上层 notify+降级（index 层验，config 层只验 throw 本身）", () => {
    const p = fx.write("not json at all");
    // config 层契约：throw。上层（W5 index）catch 后 safeNotify+降级空配置
    expect(() => loadConfig(p)).toThrow();
  });
});

describe("T1.17 / AC-2.8 whole-config 结构错误 → 静默空配置（CA-14）", () => {
  let fx: ReturnType<typeof useTmpDir>;
  beforeEach(() => {
    fx = useTmpDir();
  });
  afterEach(() => fx.cleanup());

  it("顶层 `system-prompt-loader` key 缺失 → 静默空配置（不 throw）", () => {
    const p = fx.write(JSON.stringify({ other: { sources: [] } }));
    const cfg = loadConfig(p);
    expect(cfg.sources).toEqual([]);
    // CA-14：静默，不 throw（区别于 T1.3 JSON 解析失败）
  });

  it("`sources` 非数组（字符串）→ 静默空配置", () => {
    const p = fx.write(JSON.stringify({ "system-prompt-loader": { sources: "not-array" } }));
    const cfg = loadConfig(p);
    expect(cfg.sources).toEqual([]);
  });

  it("`sources` 非数组（对象）→ 静默空配置", () => {
    const p = fx.write(
      JSON.stringify({ "system-prompt-loader": { sources: { kind: "explicit" } } }),
    );
    const cfg = loadConfig(p);
    expect(cfg.sources).toEqual([]);
  });

  it("`system-prompt-loader` value 非 object → 静默空配置", () => {
    const p = fx.write(JSON.stringify({ "system-prompt-loader": "string-value" }));
    const cfg = loadConfig(p);
    expect(cfg.sources).toEqual([]);
  });

  it("root 非 object → 静默空配置", () => {
    const p = fx.write('"just a string"');
    const cfg = loadConfig(p);
    expect(cfg.sources).toEqual([]);
  });

  it("whole-config 结构错 vs per-source 错 的区别（CA-14 核心）", () => {
    // whole-config 错（本组）：静默空配置，不进 sources
    const p = fx.write(
      JSON.stringify({ "system-prompt-loader": { sources: "x" } }),
    );
    expect(loadConfig(p).sources).toEqual([]);
    // per-source 错（unknown kind/缺字段）：config 层不处理，原样进 sources，
    // 交 validateSource 判定 → AC-2.2 notify+跳过（见 T1.4 组）
    const p2 = fx.write(
      JSON.stringify({
        "system-prompt-loader": {
          sources: [{ kind: "unknown-kind" }],
        },
      }),
    );
    const cfg2 = loadConfig(p2);
    expect(cfg2.sources).toHaveLength(1); // 进了数组，validateSource 会判失败
    expect(validateSource(cfg2.sources[0], 0).ok).toBe(false);
  });
});

describe("T1.4 / AC-2.2 validateSource 逐条校验（返回 {ok,reason}）", () => {
  it("合法 explicit → {ok:true}", () => {
    expect(validateSource({ kind: "explicit", path: "/abs/x.md" }, 0)).toEqual({ ok: true });
  });

  it("合法 walk-files → {ok:true}", () => {
    expect(validateSource({ kind: "walk-files", filenames: ["CLAUDE.md"] }, 0)).toEqual({
      ok: true,
    });
  });

  it("合法 walk-dirs → {ok:true}", () => {
    expect(validateSource({ kind: "walk-dirs", dirnames: ["rules"] }, 0)).toEqual({ ok: true });
  });

  it("合法 glob → {ok:true}", () => {
    expect(validateSource({ kind: "glob", patterns: ["**/*.md"] }, 0)).toEqual({ ok: true });
  });

  it("unknown kind → {ok:false,reason 含 source 索引}", () => {
    const r = validateSource({ kind: "mystery" }, 5);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("source #5");
      expect(r.reason).toContain("unknown kind");
    }
  });

  it("explicit 缺 path → {ok:false}", () => {
    const r = validateSource({ kind: "explicit" }, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("source #1");
  });

  it("explicit path 空字符串 → {ok:false}", () => {
    const r = validateSource({ kind: "explicit", path: "" }, 2);
    expect(r.ok).toBe(false);
  });

  it("walk-files filenames 缺/空 → {ok:false}", () => {
    expect(validateSource({ kind: "walk-files" }, 0).ok).toBe(false);
    expect(validateSource({ kind: "walk-files", filenames: [] }, 0).ok).toBe(false);
  });

  it("walk-dirs dirnames 缺/空 → {ok:false}", () => {
    expect(validateSource({ kind: "walk-dirs" }, 0).ok).toBe(false);
    expect(validateSource({ kind: "walk-dirs", dirnames: [] }, 0).ok).toBe(false);
  });

  it("glob patterns 缺/空 → {ok:false}", () => {
    expect(validateSource({ kind: "glob" }, 0).ok).toBe(false);
    expect(validateSource({ kind: "glob", patterns: [] }, 0).ok).toBe(false);
  });

  it("source 非 object（字符串/null）→ {ok:false}", () => {
    expect(validateSource("not-object", 3).ok).toBe(false);
    expect(validateSource(null, 3).ok).toBe(false);
    expect(validateSource(undefined, 3).ok).toBe(false);
  });

  it("reason 含 source 索引（供 index notify 'source #N'）", () => {
    // 所有 fail 路径的 reason 都含 "source #N"
    const cases = [
      [{ kind: "explicit" }, 7],
      [{ kind: "unknown" }, 9],
      ["str", 11],
    ] as const;
    for (const [src, idx] of cases) {
      const r = validateSource(src, idx);
      if (!r.ok) {
        expect(r.reason).toContain(`source #${idx}`);
      }
    }
  });
});

describe("loadConfig 正常路径（多类 source）", () => {
  let fx: ReturnType<typeof useTmpDir>;
  beforeEach(() => {
    fx = useTmpDir();
  });
  afterEach(() => fx.cleanup());

  it("4 类 source 都解析进 sources 数组", () => {
    const p = fx.write(
      JSON.stringify({
        "system-prompt-loader": {
          sources: [
            { kind: "explicit", path: "/abs/x.md" },
            { kind: "walk-files", filenames: ["CLAUDE.md"] },
            { kind: "walk-dirs", dirnames: ["rules"] },
            { kind: "glob", patterns: ["**/*.md"] },
          ],
        },
      }),
    );
    const cfg: LoaderConfig = loadConfig(p);
    expect(cfg.sources).toHaveLength(4);
    expect(cfg.sources.map((s) => s.kind)).toEqual([
      "explicit",
      "walk-files",
      "walk-dirs",
      "glob",
    ]);
  });

  it("config.json 路径展开不在 config 层（`~`/绝对/相对展开归 discovery expandPath，CA-8）", () => {
    // config.ts 仅校验结构，不展开 path。expandPath 在 discovery（W4 验）。
    // 此处确认 loadConfig 不触碰 path 内容（原样进 sources）
    const p = fx.write(
      JSON.stringify({
        "system-prompt-loader": {
          sources: [{ kind: "explicit", path: "~/relative/pattern" }],
        },
      }),
    );
    const cfg = loadConfig(p);
    expect(cfg.sources[0]).toEqual({ kind: "explicit", path: "~/relative/pattern" });
  });
});
