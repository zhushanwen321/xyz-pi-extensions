/**
 * Structured Output Extension
 *
 * Detects STRUCTURED_OUTPUT_SCHEMA env var on session start, registers a tool
 * with Ajv-compiled validation, injects system prompt, and enforces tool usage
 * via turn_end + sendUserMessage.
 *
 * Design: FR-1 to FR-5 from spec, FR-4 dual-layer enforcement.
 * Reference: Claude Code's SyntheticOutputTool (Ajv + Stop hook).
 */

import Ajv, { type ValidateFunction } from "ajv";
import { Type } from "@sinclair/typebox";
// eslint-disable-next-line @typescript-eslint/no-explicit-any

type PiAPI = any; // Extension API — typed as any for stub compatibility

const ENV_KEY = "STRUCTURED_OUTPUT_SCHEMA";
const TOOL_NAME = "structured-output";

const SYSTEM_PROMPT =
  "你必须在完成分析后调用 structured-output tool 来返回结构化结果。" +
  "不要在文本回复中输出 JSON，直接调用 structured-output tool。" +
  "这是你返回最终结果的唯一方式。";

const ENFORCEMENT_MESSAGE = "你必须调用 structured-output tool 来返回结果。";

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

  // Compile with Ajv
  const ajv = new Ajv({ strict: false });
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } catch (e) {
    console.error(`[${TOOL_NAME}] Invalid JSON Schema:`, (e as Error).message);
    return;
  }

  // Register tool — passthrough parameters (schema is dynamic per session)
  pi.registerTool({
    name: TOOL_NAME,
    label: "Structured Output",
    description:
      "Return structured output conforming to the JSON Schema. You MUST call this tool to return your final result.",
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
      return {
        content: [
          { type: "text" as const, text: "Structured output recorded successfully." },
        ],
        details: params,
        terminate: true,
      };
    },
  });

  // System prompt injection
  (pi as PiAPI).on("before_agent_start", async (_event: unknown, ctx: { addSystemInstruction: (s: string) => void }) => {
    ctx.addSystemInstruction(SYSTEM_PROMPT);
  });

  // Enforcement: track tool calls via tool_execution_start flag
  let hasStructuredOutputCall = false;

  (pi as PiAPI).on("tool_execution_start", async (event: { toolName: string }) => {
    if (event.toolName === TOOL_NAME) {
      hasStructuredOutputCall = true;
    }
  });

  (pi as PiAPI).on("turn_end", async () => {
    if (!hasStructuredOutputCall) {
      (pi as PiAPI).sendUserMessage(ENFORCEMENT_MESSAGE);
    }
  });

  // Block non-workflow usage
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pi as PiAPI).on("tool_call", async (event: { toolName: string }): Promise<any> => {
    if (event.toolName === TOOL_NAME && !process.env[ENV_KEY]) {
      return {
        block: true,
        reason: "This tool is only available in workflow structured-output mode",
      };
    }
    return undefined;
  });
}
