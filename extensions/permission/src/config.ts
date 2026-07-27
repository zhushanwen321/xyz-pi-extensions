/**
 * 配置加载 / 保存 / mtime 缓存
 *
 * 对应 I6 loadAndWatchConfig。参考 pi-permission-system extension-config.ts。
 * 文件位置：~/.pi/agent/permission-config.json（支持 PI_CODING_AGENT_DIR 覆盖）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
	DEFAULT_CLASSIFIER_CONFIG,
	DEFAULT_CONFIG,
	isValidPermissionMode,
	type ClassifierConfig,
	type PermissionConfig,
	type PermissionMode,
	type Rule,
} from "./types.js";

// ──────────────────────── 路径解析 ────────────────────────

/** PI_CODING_AGENT_DIR 环境变量覆盖 ~/.pi/agent 基础路径 */
function getAgentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	if (override) return override;
	return join(homedir(), ".pi", "agent");
}

/** 配置文件完整路径 */
export function getConfigPath(): string {
	return join(getAgentDir(), "permission-config.json");
}

// ──────────────────────── mtime 缓存 ────────────────────────

interface CacheEntry {
	mtimeMs: number;
	config: PermissionConfig;
}

/** 模块级缓存：path → {mtimeMs, config}。单进程多 session 共享读缓存是安全的（配置只读） */
const configCache = new Map<string, CacheEntry>();

/** 测试用：清空缓存 */
export function clearConfigCache(): void {
	configCache.clear();
}

// ──────────────────────── 归一化 ────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeClassifierConfig(raw: unknown): ClassifierConfig {
	const record = isPlainObject(raw) ? raw : {};
	const timeout = Number(record.timeout);
	return {
		enabled: record.enabled !== false,
		model: typeof record.model === "string" && record.model.length > 0 ? record.model : DEFAULT_CLASSIFIER_CONFIG.model,
		timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_CLASSIFIER_CONFIG.timeout,
		autoApproveLowRisk: record.autoApproveLowRisk !== false,
		autoDenyHighRisk: record.autoDenyHighRisk !== false,
	};
}

function normalizeRule(raw: unknown, fallbackId: string): Rule | null {
	if (!isPlainObject(raw)) return null;
	const tool = typeof raw.tool === "string" ? raw.tool : "*";
	const pattern = typeof raw.pattern === "string" ? raw.pattern : "*";
	const action = raw.action;
	if (action !== "allow" && action !== "deny" && action !== "ask") return null;
	const source = raw.source === "user" ? "user" : raw.source === "builtin-safe" ? "builtin-safe" : raw.source === "builtin-danger" ? "builtin-danger" : "user";
	const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : fallbackId;
	const description = typeof raw.description === "string" ? raw.description : undefined;
	return { id, tool, pattern, action, source, ...(description !== undefined ? { description } : {}) };
}

function normalizeConfig(raw: unknown): PermissionConfig {
	const record = isPlainObject(raw) ? raw : {};
	const mode = isValidPermissionMode(record.mode) ? record.mode : DEFAULT_CONFIG.mode;
	const enabled = record.enabled !== false;
	const classifier = normalizeClassifierConfig(record.classifier);
	const userRulesRaw = Array.isArray(record.userRules) ? record.userRules : [];
	const userRules = userRulesRaw
		.map((r, i) => normalizeRule(r, `user-${i + 1}`))
		.filter((r): r is Rule => r !== null);
	return { mode, enabled, classifier, userRules };
}

// ──────────────────────── 默认配置文件创建 ────────────────────────

function createDefaultConfigContent(): string {
	return `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
}

function ensureConfigFile(configPath: string, onWarning?: (msg: string) => void): void {
	if (existsSync(configPath)) return;
	try {
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, createDefaultConfigContent(), { encoding: "utf-8", mode: 0o600 });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		onWarning?.(`[pi-permission] Failed to create default config at '${configPath}': ${message}`);
	}
}

// ──────────────────────── 加载（带 mtime 缓存） ────────────────────────

/**
 * 加载配置，文件未变化时返回缓存。
 *
 * @param configPath 配置文件路径（默认 getConfigPath()）
 * @param onWarning 非致命问题（创建失败、解析失败）的警告回调
 */
export function loadAndWatchConfig(
	configPath: string = getConfigPath(),
	onWarning?: (msg: string) => void,
): PermissionConfig {
	ensureConfigFile(configPath, onWarning);

	let stat;
	try {
		stat = statSync(configPath);
	} catch {
		// 文件不可 stat（权限问题/被删除）→ 用缓存或默认
		const cached = configCache.get(configPath);
		return cached ? cached.config : { ...DEFAULT_CONFIG };
	}

	const cached = configCache.get(configPath);
	if (cached && cached.mtimeMs === stat.mtimeMs) {
		return cached.config;
	}

	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		const config = normalizeConfig(parsed);
		configCache.set(configPath, { mtimeMs: stat.mtimeMs, config });
		return config;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		onWarning?.(`[pi-permission] Config parse failed at '${configPath}', using default: ${message}`);
		const fallback = { ...DEFAULT_CONFIG, classifier: { ...DEFAULT_CLASSIFIER_CONFIG } };
		// 解析失败也更新缓存 mtime，避免每次都重读损坏文件
		configCache.set(configPath, { mtimeMs: stat.mtimeMs, config: fallback });
		return fallback;
	}
}

// ──────────────────────── 保存（原子写） ────────────────────────

/**
 * 保存配置（原子写：tmp 文件 + rename）。
 *
 * @returns 成功返回 {success:true}；失败返回 {success:false, error}
 */
export function saveConfig(
	config: PermissionConfig,
	configPath: string = getConfigPath(),
): { success: boolean; error?: string } {
	const normalized = normalizeConfig(config);
	const tmpPath = `${configPath}.tmp`;

	try {
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
		renameSync(tmpPath, configPath);

		// 更新缓存（用新文件的 mtime）
		try {
			const newStat = statSync(configPath);
			configCache.set(configPath, { mtimeMs: newStat.mtimeMs, config: normalized });
		} catch {
			// stat 失败不影响保存成功，缓存下次 load 时会重读
		}

		return { success: true };
	} catch (error) {
		try {
			if (existsSync(tmpPath)) unlinkSync(tmpPath);
		} catch {
			// 清理失败忽略
		}
		const message = error instanceof Error ? error.message : String(error);
		return { success: false, error: `Failed to save config at '${configPath}': ${message}` };
	}
}

/** 测试/内部用：设置特定路径的缓存（绕过文件系统） */
export function setConfigCache(configPath: string, config: PermissionConfig, mtimeMs: number): void {
	configCache.set(configPath, { mtimeMs, config });
}
