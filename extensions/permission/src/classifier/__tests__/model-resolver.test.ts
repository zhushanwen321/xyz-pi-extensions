/**
 * MRT 系列：model-resolver.ts 单元测试。
 *
 * 覆盖：
 *  - G2：agentDir 解析（env override / 默认）
 *  - loadModelsJson（文件缺失返回 null + onWarning）
 *  - flattenModels（拍平 + hasApiKey 推断）
 *  - findCheapestModel（过滤 hasApiKey + 按 input cost 升序）
 *  - resolveClassifierModel（'auto' / 'provider/model-id' / 非法格式）
 *
 * 用真实 fs + 临时目录（不用 mock fs），与 config.test.ts 风格一致。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findCheapestModel, flattenModels, loadModelsJson, resolveClassifierModel } from "../model-resolver.js";

let tempDir: string;
let modelsJsonPath: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-perm-mr-"));
	modelsJsonPath = join(tempDir, "models.json");
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

const MODELS_JSON = {
	providers: {
		"cheap-co": {
			baseUrl: "http://x",
			apiKey: "k1",
			api: "openai-completions",
			models: [
				{ id: "mini", cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 } },
				{ id: "big", cost: { input: 1.0, output: 1.0, cacheRead: 0, cacheWrite: 0 } },
			],
		},
		"noauth-co": {
			baseUrl: "http://y",
			// 无 apiKey
			api: "openai-completions",
			models: [{ id: "ultra-cheap", cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		},
		"noapi-co": {
			baseUrl: "http://z",
			apiKey: "k3",
			// 无 api
			models: [{ id: "ghost", cost: { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		},
	},
};

function writeModels(data: unknown): void {
	writeFileSync(modelsJsonPath, JSON.stringify(data), "utf-8");
}

describe("MRT1: loadModelsJson", () => {
	it("文件不存在 → null（不抛错）", () => {
		expect(existsSync(modelsJsonPath)).toBe(false);
		expect(loadModelsJson(undefined, modelsJsonPath)).toBeNull();
	});

	it("合法 JSON → 返回解析对象", () => {
		writeModels(MODELS_JSON);
		const data = loadModelsJson(undefined, modelsJsonPath);
		expect(data?.providers).toBeDefined();
	});

	it("损坏 JSON → null + onWarning 被调用", () => {
		writeFileSync(modelsJsonPath, "{ broken json", "utf-8");
		const warnings: string[] = [];
		const data = loadModelsJson((m) => warnings.push(m), modelsJsonPath);
		expect(data).toBeNull();
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("models.json");
	});
});

describe("MRT2: flattenModels", () => {
	it("拍平所有 provider.model，过滤无 api 的 model", () => {
		const entries = flattenModels(MODELS_JSON);
		const ids = entries.map((e) => e.id).sort();
		// noapi-co/ghost 无 api → 过滤；其余保留
		expect(ids).toEqual(["big", "mini", "ultra-cheap"]);
	});

	it("hasApiKey 从 provider.apiKey 推断", () => {
		const entries = flattenModels(MODELS_JSON);
		const cheap = entries.find((e) => e.id === "mini");
		const noauth = entries.find((e) => e.id === "ultra-cheap");
		expect(cheap?.hasApiKey).toBe(true);
		expect(noauth?.hasApiKey).toBe(false);
	});

	it("apiKey 值从 provider.apiKey 透传（MRT2 补充：不只断言 hasApiKey 布尔）", () => {
		const entries = flattenModels(MODELS_JSON);
		const cheap = entries.find((e) => e.id === "mini");
		const noauth = entries.find((e) => e.id === "ultra-cheap");
		// 有 apiKey 的 provider：apiKey 字段透传真实值（"k1"）
		expect(cheap?.apiKey).toBe("k1");
		// 无 apiKey 的 provider：apiKey 字段为 undefined（而非空串）
		expect(noauth?.apiKey).toBeUndefined();
		// 同 provider 下所有 model 共享 provider.apiKey
		const big = entries.find((e) => e.id === "big");
		expect(big?.apiKey).toBe("k1");
	});
});

describe("MRT3: findCheapestModel", () => {
	it("过滤无 apiKey 的，返回 input cost 最低", () => {
		const cheapest = findCheapestModel(MODELS_JSON);
		// cheap-co/mini (0.1) < cheap-co/big (1.0)；noauth-co/ultra-cheap 被 hasApiKey 过滤掉
		expect(cheapest?.id).toBe("mini");
		expect(cheapest?.cost.input).toBeCloseTo(0.1);
	});

	it("全部无 apiKey → null", () => {
		const data = {
			providers: {
				x: { baseUrl: "http://x", api: "openai-completions", models: [{ id: "m", cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
			},
		};
		expect(findCheapestModel(data)).toBeNull();
	});
});

describe("MRT4: resolveClassifierModel", () => {
	it("'auto' → 最便宜可用模型", () => {
		const r = resolveClassifierModel("auto", MODELS_JSON);
		expect(r?.id).toBe("mini");
		expect(r?.provider).toBe("cheap-co");
	});

	it("'provider/model-id' → 精确匹配", () => {
		const r = resolveClassifierModel("cheap-co/big", MODELS_JSON);
		expect(r?.id).toBe("big");
		expect(r?.provider).toBe("cheap-co");
	});

	it("'provider/model-id' 未匹配 → null", () => {
		expect(resolveClassifierModel("cheap-co/nonexistent", MODELS_JSON)).toBeNull();
	});

	it("非法格式（无斜线）→ null", () => {
		expect(resolveClassifierModel("just-a-name", MODELS_JSON)).toBeNull();
	});

	it("非法格式（斜线在首/尾）→ null", () => {
		expect(resolveClassifierModel("/leading", MODELS_JSON)).toBeNull();
		expect(resolveClassifierModel("trailing/", MODELS_JSON)).toBeNull();
	});

	it("ResolvedModel 携带 baseUrl/name/inputCost（G4）", () => {
		const r = resolveClassifierModel("cheap-co/mini", MODELS_JSON);
		expect(r?.baseUrl).toBe("http://x");
		expect(r?.name).toBe("mini"); // 无 name → fallback 到 id
		expect(r?.inputCost).toBeCloseTo(0.1);
	});

	it("ResolvedModel 携带 apiKey 值（MRT4 补充：透传给 streamSimple 用）", () => {
		// reviewer 指出 MRT4 只断言 hasApiKey，没断言 apiKey 值。补断言。
		const auto = resolveClassifierModel("auto", MODELS_JSON);
		expect(auto?.apiKey).toBe("k1"); // cheap-co 的 apiKey
		const explicit = resolveClassifierModel("cheap-co/big", MODELS_JSON);
		expect(explicit?.apiKey).toBe("k1");
	});
});
