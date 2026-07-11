/**
 * script-lint — 单元测试。
 *
 * lintScript 是纯函数、零副作用、零 IO，直接传入源码字符串即可。
 *
 * 覆盖：入口检查、result.output/outputSchema/文件状态、bare async IIFE、
 *      多错误同时存在、注释行跳过。
 *
 * 【差异说明】源码中实际不存在「未闭合括号」/「嵌套括号深度」检查——
 * lintScript 是 API 误用 lint（非语法 lint），不做括号配对。
 * 因此原任务清单的对应条目已替换为实际存在的检查项（IIFE / outputSchema 等）。
 */
import { describe, it, expect } from "vitest";

import { lintScript, type LintFinding } from "../script-lint.ts";

/** 取所有 error 级 finding。 */
function errors(findings: LintFinding[]): LintFinding[] {
  return findings.filter((f) => f.severity === "error");
}

/** 取所有 warning 级 finding。 */
function warnings(findings: LintFinding[]): LintFinding[] {
  return findings.filter((f) => f.severity === "warning");
}

// ── 基础验证 ──────────────────────────────────────────────────

describe("合法脚本通过", () => {
  it("包含 agent() 调用且无其他问题 → valid=true", () => {
    const src = `const meta = { name: "x", description: "d" };\nawait agent({ prompt: "do something" });\n`;
    const result = lintScript(src);

    expect(result.valid).toBe(true);
    expect(errors(result.findings)).toHaveLength(0);
  });

  it("parallel() 也是合法入口", () => {
    const src = `await parallel([\n  { prompt: "a" },\n  { prompt: "b" }\n]);\n`;
    const result = lintScript(src);

    expect(result.valid).toBe(true);
  });

  it("pipeline() 也是合法入口", () => {
    const src = `await pipeline({ prompt: "x" });\n`;
    const result = lintScript(src);

    expect(result.valid).toBe(true);
  });
});

// ── 入口检查 ──────────────────────────────────────────────────

describe("缺入口 — 必须含 agent/parallel/pipeline 之一", () => {
  it("不含任何入口 → 报 error", () => {
    const src = `const x = 1;\nconsole.log("no orchestration here");\n`;
    const result = lintScript(src);

    expect(result.valid).toBe(false);
    const errs = errors(result.findings);
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toMatch(/must call agent.*parallel.*pipeline/);
  });

  it("错误信息建议添加 agent/parallel/pipeline", () => {
    const src = `const x = 1;\n`;
    const result = lintScript(src);

    const finding = errors(result.findings)[0];
    expect(finding.suggestion).toMatch(/agent\(\).*parallel\(\).*pipeline\(\)/);
  });

  it("类似 agent 字符串但不构成调用不满足入口（agentX( )）", () => {
    const src = `const meta = {};\nagentX("not a real agent call");\n`;
    const result = lintScript(src);

    expect(result.valid).toBe(false);
  });
});

// ── result.output 等错误字段 ───────────────────────────────────

describe("result.output / parsedOutput / content 错误访问", () => {
  it("result.output → error", () => {
    const src = `const out = await agent({ prompt: "x" });\nconst v = result.output;\n`;
    const result = lintScript(src);

    const errs = errors(result.findings);
    const r = errs.find((f) => f.message.includes("result.output"));
    expect(r).toBeDefined();
    expect(r!.line).toBe(2);
  });

  it("result.parsedOutput → error", () => {
    const src = `await agent({ prompt: "x" });\nreturn result.parsedOutput;\n`;
    const result = lintScript(src);

    expect(errors(result.findings).some((f) => f.message.includes("result.parsedOutput")))
      .toBe(true);
  });

  it("result.content → error", () => {
    const src = `await agent({ prompt: "x" });\nconsole.log(result.content);\n`;
    const result = lintScript(src);

    expect(errors(result.findings).some((f) => f.message.includes("result.content")))
      .toBe(true);
  });

  it("result 的三种错误字段都建议用 await agent() 直接取值", () => {
    const src = `await agent({ prompt: "x" });\nresult.output;\nresult.parsedOutput;\nresult.content;\n`;
    const result = lintScript(src);

    for (const f of errors(result.findings)) {
      expect(f.suggestion).toMatch(/await agent/);
    }
  });
});

// ── outputSchema 作为 key（agent 选项误用）─────────────────────

describe("outputSchema 作为 agent 选项 key", () => {
  it("简写 outputSchema 作为 key → error", () => {
    const src = `await agent({\n  prompt: "x",\n  outputSchema,\n});\n`;
    const result = lintScript(src);

    expect(errors(result.findings).some((f) => f.message.includes("outputSchema"))).toBe(true);
  });

  it("显式 outputSchema: ... 作为 key → error", () => {
    const src = `await agent({\n  prompt: "x",\n  outputSchema: foo,\n});\n`;
    const result = lintScript(src);

    expect(errors(result.findings).some((f) => f.message.includes("outputSchema"))).toBe(true);
  });

  it("schema: outputSchema 作为 value → 不报 error", () => {
    // outputSchema 出现在 value 位置是合法的（schema 才是正确 key）
    const src = `await agent({\n  prompt: "x",\n  schema: outputSchema,\n});\n`;
    const result = lintScript(src);

    expect(errors(result.findings).some((f) => f.message.includes("outputSchema")))
      .toBe(false);
  });
});

// ── 文件状态（warning）─────────────────────────────────────────

describe("文件传状态 / unlinkSync — warning", () => {
  it("readFileSync 读 STATE 文件 → warning", () => {
    const src = `await agent({ prompt: "x" });\nconst s = readFileSync(STATE_PATH, "utf-8");\n`;
    const result = lintScript(src);

    const ws = warnings(result.findings);
    // 实际 message 是 "Reading a state file between agent calls is fragile..."（不含字面 "readFileSync"）
    expect(ws.some((w) => /state file.*fragile/i.test(w.message))).toBe(true);
  });

  it("unlinkSync 清理 state → warning", () => {
    const src = `await agent({ prompt: "x" });\nunlinkSync(stateFile);\n`;
    const result = lintScript(src);

    const ws = warnings(result.findings);
    expect(ws.some((w) => w.message.includes("unlinkSync"))).toBe(true);
  });

  it("warning 不影响 valid 判定（valid 只看 error）", () => {
    const src = `await agent({ prompt: "x" });\nunlinkSync(stateFile);\n`;
    const result = lintScript(src);

    expect(result.valid).toBe(true);
    expect(warnings(result.findings).length).toBeGreaterThan(0);
  });
});

// ── bare async IIFE ───────────────────────────────────────────

describe("顶层未 await 的异步 IIFE + 内部调 agent — 子进程被提前 kill", () => {
  it("孤立 fire-and-forget IIFE 内调 agent → error", () => {
    const src = [
      `(async function main() {`,
      `  await agent({ prompt: "x" });`,
      `})();`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    const errs = errors(result.findings);
    const iifeFinding = errs.find((f) => /fire-and-forget/i.test(f.message));
    expect(iifeFinding).toBeDefined();
  });

  it("await 前缀的 IIFE 内调 agent → 不报 error（warning 或无）", () => {
    const src = [
      `await (async () => {`,
      `  await agent({ prompt: "x" });`,
      `})();`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(errors(result.findings).some((f) => /fire-and-forget/i.test(f.message)))
      .toBe(false);
  });

  it("IIFE 被赋值/返回接住 → warning（非 error）", () => {
    const src = [
      `const p = (async () => {`,
      `  await agent({ prompt: "x" });`,
      `})();`,
      `await p;`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(errors(result.findings).some((f) => /fire-and-forget/i.test(f.message)))
      .toBe(false);
    expect(warnings(result.findings).some((f) => /assigned|returned/i.test(f.message)))
      .toBe(true);
  });

  it("IIFE 内不含 agent/parallel/pipeline → 不报（合法的纯 I/O IIFE）", () => {
    const src = [
      `(async () => {`,
      `  await new Promise(r => setTimeout(r, 100));`,
      `})();`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    // 无 entry point → 入口检查报 error；但不应有 IIFE error
    const iifeErrors = errors(result.findings).filter((f) => /iife|fire-and-forget/i.test(f.message));
    expect(iifeErrors).toHaveLength(0);
  });
});

// ── 注释/字符串内的模式不被计入 ──────────────────────────────

describe("注释行内的模式跳过", () => {
  it("// 注释中的 result.output 不报", () => {
    const src = [
      `await agent({ prompt: "x" });`,
      `// here we discuss result.output as a concept`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(errors(result.findings).some((f) => f.message.includes("result.output")))
      .toBe(false);
  });

  it("/* 块注释行内的 result.output 不报", () => {
    const src = [
      `await agent({ prompt: "x" });`,
      `/* block comment mentions result.output on purpose */`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(errors(result.findings).some((f) => f.message.includes("result.output")))
      .toBe(false);
  });

  it("* 续行注释中的 result.parsedOutput 不报", () => {
    const src = [
      `await agent({ prompt: "x" });`,
      `/**`,
      ` * result.parsedOutput is intentionally mentioned here`,
      ` */`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(errors(result.findings).some((f) => f.message.includes("result.parsedOutput")))
      .toBe(false);
  });

  it("注释中的 readFileSync(STATE) 不报 warning", () => {
    const src = [
      `await agent({ prompt: "x" });`,
      `// we used to readFileSync(STATE) but no longer`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    expect(warnings(result.findings).some((w) => /state file/i.test(w.message)))
      .toBe(false);
  });
});

// ── 多错误同时存在 ────────────────────────────────────────────

describe("多种错误同时存在", () => {
  it("缺入口 + result.output + readFileSync 一起报", () => {
    const src = [
      `const x = result.output;`,
      `const s = readFileSync(STATE, "utf-8");`,
      `console.log(x, s);`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    const msgs = result.findings.map((f) => f.message).join("\n");
    expect(result.valid).toBe(false);
    expect(msgs).toMatch(/must call agent.*parallel.*pipeline/);
    expect(msgs).toMatch(/result\.output/);
    // readFileSync(STATE) 触发的 warning 文案是 "Reading a state file..."
    expect(msgs).toMatch(/state file/i);
  });

  it("result.output + result.content + outputSchema 三种错误同报", () => {
    const src = [
      `await agent({`,
      `  prompt: "x",`,
      `  outputSchema,`,
      `});`,
      `const a = result.output;`,
      `const b = result.content;`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    const msgs = result.findings.map((f) => f.message).join("\n");
    expect(msgs).toMatch(/result\.output/);
    expect(msgs).toMatch(/result\.content/);
    expect(msgs).toMatch(/outputSchema/);
  });

  it("findings 按行号升序排列（稳定输出）", () => {
    const src = [
      `await agent({ prompt: "x" });`,           // line 1
      `const a = result.content;`,                // line 2 → 应在 outputSchema(line 5) 之前
      `const b = result.output;`,                 // line 3
      `await agent({`,
      `  prompt: "y",`,
      `  outputSchema,`,                          // line 6
      `});`,
      ``,
    ].join("\n");
    const result = lintScript(src);

    const lines = result.findings.map((f) => f.line);
    const sorted = [...lines].sort((a, b) => a - b);
    expect(lines).toEqual(sorted);
  });
});
