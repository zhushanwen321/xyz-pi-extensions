// src/__tests__/path-encoding.test.ts
//
// 锁定 encodeCwd 契约：与 subagents（ADR-027）+ Pi SDK getDefaultSessionDir 三方同源。
// 漂移会导致同一项目落到不同目录（_cw.json 找不到）。
//
// 用例与 subagents 的 path-encoding.test.ts 1:1 对齐——两处编码必须完全一致，
// 这样 CW 的 `~/.pi/agent/cw/<encoded-cwd>/` 与 subagents 的 `~/.pi/agent/subagents/<encoded-cwd>/`
// 共享同一编码空间（同一项目对应同一 encoded 段）。
import { describe, expect, it } from "vitest";

import { encodeCwd } from "../cw/path-encoding.js";

describe("encodeCwd", () => {
  it("encodes a normal unix absolute path", () => {
    expect(encodeCwd("/Users/x/proj")).toBe("--Users-x-proj--");
  });

  it("strips a single leading backslash", () => {
    expect(encodeCwd("\\foo")).toBe("--foo--");
  });

  it("encodes Windows drive letter (colon + backslash)", () => {
    // C:\proj → 去掉无前导分隔符 → C:\proj → : 和 \ 都替换为 - → C--proj
    expect(encodeCwd("C:\\proj")).toBe("--C--proj--");
  });

  it("encodes empty string to bare delimiter pair", () => {
    expect(encodeCwd("")).toBe("----");
  });

  it("encodes relative path with no leading separator", () => {
    expect(encodeCwd("relative/path")).toBe("--relative-path--");
  });

  it("collapses consecutive separators (forward slash)", () => {
    expect(encodeCwd("/a//b")).toBe("--a--b--");
  });

  it("collapses consecutive separators (backslash)", () => {
    expect(encodeCwd("a\\b\\c")).toBe("--a-b-c--");
  });

  it("encodes mixed separators and colon", () => {
    // /x:y\\z → 去前导 / → x:y\z → : \ → - - → x-y-z
    expect(encodeCwd("/x:y\\z")).toBe("--x-y-z--");
  });
});
