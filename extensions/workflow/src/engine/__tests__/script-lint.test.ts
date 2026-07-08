// 测试框架：vitest
// 运行命令：npx vitest run src/engine/__tests__/script-lint.test.ts
//
// lintScript 从 infra/script-lint.ts 迁入 engine/script-lint.ts。
// 本测试覆盖迁入后的 lintScript，并验证 WorkflowScript.validate 的回填委托。

import { describe, expect, it } from "vitest";

import { WorkflowScript } from "../models/workflow-script.js";
import { lintScript } from "../script-lint.js";

// ── lintScript ───────────────────────────────────────────────

describe("lintScript", () => {
  it("clean 脚本 → valid", () => {
    const source = `
const meta = { name: "test" };
const result = await agent({ prompt: "hello", schema: mySchema });
const value = result.someField;
`;
    const r = lintScript(source);
    expect(r.valid).toBe(true);
    expect(r.findings).toHaveLength(0);
  });

  it("捕获 outputSchema 作为 agent() 简写属性", () => {
    const source = `
const result = await agent({
  prompt: "hello",
  outputSchema,
});
`;
    const r = lintScript(source);
    expect(r.valid).toBe(false);
    expect(r.findings[0].message).toContain("outputSchema");
    expect(r.findings[0].line).toBe(4);
  });

  it("捕获 outputSchema 作为显式 key", () => {
    const source = `
const result = await agent({ prompt: "hello", outputSchema: mySchema });
`;
    const r = lintScript(source);
    expect(r.valid).toBe(false);
    expect(r.findings[0].message).toContain("outputSchema");
  });

  it("不标记 outputSchema 作为变量声明", () => {
    const source = `
const outputSchema = {
  type: "object",
  properties: { count: { type: "number" } },
};
const result = await agent({ prompt: "hello", schema: outputSchema });
`;
    const r = lintScript(source);
    expect(r.valid).toBe(true);
    expect(r.findings).toHaveLength(0);
  });

  it("不标记 outputSchema 作为 value（schema: outputSchema）", () => {
    const source = `
const result = await agent({ prompt: "hello", schema: outputSchema });
`;
    const r = lintScript(source);
    expect(r.valid).toBe(true);
    expect(r.findings).toHaveLength(0);
  });

  it("捕获 result.output", () => {
    const source = `
const result = await agent({ prompt: "hello" });
const x = result.output;
`;
    const r = lintScript(source);
    expect(r.valid).toBe(false);
    expect(r.findings[0].message).toContain("result.output");
  });

  it("捕获 result.parsedOutput", () => {
    const source = `
const result = await agent({ prompt: "hello" });
const x = result.parsedOutput;
`;
    const r = lintScript(source);
    expect(r.valid).toBe(false);
    expect(r.findings[0].message).toContain("result.parsedOutput");
  });

  it("捕获 result.content", () => {
    const source = `
const result = await agent({ prompt: "hello" });
const x = result.content;
`;
    const r = lintScript(source);
    expect(r.valid).toBe(false);
    expect(r.findings[0].message).toContain("result.content");
  });

  it("readFileSync 状态文件 → warning（不影响 valid）", () => {
    const source = `
const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
await agent({ prompt: "use state" });
`;
    const r = lintScript(source);
    expect(r.valid).toBe(true); // 有 agent() 入口，warning 不影响 valid
    expect(r.findings.some((f) => f.message.includes("state file"))).toBe(true);
  });

  it("unlinkSync 清理状态 → warning", () => {
    const source = `
try { fs.unlinkSync(STATE_FILE); } catch {}
await agent({ prompt: "cleanup done" });
`;
    const r = lintScript(source);
    expect(r.valid).toBe(true); // 有 agent() 入口，warning 不影响 valid
    expect(r.findings.some((f) => f.message.includes("unlinkSync"))).toBe(true);
  });

  it("跳过注释行（注释中的 outputSchema/result.output 不被标记）", () => {
    const source = `
// This uses outputSchema for structured output
// result.output contains the data
await agent({ prompt: "real call" });
`;
    const r = lintScript(source);
    expect(r.valid).toBe(true);
    expect(r.findings.some((f) => f.message.includes("outputSchema"))).toBe(false);
    expect(r.findings.some((f) => f.message.includes("result.output"))).toBe(false);
  });

  it("不标记 schema（正确用法）", () => {
    const source = `
const result = await agent({ prompt: "hello", schema: mySchema });
const value = result.field;
`;
    const r = lintScript(source);
    expect(r.valid).toBe(true);
    expect(r.findings).toHaveLength(0);
  });

  it("多行 agent() 调用 + outputSchema 简写", () => {
    const source = `
await agent({
  prompt: buildPrompt(iteration),
  description: 'review',
  outputSchema,
});
`;
    const r = lintScript(source);
    expect(r.valid).toBe(false);
    expect(r.findings.some((f) => f.message.includes("outputSchema"))).toBe(true);
  });
});

// ── bare async IIFE 检测（[HISTORICAL] daily-news-impact 2ms 子进程被杀的根因）──

describe("lintScript — bare async IIFE", () => {
  it("[HISTORICAL] daily-news-impact 模式：未 await 的 IIFE 内调 agent → invalid", () => {
 // 复刻真实 daily-news-impact.js 的结构：const meta + (async function main(){...})();
    const source = `
const meta = { name: 'daily-news-impact' };

(async function main() {
  const result = await agent({ prompt: 'analyze', description: 'parse' });
  return result;
})();
`;
    const r = lintScript(source);
    expect(r.valid).toBe(false);
    expect(r.findings.some((f) => f.severity === "error" && f.message.includes("IIFE"))).toBe(true);
  });

  it("箭头 IIFE 未 await + agent → invalid", () => {
    const source = `
(async () => {
  await agent({ prompt: 'x' });
})();
`;
    const r = lintScript(source);
    expect(r.valid).toBe(false);
    expect(r.findings.some((f) => f.message.includes("IIFE"))).toBe(true);
  });

  it("匿名 function IIFE 未 await + parallel → invalid", () => {
    const source = `
(async function() {
  await parallel([() => agent({ prompt: 'a' })]);
})();
`;
    const r = lintScript(source);
    expect(r.valid).toBe(false);
  });

  it("IIFE 内无 agent（纯 execSync）→ 不触发 IIFE 规则（entry-point 规则另算）", () => {
 // stock-screening 模式：IIFE + 纯 execSync，不含 agent。
 // 此脚本会被 entry-point 规则拦下（必须有 agent/parallel/pipeline），
 // 但不应触发 bare-IIFE 规则（IIFE 内无 agent，不会杀子进程）。
    const source = `
(async function main() {
  const fs = require('node:fs');
  const out = execSync('python3 script.py');
  fs.writeFileSync('result.json', out);
})();
`;
    const r = lintScript(source);
    const iifeFindings = r.findings.filter((f) => f.message.includes("IIFE"));
    expect(iifeFindings).toHaveLength(0);
  });

  it("裸顶层 await agent（无 IIFE）→ valid", () => {
    const source = `
const meta = { name: 'simple' };
const result = await agent({ prompt: 'hi' });
return result;
`;
    const r = lintScript(source);
    expect(r.valid).toBe(true);
  });

  it("await 的 IIFE + agent → valid", () => {
    const source = `
await (async function main() {
  await agent({ prompt: 'x' });
})();
`;
    const r = lintScript(source);
    expect(r.valid).toBe(true);
  });

 // [HISTORICAL] 方向 2 收紧：被 =/return 接住的 IIFE 降为 warning（不阻断），
 // 避免误伤合法写法。只有孤立语句（fire-and-forget）才 error。
  it("赋值后 await 的 IIFE → warning（valid=true，有 finding 提醒检查）", () => {
    const source = `
const p = (async () => {
  return await agent({ prompt: 'x' });
})();
const r = await p;
`;
    const r = lintScript(source);
    expect(r.valid).toBe(true);
    const iifeFindings = r.findings.filter((f) => f.message.includes("IIFE") || f.message.includes("IIFE"));
    expect(iifeFindings).toHaveLength(1);
    expect(iifeFindings[0].severity).toBe("warning");
  });

  it("return 内的 IIFE（被外层函数接住）→ warning（不阻断）", () => {
    const source = `
function wrap() {
  return (async () => {
    return await agent({ prompt: 'x' });
  })();
}
const r = await wrap();
`;
    const r = lintScript(source);
    expect(r.valid).toBe(true);
    const iifeFindings = r.findings.filter((f) => f.message.includes("IIFE"));
    expect(iifeFindings).toHaveLength(1);
    expect(iifeFindings[0].severity).toBe("warning");
  });

  it("IIFE 前是分号（语句边界）→ error（fire-and-forget）", () => {
    const source = `
const meta = {};
(async function main() {
  await agent({ prompt: 'x' });
})();
`;
    const r = lintScript(source);
    expect(r.valid).toBe(false);
    const errs = r.findings.filter((f) => f.severity === "error" && f.message.includes("IIFE"));
    expect(errs).toHaveLength(1);
  });

  it("多个 IIFE 各自独立判断（matchAll 覆盖）", () => {
 // 两个独立 IIFE 都含 agent，应各自报一条 error（共 2 条）
    const source = `
(async function a() { await agent({ prompt: 'a' }); })();
(async function b() { await agent({ prompt: 'b' }); })();
`;
    const r = lintScript(source);
    const iifeFindings = r.findings.filter((f) => f.message.includes("IIFE"));
    expect(iifeFindings).toHaveLength(2);
  });
});

// ── entry-point 检查 ─────

describe("lintScript entry-point check", () => {
  it("含 agent() → 无 entry-point error", () => {
    const r = lintScript('const r = await agent({ prompt: "hi" });');
    expect(r.findings.some((f) => f.message.includes("agent()"))).toBe(false);
    expect(r.valid).toBe(true);
  });

  it("含 parallel() → 无 entry-point error", () => {
    const r = lintScript("await parallel([agent1, agent2]);");
    expect(r.findings.some((f) => f.message.includes("parallel()"))).toBe(false);
    expect(r.valid).toBe(true);
  });

  it("含 pipeline() → 无 entry-point error", () => {
    const r = lintScript("await pipeline([stage1, stage2]);");
    expect(r.findings.some((f) => f.message.includes("pipeline()"))).toBe(false);
    expect(r.valid).toBe(true);
  });

  it("无任何编排函数 → error，message 含 agent/parallel/pipeline", () => {
    const r = lintScript('const x = 1; console.log(x);');
    expect(r.valid).toBe(false);
    const entry = r.findings.find((f) => f.message.includes("must call"));
    expect(entry).toBeDefined();
    expect(entry!.severity).toBe("error");
    expect(entry!.message).toMatch(/agent\(\)|parallel\(\)|pipeline\(\)/);
  });

  it("findings 按行号排序", () => {
 // line 2: result.output (error)，line 0: 无 entry point（error）
    const source = `
const x = result.output;`;
    const r = lintScript(source);
    const lines = r.findings.map((f) => f.line);
    const sorted = [...lines].sort((a, b) => a - b);
    expect(lines).toEqual(sorted);
  });
});

// ── WorkflowScript.validate 回填委托 ──────────────────────────

describe("WorkflowScript.validate 委托 lintScript", () => {
  function makeScript(sourceCode: string): WorkflowScript {
    return new WorkflowScript({
      name: "test-wf",
      source: "saved",
      path: "/abs/.pi/workflows/test-wf.js",
      sourceCode,
      meta: { name: "test-wf", description: "", phases: [] },
      available: true,
    });
  }

  it("含 agent() → valid", () => {
    expect(makeScript('const r = await agent({ prompt: "hi" });').validate().valid).toBe(true);
  });

  it("含 parallel() → valid", () => {
    expect(makeScript("await parallel([agent1, agent2]);").validate().valid).toBe(true);
  });

  it("含 pipeline() → valid", () => {
    expect(makeScript("await pipeline([stage1, stage2]);").validate().valid).toBe(true);
  });

  it("无编排函数 → invalid（含 error finding）", () => {
    const result = makeScript('const x = 1; console.log(x);').validate();
    expect(result.valid).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("error");
    expect(result.findings[0].message).toMatch(/agent\(\)|parallel\(\)|pipeline\(\)/);
  });

  it("含 outputSchema → invalid（lintScript 触发）", () => {
    const result = makeScript(
      'const r = await agent({ prompt: "hi", outputSchema });',
    ).validate();
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.message.includes("outputSchema"))).toBe(true);
  });

  it("含 result.output → invalid（lintScript 触发）", () => {
    const result = makeScript(
      'const result = await agent({ prompt: "hi" }); const x = result.output;',
    ).validate();
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.message.includes("result.output"))).toBe(true);
  });

  it("toExecutable 不影响 validate（sourceCode 不变）", () => {
    const s = makeScript(
      "export const meta = { name: 'x' };\nconst r = await agent({ prompt: 'hi' });",
    );
    s.toExecutable();
    expect(s.validate().valid).toBe(true);
  });
});
