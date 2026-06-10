/**
 * Structured Output Extension — 条件激活的 schema 校验工具 + hook
 *
 * 激活模式：
 *   - 日常 pi（interactive / 普通 print）：不设置 PI_WORKFLOW_SCHEMA，扩展不注册工具
 *   - workflow 子进程：agent-pool 设置 PI_WORKFLOW_SCHEMA=<json>，扩展注册工具 + hook
 *
 * Hook 机制（仅 workflow 模式）：
 *   turn_end 时检查模型是否调用了 structured-output 工具。
 *   如果没调 → 通过 pi.sendUserMessage() 注入 steering message 强制调用。
 *   最多重试 2 次，防止无限循环。
 */

import Ajv, { type ValidateFunction } from "ajv";
import { Type } from "@sinclair/typebox";

/** Pi Extension API — typed as any because shared stub has no real signatures */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PiAPI = any;

const TOOL_NAME = "structured-output";
const ENV_SCHEMA = "PI_WORKFLOW_SCHEMA";
const MAX_HOOK_RETRIES = 2;

// ── Ajv WeakMap cache ─────────────────────────────────────────
const ajvCache = new WeakMap<object, ValidateFunction>();

function getOrCompileValidator(schema: Record<string, unknown>): ValidateFunction {
	const cached = ajvCache.get(schema);
	if (cached) return cached;

	const ajv = new Ajv({ strict: false });
	const validate = ajv.compile(schema);
	ajvCache.set(schema, validate);
	return validate;
}

// ── Tool definition (shared between modes) ─────────────────────

function createToolDefinition() {
	return {
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
			schema: Type.Any({
				description: "JSON Schema draft-07 object. Example: {type:'object',properties:{name:{type:'string'}},required:['name']}",
			}),
			data: Type.Any({
				description: "The value to validate against schema. Example: {name:'Alice'}",
			}),
		}),
		async execute(
			_toolCallId: string,
			params: { schema: Record<string, unknown>; data: unknown },
		) {
			// Normalize: some models pass schema/data as JSON strings instead of objects
			let schema = params.schema;
			let data = params.data;
			if (typeof schema === "string") {
				try { schema = JSON.parse(schema); } catch { /* malformed JSON — keep raw string, Ajv will reject */ }
			}
			if (typeof data === "string") {
				try { data = JSON.parse(data); } catch { /* malformed JSON — keep raw string, Ajv will reject */ }
			}

			let validate: ValidateFunction;
			try {
				validate = getOrCompileValidator(schema as Record<string, unknown>);
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
	};
}

// ── Workflow hook ──────────────────────────────────────────────

/**
 * 注册 turn_end hook，检查模型是否调用了 structured-output 工具。
 * 如果没有调用，通过 pi.sendUserMessage() 注入 steering message。
 *
 * 检测逻辑：在 tool_execution_end 事件中追踪是否有成功的 structured-output 调用。
 */
function setupWorkflowHook(pi: PiAPI, schemaJson: string): void {
	// ── soCalledThisTurn 时序依赖说明 ──
	// Pi 的事件顺序保证：tool_execution_end → Pi 内部错误处理 → 模型下一个 turn → turn_end
	// 这意味着同一 turn 内，所有 tool_execution_end 事件都在 turn_end 之前触发。
	// 因此 soCallCount 在 turn_end 读取时已经反映了本 turn 的所有 tool 调用结果。
	// 如果 model 先调 structured-output 失败（isError=true），soCallCount++ 但 soSucceededEver 仍 false，
	// Pi 的自然错误修正流程会在下一 turn 重试，我们只在本 turn 完全未调用时才注入 steering message。
	let soCallCount = 0;
	let soSucceededEver = false;
	let hookRetryCount = 0;

	// 追踪 structured-output 调用
	// 成功调用 → soSucceededEver=true，后续不再注入
	// 失败调用 → soCallCount++ 但 soSucceededEver 仍 false，让 Pi 自行重试
	pi.on("tool_execution_end", async (event: unknown) => {
		const e = event as { toolName: string; isError: boolean };
		if (e.toolName === TOOL_NAME) {
			soCallCount++;
			if (!e.isError) {
				soSucceededEver = true;
			}
		}
	});

	pi.on("turn_end", async (event: unknown) => {
		// 已经成功调用过 structured-output，不再干预
		if (soSucceededEver) return;

		// 本 turn 调了 structured-output（无论成功失败），让 Pi 自然处理
		// 失败时 Pi 会自动返回错误让模型修正，不需要 hook 干预
		if (soCallCount > 0) {
			soCallCount = 0;
			return;
		}

		const e = event as { message?: { stopReason?: string } };
		// stopReason="toolUse" → 模型还在调工具链，不需要干预
		if (e.message?.stopReason === "toolUse") return;

		// 超过重试上限
		if (hookRetryCount >= MAX_HOOK_RETRIES) return;

		hookRetryCount++;

		const reminder = [
			"[MANDATORY] You MUST call the structured-output tool now.",
			"Your task requires a structured output. Do NOT respond with plain text.",
			`Call the structured-output tool with: schema = ${schemaJson}, data = <your result>`,
			"This is enforced by the workflow system. Just call the tool.",
		].join("\n");

		pi.sendUserMessage(reminder, { deliverAs: "steer" });
	});
}

// ── Extension entry ────────────────────────────────────────────

export default function structuredOutputExtension(pi: PiAPI): void {
	const schemaEnv = process.env[ENV_SCHEMA];

	if (schemaEnv) {
		// ── Workflow 模式：注册工具 + hook ──
		pi.registerTool(createToolDefinition());
		setupWorkflowHook(pi, schemaEnv);
	}
	// 日常模式：不注册任何东西，完全静默
}
