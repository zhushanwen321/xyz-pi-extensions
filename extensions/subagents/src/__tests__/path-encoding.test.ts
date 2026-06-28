// src/__tests__/path-encoding.test.ts
//
// 锁定 encodeCwd 契约：session-runner 与 session-file-gc 共用此编码，
// 漂移会导致同一 cwd 落到两个不同目录（见 path-encoding.ts 顶部注释）。
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { encodeCwd, getSubagentSessionDir } from "../core/path-encoding.ts";

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

describe("getSubagentSessionDir", () => {
  it("returns agentDir/subagents/sessions/<encodedCwd>", () => {
    const result = getSubagentSessionDir("/home/user/.pi/agent", "/home/user/project");
    expect(result).toBe(
      path.join("/home/user/.pi/agent", "subagents", "sessions", "--home-user-project--")
    );
  });

  it("uses mainCwd encoding (not effectiveCwd)", () => {
    // D-004: 用主 cwd 编码，保证同一主 cwd 下所有 subagent 存同一目录
    const mainCwd = "/Users/zhushanwen/Code/my-project";
    const result = getSubagentSessionDir("~/.pi/agent", mainCwd);
    const encoded = encodeCwd(mainCwd);
    expect(result).toBe(path.join("~/.pi/agent", "subagents", "sessions", encoded));
  });

  it("produces consistent path for same inputs", () => {
    const a = getSubagentSessionDir("/agent", "/cwd");
    const b = getSubagentSessionDir("/agent", "/cwd");
    expect(a).toBe(b);
  });

  it("produces different path for different mainCwd", () => {
    const a = getSubagentSessionDir("/agent", "/cwd1");
    const b = getSubagentSessionDir("/agent", "/cwd2");
    expect(a).not.toBe(b);
  });
});
