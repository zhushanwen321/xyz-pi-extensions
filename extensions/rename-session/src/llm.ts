import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { CONFIG, extractTitle } from "./pure.js";

/** sessionDir 路径含 subagents 段 → 是 subagent 子进程 session，跳过 rename。 */
export function isSubagentSession(sessionDir: string): boolean {
	return sessionDir.includes(path.sep + "subagents" + path.sep);
}

/** entry 的宽松类型（structural typing，兼容 pi 的 SessionEntry[] 但不依赖 pi 类型） */
interface EntryLike {
	type: string;
	message?: unknown;
}

/**
 * 从 session entries 构造 messages 前缀，末尾追加 rename 指令 user message。
 * 取 type==='message' 的 entry.message，按原顺序保留（前缀与主 turn 字节级一致，命中 kvcache）。
 */
export function buildMessages(entries: ReadonlyArray<EntryLike>, instruction: string): unknown[] {
	const prefix = entries
		.filter((e) => e.type === "message" && e.message !== undefined)
		.map((e) => e.message as object);
	return [
		...prefix,
		{ role: "user", content: [{ type: "text", text: instruction }] },
	];
}

/** ToolInfo 的宽松类型（pi 的 ToolInfo 是 Pick<ToolDefinition,...> & {sourceInfo}） */
interface ToolInfoLike {
	name: string;
	description: string;
	parameters: object;
}

/** pi.getAllTools() 的 ToolInfo[] 转 pi-ai 的 Tool[]（只留 name/description/parameters，丢弃 sourceInfo 等扩展字段）。 */
export function mapToolsToAiFormat(tools: ReadonlyArray<ToolInfoLike>): ToolInfoLike[] {
	return tools.map((t) => ({
		name: t.name,
		description: t.description,
		parameters: t.parameters,
	}));
}

/** Auth 的判别联合宽松类型（对应 pi 的 ResolvedRequestAuth，getApiKeyAndHeaders 返回值）。 */
type AuthLike =
	| { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
	| { ok: false; error: string };

/** completeSimple 的 options 参数形状（与 pi compaction.ts/branch-summarization.ts 同款，对应 pi-ai 的 SimpleStreamOptions）。 */
interface CompleteOptions {
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	sessionId?: string;
	signal?: AbortSignal;
	maxTokens?: number;
}

/** completeSimple 返回的 AssistantMessage 的宽松形状（extractTitle 只读 content）。 */
interface CompleteResponse {
	content: ReadonlyArray<{ type: string; text?: string }>;
}

/**
 * 发起 rename LLM 调用，返回提取的标题（空串/异常时返回 null 表示应跳过 rename）。
 *
 * 动态 import completeSimple：加载阶段 pi-ai/compat 是 throwing stub（loader.ts 尚未 bindCore），
 * 必须延迟到 turn_end 处理时（bindCore 完成）才能 import 成功，故不能用顶层 import。
 */
export async function callRenameLLM(
	ctx: ExtensionContext,
	tools: ReadonlyArray<ToolInfoLike>,
): Promise<string | null> {
	const model = ctx.model;
	if (!model) return null;

	// ctx.modelRegistry 的 .d.ts 因 pi-ai 类型未完全解析而被降级（缺 getApiKeyAndHeaders），
	// 此处用宽松 ModelRegistryLike 收窄，运行时方法存在（pi 的 ModelRegistry 已实现）。
	const modelRegistry = ctx.modelRegistry as unknown as {
		getApiKeyAndHeaders(m: unknown): Promise<AuthLike>;
	};
	// getApiKeyAndHeaders 返回判别联合，必须显式检查 .ok 才能取 apiKey/headers
	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return null;

	const sessionId = ctx.sessionManager.getSessionId();
	const systemPrompt = ctx.getSystemPrompt();
	const messages = buildMessages(
		ctx.sessionManager.getEntries() as ReadonlyArray<EntryLike>,
		CONFIG.renameInstruction,
	);
	const mappedTools = mapToolsToAiFormat(tools);

	// 说明符断言为非字面量字符串：避免 TS 静态解析子路径 @earendil-works/pi-ai/compat
	// （tsconfig 仅映射了裸包名，子路径无 path mapping）。运行时由 loader 注册的 compat 模块解析。
	const moduleSpecifier: string = "@earendil-works/pi-ai/compat";
	const { completeSimple } = (await import(moduleSpecifier)) as {
		completeSimple: (model: unknown, context: unknown, options: CompleteOptions) => Promise<CompleteResponse>;
	};

	const resp = await completeSimple(
		model,
		{ systemPrompt, messages, tools: mappedTools },
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			sessionId,
			signal: ctx.signal,
			// 标题只需几个词，64 token 足够且省 quota
			maxTokens: 64,
		},
	);

	const title = extractTitle(resp, CONFIG.maxTitleLength);
	return title || null;
}
