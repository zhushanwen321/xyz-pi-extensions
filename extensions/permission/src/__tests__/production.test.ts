/**
 * production.test.ts — createProductionClassifier + createPipelineDeps 装配测试。
 *
 * getApiProvider 来自 pi-ai，测试时用真实 SDK（vitest alias 到 @earendil-works/pi-ai）。
 * 装配后验证：classifyRisk 可调（走 fallback 路径，无真实 provider 时返回 ask）、
 * deps 字段齐全、analyzeBashStructure/matchRulesForArgv/getDefaultRules 是真实实现。
 */
import { describe, expect, it } from "vitest";

import type { ApprovalContext } from "../approval.js";
import type { CheckPermissionDeps } from "../pipeline.js";
import { createPipelineDeps, createProductionClassifier } from "../production.js";

function makeApprovalCtx(): ApprovalContext {
	return {
		mode: "headless",
		ui: {
			notify() {},
			select() {
				return Promise.resolve(undefined);
			},
			custom() {
				return Promise.resolve(undefined);
			},
		},
	};
}

describe("createProductionClassifier", () => {
	it("返回带 classifyRisk 的对象", () => {
		const classifier = createProductionClassifier();
		expect(typeof classifier.classifyRisk).toBe("function");
	});

	it("classifyRisk 在无模型时 fail-closed 返回 ask（不 throw）", async () => {
		const classifier = createProductionClassifier();
		// 无 models.json 或无可用模型 → resolveModel 返回 null → fallback ask
		const result = await classifier.classifyRisk(
			{ toolName: "bash", command: "ls", cwd: "/tmp" },
			{ enabled: true, model: "auto", timeout: 5, autoApproveLowRisk: true, autoDenyHighRisk: true },
		);
		expect(result.outcome).toBe("ask");
		expect(result.risk_level).toBe("medium");
	});
});

describe("createPipelineDeps", () => {
	it("装配完整 CheckPermissionDeps（5 个字段齐全）", () => {
		const deps = createPipelineDeps(makeApprovalCtx());
		expect(deps).toBeInstanceOf(Object);
		expect(typeof deps.analyzeBashStructure).toBe("function");
		expect(typeof deps.matchRulesForArgv).toBe("function");
		expect(typeof deps.getDefaultRules).toBe("function");
		expect(typeof deps.classifier.classifyRisk).toBe("function");
		expect(typeof deps.requestUserApproval).toBe("function");
	});

	it("getDefaultRules 返回内置危险规则（12 条）", () => {
		const deps = createPipelineDeps(makeApprovalCtx());
		const rules = deps.getDefaultRules();
		expect(rules.length).toBe(12);
		expect(rules.every((r) => r.source === "builtin-danger")).toBe(true);
	});

	it("analyzeBashStructure 是真实实现（干净命令 → clean=true）", async () => {
		const deps = createPipelineDeps(makeApprovalCtx());
		const analysis = await deps.analyzeBashStructure("ls -la");
		expect(analysis.clean).toBe(true);
		expect(analysis.commands).toEqual([["ls", "-la"]]);
	});

	it("requestUserApproval 走 headless 分支（fail-closed deny）", async () => {
		const deps = createPipelineDeps(makeApprovalCtx());
		const decision = await deps.requestUserApproval(
			{ toolName: "bash", command: "rm", reason: "test" },
			{ toolName: "bash", command: "rm", cwd: "/tmp" },
			undefined,
		);
		expect(decision.approved).toBe(false);
		expect(decision.reason).toContain("headless");
	});

	it("deps 满足 CheckPermissionDeps 类型（结构兼容）", () => {
		const deps: CheckPermissionDeps = createPipelineDeps(makeApprovalCtx());
		// 仅验证类型兼容（运行时已在上面测试）
		expect(deps).toBeDefined();
	});
});
