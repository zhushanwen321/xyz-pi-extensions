/**
 * Structured Output Extension
 *
 * Detects STRUCTURED_OUTPUT_SCHEMA env var on session start, registers a tool
 * with Ajv-compiled validation, injects system prompt, and enforces tool usage
 * via turn_end + sendUserMessage.
 *
 * Design: FR-1 to FR-5 from spec, FR-4 dual-layer enforcement.
 * Reference: Claude Code's SyntheticOutputTool (Ajv + Stop hook).
 *
 * Key design decisions (borrowed from Claude Code):
 * - Schema is injected into BOTH system prompt AND tool description, so LLM
 *   knows the exact output structure regardless of which signal it reads.
 * - Enforcement checks "last call succeeded" (not "was called"), so validation
 *   failures trigger retries rather than being silently skipped.
 * - Retry cap prevents infinite enforcement loops on persistent schema mismatch.
 * - WeakMap caches Ajv compile results for repeated calls with the same schema
 *   object reference (mirrors Claude Code's toolCache pattern).
 */

import Ajv, { type ValidateFunction } from "ajv";
import { Type } from "@sinclair/typebox";

/** Pi Extension API — typed as any because shared stub has no real signatures */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PiAPI = any;

const ENV_KEY = "STRUCTURED_OUTPUT_SCHEMA";
const TOOL_NAME = "structured-output";
const MAX_RETRIES = parseInt(process.env.MAX_STRUCTURED_OUTPUT_RETRIES || "5", 10);

const ENFORCEMENT_MESSAGE = "你必须调用 structured-output tool 来返回结果。";

// ── Ajv WeakMap cache ─────────────────────────────────────────
// Workflow scripts may call agent({schema}) 30-80 times per run.
// Without caching, each call does new Ajv() + validateSchema() + compile().
// WeakMap keyed by schema object reference brings this to near-zero overhead.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ajvCache = new WeakMap<object, ValidateFunction>();

function getOrCompileValidator(schema: Record<string, unknown>): ValidateFunction {
  const cached = ajvCache.get(schema);
  if (cached) return cached;

  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(schema);
  ajvCache.set(schema, validate);
  return validate;
}

export default function structuredOutputExtension(pi: PiAPI): void {
  const schemaStr = process.env[ENV_KEY];
  if (!schemaStr) return;

  // Parse schema
  let schema: Record<string, unknown>;
  try {
    schema = JSON.parse(schemaStr);
  } catch {
    console.error(`[${TOOL_NAME}] Failed to parse ${ENV_KEY}`);
    return;
  }

  // Compile with Ajv (cached)
  let validate: ValidateFunction;
  try {
    validate = getOrCompileValidator(schema);
  } catch (e) {
    console.error(`[${TOOL_NAME}] Invalid JSON Schema:`, (e as Error).message);
    return;
  }

  // Build prompts with schema embedded
  const schemaJsonStr = JSON.stringify(schema, null, 2);
  const systemPrompt =
    "你必须在完成分析后调用 structured-output tool 来返回结构化结果。" +
    "不要在文本回复中输出 JSON，直接调用 structured-output tool。" +
    "这是你返回最终结果的唯一方式。\n\n" +
    "输出必须严格符合以下 JSON Schema:\n" + schemaJsonStr;

  const toolDescription =
    "Return structured output conforming to the JSON Schema. " +
    "You MUST call this tool exactly once to return your final result.\n\n" +
    "The output must conform to this JSON Schema:\n" + schemaJsonStr;

  // Track structured-output call state per turn
  let turnCallCount = 0;
  let lastCallSucceeded = false;

  // Register tool
  pi.registerTool({
    name: TOOL_NAME,
    label: "Structured Output",
    description: toolDescription,
    promptSnippet: "Call structured-output with your final structured answer",
    promptGuidelines: [
      "You MUST call structured-output as your final action.",
      "Do not output JSON in your text response — use this tool instead.",
    ],
    parameters: Type.Record(Type.String(), Type.Any()),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const valid = validate(params);
      if (!valid) {
        const errors = validate.errors
          ?.map((err) => `${err.instancePath} ${err.message}`)
          .join("; ");
        throw new Error(`Schema validation failed: ${errors}`);
      }
      // Mark success for enforcement check
      lastCallSucceeded = true;
      return {
        content: [
          { type: "text" as const, text: "Structured output recorded successfully." },
        ],
        details: params,
      };
    },
  });

  // System prompt injection with embedded schema
  pi.on("before_agent_start", async (_event: unknown, ctx: { addSystemInstruction: (s: string) => void }) => {
    ctx.addSystemInstruction(systemPrompt);
  });

  // Track calls — count for retry cap, success for enforcement
  pi.on("tool_execution_start", async (event: { toolName: string }) => {
    if (event.toolName === TOOL_NAME) {
      turnCallCount++;
    }
  });

  pi.on("turn_end", async () => {
    if (lastCallSucceeded) {
      // Reset for next potential turn (shouldn't happen, but defensive)
      lastCallSucceeded = false;
      turnCallCount = 0;
      return;
    }

    // Retry cap: stop enforcement after MAX_RETRIES attempts
    if (turnCallCount >= MAX_RETRIES) {
      console.error(
        `[${TOOL_NAME}] Max retries (${MAX_RETRIES}) reached without valid output. Giving up enforcement.`,
      );
      turnCallCount = 0;
      return;
    }

    pi.sendUserMessage(ENFORCEMENT_MESSAGE);
  });
}
