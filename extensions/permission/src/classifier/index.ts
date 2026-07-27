/**
 * AI Classifier barrel（层 3 入口）
 *
 * 对外暴露 createClassifier + ClassifierDeps + prompt/json-parser/model-resolver 辅助 API。
 * ClassifierResult / ClassifierConfig / ToolInvocationContext 从 ../types.js re-export，
 * 单一类型来源（types.ts）。
 */

export type { ClassifierDeps } from "./classifier.js";
export { createClassifier } from "./classifier.js";
export { PARSE_FALLBACK_RESULT,parseClassifierResponse } from "./json-parser.js";
export type { ResolvedModel, ResolvedModelEntry } from "./model-resolver.js";
export {
	agentDir,
	findCheapestModel,
	flattenModels,
	loadModelsJson,
	resolveClassifierModel,
} from "./model-resolver.js";
export { buildClassifierUserPrompt,CLASSIFIER_SYSTEM_PROMPT } from "./prompt.js";

// 类型 re-export（单一来源：types.ts）
export type {
	ClassifierConfig,
	ClassifierResult,
	RiskLevel,
	ToolInvocationContext,
} from "../types.js";
