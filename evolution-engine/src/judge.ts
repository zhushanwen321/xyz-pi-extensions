/**
 * Evolution Engine — LLM Judge 子进程编排
 *
 * 负责：
 *   1. buildJudgeInput — 按 target 裁剪 Phase 2 报告，写入临时文件
 *   2. runJudge — spawn pi 子进程，通过 JSONL 解析 LLM 响应
 *   3. parseJudgeOutput — 解析 + 校验 LLM 产出的 EvolutionSuggestion 数组
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JudgeInput, EvolutionSuggestion } from "./types.js";

// ── target → 模板文件名映射 ─────────────────────────

const TARGET_TEMPLATE: Record<JudgeInput["target"], string> = {
	all: "session-quality.txt",
	"claude-md": "prompt-optimize.txt",
	skills: "skill-health.txt",
	"merge-reviewer": "merge-reviewer.txt",
};

// ── report 子集提取器 ────────────────────────────────

/** Phase 2 报告顶层键（宽松型，字段可能缺失） */
interface Phase2Report {
	[key: string]: unknown;
}

/**
 * 按 target 从完整报告中提取相关子集。
 * 字段不存在时传可用的子集（不抛错）。
 */
function extractReportSubset(
	report: Phase2Report,
	target: JudgeInput["target"],
): Record<string, unknown> {
	if (target === "all") return report;

	const subset: Record<string, unknown> = {};

	if (target === "claude-md") {
		if (report.token_stats != null) subset.token_stats = report.token_stats;
		if (report.user_patterns != null) subset.user_patterns = report.user_patterns;
		if (report.actionable_issues != null) subset.actionable_issues = report.actionable_issues;
		// 子集可能为空——传可用的
		if (report.tool_stats != null) subset.tool_stats = report.tool_stats;
		if (report.error_stats != null) subset.error_stats = report.error_stats;
		return subset;
	}

	if (target === "skills") {
		if (report.skill_stats != null) subset.skill_stats = report.skill_stats;
		if (report.skill_health != null) subset.skill_health = report.skill_health;
		if (report.actionable_issues != null) subset.actionable_issues = report.actionable_issues;
		return subset;
	}

	// target === "merge-reviewer"
	if (report.tool_stats != null) subset.tool_stats = report.tool_stats;
	if (report.error_stats != null) subset.error_stats = report.error_stats;
	if (report.user_patterns != null) subset.user_patterns = report.user_patterns;
	return subset;
}

// ── buildJudgeInput ──────────────────────────────────

/**
 * 按 target 裁剪报告数据，写入临时文件，返回 JudgeInput。
 *
 * @param report  Phase 2 产出的 JSON 报告对象
 * @param target  分析目标
 * @param tmpDir  临时文件目录（由调用方确保存在）
 */
export function buildJudgeInput(
	report: Phase2Report,
	target: JudgeInput["target"],
	tmpDir: string,
): JudgeInput {
	if (!existsSync(tmpDir)) {
		mkdirSync(tmpDir, { recursive: true });
	}

	const subset = extractReportSubset(report, target);
	const timestamp = Date.now();
	const reportFileName = `judge-input-${timestamp}.json`;
	const reportPath = join(tmpDir, reportFileName);

	writeFileSync(reportPath, JSON.stringify(subset, null, 2), "utf-8");

	const promptFilePath = join(tmpDir, `judge-prompt-${timestamp}.txt`);
	// 写入用户消息到临时文件，方便 runJudge 读取
	const userMessage = `分析以下信号数据，生成进化建议：\n\n${JSON.stringify(subset, null, 2)}`;
	writeFileSync(promptFilePath, userMessage, "utf-8");

	return { target, reportPath, promptFilePath };
}

// ── JSONL 解析 ───────────────────────────────────────

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

// ── runJudgeOnce（单次 Judge 调用） ─────────────────

/** 单次 Judge 调用的原始结果 */
interface JudgeOnceResult {
	suggestions: EvolutionSuggestion[];
	raw: string;
	stderr: string;
}

const JUDGE_TIMEOUT_MS = 300_000;

/**
 * 执行一次 pi 子进程调用，返回解析后的建议 + 原始输出。
 * 如果 parseJudgeOutput 抛错（包括 "Empty Judge output"），
 * 会在 result 中把 raw 和 stderr 带回来供上层判断是否重试。
 */
function runJudgeOnce(
	templateContent: string,
	userMessage: string,
): Promise<JudgeOnceResult> {
	const args = [
		"--mode", "json",
		"-p",
		"--model", "router-openai/glm-5.1",
		"--no-session",
		"--append-system-prompt", templateContent,
	];

	return new Promise<JudgeOnceResult>((resolve, reject) => {
		// stdin=pipe 以便写入 userMessage
		const proc = spawn("pi", args, {
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});

		// 通过 stdin 传递 userMessage，避免 args 截断或 shell 转义问题
		proc.stdin.write(userMessage);
		proc.stdin.end();

		let stdout = "";
		let stderr = "";
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			proc.kill("SIGTERM");
			reject(new Error(
				`LLM Judge timed out after ${JUDGE_TIMEOUT_MS / 1000}s. stderr: ${stderr.slice(0, 500)}`,
			));
		}, JUDGE_TIMEOUT_MS);

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
			reject(new Error(`LLM Judge spawn failed: ${err.message}`));
		});

		proc.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);

			if (code !== 0) {
				reject(new Error(
					`LLM Judge exited with code ${code}. stderr: ${stderr.slice(0, 500)}`,
				));
				return;
			}

			const raw = extractAssistantText(stdout);

			try {
				const suggestions = parseJudgeOutput(raw);
				resolve({ suggestions, raw, stderr });
			} catch {
				// 解析失败：带 raw 返回，让上层决定是否重试
				resolve({ suggestions: [], raw, stderr });
			}
		});
	});
}

// ── runJudge ─────────────────────────────────────────

/**
 * Spawn pi 子进程作为 LLM Judge，返回进化建议数组。
 * 如果首次调用返回空输出，自动用简化 prompt 重试一次。
 *
 * @param input        buildJudgeInput 的返回值
 * @param templateDir  模板文件目录（含 session-quality.txt 等）
 */
export async function runJudge(
	input: JudgeInput,
	templateDir: string,
): Promise<EvolutionSuggestion[]> {
	const templateFileName = TARGET_TEMPLATE[input.target];
	const templatePath = join(templateDir, templateFileName);

	if (!existsSync(templatePath)) {
		throw new Error(`Judge template not found: ${templatePath}`);
	}

	const templateContent = readFileSync(templatePath, "utf-8");
	// 现在 reportPath 指向信号文件（SignalReport JSON）
	const signalData = readFileSync(input.reportPath, "utf-8");
	const userMessage = `以下是信号摘要数据，请生成进化建议：\n\n${signalData}`;

	// 第一次尝试
	const first = await runJudgeOnce(templateContent, userMessage);

	// 首次返回非空建议 → 直接返回
	if (first.suggestions.length > 0) {
		return first.suggestions;
	}

	// 空输出可能因为 LLM 输出格式异常，用简化 prompt 重试一次
	const retryMessage = `Output ONLY a JSON array of suggestions. No markdown, no explanation. If no suggestions, output [].\n\n${signalData}`;
	const second = await runJudgeOnce(templateContent, retryMessage);

	if (second.suggestions.length > 0) {
		return second.suggestions;
	}

	// 两次都失败 → 保存诊断信息并抛错
	const ts = Date.now();
	const tmpDir = input.reportPath.slice(0, input.reportPath.lastIndexOf("/"));
	const stderrPath = join(tmpDir, `judge-stderr-${ts}.txt`);
	writeFileSync(stderrPath, [
		`=== Attempt 1 ===`,
		`stderr: ${first.stderr.slice(0, 2000)}`,
		`raw output: ${first.raw.slice(0, 2000)}`,
		``,
		`=== Attempt 2 (retry) ===`,
		`stderr: ${second.stderr.slice(0, 2000)}`,
		`raw output: ${second.raw.slice(0, 2000)}`,
	].join("\n"), "utf-8");

	throw new Error(
		`LLM Judge returned empty output after 2 attempts. Diagnostics saved to: ${stderrPath}`,
	);
}

// ── parseJudgeOutput ─────────────────────────────────

const VALID_SEVERITIES = new Set(["high", "medium", "low"]);
const REQUIRED_KEYS: ReadonlyArray<keyof EvolutionSuggestion> = [
	"target", "targetPath", "severity", "confidence",
	"title", "description", "rationale", "instruction",
];

/**
 * 解析 LLM Judge 原始输出为 EvolutionSuggestion 数组。
 *
 * - 尝试从 raw 中提取 JSON 数组（可能被 markdown 包裹）
 * - 逐条校验必需字段、confidence 范围、severity 枚举
 * - 无效条目跳过，不抛错
 * - 全部无效时返回空数组
 */
export function parseJudgeOutput(raw: string): EvolutionSuggestion[] {
	if (!raw || !raw.trim()) {
		throw new Error("Empty Judge output");
	}

	// 尝试提取 JSON（可能被 ```json ... ``` 包裹）
	let jsonStr = raw.trim();
	const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
	if (fenceMatch) {
		jsonStr = fenceMatch[1]!.trim();
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonStr);
	} catch {
		throw new Error(`JSON.parse failed on Judge output (first 200 chars): ${jsonStr.slice(0, 200)}`);
	}

	if (!Array.isArray(parsed)) {
		throw new Error(`Judge output is not an array, got: ${typeof parsed}`);
	}

	const suggestions: EvolutionSuggestion[] = [];

	for (const item of parsed) {
		if (typeof item !== "object" || item === null) continue;

		const record = item as Record<string, unknown>;

		// 检查所有必需字段存在
		let hasAllKeys = true;
		for (const key of REQUIRED_KEYS) {
			if (record[key] === undefined || record[key] === null) {
				hasAllKeys = false;
				break;
			}
		}
		if (!hasAllKeys) continue;

		// confidence 范围检查
		const confidence = Number(record.confidence);
		if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) continue;

		// severity 枚举检查
		const severity = String(record.severity);
		if (!VALID_SEVERITIES.has(severity)) continue;

		// target 检查（容错：LLM 可能输出 "skills" 复数形式或旧值）
		let target = String(record.target);
		if (target === "skills") target = "skill";
		// 容错：LLM 可能输出 claude-md 或 CLAUDE.md
		if (target === "CLAUDE.md") target = "claude-md";
		if (target !== "claude-md" && target !== "skill") continue;

		// instruction 优先取 instruction 字段，fallback 到旧格式 diff 字段
		const instruction = record.instruction
			? String(record.instruction)
			: record.diff
				? String(record.diff)
				: "";
		if (!instruction) continue;

		suggestions.push({
			id: record.id ? String(record.id) : `sug-${suggestions.length + 1}`,
			target,
			targetPath: String(record.targetPath),
			severity: severity as EvolutionSuggestion["severity"],
			confidence,
			title: String(record.title),
			description: String(record.description),
			rationale: String(record.rationale),
			instruction,
			status: "pending",
		});
	}

	return suggestions;
}
