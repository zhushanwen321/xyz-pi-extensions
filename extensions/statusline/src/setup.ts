/**
 * setup-statusline 命令
 *
 * 行为：
 * 1. 检查 ~/.pi/agent/config/{providers,secrets}.json 是否存在
 * 2. 都存在 → 加载并显示审查摘要
 * 3. 缺失 → 注入 prompt 让 LLM 生成 demo 文件
 *
 * 故意不做：交互式 wizard（让 LLM 处理）、chmod 校验、自动迁移老路径
 */

import { existsSync, mkdirSync } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
	getConfigDir,
	getProvidersConfigPath,
	getSecretsPath,
	loadProvidersConfig,
	loadSecrets,
} from "@zhushanwen/pi-quota-providers";
import { buildGenerateDemoPrompt } from "./setup-prompts.js";

export function registerSetupCommand(pi: ExtensionAPI): void {
	pi.registerCommand("setup-statusline", {
		description: "生成 statusline 的 providers.json + secrets.json demo（LLM 引导）",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const configDir = getConfigDir();
			const providersPath = getProvidersConfigPath();
			const secretsPath = getSecretsPath();

			try {
				mkdirSync(configDir, { recursive: true });
			} catch (e) {
				ctx.ui.notify(`Failed to create ${configDir}: ${(e as Error).message}`, "error");
				return;
			}

			const hasProviders = existsSync(providersPath);
			const hasSecrets = existsSync(secretsPath);

			// 都存在 → 审查模式
			if (hasProviders && hasSecrets) {
				const cfg = loadProvidersConfig();
				const secrets = loadSecrets();
				ctx.ui.notify(formatReviewSummary(cfg, secrets), "info");
				return;
			}

			// 缺失 → 让 LLM 写 demo
			const missing: string[] = [];
			if (!hasProviders) missing.push("providers.json");
			if (!hasSecrets) missing.push("secrets.json");

			const prompt = buildGenerateDemoPrompt({
				configDir,
				providersPath,
				secretsPath,
				missing,
			});

			pi.sendUserMessage(prompt);
			ctx.ui.notify(`Setup wizard started. Will generate: ${missing.join(", ")}`, "info");
		},
	});
}

function formatReviewSummary(
	cfg: ReturnType<typeof loadProvidersConfig>,
	secrets: ReturnType<typeof loadSecrets>,
): string {
	const lines: string[] = ["=== statusline config ==="];

	lines.push("token-plans:");
	if (cfg["token-plans"].length === 0) {
		lines.push("  (none)");
	} else {
		for (const p of cfg["token-plans"]) {
			const mark = p.enabled ? "✓" : "✗";
			const tag = secrets[p.id] ? "[secret ok]" : "[no secret]";
			lines.push(`  ${mark} ${p.label} (${p.id}) ${tag}`);
		}
	}

	lines.push("search-tools:");
	if (cfg["search-tools"].length === 0) {
		lines.push("  (none)");
	} else {
		for (const p of cfg["search-tools"]) {
			const mark = p.enabled ? "✓" : "✗";
			const tag = secrets[p.id] ? "[secret ok]" : "[no secret]";
			lines.push(`  ${mark} ${p.label} (${p.id}) ${tag}`);
		}
	}

	return lines.join("\n");
}
