/**
 * analyzeBashStructure — bash 命令结构分析（层 1 AST 安全门）。
 *
 * 忠实移植自 Codex `codex-rs/shell-command/src/bash.rs` 的
 * `try_parse_word_only_commands_sequence` + `parse_plain_command_from_node`。
 *
 * 判定规则（与 Codex 一致）：
 *  - ALLOWED_KINDS（11 个 named node）：program/list/pipeline/command/command_name/
 *    word/string/string_content/raw_string/number/concatenation
 *  - ALLOWED_PUNCT_TOKENS（6 个 anonymous token）：'&&' '||' ';' '|' '"' "'"
 *  - root.hasError → 解析失败
 *  - 任何非白名单 named node → 危险（command_substitution/file_redirect/subshell 等）
 *  - 任何非白名单 anonymous token（且非空白）→ 危险（括号/反引号/重定向符等）
 *  - command 节点的 named children 必须全部能被 parsePlainCommand 提取（5 分支），
 *    任一分支返回 null → 该 command 跳过（但 dangerousStructures 已收集，clean 已置 false）
 *
 * 降级策略（fail-closed）：wasm 加载失败 / parse 异常 / root.hasError / 超长 →
 *  返回 { clean:false, commands:[], dangerousStructures:[...], parseError:true }，永不 throw。
 */

import type { Node, Tree } from "web-tree-sitter";

import type { BashAnalysis } from "../types.js";
import { getBashParser } from "./loader.js";

/** 超过此长度的输入直接拒（防止 wasm 解析巨型 payload DoS）。 */
const MAX_COMMAND_LENGTH = 65536;

/**
 * Codex ALLOWED_KINDS（11 个 named node）。
 * 遇到不在此集合的 named node 即判定为危险结构。
 */
const ALLOWED_KINDS = new Set([
	"program",
	"list",
	"pipeline",
	"command",
	"command_name",
	"word",
	"string",
	"string_content",
	"raw_string",
	"number",
	"concatenation",
]);

/**
 * Codex ALLOWED_PUNCT_TOKENS（6 个 anonymous operator/quote token）。
 * 遇到不在此集合且含 &;| 的 operator token，或任何非空白 anonymous token，即判定为危险。
 */
const ALLOWED_PUNCT_TOKENS = new Set(["&&", "||", ";", "|", '"', "'"]);

/** 检查 anonymous token 是否含 & ; | 中任一字符（与 Rust `kind.chars().any(...)` 等价）。 */
function hasControlOperatorChar(kind: string): boolean {
	return kind.includes("&") || kind.includes(";") || kind.includes("|");
}

/**
 * 解析双引号字符串（对应 Rust parse_double_quoted_string）。
 *
 * 规则：string 的 named children 必须全部是 string_content；
 * 若含 ${VAR}/$VAR/$(...) 会变成 simple_expansion/command_substitution（非 string_content），
 * 返回 null。通过后，返回去掉首尾双引号的文本。
 */
function parseDoubleQuotedString(node: Node): string | null {
	if (node.type !== "string") {
		return null;
	}
	for (const child of node.namedChildren) {
		if (child.type !== "string_content") {
			return null;
		}
	}
	const raw = node.text;
	// 去掉首尾的 `"`（raw 形如 `"hello world"`）
	if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
		return raw.slice(1, -1);
	}
	// 异常 grammar（理论上不会到这）—— 原样返回
	return raw;
}

/**
 * 解析单引号字符串（对应 Rust parse_raw_string）。
 * 去掉首尾的 `'`。
 */
function parseRawString(node: Node): string | null {
	if (node.type !== "raw_string") {
		return null;
	}
	const raw = node.text;
	if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
		return raw.slice(1, -1);
	}
	return raw;
}

/**
 * 从一个 command 节点提取 argv（对应 Rust parse_plain_command_from_node）。
 *
 * 5 分支处理 named children：
 *  1. command_name → 其第一个 named child 必须是 word，取文本
 *  2. word | number → 直接取文本
 *  3. string → parseDoubleQuotedString（含 expansion 则 null）
 *  4. raw_string → parseRawString
 *  5. concatenation（如 -g"*.py"）→ 递归拼接各 part（word/number/string/raw_string）
 *
 * 任一分支失败 → 返回 null（该 command 被跳过，但 clean 已在 DFS 阶段被置 false）。
 */
function parsePlainCommand(cmd: Node): string[] | null {
	if (cmd.type !== "command") {
		return null;
	}

	const words: string[] = [];
	for (const child of cmd.namedChildren) {
		switch (child.type) {
			case "command_name": {
				const wordNode = child.namedChild(0);
				if (!wordNode || wordNode.type !== "word") {
					return null;
				}
				words.push(wordNode.text);
				break;
			}
			case "word":
			case "number": {
				words.push(child.text);
				break;
			}
			case "string": {
				const parsed = parseDoubleQuotedString(child);
				if (parsed === null) {
					return null;
				}
				words.push(parsed);
				break;
			}
			case "raw_string": {
				const parsed = parseRawString(child);
				if (parsed === null) {
					return null;
				}
				words.push(parsed);
				break;
			}
			case "concatenation": {
				// 拼接如 -g"*.py" 或 '/usr'"/"'local'/bin
				let concatenated = "";
				for (const part of child.namedChildren) {
					switch (part.type) {
						case "word":
						case "number":
							concatenated += part.text;
							break;
						case "string": {
							const parsed = parseDoubleQuotedString(part);
							if (parsed === null) return null;
							concatenated += parsed;
							break;
						}
						case "raw_string": {
							const parsed = parseRawString(part);
							if (parsed === null) return null;
							concatenated += parsed;
							break;
						}
						default:
							return null;
					}
				}
				if (concatenated.length === 0) {
					return null;
				}
				words.push(concatenated);
				break;
			}
			default:
				// 未知 named child（不应发生 —— DFS 阶段已拒，但保险起见 fail-closed）
				return null;
		}
	}
	return words;
}

/**
 * 分析 bash 命令字符串的结构（层 1 AST 安全门）。
 *
 * @param command 原始命令字符串
 * @returns BashAnalysis —— 永不 throw，失败时 fail-closed 返回 parseError:true
 */
export async function analyzeBashStructure(command: string): Promise<BashAnalysis> {
	// 空字符串 / 纯空白 → 干净且无命令
	if (command.trim().length === 0) {
		return { clean: true, commands: [], dangerousStructures: [], parseError: false };
	}

	// 超长 → fail-closed
	if (command.length > MAX_COMMAND_LENGTH) {
		return {
			clean: false,
			commands: [],
			dangerousStructures: ["INPUT_TOO_LONG"],
			parseError: true,
		};
	}

	const parser = await getBashParser();
	if (parser === null) {
		return {
			clean: false,
			commands: [],
			dangerousStructures: ["INIT_FAILED"],
			parseError: true,
		};
	}

	let tree: Tree | null = null;
	try {
		tree = parser.parse(command);
		if (!tree) {
			return {
				clean: false,
				commands: [],
				dangerousStructures: ["PARSE_NULL"],
				parseError: true,
			};
		}

		const root = tree.rootNode;
		if (root.hasError) {
			return {
				clean: false,
				commands: [],
				dangerousStructures: ["ERROR"],
				parseError: true,
			};
		}

		// ── DFS 遍历（stack-based，与 Rust 一致用 node.children() 不是 namedChildren）──
		// 收集非白名单节点 + command 节点。
		const stack: Node[] = [root];
		const dangerousStructures: string[] = [];
		const commandNodes: Node[] = [];

		while (stack.length > 0) {
			const node = stack.pop() as Node;
			const kind = node.type;

			if (node.isNamed) {
				if (!ALLOWED_KINDS.has(kind)) {
					// 非白名单 named node → 危险结构
					dangerousStructures.push(kind);
				}
				if (kind === "command") {
					commandNodes.push(node);
				}
			} else {
				// anonymous token —— 与 Rust 两条判定对应：
				// 1. 含 &;| 但不在白名单 → 危险
				// 2. 不在白名单且非空白 → 危险（括号/反引号/重定向符等）
				const isAllowedOrWhitespace =
					ALLOWED_PUNCT_TOKENS.has(kind) || kind.trim().length === 0;
				if (hasControlOperatorChar(kind) && !ALLOWED_PUNCT_TOKENS.has(kind)) {
					dangerousStructures.push(kind);
				} else if (!isAllowedOrWhitespace) {
					dangerousStructures.push(kind);
				}
			}

			// node.children() 在 web-tree-sitter 是 getter（返回 Array<SyntaxNode>）
			for (const child of node.children) {
				stack.push(child);
			}
		}

		// stack 是 LIFO，按 start_byte 排序恢复源码顺序（与 Rust 一致）
		commandNodes.sort((a, b) => a.startIndex - b.startIndex);

		const commands: string[][] = [];
		for (const node of commandNodes) {
			const words = parsePlainCommand(node);
			if (words !== null) {
				commands.push(words);
			}
			// words === null 时跳过该 command（clean 已由 dangerousStructures 决定）
		}

		return {
			clean: dangerousStructures.length === 0,
			commands,
			dangerousStructures,
			parseError: false,
		};
	} catch (err) {
		// 任何意外异常 → fail-closed
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[pi-permission/ast] analyzeBashStructure exception: ${msg}`);
		return {
			clean: false,
			commands: [],
			dangerousStructures: [msg || "EXCEPTION"],
			parseError: true,
		};
	} finally {
		// G1 critical: Tree 是 wasm 堆对象，不受 V8 GC 管，必须显式 delete 释放。
		tree?.delete();
	}
}
