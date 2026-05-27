/**
 * 共享文件日志模块 — 所有扩展复用
 *
 * 日志写入 ~/.pi/agent/logs/<prefix>-YYYY-MM-DD.log，不输出到控制台。
 * 扩展在 Pi 进程内执行，console.error/warn 的输出会被 TUI 捕获并显示给用户，
 * 干扰正常交互。此模块将调试日志隔离到文件，方便排查问题。
 *
 * 用法：
 *   import { createLogger } from "../../shared/logger.js";
 *   const log = createLogger("usage-tracker");
 *   log.info("Turn %d started", turn);
 *   log.warn("Config missing: %s", path);
 *   log.error("Failed: %s", err.message);
 */

import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── 日志级别 ────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

// ── 日志目录 ────────────────────────────────────────

const LOG_DIR = join(homedir(), ".pi", "agent", "logs");

function ensureLogDir(): void {
	if (!existsSync(LOG_DIR)) {
		mkdirSync(LOG_DIR, { recursive: true });
	}
}

// ── 格式化 ──────────────────────────────────────────

function timestamp(): string {
	return new Date().toISOString();
}

function formatMessage(level: LogLevel, prefix: string, args: unknown[]): string {
	const ts = timestamp();
	const msg = args
		.map((a) => {
			if (typeof a === "string") return a;
			try {
				return JSON.stringify(a);
			} catch {
				return String(a);
			}
		})
		.join(" ");
	return `${ts} [${level.toUpperCase()}] [${prefix}] ${msg}\n`;
}

// ── Logger 接口 ─────────────────────────────────────

export interface Logger {
	debug(...args: unknown[]): void;
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
}

// ── 工厂 ────────────────────────────────────────────

/**
 * 创建文件日志器。
 *
 * @param prefix  日志前缀，通常是扩展名（如 "usage-tracker"）
 * @param minLevel 最低日志级别，默认 "info"。可通过环境变量 PI_LOG_LEVEL 覆盖。
 */
export function createLogger(prefix: string, minLevel: LogLevel = "info"): Logger {
	const envLevel = process.env.PI_LOG_LEVEL as LogLevel | undefined;
	const effectiveLevel: LogLevel =
		envLevel && envLevel in LEVEL_ORDER ? envLevel : minLevel;

	const threshold = LEVEL_ORDER[effectiveLevel];

	function write(level: LogLevel, args: unknown[]): void {
		if (LEVEL_ORDER[level] < threshold) return;

		ensureLogDir();
		const date = new Date().toISOString().slice(0, 10);
		const filePath = join(LOG_DIR, `${prefix}-${date}.log`);
		const line = formatMessage(level, prefix, args);

		try {
			appendFileSync(filePath, line, "utf-8");
		} catch {
			// 写日志失败时静默，避免递归错误
		}
	}

	return {
		debug: (...args: unknown[]) => write("debug", args),
		info: (...args: unknown[]) => write("info", args),
		warn: (...args: unknown[]) => write("warn", args),
		error: (...args: unknown[]) => write("error", args),
	};
}
