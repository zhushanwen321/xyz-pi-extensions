/**
 * Model resolver — pure function for workflow model resolution.
 *
 * Priority: explicit model param > scene advisor > undefined (Pi default).
 * Extracted from Orchestrator for testability.
 */

import type { AgentCallOpts } from "./agent-pool";
import { resolveModelForScene } from "@zhushanwen/pi-model-switch";

/**
 * 根据调用选项解析目标模型。
 * 优先级：显式 model > scene advisor > undefined（Pi 默认）
 */
export function resolveModel(opts: AgentCallOpts): string | undefined {
	if (opts.model) return opts.model;
	if (opts.scene) {
		try {
			const resolved = resolveModelForScene(opts.scene);
			if (resolved) {
				console.log(`[workflow] scene "${opts.scene}" resolved to model: ${resolved}`);
			} else {
				console.warn(`[workflow] scene "${opts.scene}" could not resolve to a model, using default`);
			}
			return resolved ?? undefined;
		} catch (err) {
			console.warn(`[workflow] resolveModelForScene failed for scene "${opts.scene}":`, err);
			return undefined;
		}
	}
	return undefined;
}
