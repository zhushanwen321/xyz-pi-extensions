// src/__tests__/session-runner.test.ts
//
// 锁定 formatSchemaInstruction 契约：构造 schema enforcement 的 MANDATORY 指令。
// 该字符串被拼入 task 末尾 + steer reminder 复用，一旦漏掉 "MUST call structured-output"
// 关键词或 JSON 序列化漂移，schema 模式会静默失效。
import { describe, expect, it } from "vitest";

import { formatSchemaInstruction } from "../core/session-runner.ts";

describe("formatSchemaInstruction", () => {
  it("contains the structured-output tool keyword", () => {
    const out = formatSchemaInstruction({ type: "object" });
    expect(out).toContain("structured-output");
  });

  it("instructs the agent to MUST call structured-output (not output JSON directly)", () => {
    const out = formatSchemaInstruction({ type: "object" });
    expect(out).toContain("MUST");
    expect(out).toContain("MUST call the `structured-output` tool");
    expect(out).toContain("Do NOT output the JSON directly");
  });

  it("embeds the schema as pretty-printed JSON (indent=2)", () => {
    const schema = { type: "object", properties: { name: { type: "string" } } };
    const out = formatSchemaInstruction(schema);
    // 必须包含 JSON.stringify(schema, null, 2) 的完整结果
    expect(out).toContain(JSON.stringify(schema, null, 2));
    expect(out).toContain("```json");
    expect(out).toContain("```");
  });

  it("escapes double quotes inside schema string values", () => {
    const schema = { prompt: 'say "hi"' };
    const out = formatSchemaInstruction(schema);
    // JSON.stringify 会把内层 " 转义为 \"
    expect(out).toContain('say \\"hi\\"');
    expect(out).not.toContain('say "hi"');
  });

  it("escapes newlines inside schema string values", () => {
    const schema = { text: "line1\nline2" };
    const out = formatSchemaInstruction(schema);
    expect(out).toContain("line1\\nline2");
    expect(out).not.toContain("line1\nline2");
  });

  it("handles empty schema object", () => {
    const out = formatSchemaInstruction({});
    expect(out).toContain("structured-output");
    expect(out).toContain("{}");
  });

  it("is deterministic — same schema produces identical output", () => {
    const schema = { a: 1, b: [2, 3] };
    expect(formatSchemaInstruction(schema)).toBe(formatSchemaInstruction(schema));
  });
});
