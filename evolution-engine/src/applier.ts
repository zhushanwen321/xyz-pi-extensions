/**
 * Evolution Engine — 建议应用引擎
 *
 * 负责 apply（备份→LLM 执行修改→写入→commit）和 rollback（恢复）两个核心操作。
 * apply 阶段 spawn pi 子进程，让 LLM 读取目标文件并按 instruction 执行修改。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync, spawn } from "node:child_process";

import type { EvolutionSuggestion, HistoryEntry, ApplyResult, RollbackResult } from "./types";

// ── 路径白名单 ────────────────────────────────────────

function isPathAllowed(targetPath: string): boolean {
	const resolved = path.resolve(targetPath);
	const agentDir = path.resolve(os.homedir(), ".pi/agent");
	return resolved.startsWith(agentDir) && resolved.endsWith(".md");
}

// ── 备份 ──────────────────────────────────────────────

/**
 * 将目标文件复制到备份目录，保留原文件名。
 * 备份路径格式: backupDir/<timestamp>/<basename>
 */
export function backupFile(filePath: string, backupDir: string): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupSubDir = path.join(backupDir, timestamp);
	fs.mkdirSync(backupSubDir, { recursive: true });

	const backupPath = path.join(backupSubDir, path.basename(filePath));
	fs.copyFileSync(filePath, backupPath);
	return backupPath;
}

// ── LLM Apply ────────────────────────────────────────

const APPLY_TIMEOUT_MS = 120_000;

const APPLY_SYSTEM_PROMPT = `你是一个精确的文件修改执行器。你的任务是：
1. 读取指定的文件内容
2. 按照修改指令精确地修改文件
3. 输出修改后的完整文件内容

规则：
- 只输出修改后的完整文件内容，不要输出任何解释、说明或 markdown 代码块标记
- 严格遵循修改指令，不要添加指令之外的内容
- 保持文件其他部分完全不变
- 输出必须是可以直接写入文件的完整文本`;

/**
 * 通过 LLM 子进程执行修改。
 * 让 LLM 读取目标文件，按 instruction 修改，输出修改后的完整内容。
 */
function applyViaLLM(
	targetPath: string,
	instruction: string,
): Promise<{ success: boolean; reason?: string }> {
	const originalContent = fs.readFileSync(targetPath, "utf-8");

	const userMessage = `文件路径: ${targetPath}

当前文件内容:
${originalContent}

修改指令:
${instruction}

请输出修改后的完整文件内容（不要输出任何其他文字）:`;

	const args = [
		"--mode", "json",
		"-p",
		"--model", "router-openai/glm-5.1",
		"--no-session",
		"--append-system-prompt", APPLY_SYSTEM_PROMPT,
	];

	return new Promise<{ success: boolean; reason?: string }>((resolve) => {
		const proc = spawn("pi", args, {
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});

		proc.stdin.write(userMessage);
		proc.stdin.end();

		let stdout = "";
		let stderr = "";
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			proc.kill("SIGTERM");
			resolve({ success: false, reason: "LLM apply timed out" });
		}, APPLY_TIMEOUT_MS);

		proc.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});

		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ success: false, reason: `LLM apply spawn failed: ${err.message}` });
		});

		proc.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);

			if (code !== 0) {
				resolve({
					success: false,
					reason: `LLM apply exited with code ${code}: ${stderr.slice(0, 300)}`,
				});
				return;
			}

			// 从 JSONL stdout 中提取 assistant 最后的文本输出
			const modifiedContent = extractAssistantText(stdout);
			if (!modifiedContent) {
				resolve({
					success: false,
					reason: "LLM apply returned empty output",
				});
				return;
			}

			// 去除可能的 markdown 代码块包裹
			let cleaned = modifiedContent;
			const fenceMatch = cleaned.match(/^```(?:\w*)\n([\s\S]*?)\n?```$/);
			if (fenceMatch) {
				cleaned = fenceMatch[1]!;
			}

			// 基本验证：修改后的内容不能为空，不能和原内容完全相同
			if (cleaned.trim().length === 0) {
				resolve({ success: false, reason: "LLM apply output is empty after cleanup" });
				return;
			}

			if (cleaned === originalContent) {
				resolve({ success: false, reason: "LLM apply output is identical to original" });
				return;
			}

			// 写入文件
			try {
				fs.writeFileSync(targetPath, cleaned, "utf-8");
				resolve({ success: true });
			} catch (writeErr: unknown) {
				const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
				resolve({ success: false, reason: `write failed: ${msg}` });
			}
		});
	});
}

/** 从 pi --mode json 的 JSONL stdout 中提取最后一个 assistant 文本 */
function extractAssistantText(stdout: string): string {
	const lines = stdout.split("\n");
	let lastAssistantText = "";

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let event: Record<string, unknown>;
		try {
			event = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}

		if (event.type === "message_end" && event.message) {
			const msg = event.message as {
				role?: string;
				content?: Array<{ type: string; text?: string }>;
			};
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (part.type === "text" && typeof part.text === "string") {
						lastAssistantText = part.text;
					}
				}
			}
		}
	}

	return lastAssistantText;
}

// ── Apply ─────────────────────────────────────────────

/**
 * 应用一条进化建议：
 * 1. 路径白名单校验
 * 2. 目标文件存在性校验
 * 3. 备份原文件
 * 4. 通过 LLM 子进程执行修改
 * 5. 尝试 git commit（失败不影响结果）
 */
export async function applySuggestion(
	suggestion: EvolutionSuggestion,
	backupDir: string,
): Promise<ApplyResult> {
	// 1. 路径白名单校验
	if (!isPathAllowed(suggestion.targetPath)) {
		return { success: false, reason: "path not allowed" };
	}

	// 2. 目标文件存在性校验
	if (!fs.existsSync(suggestion.targetPath)) {
		return { success: false, reason: "target file not found" };
	}

	// 3. 备份
	const backupPath = backupFile(suggestion.targetPath, backupDir);

	// 4. 通过 LLM 执行修改
	const result = await applyViaLLM(suggestion.targetPath, suggestion.instruction);
	if (!result.success) {
		// LLM 修改失败时恢复备份
		try {
			fs.copyFileSync(backupPath, suggestion.targetPath);
		} catch {
			// 恢复失败不阻塞，保留备份供手动恢复
		}
		return { success: false, reason: result.reason ?? "LLM apply failed" };
	}

	// 5. 尝试 git add + commit — 失败不影响 success，但成功时记录 commitSha
	let commitSha: string | undefined;
	const cwd = path.dirname(suggestion.targetPath);
	try {
		execFileSync("git", ["add", suggestion.targetPath], { cwd, stdio: "pipe" });
		execFileSync("git", ["commit", "-m", `evolve: ${suggestion.title}`], {
			cwd,
			stdio: "pipe",
		});
		commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd })
			.toString()
			.trim();
	} catch {
		// git commit 失败（nothing to commit / detached HEAD 等）不阻塞 apply
	}

	return { success: true, backupPath, commitSha };
}

// ── Rollback ──────────────────────────────────────────

/**
 * 回滚一条已应用的建议：从备份恢复原文件，并尝试 git 操作。
 */
export async function rollbackSuggestion(
	entry: HistoryEntry,
): Promise<RollbackResult> {
	// 1. 备份文件存在性校验
	if (!fs.existsSync(entry.backupPath)) {
		return { success: false, reason: "backup file not found" };
	}

	const cwd = path.dirname(entry.targetPath);

	if (entry.commitSha) {
		// 有 commitSha 时优先 git revert（revert 会自动恢复文件内容）
		// 必须先 revert 再 copyFileSync，否则 dirty tree 会导致 revert 失败
		try {
			execFileSync("git", ["revert", "--no-edit", entry.commitSha], {
				cwd,
				stdio: "pipe",
			});
			return { success: true };
		} catch {
			// revert 失败，fallback 到 copyFileSync 恢复
		}
	}

	// 无 commitSha 或 revert 失败时：copyFileSync 恢复
	try {
		fs.copyFileSync(entry.backupPath, entry.targetPath);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { success: false, reason: `restore failed: ${msg}` };
	}

	// 尝试 git add + commit
	try {
		execFileSync("git", ["add", entry.targetPath], { cwd, stdio: "pipe" });
		execFileSync("git", ["commit", "-m", `evolve: rollback ${entry.title}`], {
			cwd,
			stdio: "pipe",
		});
	} catch {
		// git 失败不影响 rollback 结果
	}

	return { success: true };
}
