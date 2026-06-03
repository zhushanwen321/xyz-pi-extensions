/**
 * setup-statusline 命令的 i18n prompt 模板
 *
 * 中英文切换：基于 Intl.DateTimeFormat().resolvedOptions().locale
 * 失败/非 zh locale → 英文
 */

export type Locale = "zh" | "en";

export function detectLocale(): Locale {
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

const DEMO_PROVIDERS_JSON = `{
  "token-plans": [
    { "id": "zhipu", "label": "zhipu-coding-plan", "enabled": true, "fetcher": "zhipu" },
    { "id": "opencode-go", "label": "opencode-go", "enabled": true, "fetcher": "opencode-go" },
    { "id": "kimi-coding", "label": "kimi-coding-plan", "enabled": true, "fetcher": "kimi-coding" },
    { "id": "minimax", "label": "minimax-token-plan", "enabled": true, "fetcher": "minimax" }
  ],
  "search-tools": [
    { "id": "tavily", "label": "tavily", "enabled": true, "fetcher": "tavily" }
  ]
}`;

const DEMO_SECRETS_JSON = `{
  "zhipu": { "token": "\${ZAI_AUTH_TOKEN}" },
  "opencode-go": { "token": "\${OPENCODE_GO_TOKEN}" },
  "kimi-coding": { "token": "\${KIMI_AUTH_TOKEN}" },
  "minimax": { "token": "\${MINIMAX_TOKEN}" },
  "tavily": { "apiKey": "\${TAVILY_API_KEY}" }
}`;

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
		DEMO_PROVIDERS_JSON,
		"```",
		"",
		t.secretsHeader,
		"```json",
		DEMO_SECRETS_JSON,
		"```",
		"",
		t.completeHeader,
		t.completeTask,
	].join("\n");
}
