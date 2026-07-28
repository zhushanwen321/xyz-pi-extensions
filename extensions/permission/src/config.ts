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
	size: number;
	config: PermissionConfig;
}

/** 深拷贝 config（防止调用方修改污染缓存） */
function cloneConfig(config: PermissionConfig): PermissionConfig {
	return {
		mode: config.mode,
		enabled: config.enabled,
		classifier: { ...config.classifier },
		userRules: config.userRules.map((r) => ({ ...r })),
	};
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
		return cached ? cloneConfig(cached.config) : cloneConfig(DEFAULT_CONFIG);
	}

	const cached = configCache.get(configPath);
	// mtime + size 双 key：防止 APFS 等文件系统 mtime 精度截断导致快速连续保存后缓存失效。
	//
	// 已知 limitation（m5）：mtime + size 不是内容指纹，「同毫秒同字节大小但内容不同」的写入
	// （如交换两条等长 userRules 的顺序）会误命中缓存返回旧 config。完整消除需内容哈希（如 sha256），
	// 但每次 load 都算哈希成本过高（config 可能较大），且 permission-config 写入频率低（用户手动编辑
	// 或 /permission 命令）、mtime 变化的概率远高于同毫秒同大小写不同内容，故权衡采用 mtime+size。
	// saveConfig 已在写后立即用新 stat 更新缓存（见下方 saveConfig），覆盖最常见的「写后读」竞态。
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return cloneConfig(cached.config);
	}

	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		const config = normalizeConfig(parsed);
		configCache.set(configPath, { mtimeMs: stat.mtimeMs, size: stat.size, config });
		return cloneConfig(config);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		onWarning?.(`[pi-permission] Config parse failed at '${configPath}', using default: ${message}`);
		const fallback = { ...DEFAULT_CONFIG, classifier: { ...DEFAULT_CLASSIFIER_CONFIG } };
		// 解析失败也更新缓存 mtime+size，避免每次都重读损坏文件
		configCache.set(configPath, { mtimeMs: stat.mtimeMs, size: stat.size, config: fallback });
		return cloneConfig(fallback);
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
	// 信任调用方传入的已类型化对象，不重新 normalize（避免 normalizeRule 重分配 fallback id 覆盖用户意图）
	const tmpPath = `${configPath}.tmp`;
	const content = `${JSON.stringify(config, null, 2)}\n`;

	try {
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
		renameSync(tmpPath, configPath);

		// 更新缓存（用新文件的 mtime + size）
		try {
			const newStat = statSync(configPath);
			configCache.set(configPath, { mtimeMs: newStat.mtimeMs, size: newStat.size, config: cloneConfig(config) });
		} catch (statErr) {
			// stat 失败不影响保存成功；缓存下次 load 时会重读。记录原因便于调试。
			console.warn(`[pi-permission] saveConfig stat after write failed:`, statErr instanceof Error ? statErr.message : String(statErr));
		}

		return { success: true };
	} catch (error) {
		try {
			if (existsSync(tmpPath)) unlinkSync(tmpPath);
		} catch (cleanupErr) {
			// tmp 清理失败不能阻塞保存失败的返回；记录原因
			console.warn(`[pi-permission] saveConfig tmp cleanup failed:`, cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr));
		}
		const message = error instanceof Error ? error.message : String(error);
		return { success: false, error: `Failed to save config at '${configPath}': ${message}` };
	}
}

/** 测试/内部用：设置特定路径的缓存（绕过文件系统） */
export function setConfigCache(configPath: string, config: PermissionConfig, mtimeMs: number, size: number): void {
	configCache.set(configPath, { mtimeMs, size, config });
}
