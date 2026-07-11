// src/__tests__/format-schema-instruction.test.ts
//
// 锁定 formatSchemaInstruction 契约：构造 schema enforcement 的 MANDATORY 指令。
// 该字符串被拼入 task 末尾（runSpawn 的 fullTask = task + instruction），且 steer
// reminder 复用同一文本。一旦漏掉 "MUST call structured-output" 关键词或 JSON
// 序列化漂移，schema 模式会静默失效——agent 可能直接把 JSON 写进文本响应。
//
// 纯函数测试：不依赖 Pi 运行时、不 spawn 进程、不 mock。只 import 被测函数。
import { describe, expect, it } from "vitest";

import { formatSchemaInstruction } from "../session-runner.ts";

describe("formatSchemaInstruction", () => {
  // ── 指令文本契约 ──────────────────────────────────────────────

  it("contains the structured-output tool keyword", () => {
    const out = formatSchemaInstruction({ type: "object" });
    expect(out).toContain("structured-output");
  });

  it("emits a MANDATORY structured-output directive (not free-form JSON)", () => {
    const out = formatSchemaInstruction({ type: "object" });
    expect(out).toContain("MANDATORY");
    expect(out).toContain("MUST");
    expect(out).toContain("MUST call the `structured-output` tool");
    expect(out).toContain("Do NOT output the JSON directly");
  });

  // ── schema 序列化 ─────────────────────────────────────────────

  it("embeds the schema as pretty-printed JSON (indent=2) inside a fenced block", () => {
    const schema: Record<string, unknown> = {
      type: "object",
      properties: { name: { type: "string" } },
    };
    const out = formatSchemaInstruction(schema);
    // 必须包含 JSON.stringify(schema, null, 2) 的完整结果
    expect(out).toContain(JSON.stringify(schema, null, 2));
    expect(out).toContain("```json");
    expect(out).toContain("```");
    // indent=2 的可观察证据：属性键前有恰好两个空格（object 第一层缩进）
    expect(out).toContain('\n  "type": "object"');
  });

  it("locks the full output structure for a minimal schema", () => {
    const out = formatSchemaInstruction({ type: "object" });
    // 完整结构快照——任何指令措辞/顺序/缩进漂移都会被捕获。
    // 注意第三行末尾的 em-dash（—），防止有人把它替换成普通连字符。
    expect(out).toBe(
      [
        "MANDATORY: Structured Output Requirement",
        "You MUST call the `structured-output` tool with your final answer.",
        "Do NOT output the JSON directly in your text response — you MUST use the structured-output tool.",
        "The schema for the structured output is:",
        "```json",
        '{',
        '  "type": "object"',
        '}',
        "```",
      ].join("\n"),
    );
  });

  // ── 特殊字符转义（注入风险路径）──────────────────────────────

  it("escapes double quotes inside schema string values", () => {
    const schema: Record<string, unknown> = { prompt: 'say "hi"' };
    const out = formatSchemaInstruction(schema);
    // JSON.stringify 会把内层 " 转义为 \"
    expect(out).toContain('say \\"hi\\"');
    // 原始未转义形式（含成对字面双引号）绝不能回流进 JSON 体内
    expect(out).not.toContain('say "hi"');
  });

  it("escapes newlines inside schema string values", () => {
    const schema: Record<string, unknown> = { text: "line1\nline2" };
    const out = formatSchemaInstruction(schema);
    // 换行被序列化为字面反斜杠-n，不能是真实换行符
    expect(out).toContain("line1\\nline2");
    expect(out).not.toContain("line1\nline2");
  });

  it("escapes backslashes inside schema string values", () => {
    const schema: Record<string, unknown> = { path: "C:\\Users\\x" };
    const out = formatSchemaInstruction(schema);
    // 单反斜杠被序列化为 \\，避免后续解析误把转义序列当指令
    expect(out).toContain("C:\\\\Users\\\\x");
    expect(out).not.toContain("C:\\Users\\x");
  });

  // ── 边界值 ────────────────────────────────────────────────────

  it("handles empty schema object", () => {
    const out = formatSchemaInstruction({});
    expect(out).toContain("structured-output");
    expect(out).toContain("{}");
  });

  it("preserves null values in schema", () => {
    const schema: Record<string, unknown> = { default: null };
    const out = formatSchemaInstruction(schema);
    // JSON.stringify 对 null 保留字面 "null"（不会 omit 键，也不会变字符串）
    expect(out).toContain('"default": null');
  });

  it("serializes nested objects and arrays", () => {
    const schema: Record<string, unknown> = {
      type: "object",
      required: ["name", "age"],
      properties: {
        name: { type: "string" },
        age: { type: "integer", minimum: 0 },
      },
    };
    const out = formatSchemaInstruction(schema);
    expect(out).toContain(JSON.stringify(schema, null, 2));
    // 嵌套结构 indent 正确（第二层 4 空格）
    expect(out).toContain('    "name": {');
    expect(out).toContain('      "type": "string"');
  });

  // ── 确定性 ────────────────────────────────────────────────────

  it("is deterministic — same schema produces identical output", () => {
    const schema: Record<string, unknown> = { a: 1, b: [2, 3] };
    expect(formatSchemaInstruction(schema)).toBe(formatSchemaInstruction(schema));
  });

  it("is deterministic across different object key insertion (value-equal schemas)", () => {
    // JSON.stringify 按对象自身属性顺序序列化；同序构造的等价 schema 应产出相同指令
    const a: Record<string, unknown> = { x: 1, y: 2 };
    const b: Record<string, unknown> = { x: 1, y: 2 };
    expect(formatSchemaInstruction(a)).toBe(formatSchemaInstruction(b));
  });
});
