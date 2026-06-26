/**
 * Gate 校验 — 从交付物文件派生「阶段完成状态」。
 *
 * 真相源混合的核心：complete_phase 标 completed 前，必须通过本模块的 gate 校验。
 * 读 .xyz-harness/{topic}/ 下的交付物 + review + machine-check 文件的 frontmatter，
 * 不依赖 agent 主观写的状态。agent 无法伪造「做完了」——交付物不齐就拒绝。
 *
 * 不 spawn python check 脚本（路径脆弱）：直接读 review subagent 已产出的
 * machine-check-{phase}.md（frontmatter machine_check: PASS/FAIL）+ review-{phase}.md
 * （frontmatter verdict: APPROVED）。这两个文件本就是 check 脚本/review 的产物。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type Phase, PHASE_GATES } from "./model.ts";

export interface GateResult {
	ok: boolean;
	/** 缺失/不通过的项，人类可读，用于拒绝时反馈给 agent */
	missing: string[];
}

// ── frontmatter 解析（与 _shared_check_lib.py parse_frontmatter 等价的 TS 版） ──

/**
 * 解析 markdown frontmatter（--- 包裹的扁平 yaml 块）。
 * 只支持扁平 key: value（设计交付物的 frontmatter 都是扁平的）。
 */
export function parseFrontmatter(filePath: string): Record<string, string> {
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return {};
	}
	const m = content.match(/^---\s*\n(.*?)\n---\s*\n/s);
	if (!m) return {};
	const block = m[1];
	const result: Record<string, string> = {};
	for (const line of block.split("\n")) {
		const stripped = line.trim();
		if (!stripped || stripped.startsWith("#")) continue;
		if (!line.includes(":")) continue;
		const idx = line.indexOf(":");
		const key = line.slice(0, idx).trim();
		let val = line.slice(idx + 1).trim();
		// 去掉行内注释
		if (val.includes(" #")) val = val.split(" #")[0].trim();
		// 去引号
		if (val && val[0] === '"' && val[val.length - 1] === '"') val = val.slice(1, -1);
		if (val && val[0] === "'" && val[val.length - 1] === "'") val = val.slice(1, -1);
		result[key] = val;
	}
	return result;
}

// ── 单项检查 ──────────────────────────────────────────

function checkDeliverable(topicDir: string, deliverable: string): string[] {
	const path = join(topicDir, deliverable);
	if (!existsSync(path)) return [`${deliverable} 不存在`];
	const fm = parseFrontmatter(path);
	if (fm.verdict !== "pass") {
		return [`${deliverable} frontmatter verdict 非 pass（实际: '${fm.verdict ?? "(无)"}'）`];
	}
	return [];
}

function checkReview(topicDir: string, reviewSlug: string): string[] {
	const path = join(topicDir, "changes", `review-${reviewSlug}.md`);
	if (!existsSync(path)) return [`changes/review-${reviewSlug}.md 不存在（未跑 Step 6 审查）`];
	const fm = parseFrontmatter(path);
	if (fm.verdict !== "APPROVED") {
		return [`review-${reviewSlug}.md verdict 非 APPROVED（实际: '${fm.verdict ?? "(无)"}'）`];
	}
	return [];
}

function checkMachineCheck(topicDir: string, slug: string): string[] {
	const path = join(topicDir, "changes", `machine-check-${slug}.md`);
	if (!existsSync(path)) return []; // machine-check 可能未产出（旧流程），不硬阻——review 已兜底
	const fm = parseFrontmatter(path);
	if (fm.machine_check === "FAIL") {
		return [`machine-check-${slug}.md machine_check: FAIL（有机器可证的硬伤）`];
	}
	return [];
}

/** init 软 gate：AGENTS.md + CONTEXT.md 在项目根（cwd）或 topicDir 就位。 */
function checkInitGate(cwd: string, topicDir: string): string[] {
	const missing: string[] = [];
	const candidates = [cwd, topicDir];
	for (const file of ["AGENTS.md", "CONTEXT.md"]) {
		const found = candidates.some((d) => existsSync(join(d, file)));
		if (!found) missing.push(`${file} 不存在（init 阶段需就位）`);
	}
	return missing;
}

// ── 顶层 gate 校验 ────────────────────────────────────

/**
 * 校验某阶段的交付物 gate 是否通过。
 *
 * @param topicDir .xyz-harness/{topic}/ 绝对路径
 * @param cwd 项目根（init 软 gate 查 AGENTS.md/CONTEXT.md）
 * @param phase 阶段
 * @returns ok=true 可标 completed；ok=false 时 missing 列出缺什么
 */
export function checkPhaseGate(
	topicDir: string,
	cwd: string,
	phase: Phase,
): GateResult {
	const gate = PHASE_GATES[phase];
	const missing: string[] = [];

	if (phase === "init") {
		missing.push(...checkInitGate(cwd, topicDir));
		return { ok: missing.length === 0, missing };
	}

	if (gate.deliverable) {
		missing.push(...checkDeliverable(topicDir, gate.deliverable));
	}
	if (gate.reviewSlug) {
		missing.push(...checkReview(topicDir, gate.reviewSlug));
	}
	if (gate.machineCheckSlug) {
		missing.push(...checkMachineCheck(topicDir, gate.machineCheckSlug));
	}

	return { ok: missing.length === 0, missing };
}
