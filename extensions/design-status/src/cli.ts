#!/usr/bin/env node
/**
 * design-status CLI — git-style 子命令，让设计工作流状态追踪不限 Pi 能用。
 *
 * Claude Code / Cursor / 纯 shell 都能调：design-status get-status / start-phase clarity / ...
 * 调用语义与 Pi tool 完全一致（同一批 store 函数，状态机约束/gate 校验零分叉）。
 *
 * 零 Pi 依赖：只 import store/model/gate/render（纯 node:fs）。Node 24 原生 type stripping，零构建。
 *
 * Exit code: 0 = 成功；1 = 约束拒绝/错误（shell 脚本可判断）。
 * 输出惯例：成功结果 → stdout；错误/拒绝 → stderr。
 */

import { checkPhaseGate } from "./gate.ts";
import type { GapClassification, GapStatus, LoopStep, Phase } from "./model.ts";
import {
	PHASE_ORDER,
	VALID_GAP_CLASSIFICATIONS,
	VALID_GAP_STATUSES,
	VALID_STEPS,
} from "./model.ts";
import { renderOverview, renderPhaseDetail } from "./render.ts";
import {
	advanceStep,
	completePhase,
	loadStatus,
	logGap,
	resolveTopic,
	reviewPhase,
	saveStatus,
	startPhase,
} from "./store.ts";

// ── 输出辅助 ──────────────────────────────────────────

function stdout(msg: string): void {
	process.stdout.write(msg + "\n");
}

function stderr(msg: string): void {
	process.stderr.write(msg + "\n");
}

/** 成功退出 */
function ok(msg: string): never {
	stdout(msg);
	process.exit(0);
}

/** 失败/拒绝退出 */
function fail(msg: string): never {
	stderr(msg);
	process.exit(1);
}

// ── 用法 ──────────────────────────────────────────────

const USAGE = `design-status — design 工作流阶段状态/进度追踪 CLI

用法：
  design-status get-status                              全流程概览（7 阶段 + 进度 + gaps）
  design-status get-phase <phase>                       单阶段详情（step/round/gaps/gate）
  design-status start-phase <phase>                     开始阶段（校验前置 completed，防跳阶）
  design-status advance <phase> <step> [--note ...]     推进 loop step（step 单调前进）
  design-status review-phase <phase>                    标记进入 Step 6 审查
  design-status complete-phase <phase>                  收尾（自动校验交付物 gate，过了才 completed）
  design-status log-gap <phase> <gap_id> -c F|K|D -s open|resolved [-d 描述]   记/更新 gap

phase: ${PHASE_ORDER.join(" / ")}
step:  1 交互初稿 / 2 追踪 / 3 gap分流 / 4 收敛 / 5 定稿 / 6 审查 / 6b 反哺

状态机约束：阶段线性依赖（不可跳阶）、completed 不可回退、complete-phase 需过交付物 gate。
真相源混合：完成状态从交付物派生（交付物+verdict:pass+review APPROVED），非主观标记。

在 .xyz-harness/{topic}/ 目录下运行（自动检测最近修改的 topic）。
`;

// ── 参数校验 ──────────────────────────────────────────

function parsePhase(arg: string | undefined): Phase {
	if (!arg) fail(`缺少 phase 参数。用法见 --help。`);
	if (!PHASE_ORDER.includes(arg as Phase)) {
		fail(`无效 phase: '${arg}'。可选: ${PHASE_ORDER.join(" / ")}`);
	}
	return arg as Phase;
}

function parseStep(arg: string | undefined): LoopStep {
	if (!arg) fail(`缺少 step 参数。用法见 --help。`);
	if (!VALID_STEPS.includes(arg as LoopStep)) {
		fail(`无效 step: '${arg}'。可选: ${VALID_STEPS.join(" / ")}`);
	}
	return arg as LoopStep;
}

function parseClassification(arg: string | undefined): GapClassification {
	if (!arg) fail(`缺少 -c (classification) 参数。用法见 --help。`);
	if (!VALID_GAP_CLASSIFICATIONS.includes(arg as GapClassification)) {
		fail(`无效 classification: '${arg}'。可选: ${VALID_GAP_CLASSIFICATIONS.join(" / ")}`);
	}
	return arg as GapClassification;
}

function parseGapStatus(arg: string | undefined): GapStatus {
	if (!arg) fail(`缺少 -s (gap_status) 参数。用法见 --help。`);
	if (!VALID_GAP_STATUSES.includes(arg as GapStatus)) {
		fail(`无效 gap_status: '${arg}'。可选: ${VALID_GAP_STATUSES.join(" / ")}`);
	}
	return arg as GapStatus;
}

// ── topic 解析 + 读写上下文 ───────────────────────────

interface Ctx {
	cwd: string;
	topic: string;
	topicDir: string;
}

function resolveCtx(): Ctx {
	const cwd = process.cwd();
	const resolved = resolveTopic(cwd);
	if (!resolved) {
		fail(
			`未找到 .xyz-harness/ 目录。请在项目根（含 .xyz-harness/{topic}/ 的目录）运行，或先用 /design-init 初始化。`,
		);
	}
	return { cwd, ...resolved };
}

/** 执行一个 mutate 操作（load → mutate → save if ok），打印结果 + exit。 */
function runMutate(
	action: (cwd: string, topic: string, topicDir: string) => { ok: boolean; message: string },
): never {
	const { cwd, topic, topicDir } = resolveCtx();
	const r = action(cwd, topic, topicDir);
	if (r.ok) {
		ok(r.message);
	}
	fail(r.message);
}

// ── 主入口 ────────────────────────────────────────────

function main(): never {
	// argv[0]=node, argv[1]=script path, argv[2+]=用户参数
	const NODE_ARG_OFFSET = 2;
	const args = process.argv.slice(NODE_ARG_OFFSET);
	const cmd = args[0];

	if (!cmd || cmd === "--help" || cmd === "-h") {
		ok(USAGE);
	}

	switch (cmd) {
		case "get-status": {
			const { cwd, topic } = resolveCtx();
			const status = loadStatus(cwd, topic);
			ok(renderOverview(status));
		}

		case "get-phase": {
			const phase = parsePhase(args[1]);
			const { cwd, topic, topicDir } = resolveCtx();
			const status = loadStatus(cwd, topic);
			const gate = checkPhaseGate(topicDir, cwd, phase);
			ok(renderPhaseDetail(status, phase, gate));
		}

		case "start-phase": {
			const phase = parsePhase(args[1]);
			runMutate((cwd, topic) => {
				const status = loadStatus(cwd, topic);
				const r = startPhase(status, phase);
				if (r.ok) saveStatus(cwd, r.status);
				return { ok: r.ok, message: r.message };
			});
		}

		case "advance": {
			const phase = parsePhase(args[1]);
			const step = parseStep(args[2]);
			const noteIdx = args.indexOf("--note");
			const note = noteIdx >= 0 ? args[noteIdx + 1] : undefined;
			runMutate((cwd, topic) => {
				const status = loadStatus(cwd, topic);
				const r = advanceStep(status, phase, step, note);
				if (r.ok) saveStatus(cwd, r.status);
				return { ok: r.ok, message: r.message };
			});
		}

		case "review-phase": {
			const phase = parsePhase(args[1]);
			runMutate((cwd, topic) => {
				const status = loadStatus(cwd, topic);
				const r = reviewPhase(status, phase);
				if (r.ok) saveStatus(cwd, r.status);
				return { ok: r.ok, message: r.message };
			});
		}

		case "complete-phase": {
			const phase = parsePhase(args[1]);
			runMutate((cwd, topic, topicDir) => {
				const status = loadStatus(cwd, topic);
				const r = completePhase(status, phase, topicDir, cwd);
				if (r.ok) saveStatus(cwd, r.status);
				return { ok: r.ok, message: r.message };
			});
		}

		case "log-gap": {
			const phase = parsePhase(args[1]);
			const gapId = args[2];
			if (!gapId) fail(`缺少 gap_id 参数。用法: log-gap <phase> <gap_id> -c F|K|D -s open|resolved`);
			const classification = parseClassification(
				args[args.indexOf("-c") + 1],
			);
			const gapStatus = parseGapStatus(args[args.indexOf("-s") + 1]);
			const descIdx = args.indexOf("-d");
			const desc = descIdx >= 0 ? args[descIdx + 1] : "(无描述)";
			runMutate((cwd, topic) => {
				const status = loadStatus(cwd, topic);
				const r = logGap(status, gapId, phase, classification, desc, gapStatus);
				if (r.ok) saveStatus(cwd, r.status);
				return { ok: r.ok, message: r.message };
			});
		}

		default:
			fail(`未知命令: '${cmd}'。用法见 --help。`);
	}
}

main();
