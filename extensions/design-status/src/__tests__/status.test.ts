import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkPhaseGate, parseFrontmatter } from "../gate.ts";
import type { DesignStatus } from "../model.ts";
import {
	createInitialStatus,
	currentPhase,
	INIT_TOPIC_SENTINEL,
	isAllowedTransition,
	isStepAdvance,
	PHASE_ORDER,
	prerequisiteOf,
} from "../model.ts";
import {
	advanceStep,
	completePhase,
	loadStatus,
	logGap,
	resolveTopic,
	reviewPhase,
	saveStatus,
	startPhase,
	statusPath,
} from "../store.ts";

// ── 测试夹具 ──────────────────────────────────────────

/** 造一个临时 topic 目录，可选写入交付物 + review + machine-check 文件。 */
function makeTopic(opts?: {
	deliverable?: { name: string; verdict?: string };
	review?: { slug: string; verdict?: string };
	machineCheck?: { slug: string; result?: string };
}): { cwd: string; topicDir: string; topic: string } {
	const cwd = mkdtempSync(join(tmpdir(), "ds-test-"));
	const topic = "test-topic";
	const topicDir = join(cwd, ".xyz-harness", topic);
	mkdirSync(join(topicDir, "changes"), { recursive: true });
	if (opts?.deliverable) {
		writeFileSync(
			join(topicDir, opts.deliverable.name),
			`---\nverdict: ${opts.deliverable.verdict ?? "pass"}\n---\n# content\n`,
		);
	}
	if (opts?.review) {
		writeFileSync(
			join(topicDir, "changes", `review-${opts.review.slug}.md`),
			`---\nverdict: ${opts.review.verdict ?? "APPROVED"}\n---\n# review\n`,
		);
	}
	if (opts?.machineCheck) {
		writeFileSync(
			join(topicDir, "changes", `machine-check-${opts.machineCheck.slug}.md`),
			`---\nphase: ${opts.machineCheck.slug}\nmachine_check: ${opts.machineCheck.result ?? "PASS"}\n---\n# report\n`,
		);
	}
	return { cwd, topicDir, topic };
}

function freshStatus(): DesignStatus {
	return createInitialStatus("test-topic");
}

/** 把某阶段链推进到 under_review（start→advance6→review），用于测 complete。 */
function moveToReview(status: DesignStatus, phase: "clarity" | "init"): DesignStatus {
	if (phase === "init") {
		// init 软 gate，直接 start → review
		const s1 = startPhase(status, "init");
		const s2 = reviewPhase(s1.status, "init");
		return s2.status;
	}
	const s1 = startPhase(status, "clarity");
	const s2 = advanceStep(s1.status, "clarity", "6");
	const s3 = reviewPhase(s2.status, "clarity");
	return s3.status;
}

// ── model.ts: 状态机基础 ──────────────────────────────

describe("model: state machine basics", () => {
	it("should define 7 phases in linear order", () => {
		expect(PHASE_ORDER).toEqual([
			"init",
			"clarity",
			"architecture",
			"issues",
			"nfr",
			"code-arch",
			"execution",
		]);
	});

	it("init has no prerequisite, others depend on previous", () => {
		expect(prerequisiteOf("init")).toBeNull();
		expect(prerequisiteOf("clarity")).toBe("init");
		expect(prerequisiteOf("execution")).toBe("code-arch");
	});

	it("allows valid transitions, rejects invalid ones", () => {
		expect(isAllowedTransition("not_started", "in_progress")).toBe(true);
		expect(isAllowedTransition("in_progress", "under_review")).toBe(true);
		expect(isAllowedTransition("under_review", "completed")).toBe(true);
		// 非法
		expect(isAllowedTransition("not_started", "completed")).toBe(false); // 跳过 in_progress
		expect(isAllowedTransition("completed", "in_progress")).toBe(false); // completed 回退
		expect(isAllowedTransition("completed", "not_started")).toBe(false); // 终态
	});

	it("step must move forward (monotonic)", () => {
		expect(isStepAdvance(undefined, "1")).toBe(true);
		expect(isStepAdvance("1", "2")).toBe(true);
		expect(isStepAdvance("3", "3")).toBe(true); // 同 step 允许（重入）
		expect(isStepAdvance("4", "2")).toBe(false); // 倒退
		expect(isStepAdvance("6", "1")).toBe(false);
	});

	it("creates initial status with all phases not_started", () => {
		const s = freshStatus();
		for (const p of PHASE_ORDER) {
			expect(s.phases[p].status).toBe("not_started");
		}
		expect(currentPhase(s)).toBeNull();
	});
});

// ── store.ts: start_phase 约束（防跳阶 + 单 active） ──

describe("store: start_phase constraints", () => {
	it("starts init (no prerequisite needed)", () => {
		const r = startPhase(freshStatus(), "init");
		expect(r.ok).toBe(true);
		expect(r.status.phases.init.status).toBe("in_progress");
		expect(r.status.phases.init.currentStep).toBe("1");
		expect(r.status.phases.init.loopRound).toBe(0); // 0 = 尚未进入追踪
	});

	it("refuses to skip: can't start clarity before init completed", () => {
		const r = startPhase(freshStatus(), "clarity");
		expect(r.ok).toBe(false);
		expect(r.message).toContain("前置阶段 init 尚未 completed");
		expect(r.status.phases.clarity.status).toBe("not_started"); // 未改
	});

	it("refuses second active phase while one in_progress", () => {
		// init 已 completed 时，clarity 的前置满足，但已有 init active → 应被「active 阶段」拒
		// （这里 init 还没 complete，所以先命中前置检查——也正确拒绝）
		const s = startPhase(freshStatus(), "init").status;
		const r = startPhase(s, "clarity");
		expect(r.ok).toBe(false);
		// 两条约束任一触发都合法：前置未完成 OR 已有 active 阶段
		expect(r.message.includes("前置阶段 init 尚未 completed") || r.message.includes("已有 active 阶段")).toBe(true);
	});

	it("refuses to re-start a completed phase", () => {
		const { cwd, topicDir } = makeTopic({}); // init 软 gate 需 AGENTS.md
		// init 软 gate 要 AGENTS.md/CONTEXT.md——造上
		writeFileSync(join(cwd, "AGENTS.md"), "# agents");
		writeFileSync(join(cwd, "CONTEXT.md"), "# context");
		const s = moveToReview(freshStatus(), "init");
		const r = completePhase(s, "init", topicDir, cwd);
		expect(r.ok).toBe(true);
		// 再 start init
		const r2 = startPhase(r.status, "init");
		expect(r2.ok).toBe(false);
		expect(r2.message).toContain("已 completed");
	});
});

// ── store.ts: advance/review 约束 ────────────────────

describe("store: advance & review constraints", () => {
	it("advances step forward", () => {
		const s = startPhase(freshStatus(), "init").status;
		const r = advanceStep(s, "init", "2");
		expect(r.ok).toBe(true);
		expect(r.status.phases.init.currentStep).toBe("2");
		// startPhase 设 loopRound=0；进入 Step 2（第一轮追踪）+1 → 1
		expect(r.status.phases.init.loopRound).toBe(1);
	});

	it("refuses step going backward", () => {
		const s = startPhase(freshStatus(), "init").status;
		advanceStep(s, "init", "4");
		const r = advanceStep(s, "init", "2");
		expect(r.ok).toBe(false);
		expect(r.message).toContain("不能倒退");
	});

	it("refuses advance when not in_progress (e.g. under_review)", () => {
		const s = moveToReview(freshStatus(), "init");
		const r = advanceStep(s, "init", "6");
		expect(r.ok).toBe(false);
		expect(r.message).toContain("advance 只能在 in_progress 时用");
	});

	it("review_phase transitions in_progress → under_review", () => {
		const s = startPhase(freshStatus(), "init").status;
		const r = reviewPhase(s, "init");
		expect(r.ok).toBe(true);
		expect(r.status.phases.init.status).toBe("under_review");
	});
});

// ── store.ts: complete_phase gate 校验（防篡改核心）──

describe("store: complete_phase gate validation", () => {
	it("refuses complete when deliverable missing", () => {
		const { cwd, topicDir } = makeTopic({}); // 无 requirements.md
		writeFileSync(join(cwd, "AGENTS.md"), "# a");
		writeFileSync(join(cwd, "CONTEXT.md"), "# c");
		// 先把 init 完成（让 clarity 的前置满足）
		const initDone = completePhase(moveToReview(freshStatus(), "init"), "init", topicDir, cwd).status;
		// 再 start + review clarity
		const clarity = reviewPhase(startPhase(initDone, "clarity").status, "clarity");
		const r = completePhase(clarity.status, "clarity", topicDir, cwd);
		expect(r.ok).toBe(false);
		expect(r.message).toContain("requirements.md 不存在");
		expect(r.status.phases.clarity.status).toBe("under_review"); // 未升 completed
	});

	it("refuses complete when review not APPROVED", () => {
		const { cwd, topicDir } = makeTopic({
			deliverable: { name: "requirements.md" },
			review: { slug: "clarity", verdict: "CHANGES_REQUESTED" },
		});
		writeFileSync(join(cwd, "AGENTS.md"), "# a");
		writeFileSync(join(cwd, "CONTEXT.md"), "# c");
		const initDone = completePhase(moveToReview(freshStatus(), "init"), "init", topicDir, cwd).status;
		const clarity = reviewPhase(startPhase(initDone, "clarity").status, "clarity");
		const r = completePhase(clarity.status, "clarity", topicDir, cwd);
		expect(r.ok).toBe(false);
		expect(r.message).toContain("verdict 非 APPROVED");
	});

	it("refuses complete when deliverable verdict not pass", () => {
		const { cwd, topicDir } = makeTopic({
			deliverable: { name: "requirements.md", verdict: "draft" },
			review: { slug: "clarity" },
		});
		writeFileSync(join(cwd, "AGENTS.md"), "# a");
		writeFileSync(join(cwd, "CONTEXT.md"), "# c");
		const initDone = completePhase(moveToReview(freshStatus(), "init"), "init", topicDir, cwd).status;
		const clarity = reviewPhase(startPhase(initDone, "clarity").status, "clarity");
		const r = completePhase(clarity.status, "clarity", topicDir, cwd);
		expect(r.ok).toBe(false);
		expect(r.message).toContain("verdict 非 pass");
	});

	it("refuses complete when machine_check FAIL", () => {
		const { cwd, topicDir } = makeTopic({
			deliverable: { name: "requirements.md" },
			review: { slug: "clarity" },
			machineCheck: { slug: "clarity", result: "FAIL" },
		});
		writeFileSync(join(cwd, "AGENTS.md"), "# a");
		writeFileSync(join(cwd, "CONTEXT.md"), "# c");
		const initDone = completePhase(moveToReview(freshStatus(), "init"), "init", topicDir, cwd).status;
		const clarity = reviewPhase(startPhase(initDone, "clarity").status, "clarity");
		const r = completePhase(clarity.status, "clarity", topicDir, cwd);
		expect(r.ok).toBe(false);
		expect(r.message).toContain("machine_check: FAIL");
	});

	it("completes when all gates pass", () => {
		const { cwd, topicDir } = makeTopic({
			deliverable: { name: "requirements.md" },
			review: { slug: "clarity" },
			machineCheck: { slug: "clarity" },
		});
		writeFileSync(join(cwd, "AGENTS.md"), "# a");
		writeFileSync(join(cwd, "CONTEXT.md"), "# c");
		const initDone = completePhase(moveToReview(freshStatus(), "init"), "init", topicDir, cwd).status;
		const clarity = reviewPhase(startPhase(initDone, "clarity").status, "clarity");
		const r = completePhase(clarity.status, "clarity", topicDir, cwd);
		expect(r.ok).toBe(true);
		expect(r.status.phases.clarity.status).toBe("completed");
		expect(r.status.history.length).toBeGreaterThan(0);
	});

	it("refuses complete when not under_review (skipped review)", () => {
		const { cwd, topicDir } = makeTopic({});
		writeFileSync(join(cwd, "AGENTS.md"), "# a");
		writeFileSync(join(cwd, "CONTEXT.md"), "# c");
		const initDone = completePhase(moveToReview(freshStatus(), "init"), "init", topicDir, cwd).status;
		const inProgress = startPhase(initDone, "clarity").status; // 没走 review_phase
		const r = completePhase(inProgress, "clarity", topicDir, cwd);
		expect(r.ok).toBe(false);
		expect(r.message).toContain("须先 review_phase 进入 under_review");
	});
});

// ── gate.ts: init 软 gate ─────────────────────────────

describe("gate: init soft gate", () => {
	it("passes when AGENTS.md + CONTEXT.md present", () => {
		const { cwd, topicDir } = makeTopic();
		writeFileSync(join(cwd, "AGENTS.md"), "# a");
		writeFileSync(join(cwd, "CONTEXT.md"), "# c");
		const r = checkPhaseGate(topicDir, cwd, "init");
		expect(r.ok).toBe(true);
	});

	it("fails when AGENTS.md missing", () => {
		const { cwd, topicDir } = makeTopic();
		writeFileSync(join(cwd, "CONTEXT.md"), "# c"); // 只造 CONTEXT
		const r = checkPhaseGate(topicDir, cwd, "init");
		expect(r.ok).toBe(false);
		expect(r.missing).toContain("AGENTS.md 不存在（init 阶段需就位）");
	});
});

// ── gate.ts: parseFrontmatter ─────────────────────────

describe("gate: parseFrontmatter", () => {
	it("parses flat yaml frontmatter", () => {
		const dir = mkdtempSync(join(tmpdir(), "fm-"));
		const f = join(dir, "test.md");
		writeFileSync(f, "---\nverdict: pass\nname: test\n---\n# body\n");
		const fm = parseFrontmatter(f);
		expect(fm.verdict).toBe("pass");
		expect(fm.name).toBe("test");
	});

	it("returns empty for file without frontmatter", () => {
		const dir = mkdtempSync(join(tmpdir(), "fm2-"));
		const f = join(dir, "test.md");
		writeFileSync(f, "# no frontmatter\nbody\n");
		expect(parseFrontmatter(f)).toEqual({});
	});

	it("strips quotes and inline comments", () => {
		const dir = mkdtempSync(join(tmpdir(), "fm3-"));
		const f = join(dir, "test.md");
		writeFileSync(f, '---\nverdict: "pass" # comment\n---\n');
		const fm = parseFrontmatter(f);
		expect(fm.verdict).toBe("pass");
	});
});

// ── store.ts: log_gap ─────────────────────────────────

describe("store: log_gap", () => {
	it("records a new gap", () => {
		const s = startPhase(freshStatus(), "init").status;
		const r = logGap(s, "G1", "init", "K", "need user input on X", "open");
		expect(r.ok).toBe(true);
		expect(r.status.gaps).toHaveLength(1);
		expect(r.status.gaps[0].classification).toBe("K");
		expect(r.status.gaps[0].status).toBe("open");
	});

	it("updates existing gap to resolved", () => {
		const s = startPhase(freshStatus(), "init").status;
		logGap(s, "G1", "init", "K", "need input", "open");
		const r = logGap(s, "G1", "init", "K", "need input", "resolved");
		expect(r.ok).toBe(true);
		expect(r.status.gaps[0].status).toBe("resolved");
		expect(r.status.gaps[0].resolvedAt).toBeTruthy();
	});
});

// ── 审计历史 ──────────────────────────────────────────

describe("audit history", () => {
	it("records every state change", () => {
		const { cwd, topicDir } = makeTopic();
		writeFileSync(join(cwd, "AGENTS.md"), "# a");
		writeFileSync(join(cwd, "CONTEXT.md"), "# c");
		let s = freshStatus();
		const n0 = s.history.length;
		s = startPhase(s, "init").status;
		s = reviewPhase(s, "init").status;
		s = completePhase(s, "init", topicDir, cwd).status;
		expect(s.history.length).toBe(n0 + 3); // start + review + complete
		// 每条都有 timestamp + phase + action
		for (const h of s.history) {
			expect(h.timestamp).toBeTruthy();
			expect(h.phase).toBe("init");
			expect(h.action).toBeTruthy();
		}
	});
});

// ── store.ts: init 项目级状态特例（哨兵 topic）────────

describe("store: init project-level state (sentinel topic)", () => {
	it("statusPath routes sentinel topic to project-level file", () => {
		const cwd = "/proj";
		expect(statusPath(cwd, INIT_TOPIC_SENTINEL)).toBe(
			join(cwd, ".xyz-harness", ".design-status.json"),
		);
		expect(statusPath(cwd, "my-topic")).toBe(
			join(cwd, ".xyz-harness", "my-topic", ".design-status.json"),
		);
	});

	it("resolveTopic creates .xyz-harness and returns sentinel for init phase", () => {
		const cwd = mkdtempSync(join(tmpdir(), "ds-init-"));
		expect(existsSync(join(cwd, ".xyz-harness"))).toBe(false);
		expect(resolveTopic(cwd, { forPhase: "init" })).toEqual({
			topic: INIT_TOPIC_SENTINEL,
			topicDir: join(cwd, ".xyz-harness"),
		});
		// .xyz-harness 被自动创建（init 本就是建项目基建）
		expect(existsSync(join(cwd, ".xyz-harness"))).toBe(true);
	});

	it("resolveTopic returns sentinel for init even with no topic subdir", () => {
		const cwd = mkdtempSync(join(tmpdir(), "ds-init2-"));
		mkdirSync(join(cwd, ".xyz-harness"), { recursive: true });
		expect(resolveTopic(cwd, { forPhase: "init" })).toEqual({
			topic: INIT_TOPIC_SENTINEL,
			topicDir: join(cwd, ".xyz-harness"),
		});
	});

	it("resolveTopic returns null for non-init when no topic + no project init state", () => {
		const cwd = mkdtempSync(join(tmpdir(), "ds-init3-"));
		mkdirSync(join(cwd, ".xyz-harness"), { recursive: true });
		expect(resolveTopic(cwd)).toBeNull();
		expect(resolveTopic(cwd, { forPhase: "clarity" })).toBeNull();
	});

	it("resolveTopic returns null for non-init even when project init state exists (no topic subdir)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "ds-init4-"));
		const harnessDir = join(cwd, ".xyz-harness");
		mkdirSync(harnessDir, { recursive: true });
		writeFileSync(join(cwd, "AGENTS.md"), "# a");
		writeFileSync(join(cwd, "CONTEXT.md"), "# c");
		// init completed → 写项目级状态文件
		const done = completePhase(
			reviewPhase(startPhase(createInitialStatus(INIT_TOPIC_SENTINEL), "init").status, "init").status,
			"init",
			harnessDir,
			cwd,
		).status;
		saveStatus(cwd, done);
		// 非 init 查询无 topic 子目录 → null（不会误落哨兵把 clarity 状态写进项目级文件）
		expect(resolveTopic(cwd)).toBeNull();
		expect(resolveTopic(cwd, { forPhase: "clarity" })).toBeNull();
	});

	it("end-to-end: init completes at project level, clarity sees it via loadStatus merge", () => {
		const cwd = mkdtempSync(join(tmpdir(), "ds-e2e-"));
		writeFileSync(join(cwd, "AGENTS.md"), "# a");
		writeFileSync(join(cwd, "CONTEXT.md"), "# c");

		// 1. init 在无 topic 时 start → review → complete（全走项目级哨兵）
		const initCtx = resolveTopic(cwd, { forPhase: "init" })!;
		expect(initCtx.topic).toBe(INIT_TOPIC_SENTINEL);
		let status = loadStatus(cwd, initCtx.topic);
		status = startPhase(status, "init").status;
		status = reviewPhase(status, "init").status;
		const done = completePhase(status, "init", initCtx.topicDir, cwd);
		expect(done.ok).toBe(true);
		saveStatus(cwd, done.status);
		// 项目级状态文件就位
		expect(existsSync(join(cwd, ".xyz-harness", ".design-status.json"))).toBe(true);

		// 1.5 选 topic 前，clarity 无 topic → resolveTopic 拒绝（不会误落哨兵）
		expect(resolveTopic(cwd, { forPhase: "clarity" })).toBeNull();

		// 2. clarity 选 topic（建 topic 目录）
		const topic = "2026-06-feature";
		mkdirSync(join(cwd, ".xyz-harness", topic, "changes"), { recursive: true });

		// 3. loadStatus merge：topic 状态看到项目级 init completed
		const clarityStatus = loadStatus(cwd, topic);
		expect(clarityStatus.phases.init.status).toBe("completed");
		expect(clarityStatus.topic).toBe(topic); // topic 字段仍是真实 topic

		// 4. start_phase clarity 前置检查通过（init 已 completed）
		const r = startPhase(clarityStatus, "clarity");
		expect(r.ok).toBe(true);
		expect(r.status.phases.clarity.status).toBe("in_progress");
	});
});
