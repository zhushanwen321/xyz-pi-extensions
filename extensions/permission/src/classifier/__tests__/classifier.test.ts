/**
 * CT 系列：classifier.ts 单元测试（createClassifier + classifyRisk 主流程）。
 *
 * mock 策略：鸭子类型 mock streamSimple（返回只带 result() 的 AssistantMessageEventStream）。
 *
 * 重点验证：
 *  - C1-C4 主流程 happy path（allow/deny/ask）
 *  - C5-C7 fail-closed（resolveModel null / streamSimple 抛错 / 解析失败）
 *  - C8 timeout 兜底
 *  - C9 abort signal
 *  - C10 timeout 秒→毫秒传递
 *  - C11 G3 关键修正：stopReason='error' / 'aborted' → fallback（即使 result() resolve）
 */
import type { AssistantMessageEventStream, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import type { ClassifierConfig, ToolInvocationContext } from "../../types.js";
import type { ClassifierDeps } from "../classifier.js";
import { createClassifier } from "../classifier.js";
import type { ResolvedModel } from "../model-resolver.js";

// ──────────────────────── fixtures ────────────────────────

const FIXED_MODEL: ResolvedModel = {
	provider: "test-co",
	id: "test-model",
	api: "openai-completions",
	name: "Test Model",
	baseUrl: "http://localhost",
	inputCost: 0,
};

const CONFIG: ClassifierConfig = {
	enabled: true,
	model: "auto",
	timeout: 90,
	autoApproveLowRisk: true,
	autoDenyHighRisk: true,
};

const CTX: ToolInvocationContext = {
	toolName: "bash",
	command: "ls",
	cwd: "/tmp",
};

// ──────────────────────── mock helpers ────────────────────────

/** 构造「立刻 resolve 给定 AssistantMessage」的 mock EventStream（鸭子类型） */
function mockStreamFromMessage(message: unknown): AssistantMessageEventStream {
	return {
		result: () => Promise.resolve(message),
	};
}

/** 构造「永不 resolve」的 mock EventStream（用于 timeout/abort 测试） */
function mockStreamNever(): AssistantMessageEventStream {
	return {
		result: () => new Promise(() => {}),
	};
}

/** 构造「streamSimple 同步抛错」的 mock 函数 */
function throwingStreamSimple(error: Error): ClassifierDeps["streamSimple"] {
	return () => {
		throw error;
	};
}

interface AssistantMessageMock {
	stopReason?: string;
	content?: { type: string; text?: string }[];
}

function textMessage(text: string, stopReason = "stop"): AssistantMessageMock {
	return {
		stopReason,
		content: [{ type: "text", text }],
	};
}

function makeDeps(over: Partial<ClassifierDeps> = {}): ClassifierDeps {
	return {
		resolveModel: () => FIXED_MODEL,
		streamSimple: () => mockStreamFromMessage(textMessage('{"outcome":"allow","risk_level":"low","reasoning":"ok","confidence":0.9}')),
		...over,
	};
}

/** 捕获 streamSimple 调用参数的 spy（options 含 apiKey 等）。 */
function capturingStreamSimple(message: unknown): {
	spy: ClassifierDeps["streamSimple"];
	getLastOptions: () => SimpleStreamOptions | undefined;
} {
	let lastOptions: SimpleStreamOptions | undefined;
	const spy: ClassifierDeps["streamSimple"] = (_model, _context, options?) => {
		lastOptions = options;
		return mockStreamFromMessage(message);
	};
	return { spy, getLastOptions: () => lastOptions };
}

// ──────────────────────── C1-C4: happy path ────────────────────────

describe("CT1: happy path — streamSimple resolve 正常文本", () => {
	it("allow JSON → ClassifierResult.allow", async () => {
		const classifier = createClassifier(makeDeps({
			streamSimple: () => mockStreamFromMessage(textMessage('{"outcome":"allow","risk_level":"low","reasoning":"safe","confidence":0.9}')),
		}));
		const r = await classifier.classifyRisk(CTX, CONFIG);
		expect(r.outcome).toBe("allow");
		expect(r.risk_level).toBe("low");
		expect(r.confidence).toBeCloseTo(0.9);
	});

	it("deny JSON → ClassifierResult.deny", async () => {
		const classifier = createClassifier(makeDeps({
			streamSimple: () => mockStreamFromMessage(textMessage('{"outcome":"deny","risk_level":"high","reasoning":"rm -rf /","confidence":0.95}')),
		}));
		const r = await classifier.classifyRisk(CTX, CONFIG);
		expect(r.outcome).toBe("deny");
		expect(r.risk_level).toBe("high");
	});

	it("ask JSON → ClassifierResult.ask", async () => {
		const classifier = createClassifier(makeDeps({
			streamSimple: () => mockStreamFromMessage(textMessage('{"outcome":"ask","risk_level":"medium","reasoning":"uncertain","confidence":0.5}')),
		}));
		const r = await classifier.classifyRisk(CTX, CONFIG);
		expect(r.outcome).toBe("ask");
	});

	it("LLM 输出带 code fence → 正则提取仍成功", async () => {
		const classifier = createClassifier(makeDeps({
			streamSimple: () => mockStreamFromMessage(textMessage('```json\n{"outcome":"allow","risk_level":"low","reasoning":"x","confidence":0.8}\n```')),
		}));
		const r = await classifier.classifyRisk(CTX, CONFIG);
		expect(r.outcome).toBe("allow");
	});
});

// ──────────────────────── C5-C7: fail-closed ────────────────────────

describe("CT2: fail-closed 路径", () => {
	it("C5: resolveModel 返回 null → fallback ask", async () => {
		const classifier = createClassifier(makeDeps({ resolveModel: () => null }));
		const r = await classifier.classifyRisk(CTX, CONFIG);
		expect(r.outcome).toBe("ask");
		expect(r.confidence).toBe(0);
	});

	it("C6: streamSimple 同步抛错 → fallback ask", async () => {
		const classifier = createClassifier(makeDeps({
			streamSimple: throwingStreamSimple(new Error("network down")),
		}));
		const r = await classifier.classifyRisk(CTX, CONFIG);
		expect(r.outcome).toBe("ask");
	});

	it("C7: LLM 输出无法解析 → parser fallback ask", async () => {
		const classifier = createClassifier(makeDeps({
			streamSimple: () => mockStreamFromMessage(textMessage("totally not json")),
		}));
		const r = await classifier.classifyRisk(CTX, CONFIG);
		expect(r.outcome).toBe("ask");
		expect(r.reasoning).toContain("parse failed");
	});
});

// ──────────────────────── C8-C10: timeout / abort ────────────────────────

describe("CT3: timeout 与 abort 兜底", () => {
	it("C8: result() 永挂 + 短 timeout → fallback ask（不卡死）", async () => {
		const shortTimeoutConfig: ClassifierConfig = { ...CONFIG, timeout: 1 };
		const classifier = createClassifier(makeDeps({
			streamSimple: () => mockStreamNever(),
		}));
		const r = await classifier.classifyRisk(CTX, shortTimeoutConfig);
		expect(r.outcome).toBe("ask");
	}, 10000);

	it("C9: abort signal 已 abort → 立刻 fallback ask", async () => {
		const ac = new AbortController();
		ac.abort();
		const classifier = createClassifier(makeDeps({
			streamSimple: () => mockStreamNever(),
		}));
		const r = await classifier.classifyRisk(CTX, CONFIG, ac.signal);
		expect(r.outcome).toBe("ask");
	});

	it("C10: timeout=0 → 不设外层超时，result() 正常返回", async () => {
		const noTimeoutConfig: ClassifierConfig = { ...CONFIG, timeout: 0 };
		const classifier = createClassifier(makeDeps({
			streamSimple: () => mockStreamFromMessage(textMessage('{"outcome":"allow","risk_level":"low","reasoning":"x","confidence":0.5}')),
		}));
		const r = await classifier.classifyRisk(CTX, noTimeoutConfig);
		expect(r.outcome).toBe("allow");
	});
});

// ──────────────────────── C11: G3 stopReason 修正（关键） ────────────────────────

describe("CT4 / C11: G3 — result() 不 reject，必须显式检查 stopReason", () => {
	it("stopReason='error' → fallback ask（即使 result() 成功 resolve）", async () => {
		const classifier = createClassifier(makeDeps({
			streamSimple: () => mockStreamFromMessage(textMessage('{"outcome":"allow","risk_level":"low","reasoning":"x","confidence":0.9}', "error")),
		}));
		const r = await classifier.classifyRisk(CTX, CONFIG);
		// 关键：result() resolve 了，但 stopReason=error → 不能当成功 allow
		expect(r.outcome).toBe("ask");
		expect(r.confidence).toBe(0);
	});

	it("stopReason='aborted' → fallback ask", async () => {
		const classifier = createClassifier(makeDeps({
			streamSimple: () => mockStreamFromMessage(textMessage('{"outcome":"deny","risk_level":"high","reasoning":"x","confidence":0.9}', "aborted")),
		}));
		const r = await classifier.classifyRisk(CTX, CONFIG);
		expect(r.outcome).toBe("ask");
	});

	it("stopReason='stop'（正常）→ 正常解析，不受 G3 影响", async () => {
		const classifier = createClassifier(makeDeps({
			streamSimple: () => mockStreamFromMessage(textMessage('{"outcome":"allow","risk_level":"low","reasoning":"x","confidence":0.9}', "stop")),
		}));
		const r = await classifier.classifyRisk(CTX, CONFIG);
		expect(r.outcome).toBe("allow");
	});

	it("stopReason 缺省（undefined）→ 不触发 G3 兜底，走正常解析", async () => {
		const classifier = createClassifier(makeDeps({
			streamSimple: () => mockStreamFromMessage(textMessage('{"outcome":"allow","risk_level":"low","reasoning":"x","confidence":0.9}')),
		}));
		const r = await classifier.classifyRisk(CTX, CONFIG);
		expect(r.outcome).toBe("allow");
	});
});

// ──────────────────────── CT5: apiKey 透传到 streamSimple options ────────────────────────

describe("CT5: resolved.apiKey 透传到 streamSimple options", () => {
	it("resolved model 含 apiKey → streamSimple 收到的 options.apiKey 是该值", async () => {
		const { spy, getLastOptions } = capturingStreamSimple(
			textMessage('{"outcome":"allow","risk_level":"low","reasoning":"x","confidence":0.9}'),
		);
		const classifier = createClassifier(makeDeps({
			resolveModel: () => ({ ...FIXED_MODEL, apiKey: "sk-test-secret-key-12345" }),
			streamSimple: spy,
		}));
		const r = await classifier.classifyRisk(CTX, CONFIG);
		expect(r.outcome).toBe("allow");
		const options = getLastOptions();
		expect(options).toBeDefined();
		expect(options?.apiKey).toBe("sk-test-secret-key-12345");
	});

	it("resolved model 无 apiKey → streamSimple options 不含 apiKey 字段", async () => {
		// FIXED_MODEL 无 apiKey → options 不含 apiKey 键（spread 条件不触发）
		const { spy, getLastOptions } = capturingStreamSimple(
			textMessage('{"outcome":"allow","risk_level":"low","reasoning":"x","confidence":0.9}'),
		);
		const classifier = createClassifier(makeDeps({ streamSimple: spy }));
		await classifier.classifyRisk(CTX, CONFIG);
		const options = getLastOptions();
		expect(options).toBeDefined();
		expect("apiKey" in (options as object)).toBe(false);
	});

	it("apiKey 与 timeoutMs/signal 共存于 options", async () => {
		// 验证 apiKey 与 timeoutMs 同时透传不互相覆盖（spread 合并正确）
		const { spy, getLastOptions } = capturingStreamSimple(
			textMessage('{"outcome":"allow","risk_level":"low","reasoning":"x","confidence":0.9}'),
		);
		const classifier = createClassifier(makeDeps({
			resolveModel: () => ({ ...FIXED_MODEL, apiKey: "k9" }),
			streamSimple: spy,
		}));
		// CONFIG.timeout=90 → timeoutMs=90000
		await classifier.classifyRisk(CTX, CONFIG);
		const options = getLastOptions();
		expect(options?.apiKey).toBe("k9");
		expect(options?.timeoutMs).toBe(90_000);
	});
});
