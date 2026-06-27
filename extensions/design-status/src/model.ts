/**
 * Design workflow 数据模型 — 纯函数，不依赖 Pi 运行时。
 *
 * 7 个 design 阶段 + 阶段内状态机 + gate 定义。
 * 真相源 = 混合：阶段「完成状态」从交付物 gate 派生（gate.ts 读交付物文件），
 * 「过程状态」（loop step/round/gaps）由 store 存。
 * 防篡改 = 状态机约束：非法转移（跳阶/未过 gate 标 completed/completed 回退）被拒绝。
 */

// ── 阶段枚举 ───────────────────────────────────────────

/** 7 个 design 阶段，顺序即线性依赖（N 标 completed 前 N-1 必须 completed）。 */
export const PHASE_ORDER = [
	"init",
	"clarity",
	"architecture",
	"issues",
	"nfr",
	"code-arch",
	"execution",
] as const;

export type Phase = (typeof PHASE_ORDER)[number];

/**
 * init 阶段在存储层的哨兵 topic。init 是项目级一次性阶段（AGENTS.md/CONTEXT.md 就位即完成），
 * 状态存 .xyz-harness/.design-status.json（项目根），非 topic 子目录；store.ts 据此路由路径。
 * 与真实 topic slug（yyyy-MM-dd-kebab）不冲突。
 */
export const INIT_TOPIC_SENTINEL = "__init__";

/** 阶段编号（0-6），用于线性依赖校验。 */
export const PHASE_INDEX: Record<Phase, number> = PHASE_ORDER.reduce(
	(acc, p, i) => {
		acc[p] = i;
		return acc;
	},
	{} as Record<Phase, number>,
);

// ── 阶段内状态机 ───────────────────────────────────────

export const VALID_PHASE_STATUSES = [
	"not_started",
	"in_progress",
	"under_review",
	"completed",
] as const;

export type PhaseStatus = (typeof VALID_PHASE_STATUSES)[number];

/**
 * 合法的状态转移。防篡改核心：只允许表内的转移。
 * - not_started → in_progress（start_phase）
 * - in_progress → under_review（review_phase，进入 Step 6）
 * - in_progress → in_progress（advance step，不改状态）
 * - under_review → completed（complete_phase，gate 校验通过后）
 * - under_review → in_progress（review 打回，回 Step 3）
 * - completed 不可回退（要改已完成阶段须用户显式介入，见 reject 注释）
 */
const ALLOWED_TRANSITIONS: Record<PhaseStatus, PhaseStatus[]> = {
	not_started: ["in_progress"],
	in_progress: ["in_progress", "under_review"],
	under_review: ["completed", "in_progress"],
	completed: [], // 终态，不可回退
};

export function isAllowedTransition(from: PhaseStatus, to: PhaseStatus): boolean {
	return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/** 阶段 N 标 completed 前必须 completed 的前置阶段（线性依赖）。 */
export function prerequisiteOf(phase: Phase): Phase | null {
	const idx = PHASE_INDEX[phase];
	if (idx <= 0) return null; // init 无前置
	return PHASE_ORDER[idx - 1];
}

// ── Loop Step ─────────────────────────────────────────

export const VALID_STEPS = ["1", "2", "3", "4", "5", "6", "6b", "6c"] as const;
export type LoopStep = (typeof VALID_STEPS)[number];

const STEP_ORDER: Record<LoopStep, number> = {
	"1": 1,
	"2": 2,
	"3": 3,
	"4": 4,
	"5": 5,
	"6": 6,
	"6b": 7,
	"6c": 8,
};

/** step 必须单调前进（不能倒退），同 step 允许（重入）。 */
export function isStepAdvance(from: LoopStep | undefined, to: LoopStep): boolean {
	if (from === undefined) return true;
	return STEP_ORDER[to] >= STEP_ORDER[from];
}

// ── Gap（追踪发现） ───────────────────────────────────

export const VALID_GAP_CLASSIFICATIONS = ["F", "K", "D"] as const;
export type GapClassification = (typeof VALID_GAP_CLASSIFICATIONS)[number];

export const VALID_GAP_STATUSES = ["open", "resolved"] as const;
export type GapStatus = (typeof VALID_GAP_STATUSES)[number];

export interface Gap {
	id: string;
	phase: Phase;
	classification: GapClassification;
	/** F=二次确认 / K=直接问用户 / D=agent 自决 */
	description: string;
	status: GapStatus;
	round: number;
	createdAt: string;
	resolvedAt?: string;
}

// ── 阶段状态记录（store 内） ───────────────────────────

export interface PhaseState {
	phase: Phase;
	status: PhaseStatus;
	currentStep?: LoopStep;
	loopRound: number;
	startedAt?: string;
	completedAt?: string;
}

// ── 顶层 store 结构 ───────────────────────────────────

export interface DesignStatus {
	/** schema 版本，未来迁移用 */
	version: 1;
	topic: string;
	phases: Record<Phase, PhaseState>;
	gaps: Gap[];
	/** 审计留痕：每次状态变更记一条 */
	history: HistoryEntry[];
	updatedAt: string;
}

export interface HistoryEntry {
	timestamp: string;
	phase: Phase;
	action: string;
	from?: PhaseStatus;
	to?: PhaseStatus;
	note?: string;
}

// ── gate 定义（交付物派生） ────────────────────────────

/**
 * 每阶段的 gate 判据——从交付物文件派生（不是 agent 主观写）。
 * gate.ts 的 checkPhaseGate 据此读 .xyz-harness/{topic}/ 下的文件验。
 *
 * - deliverable: 主交付物文件名（验存在 + frontmatter verdict:pass）
 * - reviewSlug: review-{slug}.md（验存在 + verdict:APPROVED）
 * - machineCheckSlug: machine-check-{slug}.md（验 machine_check:PASS，由 check 脚本产出）
 *   init 阶段无 check 脚本，machineCheckSlug = undefined（软 gate）
 */
export interface PhaseGate {
	phase: Phase;
	deliverable: string | null; // null = init 无主交付物（软 gate）
	reviewSlug: string | null;
	machineCheckSlug: string | null;
	consistencyCheck: boolean; // true = 仅⑥execution，校验 changes/consistency-final.md verdict:CONSISTENT
}

export const PHASE_GATES: Record<Phase, PhaseGate> = {
	init: {
		phase: "init",
		deliverable: null, // 软 gate：AGENTS.md/CONTEXT.md，gate.ts 单独验
		reviewSlug: null,
		machineCheckSlug: null,
		consistencyCheck: false,
	},
	clarity: {
		phase: "clarity",
		deliverable: "requirements.md",
		reviewSlug: "clarity",
		machineCheckSlug: "clarity",
		consistencyCheck: false,
	},
	architecture: {
		phase: "architecture",
		deliverable: "system-architecture.md",
		reviewSlug: "architecture",
		machineCheckSlug: "architecture",
		consistencyCheck: false,
	},
	issues: {
		phase: "issues",
		deliverable: "issues.md",
		reviewSlug: "issues",
		machineCheckSlug: "issues",
		consistencyCheck: false,
	},
	nfr: {
		phase: "nfr",
		deliverable: "non-functional-design.md",
		reviewSlug: "nfr",
		machineCheckSlug: "nfr",
		consistencyCheck: false,
	},
	"code-arch": {
		phase: "code-arch",
		deliverable: "code-architecture.md",
		reviewSlug: "code-arch",
		machineCheckSlug: "code-arch",
		consistencyCheck: false,
	},
	execution: {
		phase: "execution",
		deliverable: "execution-plan.md",
		reviewSlug: "execution",
		machineCheckSlug: "execution",
		consistencyCheck: true, // ⑥Step 6c 总闸门：changes/consistency-final.md verdict:CONSISTENT
	},
};

// ── 工厂 ──────────────────────────────────────────────

export function createInitialStatus(topic: string): DesignStatus {
	const now = new Date().toISOString();
	const phases = {} as Record<Phase, PhaseState>;
	for (const p of PHASE_ORDER) {
		phases[p] = {
			phase: p,
			status: "not_started",
			loopRound: 0,
		};
	}
	return {
		version: 1,
		topic,
		phases,
		gaps: [],
		history: [],
		updatedAt: now,
	};
}

// ── 工具函数 ──────────────────────────────────────────

/** 当前 active 阶段 = 第一个非 completed 的 in_progress/under_review 阶段。 */
export function currentPhase(status: DesignStatus): Phase | null {
	for (const p of PHASE_ORDER) {
		const s = status.phases[p].status;
		if (s === "in_progress" || s === "under_review") return p;
	}
	return null;
}

/** 全流程完成度：completed 阶段数 / 总数。 */
export function completionRatio(status: DesignStatus): { done: number; total: number } {
	const done = PHASE_ORDER.filter((p) => status.phases[p].status === "completed").length;
	return { done, total: PHASE_ORDER.length };
}

/** open gap 数。 */
export function openGapCount(status: DesignStatus): number {
	return status.gaps.filter((g) => g.status === "open").length;
}
