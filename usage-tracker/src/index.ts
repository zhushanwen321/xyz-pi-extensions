/**
 * Usage Tracker Extension — 被动采集 skill/agent 使用计数 + evolution 信号
 *
 * 事件监听：
 * - before_agent_start: 构建 skill 映射 + 记录上下文
 * - tool_call(read): 匹配 skill SKILL.md 路径，递增 skill 计数
 * - tool_execution_start(subagent): 提取 agent 名称，递增 agent 计数
 * - tool_execution_end: 采集工具执行结果（成功/失败、耗时）
 * - message_end: 采集每轮 assistant 消息的 token usage
 * - session_start: 记录 session 元信息
 * - agent_end: 将本 turn 的信号 flush 到每日汇总
 *
 * 持久化：
 * - ~/.pi/agent/usage-stats.json（原有 skill/agent 计数，保持兼容）
 * - ~/.pi/agent/evolution-data/（新增：每日汇总、工具统计、skill 触发、session 清单）
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { ensureEvolutionDirs, readDailySummary, updateSessionEnd, updateSkillTrigger, updateToolStats, writeDailySummary, recordSessionStart } from "./storage.js";
import { createLogger, type Logger } from "../../shared/logger.js";
import { type DailySummary, type TurnBuffer, emptyDailySummary, emptyTurnBuffer } from "./types.js";

// ── 常量 ────────────────────────────────────────────

const STATS_FILE = join(homedir(), ".pi", "agent", "usage-stats.json");
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

// ── 持久化（原有 usage-stats.json，保持不变）─────────

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
	} catch {
		return emptyStats();
	}
}

function incrementAndPersist(category: "skills" | "agents", name: string): boolean {
	try {
		const stats = readStats();
		if (!stats[category]) stats[category] = {};
		stats[category][name] = (stats[category][name] || 0) + 1;
		stats.updatedAt = new Date().toISOString();
		writeFileSync(STATS_FILE, JSON.stringify(stats, null, JSON_INDENT), "utf-8");
		return true;
	} catch {
		return false;
	}
}

// ── Agent 名称提取 ──────────────────────────────────

function extractAgentNames(input: Record<string, unknown>): string[] {
	const names: string[] = [];
	if (typeof input.agent === "string" && input.agent.length > 0) names.push(input.agent);
	if (Array.isArray(input.tasks)) {
		for (const task of input.tasks) {
			if (task && typeof task === "object" && typeof (task as Record<string, unknown>).agent === "string") {
				names.push((task as Record<string, unknown>).agent as string);
			}
		}
	}
	if (Array.isArray(input.chain)) {
		for (const step of input.chain) {
			if (step && typeof step === "object" && typeof (step as Record<string, unknown>).agent === "string") {
				names.push((step as Record<string, unknown>).agent as string);
			}
		}
	}
	return [...new Set(names)];
}

// ── 日期工具 ─────────────────────────────────────────

function todayDate(): string {
	return new Date().toISOString().slice(0, 10);
}

// ── 扩展入口 ─────────────────────────────────────────

export default function usageTrackerExtension(pi: ExtensionAPI): void {
	// 原有状态
	let skillMap = new Map<string, string>();
	let initialized = false;
	const log: Logger = createLogger("usage-tracker");

	// 进化信号 buffer（注意：闭包级变量，多 session 并行时各实例独立，
	// 后写入的 dailySummary 会覆盖先写入的。Phase 1 单 session 可接受）
	let dailySummary: DailySummary = emptyDailySummary(todayDate());
	let turnBuffer: TurnBuffer = emptyTurnBuffer();
	let sessionId = "";
	let sessionCwd = "";
	let sessionTurnCount = 0;
	let sessionTokenTotal = 0;
	let turnSequence = 0;

	// ── 初始化 ────────────────────────────────────────

	ensureEvolutionDirs();
	// 读取今天的已有汇总（可能从之前 session 的 agent_end 已经写入）
	const today = todayDate();
	try {
		dailySummary = readDailySummary(today);
	} catch {
		dailySummary = emptyDailySummary(today);
	}

	// ── 事件监听 ─────────────────────────────────────

	// session_start: 记录 session 元信息
	pi.on("session_start", async (event, ctx) => {
		sessionId = ctx.sessionManager.getSessionFile() ?? `ephemeral-${Date.now()}`;
		sessionCwd = process.cwd();
		sessionTurnCount = 0;
		sessionTokenTotal = 0;

		recordSessionStart(sessionId, sessionCwd);
		log.info("Session started:", sessionId, `(${sessionCwd})`);
	});

	// before_agent_start: 构建 skill 映射 + 记录本次加载的 skills
	pi.on("before_agent_start", async (event) => {
		initialized = true;
		// 重置 turn 内 buffer
		turnBuffer = emptyTurnBuffer();
		turnSequence += 1;

		const skills = event.systemPromptOptions.skills;
		skillMap = new Map();
		if (Array.isArray(skills)) {
			for (const skill of skills) {
				if (skill.filePath) {
					skillMap.set(resolve(skill.filePath), skill.name);
				}
			}
		}
		log.info(`Turn ${turnSequence} started`);
		if (skillMap.size > 0) {
			log.info(`Skill map built: ${skillMap.size} entries`);
		}
	});

	// tool_call: 检测 skill 全文加载（原有逻辑）
	pi.on("tool_call", async (event) => {
		if (!initialized) return;

		if (event.toolName === "read") {
			if (skillMap.size > 0) {
				const rawPath = (event.input as Record<string, unknown>).path;
				if (typeof rawPath === "string") {
					const readPath = resolve(rawPath);
					const skillName = skillMap.get(readPath);
					if (skillName) {
						incrementAndPersist("skills", skillName);
						// 新增: 同时记录到 evolution-data
						turnBuffer.skillTriggers.push(skillName);
						updateSkillTrigger(skillName);
						log.info(`Skill loaded: ${skillName} (${readPath})`);
					}
				}
			}
		}
	});

	// tool_execution_start: 记录 subagent 调用（原有逻辑 + 新增 buffer）
	pi.on("tool_execution_start", async (event) => {
		if (event.toolName === "subagent") {
			const args = event.args as Record<string, unknown>;
			const names = extractAgentNames(args);
			for (const name of names) {
				incrementAndPersist("agents", name);
				turnBuffer.agentCalls.push(name);
			}
			if (names.length > 0) {
				log.info(`Agent(s) called: ${names.join(", ")}`);
			}
		}

	});

	// ── 新增: tool_execution_end — 采集工具执行结果 ──

	pi.on("tool_execution_end", async (event) => {
		const toolName = event.toolName ?? "unknown";
		const isError = event.isError === true;

		// 记录到 turn buffer（不记录 durationMs：Pi API 不暴露该字段）
		turnBuffer.toolCalls.push({ toolName, success: !isError });

		// 更新累积统计
		updateToolStats(toolName, !isError);

		if (isError) {
			log.error(`Tool failed: ${toolName}`);
		}
	});

	// ── 新增: message_end — 采集 token usage ──

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;

		const usage = event.message.usage;
		if (usage && typeof usage.input === "number" && typeof usage.output === "number") {
			turnBuffer.tokenUsage = {
				input: usage.input,
				output: usage.output,
			};
			sessionTokenTotal += usage.input + usage.output;
		}
	});

	// ── agent_end: flush turn buffer → daily summary ──

	pi.on("agent_end", async () => {
		sessionTurnCount += 1;

		// 合并 turn buffer 到 daily summary
		for (const tc of turnBuffer.toolCalls) {
			dailySummary.toolCalls.total += 1;
			dailySummary.toolCalls.byTool[tc.toolName] = (dailySummary.toolCalls.byTool[tc.toolName] || 0) + 1;
			if (!tc.success) {
				dailySummary.toolCalls.failures[tc.toolName] = (dailySummary.toolCalls.failures[tc.toolName] || 0) + 1;
			}
		}

		if (turnBuffer.tokenUsage) {
			dailySummary.tokenUsage.totalInput += turnBuffer.tokenUsage.input;
			dailySummary.tokenUsage.totalOutput += turnBuffer.tokenUsage.output;
			dailySummary.tokenUsage.turns += 1;
		}

		for (const skill of turnBuffer.skillTriggers) {
			dailySummary.skillTriggers[skill] = (dailySummary.skillTriggers[skill] || 0) + 1;
		}

		for (const agent of turnBuffer.agentCalls) {
			dailySummary.agentCalls[agent] = (dailySummary.agentCalls[agent] || 0) + 1;
		}

		// 写入每日汇总（每次 agent_end 后更新，保证崩溃时数据不丢失）
		writeDailySummary(dailySummary);

		log.info(
			`Turn ${sessionTurnCount} flushed: ` +
				`${turnBuffer.toolCalls.length} tool calls, ` +
				`${turnBuffer.tokenUsage ? `${turnBuffer.tokenUsage.input + turnBuffer.tokenUsage.output} tokens` : "no usage"}`,
		);
	});

	// ── session_shutdown: 更新 session 最终状态 ──

	pi.on("session_shutdown", async () => {
		updateSessionEnd(sessionId, sessionTurnCount, sessionTokenTotal);
		log.info(`Session shutdown: ${sessionId}, ${sessionTurnCount} turns, ${sessionTokenTotal} tokens`);
	});
}
