import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getShellConfig } from "@mariozechner/pi-coding-agent";
import type { ShellContext } from "./types.js";

/**
 * Re-export Pi's battle-tested shell discovery.
 * Handles Windows Git Bash, Unix bash/sh fallback, custom path.
 */
export { getShellConfig as resolveShell } from "@mariozechner/pi-coding-agent";

/**
 * Build shell environment with Pi's bin dir prepended to PATH.
 * Mirrors Pi's internal getShellEnv() logic.
 */
export function buildShellEnv(): Record<string, string> {
	const binDir = path.join(os.homedir(), ".pi", "agent", "bin");
	const pathKey =
		Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const entries = currentPath.split(path.delimiter).filter(Boolean);

	const hasBinDir = entries.includes(binDir);
	const updatedPath = hasBinDir
		? currentPath
		: [binDir, currentPath].filter(Boolean).join(path.delimiter);

	return { ...process.env, [pathKey]: updatedPath } as Record<string, string>;
}

/**
 * Read Pi settings from ~/.pi/agent/settings.json and .pi/settings.json.
 * Returns shellPath and shellCommandPrefix if present.
 */
export function loadPiSettings(): {
	shellPath?: string;
	commandPrefix?: string;
} {
	for (const filePath of [
		path.join(os.homedir(), ".pi", "agent", "settings.json"),
		path.join(process.cwd(), ".pi", "settings.json"),
	]) {
		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			const data = JSON.parse(raw) as Record<string, unknown>;
			return {
				shellPath: typeof data.shellPath === "string" ? data.shellPath : undefined,
				commandPrefix:
					typeof data.shellCommandPrefix === "string"
						? data.shellCommandPrefix
						: undefined,
			};
		} catch (e: unknown) {
			// File missing or bad JSON — expected for first install
			void e;
		}
	}
	return {};
}

/**
 * Build the full ShellContext by combining shell config with env and prefix.
 */
export function buildShellContext(prefix?: string): ShellContext {
	const settings = loadPiSettings();
	const resolved = getShellConfig(settings.shellPath);
	return {
		shell: resolved.shell,
		args: resolved.args,
		env: buildShellEnv(),
		commandPrefix: prefix ?? settings.commandPrefix ?? "",
	};
}
