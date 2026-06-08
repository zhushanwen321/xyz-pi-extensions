import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { Type } from "typebox";

import { createGate, type GateContext } from "./lib/gates/index.js";
import {
	buildSkillInjection,
	checkMissingRetrospects,
	DEFAULT_STATE,
	FINAL_PHASE,
	MAX_SLUG_LENGTH,
	MIN_SLUG_LENGTH,
	type PhaseConfig,
	type WorkflowState,
} from "./lib/helpers.js";
import { SkillResolver } from "./lib/skill-resolver.js";

// ─── Phase definitions ───────────────────────────────────

const PHASES: PhaseConfig[] = [
	{
		phase: 1, name: "Spec", skillName: "xyz-harness-brainstorming", gates: ["review-gate", "phase-gate"],
		reviewPrefix: "spec_review", retrospectPrefix: "spec_retrospect",
		deliverables: ["spec.md"], reviewMode: "Mode 1: Plan review (verify spec completeness)",
	},
	{
		phase: 2, name: "Plan", skillName: "xyz-harness-writing-plans", gates: ["review-gate", "phase-gate"],
		reviewPrefix: "plan_review", retrospectPrefix: "plan_retrospect",
		deliverables: ["plan.md", "e2e-test-plan.md", "test_cases_template.json", "use-cases.md", "non-functional-design.md"],
		reviewMode: "Mode 1: Plan review (verify plan feasibility)",
	},
	{
		phase: 3, name: "Dev", skillName: "xyz-harness-phase-dev", gates: ["review-gate", "phase-gate"],
		reviewPrefix: ["business_logic_review", "standards_review", "robustness_review", "integration_review", "ts_taste_review", "rust_taste_review", "taste_review"],
		retrospectPrefix: "dev_retrospect",
		deliverables: ["changes/evidence/test_results.md"],
		reviewMode: "Mode 2: Code review (verify implementation against spec)",
	},
	{
		phase: 4, name: "Test", skillName: "xyz-harness-phase-test", gates: ["test-fix-loop", "phase-gate"],
		reviewPrefix: "", retrospectPrefix: "test_retrospect",
		deliverables: ["changes/evidence/test_execution.json"],
		reviewMode: "Mode 3: Test review (verify test coverage and quality)",
	},
	{
		phase: 5, name: "PR", skillName: "xyz-harness-phase-pr", gates: ["phase-gate"],
		reviewPrefix: "pr_review", retrospectPrefix: "overall_retrospect",
		deliverables: ["changes/evidence/pr_evidence.md", "changes/evidence/ci_results.md"],
		reviewMode: "Code review (verify PR completeness and CI results)",
	},
];

// ─── State ───────────────────────────────────────────────

const MAX_GATE_RETRIES = 10;
const MAX_COMPACT_RETRIES = 3;

// ─── Extension entry ─────────────────────────────────────

function buildContextSummary(topicDir: string, phase: number): string {
	const parts: string[] = [];
	parts.push(`Phase ${phase} deliverables summary:`);

	const specPath = path.join(topicDir, "spec.md");
	if (fs.existsSync(specPath)) {
		const content = fs.readFileSync(specPath, "utf8");
		const title = content.match(/^#\s+(.+)$/m)?.[1] ?? "(no title)";
		parts.push(`- spec.md: ${title}`);
	}

	const planPath = path.join(topicDir, "plan.md");
	if (fs.existsSync(planPath)) {
		parts.push("- plan.md: Implementation plan");
	}

	const reviewsDir = path.join(topicDir, "changes", "reviews", `phase-${phase}`);
	if (fs.existsSync(reviewsDir)) {
		const files = fs.readdirSync(reviewsDir).filter((f) => f.endsWith(".md"));
		for (const file of files) {
			parts.push(`- ${file}`);
		}
	}

	return parts.join("\n");
}

export default function codingWorkflowExtension(pi: ExtensionAPI) {
	const state: WorkflowState = { ...DEFAULT_STATE };
	const activeSubprocesses: ChildProcess[] = [];
	const skillResolver = new SkillResolver(process.cwd(), import.meta.dirname);

	function persistState(): void {
		pi.appendEntry("coding-workflow", {
			isActive: state.isActive,
			currentPhase: state.currentPhase,
			topicDir: state.topicDir,
			topicName: state.topicName,
			phaseResults: state.phaseResults,
			pendingInit: state.pendingInit,
			pendingRequirement: state.pendingRequirement,
			gateRetryCount: state.gateRetryCount,
			compactRetryCount: state.compactRetryCount,
		});
	}

	// ── Tool: coding-workflow-gate ──────────────────────────

	pi.registerTool({
		name: "coding-workflow-gate",
		label: "Coding Workflow Gate",
		description: "Submit phase deliverables for gate check. Returns PASS or FAIL.",
		parameters: Type.Object({
			phase: Type.Number({ description: "The phase token shown in current instructions" }),
		}),
		async execute(_toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, _onUpdate: unknown, ctx: ExtensionContext) {
			const phase = (params.phase as number) ?? 0;

			if (!state.isActive) {
				return { content: [{ type: "text", text: "No active workflow." }], isError: true };
			}
			if (phase !== state.currentPhase) {
				return { content: [{ type: "text", text: "Wrong phase token." }], isError: true };
			}

			const phaseConfig = PHASES[phase - 1];
			if (!phaseConfig) {
				return { content: [{ type: "text", text: `Invalid phase: ${phase}` }], isError: true };
			}

			// Deploy standalone agents so AgentRegistry can discover them
			skillResolver.ensureOwnAgentsDeployed();

			// Execute gate chain
			for (const gateName of phaseConfig.gates) {
				const gate = await createGate(gateName);
				const gateCtx: GateContext = {
					phase,
					topicDir: state.topicDir,
					state,
					skillResolver,
					pi,
					ctx,
					signal,
				};

				const result = await gate.run(gateCtx);
				if (!result.passed) {
					return {
						content: [{ type: "text", text: `${gateName} FAILED: ${result.fixGuidance}` }],
						isError: true,
					};
				}
			}

			// All gates passed
			state.phaseResults[phase] = "passed";
			persistState();

			return {
				content: [{ type: "text", text: `Phase ${phase} gate PASSED. Call coding-workflow-phase-start() to proceed.` }],
			};
		},
	});

	// ── Tool: coding-workflow-init ────────────────────────────

	pi.registerTool({
		name: "coding-workflow-init",
		label: "Coding Workflow Init",
		description: "Initialize workflow with a generated slug.",
		parameters: Type.Object({
			slug: Type.String({ description: "Short English slug, lowercase, hyphen-separated, max 60 chars" }),
		}),
		async execute(_toolCallId: string, params: Record<string, unknown>, _signal: AbortSignal, _onUpdate: unknown, ctx: ExtensionContext) {
			const slug = String(params.slug ?? "").toLowerCase()
				.replace(/[^a-z0-9-]/g, "-")
				.replace(/-+/g, "-")
				.replace(/^-|-$/g, "")
				.slice(0, MAX_SLUG_LENGTH);

			if (!slug || slug.length < MIN_SLUG_LENGTH) {
				return { content: [{ type: "text", text: "Slug too short." }], isError: true };
			}

			const today = new Date().toISOString().slice(0, 10);
			const topicName = `${today}-${slug}`;
			const topicDir = path.join(process.cwd(), ".xyz-harness", topicName);

			if (fs.existsSync(topicDir)) {
				return { content: [{ type: "text", text: `Directory exists: ${topicDir}` }], isError: true };
			}

			fs.mkdirSync(path.join(topicDir, "changes", "reviews"), { recursive: true });
			fs.mkdirSync(path.join(topicDir, "changes", "evidence"), { recursive: true });

			state.isActive = true;
			state.currentPhase = 1;
			state.topicDir = topicDir;
			state.topicName = topicName;
			state.phaseResults = {};
			persistState();

			return { content: [{ type: "text", text: `Workflow initialized: ${topicName}\nWorkspace: ${topicDir}` }] };
		},
	});

	// ── Tool: coding-workflow-phase-start ──────────────────

	pi.registerTool({
		name: "coding-workflow-phase-start",
		label: "Coding Workflow Phase Start",
		description: "Proceed after gate check passes.",
		parameters: Type.Object({}),
		async execute(_toolCallId: string, _params: Record<string, unknown>, _signal: AbortSignal, _onUpdate: unknown, ctx: ExtensionContext) {
			if (!state.isActive) {
				return { content: [{ type: "text", text: "No active workflow." }], isError: true };
			}
			if (state.phaseResults[state.currentPhase] !== "passed") {
				return { content: [{ type: "text", text: `Gate not passed for phase ${state.currentPhase}.` }], isError: true };
			}

			// Check retrospects
			const missing = checkMissingRetrospects(PHASES, state.currentPhase, state.topicDir);
			if (missing.length > 0) {
				return {
					content: [{ type: "text", text: `Missing retrospects:\n${missing.join("\n")}` }],
					isError: true,
				};
			}

			state.currentPhase += 1;
			persistState();

			if (state.currentPhase > FINAL_PHASE) {
				state.isActive = false;
				state.currentPhase = 0;
				persistState();
				return { content: [{ type: "text", text: "Workflow complete." }] };
			}

			const nextPhaseConfig = PHASES[state.currentPhase - 1];

			// Goal 自动注入（Phase 2/3）
			if (state.currentPhase === 2) {
				const goalInit = (pi as unknown as Record<string, unknown>).__goalInit as ((objective: string, tasks: string[]) => boolean) | undefined;
				if (goalInit) {
					goalInit("Phase 2: 完成 plan 阶段交付物", [
						"Write plan.md (with Execution Groups)",
						"Write e2e-test-plan.md",
						"Write test_cases_template.json",
						"Write use-cases.md",
						"Write non-functional-design.md",
					]);
				}
			}

			if (state.currentPhase === 3) {
				// TODO: 从 plan.md 读取 Execution Groups 动态构建任务列表
				const goalInit = (pi as unknown as Record<string, unknown>).__goalInit as ((objective: string, tasks: string[]) => boolean) | undefined;
				if (goalInit) {
					goalInit("Phase 3: Dev 编码实现", [
						"TDD 测试编写",
						"Wave 1 编码",
						"Wave 2 编码（如有）",
						"运行全量测试 + 修复",
						"复跑测试（二次验证）",
						"再跑测试（稳定性检查）",
						"写 test_results.md + git commit + push",
					]);
				}
			}

			// Retrospect 上下文注入（Phase 1~N-1 的关键交付物摘要）
			if (state.currentPhase > 1) {
				const prevPhase = state.currentPhase - 1;
				const prevConfig = PHASES[prevPhase - 1];
				const retrospectPath = path.join(state.topicDir, "changes", "reviews", `${prevConfig.retrospectPrefix}.md`);
				if (!fs.existsSync(retrospectPath)) {
					// Build context summary for retrospect
					const contextSummary = buildContextSummary(state.topicDir, prevPhase);
					pi.sendUserMessage(
						`[RETROSPECT REQUIRED] Phase ${prevPhase} (${prevConfig.name}) gate passed.\n\n` +
						`Please write the retrospect to:\n${retrospectPath}\n\n` +
						`Context summary:\n${contextSummary}\n\n` +
						`After writing, call coding-workflow-phase-start() again.`,
						{ deliverAs: "steer" },
					);
				}
			}

			return {
				content: [{ type: "text", text: `Proceeding to Phase ${state.currentPhase}: ${nextPhaseConfig.name}` }],
			};
		},
	});
}
