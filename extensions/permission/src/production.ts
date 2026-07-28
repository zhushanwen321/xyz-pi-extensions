/**
 * 生产装配层（W5 集成层）。
 *
 * 把 W2/W3/W4 的真实实现 + W5 的 pipeline/approval 装配成 CheckPermissionDeps，
 * 供 index.ts 的 tool_call handler 使用。
 *
 *  - createProductionClassifier：移植 pi-permission-system ai-classifier.ts:315-331。
 *    用 getApiProvider 解析 provider → streamSimple，注入 createClassifier。
 *  - createPipelineDeps：装配完整 CheckPermissionDeps（AST + rules + classifier + approval）。
 *
 * 设计：装配函数接受 ApprovalContext（从 ExtensionContext 提取），不直接依赖完整
 * ExtensionContext 类型，便于测试 + 解耦。
 */

import { getApiProvider } from "@earendil-works/pi-ai";

import { type ApprovalContext,requestUserApproval } from "./approval.js";
import { analyzeBashStructure } from "./ast/index.js";
import { createClassifier } from "./classifier/index.js";
import { resolveClassifierModel } from "./classifier/index.js";
import type { CheckPermissionDeps } from "./pipeline.js";
import { getDefaultRules, matchRulesForArgv } from "./rules/index.js";
import type { ClassifierConfig } from "./types.js";

// ──────────────────────── createProductionClassifier ────────────────────────

/**
 * 创建生产环境 AI Classifier（移植 pi-permission-system ai-classifier.ts:315-331）。
 *
 * 流程：
 *  - resolveModel：用 resolveClassifierModel 把 ClassifierConfig.model 解析为 ResolvedModel。
 *  - streamSimple：用 getApiProvider(model.api) 拿 provider，调 provider.streamSimple。
 *    无 provider → throw（caller 捕获转 fallback，但 classifier 内部已 try/catch streamSimple）。
 *  - onLog：console.warn（生产日志）。
 *
 * 返回 createClassifier 的结果（{ classifyRisk }）。
 */
export function createProductionClassifier(): {
	classifyRisk: ReturnType<typeof createClassifier>["classifyRisk"];
} {
	return createClassifier({
		resolveModel: (config: ClassifierConfig) => resolveClassifierModel(config.model),
		streamSimple: (model, context, options) => {
			const provider = getApiProvider(model.api);
			if (!provider) {
				throw new Error(`[pi-permission] No API provider registered for api: ${model.api}`);
			}
			return provider.streamSimple(model, context, options);
		},
		onLog: (msg: string) => console.warn(msg),
	});
}

// ──────────────────────── createPipelineDeps ────────────────────────

/**
 * 装配生产环境 CheckPermissionDeps。
 *
 * @param approvalCtx 从 ExtensionContext 提取的审批 UI 上下文（mode + ui.*）
 * @returns CheckPermissionDeps（AST + rules + classifier + approval 全部装配真实实现）
 *
 * 注：classifier 单例（createProductionClassifier 只调一次），approvalCtx 每次 tool_call
 * 闭包捕获（保证 mode 切换后下次 tool_call 用新 mode —— 但 mode 在 session 内稳定，
 * 切换走 /permission 命令重载 config，approvalCtx.mode 反映运行时 mode）。
 */
export function createPipelineDeps(approvalCtx: ApprovalContext): CheckPermissionDeps {
	const classifier = createProductionClassifier();
	return {
		analyzeBashStructure,
		matchRulesForArgv,
		getDefaultRules,
		classifier,
		requestUserApproval: (req, ctx, signal) => requestUserApproval(req, ctx, signal, approvalCtx),
	};
}
