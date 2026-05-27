/**
 * Evolution Engine — 建议应用引擎
 *
 * 负责 apply（备份→diff→commit）和 rollback（恢复→revert）两个核心操作。
 * 纯 Node.js 内置模块实现，不引入 npm 依赖。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

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

// ── Unified Diff 解析与应用 ───────────────────────────

interface ParsedHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	oldContent: string;
	newContent: string;
}

/**
 * 从 unified diff 文本中解析所有 hunk。
 * 只处理以 `---` / `+++` 开头的文件头和 `@@ ... @@` 的 hunk。
 */
function parseUnifiedDiff(diff: string): ParsedHunk[] {
	const hunks: ParsedHunk[] = [];
	const lines = diff.split("\n");

	let i = 0;
	// 跳过文件头行（--- a/xxx, +++ b/xxx 等）
	while (i < lines.length && !lines[i].startsWith("@@")) {
		i++;
	}

	while (i < lines.length) {
		const hunkMatch = lines[i].match(
			/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/,
		);
		if (!hunkMatch) {
			i++;
			continue;
		}

		const oldStart = parseInt(hunkMatch[1], 10);
		const oldLines = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
		const newStart = hunkMatch[3] !== undefined ? parseInt(hunkMatch[3], 10) : 1;
		const newLines = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;

		i++; // 进入 hunk body

		const oldParts: string[] = [];
		const newParts: string[] = [];
		let oldCount = 0;
		let newCount = 0;

		while (i < lines.length && (oldCount < oldLines || newCount < newLines)) {
			const line = lines[i];
			if (line.startsWith("-")) {
				oldParts.push(line.substring(1));
				oldCount++;
			} else if (line.startsWith("+")) {
				newParts.push(line.substring(1));
				newCount++;
			} else if (line.startsWith(" ")) {
				// 上下行，两边都有
				oldParts.push(line.substring(1));
				newParts.push(line.substring(1));
				oldCount++;
				newCount++;
			} else if (line.startsWith("\\")) {
				// `\ No newline at end of file` — 跳过
			} else {
				break;
			}
			i++;
		}

		hunks.push({
			oldStart,
			oldLines,
			newStart,
			newLines,
			oldContent: oldParts.join("\n"),
			newContent: newParts.join("\n"),
		});
	}

	return hunks;
}

/**
 * 将 unified diff 应用到指定文件。
 * 策略：解析 hunk → 按顺序在文件内容中定位并替换。
 */
export function applyUnifiedDiff(
	filePath: string,
	diff: string,
): ApplyResult {
	const hunks = parseUnifiedDiff(diff);
	if (hunks.length === 0) {
		return { success: false, reason: "no hunks found in diff" };
	}

	const original = fs.readFileSync(filePath, "utf-8");
	let content = original;

	for (const hunk of hunks) {
		if (hunk.oldContent.length === 0 && hunk.newContent.length === 0) {
			continue;
		}

		// 精确匹配：在内容中查找 old 内容
		const idx = content.indexOf(hunk.oldContent);
		if (idx === -1) {
			return { success: false, reason: "diff conflict" };
		}

		content =
			content.substring(0, idx) +
			hunk.newContent +
			content.substring(idx + hunk.oldContent.length);
	}

	fs.writeFileSync(filePath, content, "utf-8");
	return { success: true };
}

// ── Apply ─────────────────────────────────────────────

/**
 * 应用一条进化建议：
 * 1. 路径白名单校验
 * 2. 目标文件存在性校验
 * 3. 备份原文件
 * 4. 应用 diff
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

	// 4. 应用 diff
	const result = applyUnifiedDiff(suggestion.targetPath, suggestion.diff);
	if (!result.success) {
		return { success: false, reason: result.reason ?? "diff conflict" };
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

	// 无 commitSha 或 revert 失败时：copyFileSync 恢复文件
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
