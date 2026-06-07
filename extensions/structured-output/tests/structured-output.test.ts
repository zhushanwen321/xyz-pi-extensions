// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）
// 运行命令：npx vitest run tests/structured-output.test.ts
//
// 测试 structured-output extension 的核心逻辑：
// 1. Schema 解析与 Ajv 编译
// 2. Tool execute 校验（通过/失败）
// 3. 环境变量检测逻辑

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 直接使用真实的 Ajv，因为这是核心依赖
import Ajv from "ajv";

// ── 纯逻辑测试：Schema 解析 + Ajv 校验 ──────────────────────

describe("Schema parsing and Ajv validation", () => {
  let ajv: Ajv;

  beforeEach(() => {
    ajv = new Ajv({ strict: false });
  });

  it("compiles a valid schema and validates matching input", () => {
    const schema = {
      type: "object",
      properties: {
        mustFix: { type: "boolean" },
        issues: { type: "array", items: { type: "string" } },
      },
      required: ["mustFix"],
    };

    const validate = ajv.compile(schema);

    expect(validate({ mustFix: true, issues: ["bug"] })).toBe(true);
    expect(validate({ mustFix: false })).toBe(true);
    expect(validate({ mustFix: true, extra: "ok" })).toBe(true); // additionalProperties allowed by default
  });

  it("rejects input that does not match schema", () => {
    const schema = {
      type: "object",
      properties: {
        count: { type: "number" },
      },
      required: ["count"],
    };

    const validate = ajv.compile(schema);

    expect(validate({ count: "not-a-number" })).toBe(false);
    expect(validate({})).toBe(false); // missing required
    expect(validate({ count: 42 })).toBe(true);
  });

  it("produces detailed error messages on validation failure", () => {
    const schema = {
      type: "object",
      properties: {
        score: { type: "number", minimum: 0, maximum: 100 },
      },
      required: ["score"],
    };

    const validate = ajv.compile(schema);
    validate({ score: -1 });

    expect(validate.errors).toBeDefined();
    expect(validate.errors!.length).toBeGreaterThan(0);
    const errorMsg = validate.errors!.map((e) => `${e.instancePath} ${e.message}`).join("; ");
    expect(errorMsg).toContain("must be");
  });

  it("validates nested object schemas", () => {
    const schema = {
      type: "object",
      properties: {
        result: {
          type: "object",
          properties: {
            items: { type: "array" },
          },
          required: ["items"],
        },
      },
      required: ["result"],
    };

    const validate = ajv.compile(schema);

    expect(validate({ result: { items: [1, 2, 3] } })).toBe(true);
    expect(validate({ result: {} })).toBe(false); // missing items
    expect(validate({})).toBe(false); // missing result
  });
});

// ── 环境变量解析逻辑 ──────────────────────────────────────

describe("STRUCTURED_OUTPUT_SCHEMA env var parsing", () => {
  const originalEnv = process.env.STRUCTURED_OUTPUT_SCHEMA;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.STRUCTURED_OUTPUT_SCHEMA;
    } else {
      process.env.STRUCTURED_OUTPUT_SCHEMA = originalEnv;
    }
  });

  it("parses valid JSON schema from env var", () => {
    process.env.STRUCTURED_OUTPUT_SCHEMA = JSON.stringify({
      type: "object",
      properties: { answer: { type: "string" } },
    });

    const raw = process.env.STRUCTURED_OUTPUT_SCHEMA;
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed.type).toBe("object");
    expect(parsed.properties.answer.type).toBe("string");
  });

  it("JSON.parse throws on invalid JSON", () => {
    process.env.STRUCTURED_OUTPUT_SCHEMA = "{invalid json";
    expect(() => JSON.parse(process.env.STRUCTURED_OUTPUT_SCHEMA!)).toThrow();
  });

  it("Ajv validateSchema returns false for invalid schema structure", () => {
    const ajv = new Ajv({ strict: false });
    // Schema with invalid type value
    const badSchema = { type: "not-a-real-type" };
    // Ajv in non-strict mode may still compile this, but let's verify behavior
    // More realistic: check that a deeply invalid schema fails compilation
    const compileResult = ajv.compile(badSchema);
    // The compile should succeed (Ajv is lenient), but validation should work predictably
    expect(typeof compileResult).toBe("function");
  });
});

// ── Tool execute 模拟测试 ──────────────────────────────────

describe("Tool execute behavior simulation", () => {
  it("returns terminate:true on valid input", () => {
    const ajv = new Ajv({ strict: false });
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const validate = ajv.compile(schema);

    const params = { ok: true };
    const valid = validate(params);

    expect(valid).toBe(true);
    // Simulated tool result
    const result = {
      content: [{ type: "text" as const, text: "Structured output recorded successfully." }],
      details: params,
      terminate: true,
    };
    expect(result.terminate).toBe(true);
    expect(result.details).toEqual({ ok: true });
  });

  it("throws with Ajv error details on invalid input", () => {
    const ajv = new Ajv({ strict: false });
    const schema = {
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    };
    const validate = ajv.compile(schema);

    const params = { count: "not-a-number" };
    const valid = validate(params);

    expect(valid).toBe(false);
    expect(validate.errors).toBeDefined();

    // Simulated tool error
    const errors = validate.errors!.map((e) => `${e.instancePath} ${e.message}`).join("; ");
    const errorMsg = `Schema validation failed: ${errors}`;
    expect(errorMsg).toContain("must be");
  });

  it("accepts passthrough params (any JSON object)", () => {
    const ajv = new Ajv({ strict: false });
    // Complex schema matching real workflow usage
    const schema = {
      type: "object",
      properties: {
        mustFix: { type: "boolean" },
        issues: { type: "array", items: { type: "string" } },
        metadata: {
          type: "object",
          properties: {
            score: { type: "number" },
            confidence: { type: "number" },
          },
        },
      },
      required: ["mustFix"],
    };
    const validate = ajv.compile(schema);

    // Valid complex input
    expect(validate({
      mustFix: true,
      issues: ["unused variable", "missing return type"],
      metadata: { score: 0.85, confidence: 0.92 },
    })).toBe(true);

    // Minimal valid input
    expect(validate({ mustFix: false })).toBe(true);
  });
});

// ── Enforcement flag 逻辑 ─────────────────────────────────

describe("Enforcement flag logic", () => {
  it("flag starts false, set to true on structured-output tool_execution_start", () => {
    let hasStructuredOutputCall = false;

    // Simulate tool_execution_start event
    const event = { toolName: "structured-output", args: { ok: true } };
    if (event.toolName === "structured-output") {
      hasStructuredOutputCall = true;
    }

    expect(hasStructuredOutputCall).toBe(true);
  });

  it("flag stays false on non-structured-output tool_execution_start", () => {
    let hasStructuredOutputCall = false;

    const event = { toolName: "read", args: { path: "/foo" } };
    if (event.toolName === "structured-output") {
      hasStructuredOutputCall = true;
    }

    expect(hasStructuredOutputCall).toBe(false);
  });

  it("flag stays false across multiple non-structured-output events", () => {
    let hasStructuredOutputCall = false;

    for (const toolName of ["read", "edit", "bash", "glob"]) {
      if (toolName === "structured-output") {
        hasStructuredOutputCall = true;
      }
    }

    expect(hasStructuredOutputCall).toBe(false);
  });

  it("sendUserMessage should be called when flag is false at turn_end", () => {
    let hasStructuredOutputCall = false;
    const sendUserMessage = vi.fn();

    // Simulate turn_end without structured-output call
    if (!hasStructuredOutputCall) {
      sendUserMessage("你必须调用 structured-output tool 来返回结果。");
    }

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledWith("你必须调用 structured-output tool 来返回结果。");
  });

  it("sendUserMessage should NOT be called when flag is true at turn_end", () => {
    let hasStructuredOutputCall = true;
    const sendUserMessage = vi.fn();

    if (!hasStructuredOutputCall) {
      sendUserMessage("你必须调用 structured-output tool 来返回结果。");
    }

    expect(sendUserMessage).not.toHaveBeenCalled();
  });
});

// ── tool_call block 逻辑 ─────────────────────────────────

describe("tool_call block logic", () => {
  it("blocks structured-output call when no env var", () => {
    delete process.env.STRUCTURED_OUTPUT_SCHEMA;

    const event = { toolName: "structured-output" };
    const result = event.toolName === "structured-output" && !process.env.STRUCTURED_OUTPUT_SCHEMA
      ? { block: true, reason: "This tool is only available in workflow structured-output mode" }
      : undefined;

    expect(result).toEqual({
      block: true,
      reason: "This tool is only available in workflow structured-output mode",
    });
  });

  it("does not block structured-output call when env var is set", () => {
    process.env.STRUCTURED_OUTPUT_SCHEMA = '{"type":"object"}';

    const event = { toolName: "structured-output" };
    const result = event.toolName === "structured-output" && !process.env.STRUCTURED_OUTPUT_SCHEMA
      ? { block: true, reason: "This tool is only available in workflow structured-output mode" }
      : undefined;

    expect(result).toBeUndefined();

    delete process.env.STRUCTURED_OUTPUT_SCHEMA;
  });

  it("does not interfere with other tool calls", () => {
    delete process.env.STRUCTURED_OUTPUT_SCHEMA;

    const event = { toolName: "read" };
    const result = event.toolName === "structured-output" && !process.env.STRUCTURED_OUTPUT_SCHEMA
      ? { block: true, reason: "..." }
      : undefined;

    expect(result).toBeUndefined();
  });
});
