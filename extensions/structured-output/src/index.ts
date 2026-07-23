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

import { Type } from "@sinclair/typebox";
import Ajv, { type ValidateFunction } from "ajv";

/** Pi Extension API — typed as any because shared stub has no real signatures */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PiAPI = any;

const TOOL_NAME = "structured-output";
const ENV_SCHEMA = "PI_WORKFLOW_SCHEMA";
const MAX_HOOK_RETRIES = 2;

// ── Ajv WeakMap cache ─────────────────────────────────────────
const ajvCache = new WeakMap<object, ValidateFunction>();

function getOrCompileValidator(schema: Record<string, unknown> | boolean): ValidateFunction {
	// boolean 根 schema（true=接受一切，false=拒绝一切）是合法 draft-07，
	// 但 boolean 不能做 WeakMap key，故不缓存（编译结果恒定，重复编译无副作用）。
	if (typeof schema === "boolean") {
		return new Ajv({ strict: false }).compile(schema);
	}
	const cached = ajvCache.get(schema);
	if (cached) return cached;

	const ajv = new Ajv({ strict: false });
	const validate = ajv.compile(schema);
	ajvCache.set(schema, validate);
	return validate;
}

// ── Schema-shape guards (swap detection + silent-corruption prevention) ──
//
// 核心问题：schema 和 data 参数都用 Type.Unknown()，结构无差别。弱模型常把答案
// 塞进 schema、把形状塞进 data。因 ajv strict:false 把无 keyword 的对象编译成
// "接受一切" 的 validator，互换后会校验通过、存垃圾、无报错（静默腐败）。
// 这组守卫在编译前拦截两类形态：互换（schema 像数据 + data 像 schema）和
// keyword-less schema（{} / {a:1} 这种会被 ajv 静默放行）。

/** JSON Schema draft-07 识别 keyword。只要 schema 含其一就认为是"真 schema"。 */
const SCHEMA_KEYWORDS = [
	// 核心类型
	"type",
	// object
	"properties", "required", "additionalProperties", "patternProperties",
	"minProperties", "maxProperties",
	// array
	"items", "additionalItems", "minItems", "maxItems", "uniqueItems",
	// enum / const
	"enum", "const",
	// 组合
	"allOf", "anyOf", "oneOf", "not",
	// 条件验证（draft-07）
	"if", "then", "else",
	// 依赖与约束
	"dependencies", "propertyNames", "contains",
	// 引用与定义
	"$ref", "$id", "$defs", "definitions",
	// 数值
	"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
	// 字符串
	"minLength", "maxLength", "pattern", "format",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasSchemaKeyword(obj: Record<string, unknown>): boolean {
	return SCHEMA_KEYWORDS.some((keyword) => keyword in obj);
}

/** 错误回显长度上限（截断长 schema/data，避免错误消息爆炸）。 */
const ECHO_MAX_CHARS = 200;

function echo(value: unknown): string {
	let str: string;
	try {
		// JSON.stringify(undefined) 返回 undefined（不是 throw），需 ?? 兜底，
		// 否则后续 str.length 会 "Cannot read properties of undefined"。
		str = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
	} catch {
		str = String(value);
	}
	return str.length <= ECHO_MAX_CHARS ? str : `${str.slice(0, ECHO_MAX_CHARS)}...`;
}

/**
 * 尝试 JSON.parse；失败（malformed JSON）时保留原值，让 Ajv 拒绝。
 * 模型有时把 schema/data 当 JSON 字符串传；parse 失败不是错误，保持原样让下游校验拒绝。
 * catch 里有实质处理（决定返回原值），满足 taste/no-silent-catch。
 */
function tryParseJson(raw: unknown): unknown {
	if (typeof raw !== "string") return raw;
	try {
		return JSON.parse(raw);
	} catch {
		return raw; // malformed JSON → 保留原字符串，Ajv 会拒绝
	}
}

/** turn_end event 是否可安全访问 message.stopReason（用于判断模型是否还在调工具链）。 */
function isTurnEndEvent(e: unknown): e is { message?: { stopReason?: string } } {
	return typeof e === "object" && e !== null;
}

/** tool_execution_end event 结构守卫（替代直接 cast，配合 taste/no-unsafe-cast）。 */
function isToolExecutionEndEvent(
	e: unknown,
): e is { toolName: unknown; isError: unknown; result?: unknown } {
	return typeof e === "object" && e !== null && "toolName" in e && "isError" in e;
}

/** swap 检测 + keyword-less schema 拒绝的纠错文案前缀，所有相关错误共用。 */
const CORRECT_USAGE_HINT =
	"Correct: structured_output({schema:{type:'object',properties:{...}}, data:{...actual values}}). ";

/**
 * 执行 schema 校验。从 createToolDefinition.execute 抽出以便单元测试直接调用。
 *
 * 防御顺序（编译前拦截，治静默腐败的根）：
 *   1. 互换检测 — schema 像 data（无 keyword）且 data 像 schema（有 keyword）→ 抛纠错
 *   2. keyword-less schema 拒绝 — schema 是对象但无任何识别 keyword（{} / {a:1}）
 *      → 抛 "no recognized keyword"，否则 ajv strict:false 会编译成"接受一切"
 *   3. ajv 编译失败 → 抛 "Invalid JSON Schema"（含回显）
 *   4. 校验失败 → 抛 "Schema validation failed"（含回显）
 */
export async function executeStructuredOutput(params: {
	schema: unknown;
	data: unknown;
}): Promise<{
	content: Array<{ type: "text"; text: string }>;
	// data 可能是 primitive/array/object（根 schema 决定），故 details 为 unknown。
	// 测试断言 toEqual(42)/toEqual(true)/toEqual(["a","b","c"])，不可窄化为 Record。
	details: unknown;
}> {
	// Normalize: some models pass schema/data as JSON strings instead of objects
	const schema = tryParseJson(params.schema);
	const data = tryParseJson(params.data);

	// 1. 互换检测：schema 像数据（对象无 keyword）且 data 像 schema（对象有 keyword）。
	// 这是最严重的静默腐败路径——若放行，ajv 会把"数据形态的 schema"编译成接受一切，
	// 真正的 schema（此时在 data 里）被丢弃，校验通过并存入垃圾。
	if (isPlainObject(schema) && !hasSchemaKeyword(schema) && isPlainObject(data) && hasSchemaKeyword(data)) {
		throw new Error(
			"Likely swapped: schema looks like data and data looks like a schema. "
			+ CORRECT_USAGE_HINT
			+ `Received schema=${echo(schema)}, data=${echo(data)}`,
		);
	}

	// 2. keyword-less schema 拒绝：治静默腐败的根。{} / {a:1} 这类对象会被
	// ajv strict:false 编译成"接受一切"的 validator，模型把答案塞进 schema 时会静默通过。
	if (isPlainObject(schema) && !hasSchemaKeyword(schema)) {
		throw new Error(
			"Invalid JSON Schema: schema has no recognized keyword "
			+ "(type/properties/items/enum/...). If you passed the answer value as schema, "
			+ "you likely swapped schema and data. "
			+ CORRECT_USAGE_HINT
			+ `Received schema=${echo(schema)}`,
		);
	}

	// 3. ajv 编译。schema 此时可能是 object（过 keyword 检查）、boolean（合法 draft-07 根）、
	// 或 string/number/array/null（非法 → 显式抛错给清晰提示）。getOrCompileValidator 只接受
	// object|boolean，消除原先的 `as Record<string,unknown>` 不安全 cast。
	let validate: ValidateFunction;
	try {
		if (isPlainObject(schema) || typeof schema === "boolean") {
			validate = getOrCompileValidator(schema);
		} else {
			throw new Error(`schema must be a JSON Schema object or boolean, got ${typeof schema}`);
		}
	} catch (e) {
		throw new Error(
			`Invalid JSON Schema: ${(e as Error).message}. `
			+ `Received schema=${echo(schema)}, data=${echo(data)}`,
		);
	}

	// 4. 校验
	const valid = validate(data);
	if (!valid) {
		const errors = validate.errors
			?.map((err) => `${err.instancePath} ${err.message}`)
			.join("; ");
		throw new Error(
			`Schema validation failed: ${errors}. `
			+ `Received schema=${echo(schema)}, data=${echo(data)}`,
		);
	}

	return {
		content: [
			{ type: "text" as const, text: "Structured output recorded successfully." },
		],
		details: data,
	};
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
			+ "schema describes the shape; data fills the values; they must match.\n\n"
			+ "✅ Correct (full call): structured_output({schema:{type:'object',properties:{name:{type:'string'},age:{type:'number'}},required:['name']}, data:{name:'Alice',age:30}})\n"
			+ "✅ Correct: schema={type:'array',items:{type:'string'}}, data=['a','b','c']\n"
			+ "✅ Correct: schema={type:'string',enum:['low','medium','high']}, data='medium'\n"
			+ "✅ Correct: schema={type:'number',minimum:0,maximum:100}, data=42\n"
			+ "✅ Correct: schema={type:'boolean'}, data=true\n\n"
			+ "❌ Wrong: putting the answer in text instead of calling this tool\n"
			+ "❌ Wrong: data not matching schema (e.g. schema requires number but data is string)\n"
			+ "❌ Wrong: schema={type:'object'} with data='hello' (string ≠ object)\n"
			+ "❌ Wrong: structured_output({name:'Alice'}) — missing the schema/data envelope. Wrap as {schema:{...}, data:{name:'Alice'}}.\n"
			+ "❌ Wrong: swapping schema and data (passing the answer as schema). The tool detects this as 'likely swapped' and rejects it.\n"
			+ "❌ Wrong: merging schema and data into one object.\n"
			+ "❌ Wrong: schema with no recognized JSON Schema keyword (e.g. {} or {answer:42}). The schema must describe shape via draft-07 keywords (type/properties/items/if-then-else/enum/...); a keyword-less object is rejected to prevent silent accept-all compilation.",
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
			params: { schema: unknown; data: unknown },
		) {
			return executeStructuredOutput(params);
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
		if (!isToolExecutionEndEvent(event)) return;
		if (event.toolName !== TOOL_NAME) return;
		soCallCount++;
		if (event.isError !== true) {
			soSucceededEver = true;
		} else {
			lastSchemaError = extractToolErrorText(event.result) ?? "structured-output call failed";
		}
	});

	pi.on("turn_end", async (event: unknown) => {
		// 已经成功调用过 structured-output，不再干预
		if (soSucceededEver) return;

		// 完全没调用 OR 调了但全是失败 → 都需要 steer。两种情况共用重试上限与计数。
		// stopReason="toolUse" → 模型还在调工具链，不需要干预
		if (!isTurnEndEvent(event)) return;
		if (event.message?.stopReason === "toolUse") return;

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
