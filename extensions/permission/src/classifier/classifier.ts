/**
 * AI Classifier 主流程（I4 classifyRisk）
 *
 * 流程：resolveModel → 构造 Model<Api> + Context + Options → streamSimple →
 *       检查 stopReason → 解析文本 → ClassifierResult。所有失败路径返回 fail-closed ask。
 *
 * 关键设计：
 *   - 依赖注入 ClassifierDeps（streamSimple 注入，便于测试 mock，不直接 import）
 *   - 超时/中止：传 provider 原生 timeoutMs + signal 给 streamSimple；外层再叠
 *     Promise.race 兜底（防止 provider 不支持 timeoutMs 时 result() 永挂）
 *   - G3 修正：EventStream.result() 只 resolve 不 reject，error/aborted 也 resolve
 *     （带 stopReason）。因此 classifyRisk 在取 text 前显式检查 stopReason，
 *     error/aborted → fallback ask
 *   - fail-closed：timeout / 抛错 / 解析失败 / 无可用模型 → 一律 ask
 */

import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import type {
	ClassifierConfig,
	ClassifierResult,
	ToolInvocationContext,
} from "../types.js";
import { parseClassifierResponse } from "./json-parser.js";
import { type ResolvedModel } from "./model-resolver.js";
import { buildClassifierUserPrompt, CLASSIFIER_SYSTEM_PROMPT } from "./prompt.js";

// ──────────────────────── fail-closed fallback ────────────────────────

/** 秒→毫秒换算系数（用于 timeout 字段转 provider 原生 timeoutMs） */
const MILLIS_PER_SECOND = 1000;

/** classifyRisk 所有失败路径的统一 fallback（fail-closed ask） */
const CLASSIFY_FALLBACK_RESULT: ClassifierResult = {
	outcome: "ask",
	risk_level: "medium",
	reasoning: "classifier unavailable",
	confidence: 0,
};

// ──────────────────────── 依赖注入 ────────────────────────

/**
 * Classifier 的外部依赖（DI 便于测试 mock）。
 *
 * - resolveModel：把 ClassifierConfig.model 解析为 ResolvedModel（或 null）
 * - streamSimple：pi-ai 的流式调用（同步返回 EventStream，result() 异步）
 * - onLog：可选日志回调（调试/审计）
 *
 * 命名锁定为 streamSimple（G7：不是 callStreamSimple）。
 */
export interface ClassifierDeps {
	resolveModel: (config: ClassifierConfig) => ResolvedModel | null;
	streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	onLog?: (msg: string) => void;
}

// ──────────────────────── AssistantMessage 最小子集 ────────────────────────

/** AssistantMessage 的最小子集（只取 stopReason + content，避免泛型/依赖膨胀） */
interface AssistantMessageLike {
	stopReason?: string;
	content?: { type: string; text?: string }[];
}

// ──────────────────────── 辅助：构造 Model<Api> ────────────────────────

/**
 * 从 ResolvedModel 构造 pi-ai 的 Model<Api>。
 *
 * ResolvedModel.api 是字符串（来自 models.json），断言为 Api 联合类型。
 * cost 字段携带 input 真实值（G4），其余填 0（classifier 不关心 token 成本计量）。
 */
function buildModel(resolved: ResolvedModel): Model<Api> {
	const inputCost = typeof resolved.inputCost === "number" ? resolved.inputCost : 0;
	return {
		id: resolved.id,
		name: resolved.name ?? resolved.id,
		api: resolved.api as Api,
		provider: resolved.provider,
		// G4：baseUrl 用真实值（无则空串，provider 内部会补默认）
		baseUrl: resolved.baseUrl ?? "",
		reasoning: false,
		input: ["text"],
		cost: { input: inputCost, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

/** 构造无 transcript 的 Context（单轮 user message） */
function buildContext(ctx: ToolInvocationContext): Context {
	return {
		systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: buildClassifierUserPrompt(ctx) }],
				timestamp: Date.now(),
			},
		],
	};
}

/** 从 AssistantMessage.content 抽取纯文本（拼接所有 text 块） */
function extractAssistantText(content: { type: string; text?: string }[]): string {
	return content
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("");
}

// ──────────────────────── 外层超时（兜底） ────────────────────────

/**
 * 给 result() 叠加外层超时（毫秒）+ abort 信号。
 *
 * 防御 provider 不支持 timeoutMs 时 result() 永挂。result() 自身只 resolve 不 reject，
 * 故 race 不会因 provider 错误提前 reject——错误走 stopReason 路径。
 */
function raceResultWithDeadline(
	resultPromise: Promise<AssistantMessageLike>,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<{ kind: "ok"; message: AssistantMessageLike } | { kind: "timeout" } | { kind: "aborted" }> {
	type Outcome = { kind: "ok"; message: AssistantMessageLike } | { kind: "timeout" } | { kind: "aborted" };
	const racers: Promise<Outcome>[] = [
		resultPromise.then((message) => ({ kind: "ok" as const, message })),
	];

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	if (timeoutMs !== undefined && timeoutMs > 0) {
		racers.push(
			new Promise<Outcome>((resolve) => {
				timeoutHandle = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
			}),
		);
	}
	if (signal !== undefined) {
		if (signal.aborted) {
			return Promise.resolve({ kind: "aborted" });
		}
		racers.push(
			new Promise<Outcome>((resolve) => {
				signal.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true });
			}),
		);
	}

	return Promise.race(racers).finally(() => {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
	});
}

// ──────────────────────── createClassifier ────────────────────────

/**
 * 创建 classifier 实例（工厂，注入 deps）。
 *
 * 返回 classifyRisk 主函数。
 */
export function createClassifier(deps: ClassifierDeps): {
	classifyRisk: (ctx: ToolInvocationContext, config: ClassifierConfig, signal?: AbortSignal) => Promise<ClassifierResult>;
} {
	const { resolveModel, streamSimple, onLog } = deps;

	async function classifyRisk(
		ctx: ToolInvocationContext,
		config: ClassifierConfig,
		signal?: AbortSignal,
	): Promise<ClassifierResult> {
		// 1. 解析模型；无可用模型 → fail-closed
		const resolved = resolveModel(config);
		if (resolved === null) {
			onLog?.("[pi-permission] classifier: no model resolved, returning fallback");
			return { ...CLASSIFY_FALLBACK_RESULT };
		}

		// 2. 构造 model/context/options（timeout 秒→毫秒，传 provider 原生 timeoutMs + signal + apiKey）
		const model = buildModel(resolved);
		const context = buildContext(ctx);
		const timeoutMs = config.timeout > 0 ? config.timeout * MILLIS_PER_SECOND : undefined;
		const options: SimpleStreamOptions = {
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
			...(signal !== undefined ? { signal } : {}),
			...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
		};

		// 3. 调用 streamSimple（同步返回 EventStream）。包裹 try/catch 防同步抛错。
		let stream: AssistantMessageEventStream;
		try {
			stream = streamSimple(model, context, options);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			onLog?.(`[pi-permission] classifier: streamSimple threw: ${message}`);
			return { ...CLASSIFY_FALLBACK_RESULT };
		}

		// 4. 等待 result() + 外层超时/中止兜底。
		//    G3：result() 只 resolve 不 reject，error/aborted 也 resolve（带 stopReason）。
		const resultPromise = stream.result() as Promise<AssistantMessageLike>;
		let settled: { kind: "ok"; message: AssistantMessageLike } | { kind: "timeout" } | { kind: "aborted" };
		try {
			settled = await raceResultWithDeadline(resultPromise, timeoutMs, signal);
		} catch (error) {
			// result() 理论上不 reject，但防御性 catch（fail-closed）
			const message = error instanceof Error ? error.message : String(error);
			onLog?.(`[pi-permission] classifier: result race threw: ${message}`);
			return { ...CLASSIFY_FALLBACK_RESULT };
		}

		if (settled.kind === "timeout") {
			onLog?.(`[pi-permission] classifier: timed out after ${timeoutMs}ms`);
			return { ...CLASSIFY_FALLBACK_RESULT };
		}
		if (settled.kind === "aborted") {
			onLog?.(`[pi-permission] classifier: aborted by signal`);
			return { ...CLASSIFY_FALLBACK_RESULT };
		}

		// 5. G3 关键修正：显式检查 stopReason。error/aborted → fallback（不能当成功）
		const message = settled.message;
		if (message?.stopReason === "error" || message?.stopReason === "aborted") {
			const errorDetail = message?.content?.[0]?.text ?? "unknown error";
			onLog?.(`[pi-permission] classifier: stream stopReason=${message.stopReason}, error=${errorDetail}, returning fallback`);
			return { ...CLASSIFY_FALLBACK_RESULT };
		}

		// 6. 提取文本 → 三层容错解析
		const content = Array.isArray(message?.content) ? (message.content as { type: string; text?: string }[]) : [];
		const text = extractAssistantText(content);
		return parseClassifierResponse(text);
	}

	return { classifyRisk };
}
