/**
 * 规则匹配引擎（W3 层 2 核心入口）。
 *
 * 三个 critical gap 修正（design-review）：
 *
 *  ── G1: no-match 兜底语义 ──
 *  无匹配返回 `{ action: 'ask', matchedRule: undefined }`（非 'deny'）。
 *  deny 会让 auto 模式所有未匹配命令被拦截，无法到 AI 层。ask 让未匹配命令
 *  进入下游（auto 模式 → AI classifier；approve/strict 模式 → 人工审批）。
 *
 *  ── G2: pattern 双语义 ──
 *  source='builtin-danger' 的 pattern 是 RegExp 源字符串（含 `\b`/`\s`），
 *  用 `new RegExp(pattern, 'i')` 编译；其余（builtin-safe/user）是 OpenCode
 *  wildcard，用 `wildcardToRegExp(pattern)` 编译。resolvePattern 按 source 分发。
 *
 *  ── G3: 24+5 白名单用函数 ──
 *  matchRulesForArgv 先调 isKnownSafeCommand(argv)，命中返回 allow。
 *  白名单不进 Rule[] 数组（Codex flag 子检查无法用单条 wildcard 表达）。
 *
 * 匹配语义：last-match-wins（rules 数组顺序遍历，最后匹配的 rule 胜出）。
 * 拼接顺序由调用方（W5）负责：[...builtin-danger, ...userRules]。
 */

import type { Rule, RuleMatchResult } from "../types.js";
import { isKnownSafeCommand } from "./builtins.js";
import { wildcardToRegExp } from "./wildcard.js";

// ──────────────────────── pattern 缓存（module-level 状态）────────────────────────

/**
 * pattern → RegExp 缓存，key = `source + ':' + pattern`。
 *
 * 唯一的 module-level 可变状态（matcher 是纯函数，缓存为性能优化，不改变语义）。
 * 进程级生命周期，无需手动清理（pattern 集合有限且有界）。
 */
const patternCache = new Map<string, RegExp>();

/**
 * 把 rule.pattern 编译为 RegExp，按 source 分发（G2）。
 *
 *  - source='builtin-danger'：pattern 是 RegExp 源字符串 → `new RegExp(pattern, 'i')`
 *  - 其余（builtin-safe/user）：pattern 是 OpenCode wildcard → `wildcardToRegExp(pattern)`
 *
 * 结果缓存到 patternCache。
 */
export function resolvePattern(rule: Rule): RegExp {
	const cacheKey = rule.source + ":" + rule.pattern;
	const cached = patternCache.get(cacheKey);
	if (cached !== undefined) return cached;

	const re =
		rule.source === "builtin-danger"
			? new RegExp(rule.pattern, "i")
			: wildcardToRegExp(rule.pattern);

	patternCache.set(cacheKey, re);
	return re;
}

// ──────────────────────── matchRulesForArgv（happy path，W2 clean=true 有 argv[]）────────────────────────

/** 命中 isKnownSafeCommand 时构造的虚拟 builtin-safe rule（保持 matchedRule 字段一致性）。 */
function virtualSafeRule(argv0: string): Rule {
	return {
		id: "builtin-safe",
		tool: "bash",
		pattern: argv0,
		action: "allow",
		source: "builtin-safe",
		description: "known safe command (Codex safelist)",
	};
}

/**
 * 对已 tokenize 的 argv 做规则匹配（happy path）。
 *
 * 顺序：
 *  1. G3：isKnownSafeCommand(argv) → 命中返回 allow（虚拟 builtin-safe rule）
 *  2. 遍历 rules（last-match-wins），对每条用 resolvePattern(rule).test(argv.join(' '))
 *  3. G1：无匹配 → ask
 *
 * 匹配目标字符串统一为 `argv.join(' ')`（builtin-danger 正则与 user wildcard 都对它匹配）。
 */
export function matchRulesForArgv(argv: string[], rules: readonly Rule[]): RuleMatchResult {
	// G3：先查白名单（只对 argv 有效，命令名 + flag 子检查）
	if (argv.length > 0 && isKnownSafeCommand(argv)) {
		return { action: "allow", matchedRule: virtualSafeRule(argv[0] ?? "") };
	}

	if (argv.length === 0) {
		// 空命令无法匹配任何规则 → ask（G1）
		return { action: "ask", matchedRule: undefined };
	}

	const commandStr = argv.join(" ");

	let winner: RuleMatchResult = { action: "ask", matchedRule: undefined };
	for (const rule of rules) {
		const re = resolvePattern(rule);
		if (re.test(commandStr)) {
			winner = { action: rule.action, matchedRule: rule };
		}
	}
	return winner;
}

// ──────────────────────── matchRules（退化路径，command 字符串）────────────────────────

/**
 * 对原始 command 字符串做规则匹配（退化路径）。
 *
 * 适用场景：W2 AST 解析失败（parseError）或调用方只拿到 command 字符串
 * （无法可靠 tokenize argv）。
 *
 * 行为：
 *  - toolName !== 'bash' → ask（W3 只管 bash，其他工具交下游）
 *  - command === undefined / 空字符串 → ask
 *  - 遍历 rules（last-match-wins），对每条用 resolvePattern(rule).test(command)
 *  - 无匹配 → ask（G1）
 *
 * 不调 isKnownSafeCommand：command 字符串无法可靠提取 argv（含引号/转义/管道），
 * argv 级白名单判断由 matchRulesForArgv 在 happy path 负责。
 */
export function matchRules(
	toolName: string,
	command: string | undefined,
	rules: readonly Rule[],
): RuleMatchResult {
	if (toolName !== "bash") {
		return { action: "ask", matchedRule: undefined };
	}
	if (command === undefined || command === "") {
		return { action: "ask", matchedRule: undefined };
	}

	let winner: RuleMatchResult = { action: "ask", matchedRule: undefined };
	for (const rule of rules) {
		const re = resolvePattern(rule);
		if (re.test(command)) {
			winner = { action: rule.action, matchedRule: rule };
		}
	}
	return winner;
}
