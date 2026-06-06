import { describe, expect, it } from "vitest";

import { lintScript } from "../script-lint";

describe("lintScript", () => {
  it("passes a clean script", () => {
    const source = `
const meta = { name: "test" };
const result = await agent({ prompt: "hello", schema: mySchema });
const value = result.someField;
`;
    const r = lintScript(source);
    expect(r.valid).toBe(true);
    expect(r.findings).toHaveLength(0);
  });

  it("catches outputSchema (should be schema)", () => {
    const source = `
const result = await agent({ prompt: "hello", outputSchema });
`;
    const r = lintScript(source);
    expect(r.valid).toBe(false);
    expect(r.findings[0].message).toContain("outputSchema");
    expect(r.findings[0].line).toBe(2);
  });

  it("catches result.output", () => {
    const source = `
const result = await agent({ prompt: "hello" });
const x = result.output;
`;
    const r = lintScript(source);
    expect(r.valid).toBe(false);
    expect(r.findings[0].message).toContain("result.output");
  });

  it("catches result.parsedOutput", () => {
    const source = `
const result = await agent({ prompt: "hello" });
const x = result.parsedOutput;
`;
    const r = lintScript(source);
    expect(r.valid).toBe(false);
    expect(r.findings[0].message).toContain("result.parsedOutput");
  });

  it("catches result.content", () => {
    const source = `
const result = await agent({ prompt: "hello" });
const x = result.content;
`;
    const r = lintScript(source);
    expect(r.valid).toBe(false);
    expect(r.findings[0].message).toContain("result.content");
  });

  it("warns on readFileSync for state files", () => {
    const source = `
const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
`;
    const r = lintScript(source);
    expect(r.valid).toBe(true); // warning, not error
    expect(r.findings.some((f) => f.message.includes("state file"))).toBe(true);
  });

  it("warns on unlinkSync for state cleanup", () => {
    const source = `
try { fs.unlinkSync(STATE_FILE); } catch {}
`;
    const r = lintScript(source);
    expect(r.valid).toBe(true); // warning
    expect(r.findings.some((f) => f.message.includes("unlinkSync"))).toBe(true);
  });

  it("skips comment lines", () => {
    const source = `
// This script uses outputSchema for structured output
// result.output contains the parsed data
`;
    const r = lintScript(source);
    expect(r.valid).toBe(true);
    expect(r.findings).toHaveLength(0);
  });

  it("reports multiple findings", () => {
    const source = `
const r1 = await agent({ prompt: "a", outputSchema });
const x = r1.output;
const r2 = await agent({ prompt: "b", outputSchema });
const y = r2.parsedOutput;
`;
    const r = lintScript(source);
    expect(r.valid).toBe(false);
    expect(r.findings.length).toBeGreaterThanOrEqual(4);
  });

  it("does not flag schema (correct usage)", () => {
    const source = `
const result = await agent({ prompt: "hello", schema: mySchema });
const value = result.field;
`;
    const r = lintScript(source);
    expect(r.valid).toBe(true);
    expect(r.findings).toHaveLength(0);
  });
});
