// U2 + E1: 内置 workflow 脚本 null guard 覆盖 + 文件结构一致性
//
// U2: agent() 失败时 resolve 成空字符串/undefined（设计行为），脚本直接访问
// 返回值属性会 TypeError。验证 4 个内置脚本的 agent() 返回值属性访问均含
// null guard（?. 或 ??），不遗留裸 .property 访问。
//
// E1: workflows/ 目录含 4 个 .js 文件，每个 meta.name 与文件名 stem 一致。

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(__dirname, "../../workflows");

const SCRIPTS = ["chain.js", "parallel.js", "scatter-gather.js", "map-reduce.js"] as const;

function readScript(name: string): string {
  return readFileSync(join(WORKFLOWS_DIR, name), "utf-8");
}

/** 提取 meta.name 值（从 `name: "xxx"` 模式）。 */
function extractMetaName(src: string): string | null {
  const match = src.match(/name:\s*["']([^"']+)["']/);
  return match ? match[1] : null;
}

describe("E1: 内置 workflow 文件结构一致性", () => {
  it("workflows/ 目录含 4 个 .js 文件", () => {
    const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".js"));
    expect(files.sort()).toEqual([...SCRIPTS].sort());
  });

  it.each(SCRIPTS)("meta.name 与文件名 stem 一致：%s", (filename) => {
    const src = readScript(filename);
    const metaName = extractMetaName(src);
    const stem = filename.replace(/\.js$/, "");
    expect(metaName).toBe(stem);
  });
});

describe("U2: 内置脚本 agent() 返回值属性访问含 null guard", () => {
  // 策略：检查脚本中 ?. 和 ?? 的出现次数 >= agent() 调用次数（每个 agent() 返回值
  // 至少有一处属性访问需 guard）。更精确地：脚本不应有裸的 `变量.属性` 访问
  // agent() 返回值——但区分 agent() 返回值和局部对象属性访问需要 AST 分析，
  // 这里用启发式：验证每个脚本都含 ?. 模式（null guard 已存在）。

  it.each(SCRIPTS)("%s 含 optional chaining（?.）null guard 模式", (filename) => {
    const src = readScript(filename);
    // 每个脚本至少有 1 处 ?. guard（chain=6处, parallel=3处, scatter-gather=3处, map-reduce=2处）
    expect(src).toContain("?.");
  });

  it("chain.js 的 analysis/plan/final 属性访问均含 null guard", () => {
    const src = readScript("chain.js");
    // analysis 的 insights/keyPoints
    expect(src).toContain("analysis?.insights");
    expect(src).toContain("analysis?.keyPoints");
    // plan 的 plan/actions
    expect(src).toContain("plan?.plan");
    expect(src).toContain("plan?.actions");
    // final 的 summary/recommendation
    expect(src).toContain("final?.summary");
    expect(src).toContain("final?.recommendation");
  });

  it("parallel.js 的 aggregate 属性访问含 null guard", () => {
    const src = readScript("parallel.js");
    expect(src).toContain("aggregate?.overallScore");
    expect(src).toContain("aggregate?.topIssues");
    expect(src).toContain("aggregate?.consensus");
  });

  it("scatter-gather.js 的 split/gathered 属性访问含 null guard", () => {
    const src = readScript("scatter-gather.js");
    expect(src).toContain("split?.subtasks");
    expect(src).toContain("gathered?.mergedResult");
    expect(src).toContain("gathered?.completeness");
  });

  it("map-reduce.js 的 reduced 属性访问含 null guard", () => {
    const src = readScript("map-reduce.js");
    expect(src).toContain("reduced?.reduced");
    expect(src).toContain("reduced?.stats");
  });

  it.each(SCRIPTS)("%s 不含裸 analysis.insights/plan.plan 等无 guard 访问", (filename) => {
    const src = readScript(filename);
    // 检查不存在 "变量.属性" 形式的裸访问（不含 ?. 的）
    // 排除 schema 对象定义里的 properties.xxx 和 JSON.stringify 等合法用法
    // 只检查 agent() 返回值变量名后的裸属性访问
    const agentVars = ["analysis", "plan", "final", "aggregate", "split", "gathered", "reduced"];
    for (const v of agentVars) {
      // 匹配 `变量.属性`（非 `变量?.属性`），但排除变量声明和赋值左侧
      const bareAccess = new RegExp(`[^?\\w.]${v}\\.[a-zA-Z]`);
      // 排除 schema properties 定义中的合法用法（如 properties: { insights: ... }）
      // 这里只关注 prompt 拼接和 outcome 构造中的裸访问
      const lines = src.split("\n");
      for (const line of lines) {
        // 跳过 schema 定义行（含 type: / properties: / description:）
        if (/^\s*(type|properties|description|required|items):/.test(line)) continue;
        // 跳过 const 声明行（如 `const plan = await agent(...)`）
        if (/^\s*const\s+\w+\s*=/.test(line) && line.includes("agent(")) continue;
        if (bareAccess.test(line)) {
          // 检查这个裸访问是否真的在属性读取位置（而非变量定义）
          const match = line.match(bareAccess);
          if (match && !line.includes(`?.`)) {
            // 确认是 agent() 返回值的属性访问（同一行有拼接/赋值上下文）
            // 如果行里同时有 ?. 版本，说明是 guard 后的，不算裸访问
            expect(line).toMatch(new RegExp(`${v}\\?\\.`));
          }
        }
      }
    }
  });
});
