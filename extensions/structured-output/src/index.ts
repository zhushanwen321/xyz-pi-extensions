/**
 * Structured Output Extension — 全局可用 tool
 *
 * 始终注册 `structured-output` tool，AI 可在任何场景下调用。
 * 调用时传入 schema + data，扩展用 Ajv 验证 data 是否符合 schema。
 *
 * workflow 场景：agent-pool 通过 prompt 指示 AI 调用此 tool 并传入 schema。
 * 普通对话场景：AI 需要返回结构化数据时自行调用。
 */

import Ajv, { type ValidateFunction } from "ajv";
import { Type } from "@sinclair/typebox";

/** Pi Extension API — typed as any because shared stub has no real signatures */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PiAPI = any;

const TOOL_NAME = "structured-output";

// ── Ajv WeakMap cache ─────────────────────────────────────────
// Repeated calls with the same schema object reference are cached.
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
	pi.registerTool({
		name: TOOL_NAME,
		label: "Structured Output",
		description:
			"Return structured output validated against a JSON Schema. "
			+ "Call this tool when you need to produce structured data (JSON). "
			+ "Pass the `schema` (JSON Schema object) and `data` (the value to validate). "
			+ "The tool validates `data` against `schema` and returns it on success.",
		promptSnippet:
			"Use structured-output to return validated JSON data. "
			+ "Pass schema (JSON Schema) and data (your output). "
			+ "Workflow scripts: always use this tool instead of raw JSON in text.",
		promptGuidelines: [
			"Pass a valid JSON Schema in the `schema` parameter.",
			"Pass the data to validate in the `data` parameter.",
			"Do not output JSON in text — use this tool instead.",
		],
		parameters: Type.Object({
			schema: Type.Object({}, {
				description: "JSON Schema object that `data` must conform to",
			}),
			data: Type.Any({
				description: "The value to validate against `schema`",
			}),
		}),
		async execute(
			_toolCallId: string,
			params: { schema: Record<string, unknown>; data: unknown },
		) {
			const { schema, data } = params;

			let validate: ValidateFunction;
			try {
				validate = getOrCompileValidator(schema);
			} catch (e) {
				throw new Error(`Invalid JSON Schema: ${(e as Error).message}`);
			}

			const valid = validate(data);
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
				details: data as Record<string, unknown>,
			};
		},
	});
}
