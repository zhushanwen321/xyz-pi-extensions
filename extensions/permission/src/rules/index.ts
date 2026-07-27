/**
 * rules 模块 barrel —— 只 re-export 公开 API。
 *
 * 公开 surface（供 W5/调用方使用）：
 *  - matchRules / matchRulesForArgv：规则匹配入口
 *  - getDefaultRules：内置危险规则（12 条）
 *  - isKnownSafeCommand：Codex 白名单判断（W5 可能直接用）
 *  - wildcardToRegExp：wildcard 编译（测试用）
 *  - findGitSubcommand：git 子命令提取（测试用）
 *
 * 类型从 ../types.js re-export（Rule / RuleMatchResult / PermissionAction 等）。
 */
export type {
	PermissionAction,
	Rule,
	RuleMatchResult,
	RuleSource,
} from "../types.js";
export {
	BUILTIN_DANGER_RULES,
	BUILTIN_UNCONDITIONAL_SAFE,
	findGitSubcommand,
	getDefaultRules,
	isKnownSafeCommand,
} from "./builtins.js";
export { matchRules, matchRulesForArgv, resolvePattern } from "./matcher.js";
export { wildcardToRegExp } from "./wildcard.js";
