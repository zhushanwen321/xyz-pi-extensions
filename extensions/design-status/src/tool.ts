/**
 * design_status tool 注册 + action dispatcher。
 *
 * 单 tool + action（像 todo），统管 7 个 design 阶段状态。
 * 提示词只讲「做什么」（action 语义），不暴露存储实现（json/路径/frontmatter 细节）。
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";

import { checkPhaseGate } from "./gate.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	type GapClassification,
	type GapStatus,
	type LoopStep,
	type Phase,
	PHASE_ORDER,
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

// ── 参数 schema ───────────────────────────────────────

const DesignStatusParams = Type.Object({
	action: StringEnum(
		["get_status", "get_phase", "start_phase", "advance", "review_phase", "complete_phase", "log_gap"] as const,
	),
	phase: Type.Optional(
		StringEnum(PHASE_ORDER, {
			description: "Design phase (one of init/clarity/architecture/issues/nfr/code-arch/execution)",
		}),
	),
	step: Type.Optional(
		StringEnum(["1", "2", "3", "4", "5", "6", "6b", "6c"] as const, {
			description: "Loop step (for advance action): 1=交互初稿 2=追踪 3=gap分流 4=收敛 5=定稿 6=审查 6b=反哺 6c=仅⑥一致性终检",
		}),
	),
	gap_id: Type.Optional(Type.String({ description: "Gap ID (for log_gap action)" })),
	classification: Type.Optional(
		StringEnum(["F", "K", "D"] as const, {
			description: "Gap classification (for log_gap): F=二次确认 K=问用户 D=agent自决",
		}),
	),
	gap_desc: Type.Optional(Type.String({ description: "Gap description (for log_gap action)" })),
	gap_status: Type.Optional(
		StringEnum(["open", "resolved"] as const, { description: "Gap status (for log_gap action)" }),
	),
	note: Type.Optional(Type.String({ description: "Optional note for advance/complete actions" })),
	topic: Type.Optional(Type.String({ description: "显式绑定 topic slug（多 topic 并行操作时锁住，不依赖 mtime 自动选择）。省略则自动检测最近修改的 topic" })),
});

type Params = Static<typeof DesignStatusParams>;

// ── topic 解析（resolveTopic 从 store.ts import，tool 传 ctx.cwd） ──
// ── 渲染（renderOverview / renderPhaseDetail 从 render.ts import，CLI 共用） ──

// ── action dispatcher ─────────────────────────────────

function executeAction(
	params: Params,
	ctx: ExtensionContext,
): { content: Array<{ type: "text"; text: string }>; error?: boolean } {
	const phase = params.phase as Phase | undefined;
	// 显式 topic 优先（多 topic 并行时锁住）；否则带 phase 路由，无 phase 回退哨兵展示项目级 init。
	let resolved: { topic: string; topicDir: string } | null;
	if (params.topic) {
		const topicDir = join(ctx.cwd, ".xyz-harness", params.topic);
		if (!existsSync(topicDir)) {
			return { content: [{ type: "text", text: `Error: topic '${params.topic}' 不存在：无 ${topicDir} 目录` }], error: true };
		}
		resolved = { topic: params.topic, topicDir };
	} else {
		resolved = phase
			? resolveTopic(ctx.cwd, { forPhase: phase })
			: resolveTopic(ctx.cwd) ?? resolveTopic(ctx.cwd, { forPhase: "init" });
	}
	if (!resolved) {
		return {
			content: [{ type: "text", text: "Error: 未找到 .xyz-harness/{topic}/ 主题子目录。请先用 full-clarity 选 topic（它会创建 topic 目录），或在一个含 .xyz-harness/{topic}/ 的项目根运行。" }],
			error: true,
		};
	}
	const { topic, topicDir } = resolved;
	let status = loadStatus(ctx.cwd, topic);

	try {
		switch (params.action) {
			case "get_status": {
				return { content: [{ type: "text", text: renderOverview(status) }] };
			}

			case "get_phase": {
				if (!phase) return err("get_phase 需要 phase 参数");
				const gate = checkPhaseGate(topicDir, ctx.cwd, phase);
				return { content: [{ type: "text", text: renderPhaseDetail(status, phase, gate) }] };
			}

			case "start_phase": {
				if (!phase) return err("start_phase 需要 phase 参数");
				const r = startPhase(status, phase);
				status = r.status;
				if (r.ok) saveStatus(ctx.cwd, status);
				return { content: [{ type: "text", text: r.message }], error: r.ok ? undefined : true };
			}

			case "advance": {
				if (!phase) return err("advance 需要 phase 参数");
				if (!params.step) return err("advance 需要 step 参数");
				const r = advanceStep(status, phase, params.step as LoopStep, params.note);
				status = r.status;
				if (r.ok) saveStatus(ctx.cwd, status);
				return { content: [{ type: "text", text: r.message }], error: r.ok ? undefined : true };
			}

			case "review_phase": {
				if (!phase) return err("review_phase 需要 phase 参数");
				const r = reviewPhase(status, phase);
				status = r.status;
				if (r.ok) saveStatus(ctx.cwd, status);
				return { content: [{ type: "text", text: r.message }], error: r.ok ? undefined : true };
			}

			case "complete_phase": {
				if (!phase) return err("complete_phase 需要 phase 参数");
				const r = completePhase(status, phase, topicDir, ctx.cwd);
				status = r.status;
				if (r.ok) saveStatus(ctx.cwd, status);
				return { content: [{ type: "text", text: r.message }], error: r.ok ? undefined : true };
			}

			case "log_gap": {
				if (!phase) return err("log_gap 需要 phase 参数");
				if (!params.gap_id) return err("log_gap 需要 gap_id 参数");
				if (!params.classification) return err("log_gap 需要 classification 参数");
				if (!params.gap_status) return err("log_gap 需要 gap_status 参数");
				const r = logGap(
					status,
					params.gap_id,
					phase,
					params.classification as GapClassification,
					params.gap_desc ?? "(无描述)",
					params.gap_status as GapStatus,
				);
				status = r.status;
				if (r.ok) saveStatus(ctx.cwd, status);
				return { content: [{ type: "text", text: r.message }], error: r.ok ? undefined : true };
			}

			default:
				return err(`未知 action: ${params.action}`);
		}
	} catch (e) {
		return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], error: true };
	}
}

function err(msg: string): { content: Array<{ type: "text"; text: string }>; error: boolean } {
	return { content: [{ type: "text", text: `Error: ${msg}` }], error: true };
}

// ── Tool 注册 ─────────────────────────────────────────

export function registerDesignStatusTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "design_status",
		label: "Design Status",
		description:
			"Track design workflow phase status & progress across 7 design skills (init → clarity → architecture → issues → nfr → code-arch → execution)." +
			"\n\nActions:" +
			"\n- get_status: Overview of all 7 phases + current progress + open gaps" +
			"\n- get_phase: Detail of one phase (step/round/gaps/gate check)" +
			"\n- start_phase: Begin a phase (requires prior phase completed — prevents skipping)" +
			"\n- advance: Move to next loop step within a phase (step must move forward)" +
			"\n- review_phase: Mark phase entering Step 6 review" +
			"\n- complete_phase: Mark phase done (AUTO-CHECKS deliverable gate — refuses if deliverable missing or review not APPROVED)" +
			"\n- log_gap: Record/update a tracking gap (F/K/D classification)" +
			"\n\nState-machine enforced: phases are linearly dependent (can't skip), completion requires passing the deliverable gate, completed phases can't revert.",
		promptSnippet:
			"Use design_status to track which design phase you're in and gate-check completion. Call start_phase at phase start, complete_phase to finish (it validates deliverables).",
		promptGuidelines: [
			"[何时用] design 工作流中：阶段开始(start_phase)、推进 loop step(advance)、收尾(complete_phase)、看进度(get_status)",
			"[阶段线性] 阶段有顺序依赖，start_phase 前置阶段必须 completed，不可跳阶",
			"[收尾校验] complete_phase 会自动校验交付物 gate——交付物不存在/verdict 非 pass/review 未 APPROVED 会拒绝并告你缺什么",
			"[真相源] 阶段完成状态从交付物派生，不是主观标记；交付物是真相",
			"[Not for] 非 design 工作流的普通任务追踪——用 todo 工具",
		],
		parameters: DesignStatusParams,

		async execute(
			_toolCallId: string,
			params: Static<typeof DesignStatusParams>,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			if (signal?.aborted) {
				return {
					content: [{ type: "text" as const, text: "design_status 调用被中止。" }],
				};
			}
			return executeAction(params as Params, ctx);
		},

		renderCall(args: Record<string, unknown>, theme: Theme, _context?: unknown) {
			let text = theme.fg("toolTitle", theme.bold("design_status ")) + theme.fg("muted", args.action as string);
			if (args.phase) text += ` ${theme.fg("accent", args.phase as string)}`;
			if (args.step) text += ` ${theme.fg("warning", `Step ${args.step}`)}`;
			if (args.gap_id) text += ` ${theme.fg("dim", args.gap_id as string)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result: unknown, _options: { expanded: boolean }, theme: Theme, _context?: unknown) {
			// result 是 execute 返回的 { content: [{type,text}] }；类型守卫取首条 text
			const text =
				typeof result === "object" &&
				result !== null &&
				"content" in result &&
				Array.isArray((result as { content: unknown }).content)
					? ((result as { content: Array<{ text?: string }> }).content[0]?.text ?? "")
					: "";
			return new Text(theme.fg("text", text), 0, 0);
		},
	});
}
