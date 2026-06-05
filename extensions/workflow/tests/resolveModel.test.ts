/**
 * resolveModel() 单元测试
 *
 * 测试框架：vitest
 * 运行命令：npx vitest run tests/resolveModel.test.ts
 */

import { beforeEach,describe, expect, it, vi } from "vitest";

import type { AgentCallOpts } from "../src/agent-pool";

const { mockResolveModelForScene } = vi.hoisted(() => ({
	mockResolveModelForScene: vi.fn<(scene: string) => string | undefined>(),
}));

vi.mock("@zhushanwen/pi-model-switch", () => ({
	resolveModelForScene: mockResolveModelForScene,
}));

import { resolveModel } from "../src/model-resolver";

describe("resolveModel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("TC-3-01: opts.model set → returns it directly, ignores scene", () => {
		mockResolveModelForScene.mockReturnValue("other/model");
		const opts: AgentCallOpts = { prompt: "test", model: "minimax/m3", scene: "coding" };
		expect(resolveModel(opts)).toBe("minimax/m3");
		// Should NOT call advisor
		expect(mockResolveModelForScene).not.toHaveBeenCalled();
	});

	it("TC-3-02: no model + scene set + advisor returns value → returns it", () => {
		mockResolveModelForScene.mockReturnValue("zhipu/glm-5.1");
		const opts: AgentCallOpts = { prompt: "test", scene: "coding" };
		expect(resolveModel(opts)).toBe("zhipu/glm-5.1");
		expect(mockResolveModelForScene).toHaveBeenCalledWith("coding");
	});

	it("TC-3-03: no model + scene set + advisor returns undefined → returns undefined", () => {
		mockResolveModelForScene.mockReturnValue(undefined);
		const logSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const opts: AgentCallOpts = { prompt: "test", scene: "coding" };
		expect(resolveModel(opts)).toBeUndefined();
		expect(logSpy).toHaveBeenCalled();
		logSpy.mockRestore();
	});

	it("TC-3-04: no model + no scene → returns undefined", () => {
		const opts: AgentCallOpts = { prompt: "test" };
		expect(resolveModel(opts)).toBeUndefined();
		expect(mockResolveModelForScene).not.toHaveBeenCalled();
	});

	it("TC-3-05: advisor throws → catch + warn + returns undefined", () => {
		mockResolveModelForScene.mockImplementation(() => {
			throw new Error("advisor crash");
		});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const opts: AgentCallOpts = { prompt: "test", scene: "coding" };
		expect(resolveModel(opts)).toBeUndefined();
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("resolveModelForScene failed"),
			expect.any(Error),
		);
		warnSpy.mockRestore();
	});
});
