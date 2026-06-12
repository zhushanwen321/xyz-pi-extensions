/**
 * Model resolver — pure function for workflow model resolution.
 *
 * Priority: explicit model param > scene advisor > undefined (Pi default).
 * Extracted from Orchestrator for testability.
 *
 * @zhushanwen/pi-model-switch is an optional peer dependency.
 * When unavailable, scene-based resolution is silently skipped.
 */

import type { AgentCallOpts } from "../infra/agent-pool";

/** Lazy-loaded reference to resolveModelForScene from pi-model-switch (optional). */
let _resolveModelForScene: ((scene: string) => string | undefined) | null | undefined = undefined;

async function loadSceneResolver(): Promise<typeof _resolveModelForScene> {
	if (_resolveModelForScene !== undefined) return _resolveModelForScene;
	try {
		const mod = await import("@zhushanwen/pi-model-switch");
		_resolveModelForScene = typeof mod.resolveModelForScene === "function" ? mod.resolveModelForScene : null;
	} catch {
		// @zhushanwen/pi-model-switch is an optional peer — silent fallback
		_resolveModelForScene = null;
	}
	return _resolveModelForScene;
}

/**
 * 根据调用选项解析目标模型。
 * 优先级：显式 model > scene advisor > undefined（Pi 默认）
 *
 * 注意：scene 解析是异步的（dynamic import），首次调用可能有微秒延迟。
 */
export async function resolveModel(opts: AgentCallOpts): Promise<string | undefined> {
	if (opts.model) return opts.model;
	if (opts.scene) {
		const resolver = await loadSceneResolver();
		if (!resolver) return undefined;
		try {
			const resolved = resolver(opts.scene);
			return resolved ?? undefined;
		} catch {
			// Scene resolution failed — return undefined and let the caller fall back
			return undefined;
		}
	}
	return undefined;
}
