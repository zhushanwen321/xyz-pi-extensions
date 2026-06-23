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
 * 从 tool 执行结果里提取错误文本。
 *
 * Pi 框架在 tool execute 抛错时，构造 `{ content: [{ type: "text", text }] }`
 * 塞进 result.content[0].text（见 extensions/unified-hooks 的 extractErrorText 及其
 * 文档：SDK 事件结构里没有独立 errorMessage 字段，错误文本只能从 result.content 里取）。
 * 这里防御性取多种结构，取不到就返回 undefined（调用方降级为通用提示）。
 */
function extractToolErrorText(result: unknown): string | undefined {
	// 常见结构：{ content: [{ type: "text", text: "..." }] }
	if (typeof result === "object" && result !== null) {
		const content = (result as Record<string, unknown>).content;
		if (Array.isArray(content)) {
			for (const item of content) {
				if (typeof item === "object" && item !== null) {
					const text = (item as Record<string, unknown>).text;
					if (typeof text === "string" && text.length > 0) return text;
				}
			}
		}
		// 兜底：某些 tool 直接塞 { error: "..." }
		const err = (result as Record<string, unknown>).error;
		if (typeof err === "string" && err.length > 0) return err;
	}
	return undefined;
}

/**
 * 注册 turn_end hook，检查模型是否成功调用 structured-output 工具。
 * 未成功时通过 pi.sendUserMessage({deliverAs:"steer"}) 注入 steering message 重试。
 *
 * 两种失败形态都会触发 steer：
 * 1. 完全没调用（soCallCount === 0）→ 注入"必须调用"提示 + 正确 schema
 * 2. 调了但全是 isError（soCallCount > 0 && !soSucceededEver）→ 注入具体校验错误
 *    + 正确 schema。旧实现在此处撒手交给 Pi 自然修正，但模型遇到 "Invalid JSON Schema"
 *    时无法自行修正（它不知道正确 schema 长什么样），实测会放弃 → 子进程正常退出 →
 *    workflow 把单点失败放大成整批崩溃。故此处主动 steer 并回灌错误细节。
 *
 * 检测时序：Pi 保证同 turn 内所有 tool_execution_end 都在 turn_end 之前触发，
 * 故 turn_end 读取的状态已反映本 turn 全部 tool 调用结果。
 */
function setupWorkflowHook(pi: PiAPI, schemaJson: string): void {
	let soCallCount = 0;
	let soSucceededEver = false;
	let hookRetryCount = 0;
	// 最近一次 structured-output 调用的错误文本（isError=true 时从 result.content 提取）。
	// turn_end 据此决定 steer 消息是"必须调用"还是"修正后重试"。
	let lastSchemaError = "";

	// 追踪 structured-output 调用结果：
	// 成功 → soSucceededEver=true（终态，后续不再干预）
	// 失败 → soCallCount++，记录 lastSchemaError，由 turn_end 决定是否 steer 重试
	pi.on("tool_execution_end", async (event: unknown) => {
		const e = event as { toolName: string; isError: boolean; result?: unknown };
		if (e.toolName !== TOOL_NAME) return;
		soCallCount++;
		if (!e.isError) {
			soSucceededEver = true;
		} else {
			lastSchemaError = extractToolErrorText(e.result) ?? "structured-output call failed";
		}
	});

	pi.on("turn_end", async (event: unknown) => {
		// 已经成功调用过 structured-output，不再干预
		if (soSucceededEver) return;

		// 完全没调用 OR 调了但全是失败 → 都需要 steer。两种情况共用重试上限与计数。
		// stopReason="toolUse" → 模型还在调工具链，不需要干预
		const e = event as { message?: { stopReason?: string } };
		if (e.message?.stopReason === "toolUse") return;

		// 超过重试上限：放弃，让子进程自然结束（调用方据 result.error 判定失败）
		if (hookRetryCount >= MAX_HOOK_RETRIES) return;

		const calledButFailed = soCallCount > 0;
		// 按本 turn 重置计数；lastSchemaError 在下次 steer 消息构造后自然覆盖
		soCallCount = 0;
		hookRetryCount++;

		const reminder = calledButFailed
			? [
					"[MANDATORY] Your structured-output call FAILED validation:",
					lastSchemaError,
					"",
					`The correct schema is: ${schemaJson}`,
					"Call the structured-output tool AGAIN with data conforming to this schema.",
					"Do NOT output the result as text — call the tool.",
				].join("\n")
			: [
					"[MANDATORY] You MUST call the structured-output tool now.",
					"Your task requires a structured output. Do NOT respond with plain text.",
					`Call the structured-output tool with: schema = ${schemaJson}, data = <your result>`,
					"This is enforced by the workflow system. Just call the tool.",
				].join("\n");

		lastSchemaError = "";
		pi.sendUserMessage(reminder, { deliverAs: "steer" });
	});
}

// ── Extension entry ────────────────────────────────────────────

export default function structuredOutputExtension(pi: PiAPI): void {
	const schemaEnv = process.env[ENV_SCHEMA];

	// Always register the tool so it's available in all sessions (interactive, workflow, etc.)
	pi.registerTool(createToolDefinition());

	if (schemaEnv) {
		// ── Workflow 模式：额外注册 hook 强制调用 ──
		setupWorkflowHook(pi, schemaEnv);
	}
}
