/**
 * resolveModelForScene() 单元测试
 *
 * 测试框架：vitest
 * 运行命令：npx vitest run tests/resolveModelForScene.test.ts
 */

import type { CacheData } from "@zhushanwen/pi-quota-providers";
import { beforeEach,describe, expect, it, vi } from "vitest";

import type { ModelPolicy } from "../../src/types";

// Hoisted mocks — vitest hoists these before any import
const { mockLoadConfig, mockReadCache } = vi.hoisted(() => ({
	mockLoadConfig: vi.fn<() => ModelPolicy | null>(),
	mockReadCache: vi.fn<() => CacheData>(),
}));

vi.mock("../src/config", () => ({
	loadConfig: mockLoadConfig,
}));

vi.mock("@zhushanwen/pi-quota-providers", () => ({
	readCache: mockReadCache,
}));

import { resolveModelForScene } from "../src/advisor";

// ── Test Fixtures ──────────────────────────────────────

const mockConfig: ModelPolicy = {
	version: 2,
	models: {
		zhipu: {
			plan: "zhipu",
			models: {
				"glm-5.1": { modelId: "glm-5.1", capabilities: ["text"] },
			},
		},
		"opencode-go": {
			plan: "opencode-go",
			models: {
				"ds-flash": { modelId: "ds-flash", capabilities: ["text"] },
			},
		},
	},
	scenes: { coding: ["glm-5.1", "ds-flash"] },
	plans: {
		zhipu: { priority: 1, peak: { start: 14, end: 18, multiplier: 3 } },
		"opencode-go": { priority: 2 },
	},
	stickiness: { minTurns: 3, minInputTokens: 1000 },
};

/** Config where provider key != plan name */
const mockConfigWithDiffPlan: ModelPolicy = {
	version: 2,
	models: {
		"my-router": {
			plan: "shared-plan",
			models: {
				"glm-5.1": { modelId: "glm-5.1", capabilities: ["text"] },
			},
		},
		"opencode-go": {
			plan: "opencode-go",
			models: {
				"ds-flash": { modelId: "ds-flash", capabilities: ["text"] },
			},
		},
	},
	scenes: { coding: ["glm-5.1", "ds-flash"] },
	plans: {
		"shared-plan": { priority: 1, peak: { start: 14, end: 18, multiplier: 3 } },
		"opencode-go": { priority: 2 },
	},
	stickiness: { minTurns: 3, minInputTokens: 1000 },
};

/** Both providers share the same peak plan → both candidates can be avoided */
const mockConfigAllPeak: ModelPolicy = {
	version: 2,
	models: {
		zhipu: {
			plan: "shared-plan",
			models: {
				"glm-5.1": { modelId: "glm-5.1", capabilities: ["text"] },
			},
		},
		"opencode-go": {
			plan: "shared-plan",
			models: {
				"ds-flash": { modelId: "ds-flash", capabilities: ["text"] },
			},
		},
	},
	scenes: { coding: ["glm-5.1", "ds-flash"] },
	plans: {
		"shared-plan": { priority: 1, peak: { start: 0, end: 24, multiplier: 3 } },
	},
	stickiness: { minTurns: 3, minInputTokens: 1000 },
};

/** Scene list order differs from priority order */
const mockConfigReversedOrder: ModelPolicy = {
	...mockConfig,
	scenes: { coding: ["ds-flash", "glm-5.1"] },
};

function makeCacheWithPct(pct: number): CacheData {
	return {
		zhipu: { tokensPct: pct, resetTime: "2h30m", usedTokens: 1000, totalTokens: 10000 },
		"opencode-go": { rolling: { usagePercent: 10, resetSec: 5000 } },
	} as unknown as CacheData;
}

// ── Tests ──────────────────────────────────────────────

describe("resolveModelForScene", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("TC-1-01: non-peak, scene exists → returns first candidate by priority", () => {
		mockLoadConfig.mockReturnValue(mockConfig);
		mockReadCache.mockReturnValue(makeCacheWithPct(30));

		// Hour 10 (non-peak, zhipu peak is 14-18)
		const result = resolveModelForScene("coding", new Date(2026, 0, 1, 10, 0));

		expect(result).toBe("zhipu/glm-5.1");
	});

	it("TC-1-02: peak, zhipu avoid → returns non-peak candidate", () => {
		mockLoadConfig.mockReturnValue(mockConfig);
		mockReadCache.mockReturnValue(makeCacheWithPct(60));

		// Hour 15 (peak, zhipu 14-18)
		const result = resolveModelForScene("coding", new Date(2026, 0, 1, 15, 0));

		expect(result).toBe("opencode-go/ds-flash");
	});

	it("TC-1-03: scene not found → returns undefined + warn", () => {
		mockLoadConfig.mockReturnValue(mockConfig);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const result = resolveModelForScene("nonexistent");

		expect(result).toBeUndefined();
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("nonexistent"));

		warnSpy.mockRestore();
	});

	it("TC-1-04: no config → returns undefined + warn", () => {
		mockLoadConfig.mockReturnValue(null);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const result = resolveModelForScene("coding");

		expect(result).toBeUndefined();
		expect(warnSpy).toHaveBeenCalled();

		warnSpy.mockRestore();
	});

	it("TC-1-05: all candidates peak avoid → returns undefined", () => {
		mockLoadConfig.mockReturnValue(mockConfigAllPeak);
		mockReadCache.mockReturnValue(makeCacheWithPct(60));

		// Any hour → both plans have peak 0-24, so both are in peak
		const result = resolveModelForScene("coding", new Date(2026, 0, 1, 12, 0));

		expect(result).toBeUndefined();
	});

	it("TC-1-06: scene list order != priority order → returns by priority", () => {
		mockLoadConfig.mockReturnValue(mockConfigReversedOrder);
		mockReadCache.mockReturnValue(makeCacheWithPct(30));

		// scenes.coding = ["ds-flash", "glm-5.1"] but zhipu priority=1
		// Non-peak → should return zhipu/glm-5.1 (priority 1 beats ds-flash priority 2)
		const result = resolveModelForScene("coding", new Date(2026, 0, 1, 10, 0));

		expect(result).toBe("zhipu/glm-5.1");
	});

	it("TC-1-07: providerKey != planName → returns providerKey/modelId", () => {
		mockLoadConfig.mockReturnValue(mockConfigWithDiffPlan);
		mockReadCache.mockReturnValue(makeCacheWithPct(30));

		// Non-peak for "shared-plan" (peak 14-18), hour 10
		const result = resolveModelForScene("coding", new Date(2026, 0, 1, 10, 0));

		// Must return "my-router/glm-5.1", NOT "shared-plan/glm-5.1"
		expect(result).toBe("my-router/glm-5.1");
	});
});
