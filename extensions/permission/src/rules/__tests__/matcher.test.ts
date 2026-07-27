/**
 * MT 系列：matcher.ts 单元测试。
 *
 * 重点验证三个 critical gap 修正：
 *  - G1：no-match → { action:'ask' }（非 deny）
 *  - G2：pattern 双语义（builtin-danger 正则 vs user wildcard）
 *  - G3：matchRulesForArgv 先调 isKnownSafeCommand
 *
 * 以及 last-match-wins 语义、matchRules 退化路径、pattern 缓存。
 */
import { describe, expect, it } from "vitest";

import type { Rule } from "../../types.js";
import {
	BUILTIN_DANGER_RULES,
	getDefaultRules,
	matchRules,
	matchRulesForArgv,
	resolvePattern,
} from "../index.js";

// 构造 user 规则的辅助
function userRule(id: string, pattern: string, action: Rule["action"] = "allow"): Rule {
	return { id, tool: "bash", pattern, action, source: "user" };
}

// ──────────────────────── G1: no-match 兜底 ────────────────────────

describe("MT-G1: no-match 返回 ask（非 deny）", () => {
	it("matchRulesForArgv 无匹配 → ask", () => {
		// 注意：ls 在 Codex 24 白名单会先命中 G3 → allow，故用非白名单命令 npm
		const rules: Rule[] = [userRule("u1", "docker *")]; // 不匹配 npm
		const r = matchRulesForArgv(["npm", "install"], rules);
		expect(r.action).toBe("ask");
		expect(r.matchedRule).toBeUndefined();
	});

	it("matchRules 无匹配 → ask", () => {
		const rules: Rule[] = [userRule("u1", "npm *")];
		const r = matchRules("bash", "ls", rules);
		expect(r.action).toBe("ask");
		expect(r.matchedRule).toBeUndefined();
	});

	it("空 rules 数组 → ask", () => {
		const r = matchRulesForArgv(["rm", "-rf", "/"], []);
		expect(r.action).toBe("ask");
	});
});

// ──────────────────────── G2: pattern 双语义 ────────────────────────

describe("MT-G2: pattern 双语义（builtin-danger 正则 vs user wildcard）", () => {
	it("builtin-danger pattern 是 RegExp（含 \\b/\\s）—— 作为正则编译", () => {
		const rule = BUILTIN_DANGER_RULES[0]; // \brm\s+(-[^\s]*r|--recursive)
		const re = resolvePattern(rule);
		// 正则语义：rm -rf 匹配
		expect(re.test("rm -rf /")).toBe(true);
		expect(re.test("rm foo")).toBe(false);
	});

	it("user pattern 是 wildcard —— `.` 被转义为字面点", () => {
		const rule = userRule("u1", "file.txt");
		const re = resolvePattern(rule);
		// wildcard 语义：. 是字面点，不是任意字符
		expect(re.test("file.txt")).toBe(true);
		expect(re.test("fileXtxt")).toBe(false);
	});

	it("两条 rm 规则：builtin-danger 正则 vs user wildcard `rm *`", () => {
		const builtinRm = BUILTIN_DANGER_RULES[0]; // 正则 \brm\s+(-[^\s]*r|--recursive)
		const userRm = userRule("u1", "rm *", "allow"); // wildcard

		// 正则匹配 rm -rf
		expect(resolvePattern(builtinRm).test("rm -rf /")).toBe(true);
		// wildcard `rm *` 也匹配 rm -rf /
		expect(resolvePattern(userRm).test("rm -rf /")).toBe(true);
		// 但 wildcard `rm *` 不匹配 `rm`（末尾 ` *` 改写后匹配无参）—— 实际匹配
		expect(resolvePattern(userRm).test("rm")).toBe(true);
		// 正则 \brm\s+... 不匹配裸 rm（需要 \s+）
		expect(resolvePattern(builtinRm).test("rm")).toBe(false);
	});
});

// ──────────────────────── G3: isKnownSafeCommand 命中返回 allow ────────────────────────

describe("MT-G3: matchRulesForArgv 先调 isKnownSafeCommand", () => {
	it("ls 命中白名单 → allow（即使 rules 里有 deny）", () => {
		// 假设用户加了一条 deny `ls *`，但白名单优先
		const rules: Rule[] = [userRule("u1", "ls *", "deny")];
		const r = matchRulesForArgv(["ls", "-la"], rules);
		expect(r.action).toBe("allow");
		expect(r.matchedRule?.source).toBe("builtin-safe");
	});

	it("git status 命中白名单 → allow", () => {
		const rules: Rule[] = BUILTIN_DANGER_RULES.slice(); // 无匹配的 danger
		const r = matchRulesForArgv(["git", "status"], rules);
		expect(r.action).toBe("allow");
	});

	it("matchRules（退化路径）不调 isKnownSafeCommand —— command 字符串", () => {
		// matchRules 不查白名单，直接对 command 字符串做正则/wildcard 匹配
		const r = matchRules("bash", "ls -la", []);
		expect(r.action).toBe("ask"); // 无规则匹配 → ask（不查白名单）
	});

	it("空 argv → ask（G3 不命中，无规则）", () => {
		const r = matchRulesForArgv([], []);
		expect(r.action).toBe("ask");
	});
});

// ──────────────────────── last-match-wins ────────────────────────

describe("MT-last-match-wins: 后匹配的规则胜出", () => {
	it("两条规则都匹配，后一条赢", () => {
		const rules: Rule[] = [
			userRule("u1", "git *", "deny"),
			userRule("u2", "git *", "allow"), // 后一条
		];
		const r = matchRulesForArgv(["nonexistent-cmd"], rules);
		// 注意：nonexistent-cmd 不在白名单，且不匹配 git *
		expect(r.action).toBe("ask");

		// 用匹配的命令
		const r2 = matchRulesForArgv(["npm", "install"], [
			userRule("u1", "npm *", "deny"),
			userRule("u2", "npm *", "allow"),
		]);
		expect(r2.action).toBe("allow");
		expect(r2.matchedRule?.id).toBe("u2");
	});

	it("user allow 覆盖 builtin-danger deny（user 在数组后）", () => {
		const rules: Rule[] = [
			...getDefaultRules(), // builtin-danger 在前
			userRule("u1", "rm *", "allow"), // user 在后，覆盖
		];
		// rm foo 不在白名单，rm * 匹配，user allow 后置 → allow
		// 但 rm -rf 会被 builtin-danger bd-001 匹配（deny），user rm * 也匹配（allow）
		// last-match-wins → user 在后 → allow
		const r = matchRulesForArgv(["rm", "-rf", "/tmp/x"], rules);
		expect(r.action).toBe("allow");
		expect(r.matchedRule?.id).toBe("u1");
	});

	it("user deny 在 builtin-danger 之后 → deny", () => {
		// ls 不在白名单？错——ls 在 Codex 24 白名单
		// 所以 ls 命中 G3 → allow，不到 rules
		// 用非白名单命令验证 user deny
		const r = matchRulesForArgv(["npm", "install"], [
			userRule("u1", "npm *", "allow"),
			userRule("u2", "npm *", "deny"), // 后置 deny 赢
		]);
		expect(r.action).toBe("deny");
	});
});

// ──────────────────────── matchRules 退化路径 ────────────────────────

describe("MT-matchRules: 退化路径（command 字符串）", () => {
	it("toolName !== 'bash' → ask", () => {
		const r = matchRules("edit", "rm -rf /", getDefaultRules());
		expect(r.action).toBe("ask");
	});

	it("command === undefined → ask", () => {
		const r = matchRules("bash", undefined, getDefaultRules());
		expect(r.action).toBe("ask");
	});

	it("command 空字符串 → ask", () => {
		const r = matchRules("bash", "", getDefaultRules());
		expect(r.action).toBe("ask");
	});

	it("command 命中 builtin-danger 正则 → deny", () => {
		const r = matchRules("bash", "rm -rf /", getDefaultRules());
		expect(r.action).toBe("deny");
		expect(r.matchedRule?.id).toBe("bd-001");
	});

	it("command 命中 user wildcard → allow", () => {
		const rules: Rule[] = [userRule("u1", "ls *", "allow")];
		const r = matchRules("bash", "ls -la", rules);
		expect(r.action).toBe("allow");
	});
});

// ──────────────────────── 缓存 ────────────────────────

describe("MT-cache: resolvePattern 缓存", () => {
	it("相同 source+pattern 返回同一 RegExp 实例", () => {
		const rule = userRule("u1", "git *");
		const re1 = resolvePattern(rule);
		const re2 = resolvePattern(rule);
		expect(re1).toBe(re2); // 缓存命中，同一对象
	});

	it("不同 pattern 返回不同 RegExp", () => {
		const re1 = resolvePattern(userRule("u1", "git *"));
		const re2 = resolvePattern(userRule("u2", "npm *"));
		expect(re1).not.toBe(re2);
	});

	it("相同 pattern 不同 source 返回不同 RegExp（builtin-danger 正则 vs user wildcard）", () => {
		const builtinRule: Rule = {
			id: "bd-test",
			tool: "bash",
			pattern: "rm *",
			action: "deny",
			source: "builtin-danger",
		};
		const userR = userRule("u1", "rm *");
		// 同 pattern "rm *" 但 source 不同
		expect(resolvePattern(builtinRule)).not.toBe(resolvePattern(userR));
	});
});
