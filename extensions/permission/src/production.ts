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

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - getApiProvider resolves via root tsconfig stub but per-package tsc paths differ
import { getApiProvider } from "@earendil-works/pi-ai";

import { type ApprovalContext, requestUserApproval } from "./approval.js";
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
 * 模块级 classifier 单例（m1 修正）。
 *
 * classifier 工厂返回 { classifyRisk }，本身无状态（classifyRisk 每次调用自包含所有输入），
 * 故模块级单例是安全的（不违反 session 隔离：不同 session 仅 config/rules 不同，classifyRisk 接收
 * 这些参数而非持有状态）。
 *
 * 采用惰性初始化（首次 createPipelineDeps 时创建）而非 import-time 副作用：
 *  - 避免模块加载时即创建 classifier（若 classifier 创建有副作用如读 models.json，import 时触发不直观）。
 *  - index.ts 的 processToolCall 每次 tool_call 都调 createPipelineDeps，惰性单例保证 classifier
 *    全进程只创建一次（修复原实现每次 tool_call 重建 classifier 的问题）。
 */
let classifierSingleton: { classifyRisk: ReturnType<typeof createClassifier>["classifyRisk"] } | undefined;

/**
 * 测试用：重置 classifier 单例（强制下次 createPipelineDeps 重建）。
 * @internal 仅测试使用，生产代码不应调用。
 */
export function _resetClassifierSingletonForTest(): void {
	classifierSingleton = undefined;
}

/**
 * 装配生产环境 CheckPermissionDeps。
 *
 * @param approvalCtx 从 ExtensionContext 提取的审批 UI 上下文（mode + ui.*）
 * @returns CheckPermissionDeps（AST + rules + classifier + approval 全部装配真实实现）
 *
 * 注：classifier 单例（m1：模块级惰性初始化，全进程只创建一次）。approvalCtx 每次 tool_call
 * 闭包捕获（保证 mode 切换后下次 tool_call 用新 mode —— 但 mode 在 session 内稳定，
 * 切换走 /permission 命令重载 config，approvalCtx.mode 反映运行时 mode）。
 */
export function createPipelineDeps(approvalCtx: ApprovalContext): CheckPermissionDeps {
	if (!classifierSingleton) {
		classifierSingleton = createProductionClassifier();
	}
	return {
		analyzeBashStructure,
		matchRulesForArgv,
		getDefaultRules,
		classifier: classifierSingleton,
		isHeadless: () => approvalCtx.mode !== "tui" && approvalCtx.mode !== "rpc",
		requestUserApproval: (req, ctx, signal) => requestUserApproval(req, ctx, signal, approvalCtx),
	};
}
