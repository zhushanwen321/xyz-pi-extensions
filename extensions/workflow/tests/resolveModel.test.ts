/**
 * resolveModel() 单元测试
 *
 * 测试框架：vitest
 * 运行命令：npx vitest run tests/resolveModel.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentCallOpts } from "../src/infra/agent-pool";

const { mockResolveModelForScene } = vi.hoisted(() => ({
	mockResolveModelForScene: vi.fn<(scene: string) => string | undefined>(),
}));

vi.mock("@zhushanwen/pi-model-switch", () => ({
	resolveModelForScene: mockResolveModelForScene,
}));

import { resolveModel } from "../src/engine/model-resolver";

describe("resolveModel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("TC-3-01: opts.model set → returns it directly, ignores scene", async () => {
		mockResolveModelForScene.mockReturnValue("other/model");
		const opts: AgentCallOpts = { prompt: "test", model: "minimax/m3", scene: "coding" };
		await expect(resolveModel(opts)).resolves.toBe("minimax/m3");
		expect(mockResolveModelForScene).not.toHaveBeenCalled();
	});

	it("TC-3-02: no model + scene set + advisor returns value → returns it", async () => {
		mockResolveModelForScene.mockReturnValue("zhipu/glm-5.1");
		const opts: AgentCallOpts = { prompt: "test", scene: "coding" };
		await expect(resolveModel(opts)).resolves.toBe("zhipu/glm-5.1");
		expect(mockResolveModelForScene).toHaveBeenCalledWith("coding");
	});

	it("TC-3-03: no model + scene set + advisor returns undefined → returns undefined", async () => {
		mockResolveModelForScene.mockReturnValue(undefined);
		const opts: AgentCallOpts = { prompt: "test", scene: "coding" };
		await expect(resolveModel(opts)).resolves.toBeUndefined();
		// Note: model-resolver no longer logs a warning when the advisor
		// returns undefined — it silently falls back to the default model.
		// Surfacing to the input area would leak workflow internals.
	});

	it("TC-3-04: no model + no scene → returns undefined", async () => {
		const opts: AgentCallOpts = { prompt: "test" };
		await expect(resolveModel(opts)).resolves.toBeUndefined();
		expect(mockResolveModelForScene).not.toHaveBeenCalled();
	});

	it("TC-3-05: advisor throws → catch + returns undefined (no warn to avoid input leak)", async () => {
		mockResolveModelForScene.mockImplementation(() => {
			throw new Error("advisor crash");
		});
		const opts: AgentCallOpts = { prompt: "test", scene: "coding" };
		await expect(resolveModel(opts)).resolves.toBeUndefined();
		// Note: model-resolver silently swallows advisor exceptions and falls
		// back. The previous behavior logged a warning, but that leaked to
		// the input area via stderr; the caller's flow is unaffected.
	});
});
