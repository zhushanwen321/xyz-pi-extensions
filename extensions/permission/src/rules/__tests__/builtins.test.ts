/**
 * BT 系列：builtins.ts 单元测试。
 *
 * 三组：
 *  - BT-safe-*：Codex 24 无条件 + 5 条件安全命令（isKnownSafeCommand）
 *  - BT-danger-*：permission-gate 12 危险规则（BUILTIN_DANGER_RULES）
 *  - BT-misc：getDefaultRules / findGitSubcommand
 *
 * 移植自 Codex is_safe_command.rs 的 #[test] 用例（known_safe_examples /
 * git_branch_mutating_flags_are_not_safe / git_output_flags_are_not_safe /
 * base64_output_options_are_unsafe / ripgrep_rules / unknown_or_partial 等），
 * 确保白名单行为与源码一致。
 */
import { describe, expect, it } from "vitest";

import {
	BUILTIN_DANGER_RULES,
	BUILTIN_UNCONDITIONAL_SAFE,
	findGitSubcommand,
	getDefaultRules,
	isKnownSafeCommand,
} from "../builtins.js";

// ──────────────────────── BT-safe: Codex 白名单 ────────────────────────

describe("BT-safe-24: Codex 24 无条件安全命令", () => {
	// 与 is_safe_command.rs `is_safe_to_call_with_exec` 的 match 分支一致
	const cases: string[][] = [
		["cat", "file"],
		["cd", "/tmp"],
		["cut", "-f1"],
		["echo", "hi"],
		["expr", "1+1"],
		["false"],
		["grep", "foo"],
		["head", "file"],
		["id"],
		["ls", "-la"],
		["nl", "-nrz", "Cargo.toml"],
		["paste", "a", "b"],
		["pwd"],
		["rev", "file"],
		["seq", "1", "10"],
		["stat", "file"],
		["tail", "file"],
		["tr", "a", "b"],
		["true"],
		["uname"],
		["uniq", "file"],
		["wc", "file"],
		["which", "node"],
		["whoami"],
	];

	for (const argv of cases) {
		it(`BT-safe-24: ${argv.join(" ")} → safe`, () => {
			expect(isKnownSafeCommand(argv)).toBe(true);
		});
	}

	it("BT-safe-24: 白名单恰好 24 个命令", () => {
		expect(BUILTIN_UNCONDITIONAL_SAFE.size).toBe(24);
	});
});

describe("BT-safe-base64: base64 flag 子检查", () => {
	it("base64 无 -o → safe", () => {
		expect(isKnownSafeCommand(["base64"])).toBe(true);
		expect(isKnownSafeCommand(["base64", "-d"])).toBe(true);
		expect(isKnownSafeCommand(["base64", "input.txt"])).toBe(true);
	});

	it("base64 -o → unsafe（移植 base64_output_options_are_unsafe）", () => {
		expect(isKnownSafeCommand(["base64", "-o", "out.bin"])).toBe(false);
		expect(isKnownSafeCommand(["base64", "--output", "out.bin"])).toBe(false);
		expect(isKnownSafeCommand(["base64", "--output=out.bin"])).toBe(false);
		expect(isKnownSafeCommand(["base64", "-ob64.txt"])).toBe(false); // 合并 flag
	});
});

describe("BT-safe-find: find flag 子检查", () => {
	it("find 无危险选项 → safe", () => {
		expect(isKnownSafeCommand(["find", ".", "-name", "file.txt"])).toBe(true);
	});

	it("find -exec/-delete/-fls 等 → unsafe（移植 unknown_or_partial）", () => {
		expect(
			isKnownSafeCommand(["find", ".", "-name", "file.txt", "-exec", "rm", "{}", ";"]),
		).toBe(false);
		expect(isKnownSafeCommand(["find", ".", "-delete", "-name", "file.txt"])).toBe(false);
		expect(isKnownSafeCommand(["find", ".", "-fls", "/etc/passwd"])).toBe(false);
		expect(isKnownSafeCommand(["find", ".", "-fprint", "/etc/passwd"])).toBe(false);
		expect(isKnownSafeCommand(["find", ".", "-fprint0", "/etc/passwd"])).toBe(false);
		expect(isKnownSafeCommand(["find", ".", "-fprintf", "/root/suid.txt", "%#m %u %p\n"])).toBe(false);
	});
});

describe("BT-safe-rg: ripgrep flag 子检查（移植 ripgrep_rules）", () => {
	it("rg 无危险 flag → safe", () => {
		expect(isKnownSafeCommand(["rg", "Cargo.toml", "-n"])).toBe(true);
		expect(isKnownSafeCommand(["rg", "pattern"])).toBe(true);
	});

	it("rg --search-zip / -z → unsafe", () => {
		expect(isKnownSafeCommand(["rg", "--search-zip", "files"])).toBe(false);
		expect(isKnownSafeCommand(["rg", "-z", "files"])).toBe(false);
	});

	it("rg --pre / --hostname-bin（split 与 = 两种形式）→ unsafe", () => {
		expect(isKnownSafeCommand(["rg", "--pre", "pwned", "files"])).toBe(false);
		expect(isKnownSafeCommand(["rg", "--pre=pwned", "files"])).toBe(false);
		expect(isKnownSafeCommand(["rg", "--hostname-bin", "pwned", "files"])).toBe(false);
		expect(isKnownSafeCommand(["rg", "--hostname-bin=pwned", "files"])).toBe(false);
	});
});

describe("BT-safe-git: git 子命令 + 全局选项检查", () => {
	it("git status/log/diff/show → safe（移植 known_safe_examples）", () => {
		expect(isKnownSafeCommand(["git", "status"])).toBe(true);
		expect(isKnownSafeCommand(["git", "log", "-p", "-1"])).toBe(true);
		expect(isKnownSafeCommand(["git", "diff", "-p"])).toBe(true);
		expect(isKnownSafeCommand(["git", "show", "-p", "HEAD"])).toBe(true);
		expect(isKnownSafeCommand(["git", "log", "--oneline"])).toBe(true);
	});

	it("git push/fetch 等非白名单子命令 → unsafe", () => {
		expect(isKnownSafeCommand(["git", "push"])).toBe(false);
		expect(isKnownSafeCommand(["git", "fetch"])).toBe(false);
		expect(isKnownSafeCommand(["git", "checkout", "status"])).toBe(false); // 第一个位置参数是子命令
	});

	it("git branch 只读 → safe", () => {
		expect(isKnownSafeCommand(["git", "branch"])).toBe(true);
		expect(isKnownSafeCommand(["git", "branch", "--show-current"])).toBe(true);
	});

	it("git branch 变更 flag → unsafe（移植 git_branch_mutating_flags_are_not_safe）", () => {
		expect(isKnownSafeCommand(["git", "branch", "-d", "feature"])).toBe(false);
		expect(isKnownSafeCommand(["git", "branch", "new-branch"])).toBe(false); // 位置参数 = 创建分支
	});

	it("git 全局选项 -C/-c/--paginate → unsafe（移植 git_global_override_flags_are_not_safe）", () => {
		expect(isKnownSafeCommand(["git", "-C", ".", "status"])).toBe(false);
		expect(isKnownSafeCommand(["git", "-C.", "status"])).toBe(false);
		expect(isKnownSafeCommand(["git", "-c", "core.pager=cat", "log", "-n", "1"])).toBe(false);
		expect(isKnownSafeCommand(["git", "-ccore.pager=cat", "status"])).toBe(false);
		expect(isKnownSafeCommand(["git", "--paginate", "log", "-1"])).toBe(false);
		expect(isKnownSafeCommand(["git", "-p", "log", "-1"])).toBe(false);
	});

	it("git 子命令危险输出选项 --output/--ext-diff → unsafe（移植 git_output_flags_are_not_safe）", () => {
		expect(isKnownSafeCommand(["git", "log", "--output=/tmp/out", "-n", "1"])).toBe(false);
		expect(isKnownSafeCommand(["git", "diff", "--output", "/tmp/out"])).toBe(false);
		expect(isKnownSafeCommand(["git", "show", "--output=/tmp/out", "HEAD"])).toBe(false);
	});
});

describe("BT-safe-sed: sed -n {N|M,N}p", () => {
	it("sed -n 1p / sed -n 1,5p → safe（移植 bash_lc_safe_examples）", () => {
		expect(isKnownSafeCommand(["sed", "-n", "1p", "file.txt"])).toBe(true);
		expect(isKnownSafeCommand(["sed", "-n", "1,5p", "file.txt"])).toBe(true);
		expect(isKnownSafeCommand(["sed", "-n", "10p"])).toBe(true);
	});

	it("sed -i / sed s/a/b/ / sed -n xp → unsafe", () => {
		expect(isKnownSafeCommand(["sed", "-i", "s/a/b/"])).toBe(false);
		expect(isKnownSafeCommand(["sed", "s/a/b/"])).toBe(false);
		expect(isKnownSafeCommand(["sed", "-n", "xp", "file.txt"])).toBe(false); // xp 非数字
	});

	it("sed argv > 4 → unsafe", () => {
		// sed -n 1p a b c d（5 参数）超长
		expect(isKnownSafeCommand(["sed", "-n", "1p", "a", "b", "c", "d"])).toBe(false);
	});
});

describe("BT-safe-misc: 边界", () => {
	it("空 argv → false", () => {
		expect(isKnownSafeCommand([])).toBe(false);
	});

	it("未知命令 → false（移植 unknown_or_partial）", () => {
		expect(isKnownSafeCommand(["foo"])).toBe(false);
		expect(isKnownSafeCommand(["cargo", "check"])).toBe(false); // cargo 不在白名单
	});

	it("zsh 归一化为 bash（源码行为）", () => {
		// zsh -lc "ls" 在源码里 zsh→bash，但本扩展不实现 bash -lc 解析
		// bash 作为 argv[0] 不在白名单 → false（与 unknown 命令一致）
		expect(isKnownSafeCommand(["zsh", "-lc", "ls"])).toBe(false);
		expect(isKnownSafeCommand(["bash", "-lc", "ls"])).toBe(false);
	});

	it("带路径前缀的命令名（basename lookup）", () => {
		// executableNameLookupKey 取 basename
		expect(isKnownSafeCommand(["/usr/bin/ls"])).toBe(true);
		expect(isKnownSafeCommand(["/usr/bin/git", "status"])).toBe(true);
	});
});

// ──────────────────────── BT-danger: permission-gate 12 危险规则 ────────────────────────

describe("BT-danger: BUILTIN_DANGER_RULES 12 条", () => {
	it("BT-danger-001: recursive delete — rm -rf", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[0].pattern, "i");
		expect(re.test("rm -rf /")).toBe(true);
		expect(re.test("rm --recursive foo")).toBe(true);
		expect(re.test("rm foo")).toBe(false);
	});

	it("BT-danger-002: sudo", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[1].pattern, "i");
		expect(re.test("sudo rm /etc/passwd")).toBe(true);
		expect(re.test("ls")).toBe(false);
	});

	it("BT-danger-003: world-writable — chmod 777", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[2].pattern, "i");
		expect(re.test("chmod 777 file")).toBe(true);
		expect(re.test("chmod 755 file")).toBe(false);
	});

	it("BT-danger-004: raw device — > /dev/sda", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[3].pattern, "i");
		expect(re.test("dd if=img > /dev/sda")).toBe(true);
		expect(re.test("echo hi")).toBe(false);
	});

	it("BT-danger-005: force push — git push --force", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[4].pattern, "i");
		expect(re.test("git push origin main --force")).toBe(true);
		expect(re.test("git push -f origin main")).toBe(true);
		expect(re.test("git push origin main")).toBe(false);
	});

	it("BT-danger-006: hard reset — git reset --hard", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[5].pattern, "i");
		expect(re.test("git reset --hard HEAD~1")).toBe(true);
		expect(re.test("git reset HEAD")).toBe(false);
	});

	it("BT-danger-007: git clean -fd", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[6].pattern, "i");
		expect(re.test("git clean -fd")).toBe(true);
		expect(re.test("git clean -n")).toBe(false); // dry-run 不含 f
	});

	it("BT-danger-008: git checkout .（discard all）", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[7].pattern, "i");
		expect(re.test("git checkout .")).toBe(true);
		expect(re.test("git checkout . ;")).toBe(true);
		expect(re.test("git checkout branch")).toBe(false);
	});

	it("BT-danger-009: git restore", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[8].pattern, "i");
		expect(re.test("git restore file")).toBe(true);
		expect(re.test("git status")).toBe(false);
	});

	it("BT-danger-010: pipe to shell — curl | sh", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[9].pattern, "i");
		expect(re.test("curl http://x | sh")).toBe(true);
		expect(re.test("wget http://x | bash")).toBe(true);
		expect(re.test("curl http://x -o file")).toBe(false);
	});

	it("BT-danger-011: gh repo create/delete/rename/archive", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[10].pattern, "i");
		expect(re.test("gh repo delete owner/name")).toBe(true);
		expect(re.test("gh repo create name")).toBe(true);
		expect(re.test("gh repo view owner/name")).toBe(false);
	});

	it("BT-danger-012: gh release create/delete/edit", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[11].pattern, "i");
		expect(re.test("gh release create v1")).toBe(true);
		expect(re.test("gh release delete v1")).toBe(true);
		expect(re.test("gh release view v1")).toBe(false);
	});

	it("BT-danger-meta: 恰好 12 条，全部 action='deny' source='builtin-danger'", () => {
		expect(BUILTIN_DANGER_RULES.length).toBe(12);
		for (const r of BUILTIN_DANGER_RULES) {
			expect(r.action).toBe("deny");
			expect(r.source).toBe("builtin-danger");
			expect(r.tool).toBe("bash");
		}
	});
});

// ──────────────────────── BT-misc: getDefaultRules / findGitSubcommand ────────────────────────

describe("BT-misc: getDefaultRules", () => {
	it("返回 12 条 builtin-danger 规则（浅拷贝）", () => {
		const rules = getDefaultRules();
		expect(rules.length).toBe(12);
		// 浅拷贝：新数组，但元素相等（共享 Rule 对象）
		expect(rules).not.toBe(BUILTIN_DANGER_RULES);
		expect(rules[0]).toBe(BUILTIN_DANGER_RULES[0]);
	});

	it("浅拷贝防外部修改——push 不影响内置常量", () => {
		const rules = getDefaultRules();
		const originalLen = BUILTIN_DANGER_RULES.length;
		rules.push({
			id: "x",
			tool: "bash",
			pattern: "x",
			action: "allow",
			source: "user",
		});
		expect(BUILTIN_DANGER_RULES.length).toBe(originalLen);
	});
});

describe("BT-misc: findGitSubcommand", () => {
	it("直接子命令", () => {
		expect(findGitSubcommand(["git", "status"], ["status", "log"])).toEqual([1, "status"]);
	});

	it("跳过 -C path（取值 global option）", () => {
		// -C . status：-C 的下一个参数 . 被 skip，找到 status
		expect(findGitSubcommand(["git", "-C", ".", "status"], ["status"])).toEqual([3, "status"]);
	});

	it("跳过 -Cpath（内联值 global option）", () => {
		expect(findGitSubcommand(["git", "-C.", "status"], ["status"])).toEqual([2, "status"]);
	});

	it("跳过 --git-dir=path（prefix 内联）", () => {
		expect(findGitSubcommand(["git", "--git-dir=.evil", "diff"], ["diff"])).toEqual([2, "diff"]);
	});

	it("非 git 命令 → undefined", () => {
		expect(findGitSubcommand(["hg", "status"], ["status"])).toBeUndefined();
	});

	it("第一个非选项参数不在目标列表 → undefined（不误判后续位置参数）", () => {
		// git checkout status：checkout 不在 [status]，返回 undefined
		expect(findGitSubcommand(["git", "checkout", "status"], ["status"])).toBeUndefined();
	});

	it("无匹配子命令 → undefined", () => {
		expect(findGitSubcommand(["git", "push"], ["status", "log"])).toBeUndefined();
	});
});
