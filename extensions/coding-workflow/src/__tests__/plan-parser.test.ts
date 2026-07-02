// plan-parser 单测 — 纯函数，验证 E2E 表解析 + expected key=value 语法。
//
// 覆盖维度：
//   - 章节定位（标准 heading / 变体 / 缺失）
//   - 表格行解析（数据行 / 跳过表头+分隔 / 列数不足）
//   - 测试层解析（mock/real/非法）
//   - expected 解析（url=/text=/混合/无 key=/多逗号）
//   - 整体集成（完整 plan.md 片段 → cases）

import { describe, expect, it } from "vitest";

import { parseE2ECases, parseExpected } from "../test-orchestrator/plan-parser.js";

// ── parseExpected（核心防谎报：key=value 语法） ──────────────

describe("parseExpected", () => {
  it("url= 单字段", () => {
    expect(parseExpected("url=/profile")).toEqual({ url: "/profile" });
  });

  it("text= 单字段", () => {
    expect(parseExpected("text=用户名")).toEqual({ text: "用户名" });
  });

  it("url= + text= 混合（逗号分隔）", () => {
    expect(parseExpected("url=/profile, text=用户名")).toEqual({
      url: "/profile",
      text: "用户名",
    });
  });

  it("空字符串 → 空 Expected", () => {
    expect(parseExpected("")).toEqual({});
  });

  it("无 key= 语法的自由文本 → 空 Expected（不可判定）", () => {
    expect(parseExpected("跳转到首页")).toEqual({});
  });

  it("大写 URL= 同样识别（case-insensitive key）", () => {
    expect(parseExpected("URL=/dashboard")).toEqual({ url: "/dashboard" });
  });

  it("未知 key= 被忽略（domAttr 第一版不支持）", () => {
    expect(parseExpected("url=/x, domAttr=hidden")).toEqual({ url: "/x" });
  });

  it("value 含等号（只切第一个 =）", () => {
    expect(parseExpected("url=/x?a=b")).toEqual({ url: "/x?a=b" });
  });

  it("key 前后有空格仍识别", () => {
    expect(parseExpected("url = /profile")).toEqual({ url: "/profile" });
  });

  it("无 value 的 key= 被忽略", () => {
    expect(parseExpected("url=, text=用户名")).toEqual({ text: "用户名" });
  });
});

// ── parseE2ECases（章节定位 + 表格解析集成） ─────────────────

describe("parseE2ECases", () => {
  it("完整 E2E 章节 → 多条用例", () => {
    const md = makePlanWithE2ETable([
      "| E1 | 用户登录 | mock | 已注册用户 | 1.打开/login 2.提交 | url=/profile, text=用户名 | vitest |",
      "| E1-r | 用户登录 | real | 真实后端 | 同 E1 | url=/profile | playwright |",
      "| E2 | 登录失败 | mock | 错误密码 | 1.提交错误密码 | text=密码错误 | vitest |",
    ]);

    const result = parseE2ECases(md);

    expect(result.cases).toHaveLength(3);
    expect(result.cases[0]).toMatchObject({
      id: "E1",
      layer: "mock",
      expected: { url: "/profile", text: "用户名" },
      status: "pending",
    });
    expect(result.cases[1]).toMatchObject({
      id: "E1-r",
      layer: "real",
      expected: { url: "/profile" },
    });
    expect(result.cases[2]).toMatchObject({
      id: "E2",
      layer: "mock",
      expected: { text: "密码错误" },
    });
  });

  it("用例 ID 支持大写和小写 E 前缀", () => {
    const md = makePlanWithE2ETable([
      "| e1 | 场景 | mock | - | - | url=/x | - |",
    ]);
    const result = parseE2ECases(md);
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]!.id).toBe("e1");
  });

  it("缺失 E2E 章节 → 空 cases + error", () => {
    const result = parseE2ECases("# 业务目标\n无 E2E 章节");
    expect(result.cases).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/E2E.*未找到/);
  });

  it("E2E 章节但无表格行 → 空 cases + error", () => {
    const md = "## E2E 用例清单\n\n本章无表格。\n";
    const result = parseE2ECases(md);
    expect(result.cases).toHaveLength(0);
    expect(result.errors[0]).toMatch(/无可解析/);
  });

  it("跳过表头行和分隔行", () => {
    const md = `## E2E 用例清单

| 用例ID | 场景 | 测试层 | 前置 | 步骤 | 预期 | 执行方式 |
|--------|------|--------|------|------|------|---------|
| E1     | 登录 | mock   | -    | -    | url=/x | vitest |
`;
    const result = parseE2ECases(md);
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]!.id).toBe("E1");
  });

  it("测试层列非法（非 mock/real）→ 该行报错，其他行正常", () => {
    const md = makePlanWithE2ETable([
      "| E1 | 场景 | manual | - | - | url=/x | - |",
      "| E2 | 场景 | mock | - | - | url=/y | - |",
    ]);
    const result = parseE2ECases(md);
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]!.id).toBe("E2");
    expect(result.errors.some((e) => e.includes("E1") && e.includes("manual"))).toBe(true);
  });

  it("预期列无 key= 语法 → 该行报错（不可机器判定）", () => {
    const md = makePlanWithE2ETable([
      "| E1 | 场景 | mock | - | - | 跳转到首页 | - |",
    ]);
    const result = parseE2ECases(md);
    expect(result.cases).toHaveLength(0);
    expect(result.errors[0]).toMatch(/E1.*无 url=\/text=/);
  });

  it("用例 ID 非 E 前缀（如 U1 单测）→ 不被 E2E 解析误收", () => {
    const md = makePlanWithE2ETable([
      "| U1 | 单测 | mock | - | - | url=/x | - |",
      "| E1 | e2e | mock | - | - | url=/y | - |",
    ]);
    const result = parseE2ECases(md);
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]!.id).toBe("E1");
  });

  it("支持「E2E 清单」变体 heading（无「用例」字样）", () => {
    const md = `## E2E 清单

| E1 | 场景 | mock | - | - | url=/x | - |
`;
    const result = parseE2ECases(md);
    expect(result.cases).toHaveLength(1);
  });

  it("章节后遇到下一级 heading 截断（不误收后续章节内容）", () => {
    const md = `## E2E 用例清单

| E1 | 场景 | mock | - | - | url=/x | - |

## 覆盖率 gate

| 不应该 | 被解析 | mock |
`;
    const result = parseE2ECases(md);
    expect(result.cases).toHaveLength(1);
  });

  it("real 层用例正确标记", () => {
    const md = makePlanWithE2ETable([
      "| E3-r | 并发 | real | 真实DB | - | url=/sold-out | 脚本 |",
    ]);
    const result = parseE2ECases(md);
    expect(result.cases[0]).toMatchObject({ id: "E3-r", layer: "real" });
  });
});

// ── 辅助 ─────────────────────────────────────────────────────

/** 构造含 E2E 章节的 plan.md 文本，tableLines 为表格行数组。 */
function makePlanWithE2ETable(tableLines: string[]): string {
  return [
    "# Plan",
    "",
    "## 业务目标",
    "做某事",
    "",
    "## E2E 用例清单",
    "",
    "| 用例ID | 场景 | 测试层 | 前置 | 步骤 | 预期 | 执行方式 |",
    "|--------|------|--------|------|------|------|---------|",
    ...tableLines,
    "",
  ].join("\n");
}
