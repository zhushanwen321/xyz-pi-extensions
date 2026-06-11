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
			+ "Call this tool to produce validated JSON data. "
			+ "Pass `schema` (a JSON Schema draft-07 object) and `data` (the value to validate).\n\n"
			+ "✅ Correct: schema={type:'object',properties:{name:{type:'string'},age:{type:'number'}},required:['name']}, data={name:'Alice',age:30}\n"
			+ "✅ Correct: schema={type:'array',items:{type:'string'}}, data=['a','b','c']\n"
			+ "✅ Correct: schema={type:'string',enum:['low','medium','high']}, data='medium'\n\n"
			+ "❌ Wrong: putting the answer in text instead of calling this tool\n"
			+ "❌ Wrong: data not matching schema (e.g. schema requires number but data is string)\n"
			+ "❌ Wrong: schema={type:'object'} with data='hello' (string ≠ object)",
		promptSnippet:
			"Use structured-output to return validated JSON data. "
			+ "Pass schema (JSON Schema draft-07) and data (your output). "
			+ "Example: {schema:{type:'object',properties:{score:{type:'number'}},required:['score']}, data:{score:8}}",
		promptGuidelines: [
			"schema must be a valid JSON Schema (draft-07). data must conform to it.",
			"Both primitive types (string, number, boolean) and complex types (object, array) are valid schema roots.",
			"Do not output JSON in text — call this tool instead.",
		],
		parameters: Type.Object({
			schema: Type.Unknown({
				description: "JSON Schema draft-07 object. Example: {type:'object',properties:{name:{type:'string'}},required:['name']}",
			}),
			data: Type.Unknown({
				description: "The value to validate against schema. Example: {name:'Alice'}",
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
