/**
 * setup-statusline 命令的 i18n prompt 模板
 *
 * 中英文切换：基于 Intl.DateTimeFormat().resolvedOptions().locale
 * 失败/非 zh locale → 英文
 *
 * demo 模板：providers.json 的结构由 quota-providers.PROVIDERS 动态生成
 *   （新增 provider 自动出现，无需改本文件）
 * secrets.json 的 env var 映射在下面 DEFAULT_SECRETS 集中维护
 *   （用户编辑后会自动覆盖默认值）
 */

import { PROVIDERS } from "@zhushanwen/pi-quota-providers";

export type Locale = "zh" | "en";

function detectLocale(): Locale {
	try {
		const locale = Intl.DateTimeFormat().resolvedOptions().locale;
		return /^zh/i.test(locale) ? "zh" : "en";
	} catch {
		return "en";
	}
}

export interface SetupPromptArgs {
	configDir: string;
	providersPath: string;
	secretsPath: string;
	missing: string[];
}

/** provider.id → 默认 secret 字段（key=value 形式，value 是 env var 占位符） */
const DEFAULT_SECRETS: Record<string, Record<string, string>> = {
	zhipu: { token: "${ZAI_AUTH_TOKEN}" },
	"opencode-go": { token: "${OPENCODE_GO_TOKEN}" },
	"kimi-coding": { token: "${KIMI_AUTH_TOKEN}" },
	minimax: { token: "${MINIMAX_TOKEN}" },
	tavily: { apiKey: "${TAVILY_API_KEY}" },
};

/** 从 PROVIDERS 动态生成 providers.json demo（自动跟随新增 provider） */
function buildDemoProvidersJson(): string {
	// 按 category 分组
	const groups: Record<string, string[]> = { "token-plans": [], "search-tools": [] };
	for (const p of PROVIDERS) {
		const key = p.category === "search-tool" ? "search-tools" : "token-plans";
		groups[key]!.push(JSON.stringify({
			id: p.id,
			label: p.label,
			enabled: true,
			fetcher: p.id,
		}));
	}

	const lines: string[] = ["{"];
	const sections: string[] = [];
	for (const [key, items] of Object.entries(groups)) {
		if (items.length === 0) continue;
		sections.push(`  "${key}": [\n${items.map((s) => `    ${s}`).join(",\n")}\n  ]`);
	}
	lines.push(sections.join(",\n"));
	lines.push("}");
	return lines.join("\n");
}

/** 从 DEFAULT_SECRETS 动态生成 secrets.json demo（仅含 PROVIDERS 实际支持的） */
function buildDemoSecretsJson(): string {
	const lines: string[] = ["{"];
	const sections: string[] = [];
	for (const p of PROVIDERS) {
		const fields = DEFAULT_SECRETS[p.id];
		if (!fields) continue;
		const fieldStr = Object.entries(fields)
			.map(([k, v]) => `    "${k}": "${v}"`)
			.join(",\n");
		sections.push(`  "${p.id}": {\n${fieldStr}\n  }`);
	}
	lines.push(sections.join(",\n"));
	lines.push("}");
	return lines.join("\n");
}

const T = {
	zh: {
		title: "# statusline 配置初始化",
		missing: (m: string[]) => `缺失文件：${m.join(", ")}`,
		task: "请帮我创建 demo 配置文件。",
		constraint1: "secrets.json 凭证请用 \\${ENV_VAR} 环境变量引用形式",
		constraint2: "providers.json 默认启用所有 provider（用户可后续编辑禁用）",
		constraint3: "创建完成后告诉用户可以编辑这两个文件",
		pathsHeader: "## 写入路径",
		providersHeader: "## providers.json demo",
		secretsHeader: "secrets.json demo",
		completeHeader: "## 完成后",
		completeTask: "读两个文件，输出最终内容给用户确认。",
	},
	en: {
		title: "# statusline setup",
		missing: (m: string[]) => `Missing files: ${m.join(", ")}`,
		task: "Generate demo config files for me.",
		constraint1: "Use \\${ENV_VAR} format in secrets.json for credentials",
		constraint2: "Enable all providers in providers.json by default (user can disable later)",
		constraint3: "After creating, tell the user they can edit these files",
		pathsHeader: "## Target paths",
		providersHeader: "## providers.json demo",
		secretsHeader: "## secrets.json demo",
		completeHeader: "## After writing",
		completeTask: "Read both files and show the final content to the user for confirmation.",
	},
} as const;

/** 生成让 LLM 写 demo 文件的引导 prompt */
export function buildGenerateDemoPrompt(args: SetupPromptArgs): string {
	const t = T[detectLocale()];
	return [
		t.title,
		"",
		t.missing(args.missing),
		"",
		"## 任务",
		t.task,
		"",
		"## 重要约束",
		`1. ${t.constraint1}`,
		`2. ${t.constraint2}`,
		`3. ${t.constraint3}`,
		"",
		t.pathsHeader,
		`- providers.json: \`${args.providersPath}\``,
		`- secrets.json: \`${args.secretsPath}\``,
		"",
		t.providersHeader,
		"```json",
		buildDemoProvidersJson(),
		"```",
		"",
		t.secretsHeader,
		"```json",
		buildDemoSecretsJson(),
		"```",
		"",
		t.completeHeader,
		t.completeTask,
	].join("\n");
}
