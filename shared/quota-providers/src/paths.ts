/**
 * 路径工具 — 统一从 Pi 的 getAgentDir() 派生所有路径
 *
 * 设计要点：
 * - 不做老路径 fallback（~/.pi/...），全部用 getAgentDir() 提供的新位置
 * - resolveEnvRef 支持 ${ENV_VAR} 占位符，无环境变量时静默返回空串
 */

import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { join } from "node:path";

/** 状态栏扩展的配置根目录（~/.pi/agent/config/） */
export function getConfigDir(): string {
	return join(getAgentDir(), "config");
}

/** providers.json 完整路径 */
export function getProvidersConfigPath(): string {
	return join(getConfigDir(), "providers.json");
}

/** secrets.json 完整路径 */
export function getSecretsPath(): string {
	return join(getConfigDir(), "secrets.json");
}

/** statusline_cache.json 路径 */
export function getCachePath(): string {
	return join(getAgentDir(), "statusline_cache.json");
}

/** token-stats 目录 */
export function getSpeedDir(): string {
	return join(getAgentDir(), "token-stats");
}

/** 解析 ${ENV_VAR} 引用 */
export function resolveEnvRef(value: string): string {
	const m = value.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/);
	if (!m) return value;
	const envVal = process.env[m[1]!];
	return envVal ?? "";
}
