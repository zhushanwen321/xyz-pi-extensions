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
import { _resetClassifierSingletonForTest, createPipelineDeps, createProductionClassifier } from "../production.js";

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
		// 用不存在的 provider/model 规格强制 resolveClassifierModel 返回 null → fallback ask。
		// （真实环境磁盘存在带 apiKey 的 models.json，model:"auto" 会解析到真实模型并调用 LLM，
		//   无法稳定走 fail-closed 路径，故用 bogus spec 确保无可用模型。）
		const result = await classifier.classifyRisk(
			{ toolName: "bash", command: "ls", cwd: "/tmp" },
			{ enabled: true, model: "nonexistent-provider/no-such-model", timeout: 5, autoApproveLowRisk: false, autoDenyHighRisk: true },
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

	it("requestUserApproval 走 headless 分支（M1：signal abort → fail-closed deny）", async () => {
		const deps = createPipelineDeps(makeApprovalCtx());
		// M1：headless 无 signal 时永挂，故用已 aborted 的 signal 触发 fail-closed deny。
		const controller = new AbortController();
		controller.abort();
		const decision = await deps.requestUserApproval(
			{ toolName: "bash", command: "rm", reason: "test" },
			{ toolName: "bash", command: "rm", cwd: "/tmp" },
			controller.signal,
		);
		expect(decision.approved).toBe(false);
		expect(decision.reason).toContain("headless");
	});

	it("deps 满足 CheckPermissionDeps 类型（结构兼容）", () => {
		const deps: CheckPermissionDeps = createPipelineDeps(makeApprovalCtx());
		// 仅验证类型兼容（运行时已在上面测试）
		expect(deps).toBeDefined();
	});

	it("m1：多次 createPipelineDeps 复用同一 classifier 单例", () => {
		_resetClassifierSingletonForTest();
		const deps1 = createPipelineDeps(makeApprovalCtx());
		const deps2 = createPipelineDeps(makeApprovalCtx());
		// classifier 是单例，两次装配应引用同一对象（classifyRisk 引用相同）
		expect(deps1.classifier).toBe(deps2.classifier);
		expect(deps1.classifier.classifyRisk).toBe(deps2.classifier.classifyRisk);
	});
});
