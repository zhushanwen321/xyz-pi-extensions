/**
 * Store — json 读写 + 状态机约束逻辑。
 *
 * 纯逻辑函数（operate on DesignStatus object，不碰磁盘）单独导出，便于单测。
 * 磁盘 I/O（load/save）用 node:fs，路径 = .xyz-harness/{topic}/.design-status.json。
 *
 * 防篡改 = 状态机约束：每个 mutate 操作先校验前置条件（线性依赖/合法转移/gate），
 * 不满足返回 error，不改 status。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { checkPhaseGate, type GateResult } from "./gate.ts";
import {
	createInitialStatus,
	type DesignStatus,
	type Gap,
	type GapClassification,
	type GapStatus,
	type HistoryEntry,
	INIT_TOPIC_SENTINEL,
	isAllowedTransition,
	isStepAdvance,
	type LoopStep,
	type Phase,
	PHASE_ORDER,
	type PhaseStatus,
	prerequisiteOf,
} from "./model.ts";

// ── 结果类型 ──────────────────────────────────────────

export interface MutateResult {
	status: DesignStatus;
	ok: boolean;
	/** 成功的人类可读摘要，或失败的拒绝原因 */
	message: string;
}

function ok(status: DesignStatus, message: string): MutateResult {
	return { status, ok: true, message };
}

function fail(status: DesignStatus, message: string): MutateResult {
	return { status, ok: false, message };
}

function now(): string {
	return new Date().toISOString();
}

/** 追加审计历史条目（原地改 status）。 */
function appendHistory(
	status: DesignStatus,
	phase: Phase,
	action: string,
	extra?: { from?: PhaseStatus; to?: PhaseStatus; note?: string },
): void {
	const entry: HistoryEntry = {
		timestamp: now(),
		phase,
		action,
		...extra,
	};
	status.history.push(entry);
	status.updatedAt = entry.timestamp;
}

// ── 纯逻辑：状态机约束（不碰磁盘，可单测） ────────────

/**
 * start_phase: not_started → in_progress。
 * 约束：前置阶段必须 completed（防跳阶）。
 */
export function startPhase(
	status: DesignStatus,
	phase: Phase,
): MutateResult {
	const ps = status.phases[phase];
	if (ps.status === "completed") {
		return fail(status, `阶段 ${phase} 已 completed，不能重新 start（completed 不可回退）`);
	}
	if (ps.status !== "not_started") {
		return fail(status, `阶段 ${phase} 当前状态 ${ps.status}，只有 not_started 才能 start`);
	}
	// 同时只允许一个 active 阶段（先查这个——「你正在别的阶段里」是最直接的拒绝理由）
	for (const p of PHASE_ORDER) {
		const s = status.phases[p].status;
		if (s === "in_progress" || s === "under_review") {
			return fail(status, `已有 active 阶段 ${p}（${s}），须先 complete 或显式中止才能开始 ${phase}`);
		}
	}
	// 线性依赖：前置阶段必须 completed（防跳阶）
	const prereq = prerequisiteOf(phase);
	if (prereq && status.phases[prereq].status !== "completed") {
		return fail(
			status,
			`阶段 ${phase} 的前置阶段 ${prereq} 尚未 completed（当前 ${status.phases[prereq].status}），不可跳阶`,
		);
	}

	const from = ps.status;
	ps.status = "in_progress";
	ps.startedAt = now();
	ps.currentStep = "1";
	ps.loopRound = 0; // 0 = 尚未进入追踪；进入 Step 2 时 +1
	appendHistory(status, phase, "start_phase", { from, to: "in_progress" });
	return ok(status, `阶段 ${phase} 已开始（in_progress）。当前 Step 1。`);
}

/**
 * advance: 推进 loop step（in_progress 内部）。
 * 约束：step 单调前进；当前必须 in_progress。
 */
export function advanceStep(
	status: DesignStatus,
	phase: Phase,
	step: LoopStep,
	note?: string,
): MutateResult {
	const ps = status.phases[phase];
	if (ps.status !== "in_progress") {
		return fail(status, `阶段 ${phase} 当前状态 ${ps.status}，advance 只能在 in_progress 时用（review 阶段用 review_phase/complete_phase）`);
	}
	if (!isStepAdvance(ps.currentStep, step)) {
		return fail(status, `阶段 ${phase} step 不能倒退（当前 ${ps.currentStep ?? "(无)"} → ${step}）`);
	}
	const prevStep = ps.currentStep;
	ps.currentStep = step;
	// 进入 Step 2+ 时递增轮次（每轮追踪）
	if (step === "2") {
		ps.loopRound += 1;
	}
	appendHistory(status, phase, "advance", { note: `step ${prevStep ?? "?"}→${step}${note ? `: ${note}` : ""}` });
	return ok(status, `阶段 ${phase} 推进到 Step ${step}。${note ? note : ""}`);
}

/**
 * review_phase: in_progress → under_review（进入 Step 6 审查）。
 */
export function reviewPhase(status: DesignStatus, phase: Phase): MutateResult {
	const ps = status.phases[phase];
	if (!isAllowedTransition(ps.status, "under_review")) {
		return fail(status, `阶段 ${phase} 当前状态 ${ps.status}，不能进入 under_review（合法：in_progress → under_review）`);
	}
	const from = ps.status;
	ps.status = "under_review";
	appendHistory(status, phase, "review_phase", { from, to: "under_review" });
	return ok(status, `阶段 ${phase} 进入审查（under_review）。跑 check 脚本 + 派 review subagent 后用 complete_phase 收尾。`);
}

/**
 * complete_phase: under_review → completed。
 * 约束：强制 cross-check 交付物 gate（真相源派生，防伪造完成）。
 */
export function completePhase(
	status: DesignStatus,
	phase: Phase,
	topicDir: string,
	cwd: string,
): MutateResult {
	const ps = status.phases[phase];
	if (ps.status === "completed") {
		return fail(status, `阶段 ${phase} 已 completed`);
	}
	if (ps.status !== "under_review") {
		return fail(
			status,
			`阶段 ${phase} 当前状态 ${ps.status}，complete_phase 须先 review_phase 进入 under_review（当前流程未到审查环节）`,
		);
	}
	// gate 校验——从交付物派生，agent 无法伪造
	const gate: GateResult = checkPhaseGate(topicDir, cwd, phase);
	if (!gate.ok) {
		return fail(
			status,
			`阶段 ${phase} 的交付物 gate 未通过，拒绝标 completed：\n  - ${gate.missing.join("\n  - ")}\n补齐后重试。`,
		);
	}
	const from = ps.status;
	ps.status = "completed";
	ps.completedAt = now();
	appendHistory(status, phase, "complete_phase", { from, to: "completed", note: "gate PASS" });
	return ok(status, `阶段 ${phase} 已 completed（gate 校验通过）。${phase === "execution" ? "全流程完成。" : `下一阶段：${PHASE_ORDER[PHASE_ORDER.indexOf(phase) + 1] ?? "(无)"}`}`);
}

/**
 * log_gap: 记/更新追踪 gap。
 */
export function logGap(
	status: DesignStatus,
	gapId: string,
	phase: Phase,
	classification: GapClassification,
	description: string,
	gapStatus: GapStatus,
): MutateResult {
	const existing = status.gaps.find((g) => g.id === gapId);
	if (existing) {
		const prev = existing.status;
		existing.classification = classification;
		existing.description = description;
		existing.status = gapStatus;
		if (gapStatus === "resolved" && !existing.resolvedAt) {
			existing.resolvedAt = now();
		}
		appendHistory(status, phase, "log_gap", { note: `${gapId} ${prev}→${gapStatus}` });
		return ok(status, `gap ${gapId} 更新（${gapStatus}）。`);
	}
	const gap: Gap = {
		id: gapId,
		phase,
		classification,
		description,
		status: gapStatus,
		round: status.phases[phase].loopRound,
		createdAt: now(),
	};
	status.gaps.push(gap);
	appendHistory(status, phase, "log_gap", { note: `${gapId} [${classification}] ${gapStatus}` });
	return ok(status, `gap ${gapId} 已记录（[${classification}] ${gapStatus}）。`);
}

// ── 磁盘 I/O ─────────────────────────────────────────

const STATUS_FILENAME = ".design-status.json";

/**
 * topic 目录路径。init 哨兵 → .xyz-harness/（项目级，状态文件直接放其下）；
 * 否则 → .xyz-harness/{topic}/。
 */
export function topicDirFor(cwd: string, topic: string): string {
	if (topic === INIT_TOPIC_SENTINEL) {
		return join(cwd, ".xyz-harness");
	}
	return join(cwd, ".xyz-harness", topic);
}

export function statusPath(cwd: string, topic: string): string {
	return join(topicDirFor(cwd, topic), STATUS_FILENAME);
}

/** 读单个状态文件（不做 merge）。文件缺失或损坏返回该 topic 的初始状态。 */
function loadRaw(cwd: string, topic: string): DesignStatus {
	const path = statusPath(cwd, topic);
	if (!existsSync(path)) {
		return createInitialStatus(topic);
	}
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as Partial<DesignStatus>;
		// 合并默认值（向前兼容缺字段）
		const base = createInitialStatus(topic);
		return {
			...base,
			...parsed,
			phases: { ...base.phases, ...(parsed.phases ?? {}) },
			gaps: parsed.gaps ?? [],
			history: parsed.history ?? [],
		};
	} catch {
		return createInitialStatus(topic);
	}
}

/**
 * 加载 topic 状态。init 是项目级一次性阶段，状态始终从项目级文件（哨兵 topic）派生，
 * 不绑 topic——故非哨兵 topic 加载时，用项目级 init 状态覆盖 topic 文件里的 init 快照。
 * 这样 clarity 的 start_phase 前置检查（init 是否 completed）能看到项目级真实状态。
 */
export function loadStatus(cwd: string, topic: string): DesignStatus {
	const topicStatus = loadRaw(cwd, topic);
	if (topic === INIT_TOPIC_SENTINEL) {
		return topicStatus;
	}
	const initStatus = loadRaw(cwd, INIT_TOPIC_SENTINEL);
	return {
		...topicStatus,
		phases: {
			...topicStatus.phases,
			init: initStatus.phases.init,
		},
	};
}

export function saveStatus(cwd: string, status: DesignStatus): void {
	const dir = topicDirFor(cwd, status.topic);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const path = join(dir, STATUS_FILENAME);
	const JSON_INDENT = 2;
	writeFileSync(path, JSON.stringify(status, null, JSON_INDENT) + "\n", "utf-8");
}

// ── topic 解析（tool.ts / cli.ts 共用） ───────────────

/**
 * 推断当前 topic。
 * - forPhase=init：init 是项目级，始终返回哨兵上下文（.xyz-harness/，必要时创建）
 * - 否则：扫 .xyz-harness/ 子目录取最近修改的；无子目录 → null（非 init mutate 不落到哨兵，
 *   避免把 clarity 等阶段状态误写进项目级文件；只读 get_status 由调用方回退哨兵展示 init）
 * - 无 .xyz-harness 且非 init → null
 */
export function resolveTopic(
	cwd: string,
	opts?: { forPhase?: Phase },
): { topic: string; topicDir: string } | null {
	const harnessDir = join(cwd, ".xyz-harness");

	// init 是项目级：始终用哨兵，确保 .xyz-harness 存在（init 本就是建项目基建）
	if (opts?.forPhase === "init") {
		if (!existsSync(harnessDir)) {
			mkdirSync(harnessDir, { recursive: true });
		}
		return { topic: INIT_TOPIC_SENTINEL, topicDir: harnessDir };
	}

	if (!existsSync(harnessDir)) return null;
	const entries = readdirSync(harnessDir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => {
			const dir = join(harnessDir, e.name);
			const stat = statSync(dir);
			return { name: e.name, mtime: stat.mtimeMs };
		})
		.sort((a, b) => b.mtime - a.mtime);
	if (entries.length > 0) {
		const topic = entries[0].name;
		return { topic, topicDir: join(harnessDir, topic) };
	}
	return null;
}
