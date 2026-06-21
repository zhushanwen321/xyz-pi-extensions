import { describe, expect, it } from "vitest";

import { lintScript } from "../infra/script-lint";

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

  it("catches outputSchema as shorthand property in agent()", () => {
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

  it("catches outputSchema as explicit key in agent()", () => {
    const source = `
const result = await agent({ prompt: "hello", outputSchema: mySchema });
`;
    const r = lintScript(source);
    expect(r.valid).toBe(false);
    expect(r.findings[0].message).toContain("outputSchema");
  });

  it("does NOT flag outputSchema used as variable declaration", () => {
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

  it("does NOT flag outputSchema passed as value (schema: outputSchema)", () => {
    const source = `
const result = await agent({ prompt: "hello", schema: outputSchema });
`;
    const r = lintScript(source);
    expect(r.valid).toBe(true);
    expect(r.findings).toHaveLength(0);
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
// This uses outputSchema for structured output
// result.output contains the data
`;
    const r = lintScript(source);
    expect(r.valid).toBe(true);
    expect(r.findings).toHaveLength(0);
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

  it("handles multi-line agent() calls with outputSchema shorthand", () => {
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
