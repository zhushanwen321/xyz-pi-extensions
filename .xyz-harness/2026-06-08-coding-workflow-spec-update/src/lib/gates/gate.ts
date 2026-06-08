// AbortSignal is available globally in Node.js 16+

// Forward-declare types to avoid circular imports at type level
export interface SkillResolverLike {
	resolve(name: string): string;
	resolvePath(name: string): string;
}

export interface WorkflowStateLike {
	isActive: boolean;
	currentPhase: number;
	topicDir: string;
	topicName: string;
	phaseResults: Record<number, "passed">;
}

/**
 * Gate Pipeline 抽象接口
 *
 * 每个 phase 配置声明自己的 gate 链，gate 按顺序执行，全部通过才算通过。
 */

export interface Gate {
	name: string;
	run(ctx: GateContext): Promise<GateResult>;
}

export interface GateContext {
	phase: number;
	topicDir: string;
	state: WorkflowStateLike;
	skillResolver: SkillResolverLike;
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	signal?: AbortSignal;
}

export interface GateResult {
	passed: boolean;
	fixGuidance?: string;
	details?: Record<string, unknown>;
}

/** Gate 工厂：根据名称创建对应的 gate 实例 */
export async function createGate(name: string): Promise<Gate> {
	switch (name) {
		case "review-gate": {
			const { ReviewGate } = await import("./review-gate.js");
			return new ReviewGate();
		}
		case "phase-gate": {
			const { PhaseGate } = await import("./phase-gate.js");
			return new PhaseGate();
		}
		case "test-fix-loop": {
			const { TestFixLoopGate } = await import("./test-fix-loop.js");
			return new TestFixLoopGate();
		}
		default:
			throw new Error(`Unknown gate: ${name}`);
	}
}
