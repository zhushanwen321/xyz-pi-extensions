/**
 * Usage Tracker Extension — 被动采集 skill 全文加载和 agent 调用计数
 *
 * 事件监听：
 * - before_agent_start: 从 systemPromptOptions.skills 构建 filePath→name 映射
 * - tool_call(read): 匹配 skill SKILL.md 路径，递增 skill 计数
 * - tool_execution_start(subagent): 提取 agent 名称（single/parallel/chain），递增 agent 计数
 *   （用 tool_execution_start 而非 tool_call，因为 Pi 只对内置工具触发 tool_call）
 *
 * 持久化：~/.pi/agent/usage-stats.json（read-before-write 防竞争）
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ── 常量 ────────────────────────────────────────────

const STATS_FILE = join(homedir(), ".pi", "agent", "usage-stats.json");
const LOG_PREFIX = "[usage-tracker]";
const JSON_INDENT = 2;

// ── 数据模型 ─────────────────────────────────────────

interface UsageStats {
	skills: Record<string, number>;
	agents: Record<string, number>;
	updatedAt: string;
}

function emptyStats(): UsageStats {
	return { skills: {}, agents: {}, updatedAt: "" };
}

// ── 持久化 ──────────────────────────────────────────

/** 从磁盘读取最新统计，文件不存在或解析失败返回空 */
function readStats(): UsageStats {
	try {
		if (!existsSync(STATS_FILE)) return emptyStats();
		const raw = readFileSync(STATS_FILE, "utf-8");
		const parsed = JSON.parse(raw) as Partial<UsageStats>;
		return {
			skills: typeof parsed.skills === "object" && parsed.skills !== null ? parsed.skills : {},
			agents: typeof parsed.agents === "object" && parsed.agents !== null ? parsed.agents : {},
			updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
		};
	} catch (err) {
		console.error(`${LOG_PREFIX} Failed to read stats file: ${err}`, STATS_FILE);
		return emptyStats();
	}
}

/**
 * 读取最新数据 → 递增 → 写回（read-before-write 防跨 session 覆盖）。
 * 返回 true 表示写入成功，false 表示写入失败（调用方可据此决定行为）。
 */
function incrementAndPersist(category: "skills" | "agents", name: string): boolean {
	try {
		const stats = readStats();
		if (!stats[category]) stats[category] = {};
		stats[category][name] = (stats[category][name] || 0) + 1;
		stats.updatedAt = new Date().toISOString();
		writeFileSync(STATS_FILE, JSON.stringify(stats, null, JSON_INDENT), "utf-8");
		return true;
	} catch (err) {
		console.error(`${LOG_PREFIX} Failed to write stats: ${err}`, STATS_FILE);
		return false;
	}
}

// ── Agent 名称提取 ──────────────────────────────────

/** 从 subagent tool 的 input 中提取所有 agent 名称 */
function extractAgentNames(input: Record<string, unknown>): string[] {
	const names: string[] = [];

	if (typeof input.agent === "string" && input.agent.length > 0) {
		names.push(input.agent);
	}

	if (Array.isArray(input.tasks)) {
		for (const task of input.tasks) {
			if (task && typeof task === "object" && typeof task.agent === "string" && task.agent.length > 0) {
				names.push(task.agent);
			}
		}
	}

	if (Array.isArray(input.chain)) {
		for (const step of input.chain) {
			if (step && typeof step === "object" && typeof step.agent === "string" && step.agent.length > 0) {
				names.push(step.agent);
			}
		}
	}

	return [...new Set(names)];
}

// ── 扩展入口 ─────────────────────────────────────────

export default function usageTrackerExtension(pi: ExtensionAPI): void {
	let skillMap = new Map<string, string>();
	let initialized = false;

	pi.on("before_agent_start", async (event) => {
		// 无论 skills 是否存在，都标记初始化完成，确保 agent 计数不受影响
		initialized = true;

		const skills = event.systemPromptOptions.skills;
		if (!Array.isArray(skills)) return;

		skillMap = new Map();
		for (const skill of skills) {
			if (skill.filePath) {
				skillMap.set(resolve(skill.filePath), skill.name);
			}
		}
		console.error(`${LOG_PREFIX} Skill map built: ${skillMap.size} entries`);
	});

	pi.on("tool_call", async (event) => {
		if (!initialized) {
			console.error(`${LOG_PREFIX} tool_call received before skill map initialized, skipping`);
			return;
		}

		// FR-1: Skill 全文加载计数
		if (event.toolName === "read") {
			if (skillMap.size === 0) {
				console.error(`${LOG_PREFIX} skillMap is empty (no skills loaded), skipping skill matching`);
				return;
			}

			const rawPath = (event.input as Record<string, unknown>).path;
			if (typeof rawPath !== "string") return;
			const readPath = resolve(rawPath);

			const skillName = skillMap.get(readPath);
			if (skillName) {
				incrementAndPersist("skills", skillName);
				console.error(`${LOG_PREFIX} Skill loaded: ${skillName} (${readPath})`);
			}
		}

		// FR-1 仅处理 read，skill 计数
	});

	// FR-2: Agent 调用计数
	// 用 tool_execution_start 而非 tool_call，因为 Pi 只对内置工具 emit tool_call
	pi.on("tool_execution_start", async (event) => {
		if (event.toolName !== "subagent") return;

		const args = event.args as Record<string, unknown>;
		const names = extractAgentNames(args);
		for (const name of names) {
			incrementAndPersist("agents", name);
		}
		if (names.length > 0) {
			console.error(`${LOG_PREFIX} Agent(s) called: ${names.join(", ")}`);
		}
	});
}
