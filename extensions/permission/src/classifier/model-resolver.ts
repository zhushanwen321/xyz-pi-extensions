/**
 * Classifier 模型解析（model='auto' → 最便宜可用模型）
 *
 * 移植自 pi-coding-agent 的 ModelRegistry 思路，但只读 models.json（不刷新 OAuth、
 * 不合并内置模型），保持轻量。核心：
 *   - agentDir()：解析 agent 根目录（与 config.ts 同逻辑，G2 自实现，不依赖未导出的 getAgentDir）
 *   - loadModelsJson()：读 <agentDir>/models.json，含 onWarning 回调（G6）
 *   - findCheapestModel()：拍平 providers → 过滤 hasApiKey → 按 input cost 升序
 *   - resolveClassifierModel()：'auto' / 'provider/model-id' 两路解析
 *
 * 不直接 import pi-ai 的 Model 类型用于返回（ResolvedModel 只携带构造 Model<Api> 必需的字段，
 * 避免 here-stringing 一个完整 Model<Api>——api 是字符串联合类型，跨 provider 边界难捏造）。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ──────────────────────── agentDir（G2 自实现） ────────────────────────

/**
 * 解析 agent 根目录。
 *
 * 与 config.ts 的 getAgentDir 逻辑一致（env override 优先，否则 ~/.pi/agent），
 * 但此处显式 export 供 classifier 子模块复用——config.ts 的 getAgentDir 未导出。
 */
export function agentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	if (override) return override;
	return join(homedir(), ".pi", "agent");
}

// ──────────────────────── models.json schema（最小子集） ────────────────────────

/** 单个 model 的 cost 结构（与 pi-ai Model.cost 同形） */
interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** models.json 中单个 model 定义的最小子集（参考 pi-coding-agent parseModels） */
interface ModelsJsonModelDef {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	cost?: ModelCost;
	contextWindow?: number;
	maxTokens?: number;
}

/** models.json 中 provider 定义的最小子集 */
interface ModelsJsonProviderDef {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	models?: ModelsJsonModelDef[];
}

/** models.json 顶层结构 */
interface ModelsJsonFile {
	providers?: Record<string, ModelsJsonProviderDef>;
}

/**
 * 解析后的「扁平 model 条目」：附带其 provider 名 + 是否有 apiKey（auth 可用）。
 *
 * 这是 findCheapestModel / resolveClassifierModel 的中间表示，避免直接构造
 * pi-ai Model<Api>（api 联合类型难以跨 provider 安全构造）。
 */
export interface ResolvedModelEntry {
	provider: string;
	id: string;
	name: string;
	api: string;
	baseUrl?: string;
	cost: ModelCost;
	/** 该 provider 在 models.json 是否配置了 apiKey（auth 可用） */
	hasApiKey: boolean;
	/** 该 provider 的 apiKey（用于 streamSimple 调用） */
	apiKey?: string;
}

// ──────────────────────── loadModelsJson ────────────────────────

/**
 * 读取并解析 models.json。
 *
 * @param onWarning 非致命问题（文件缺失/解析失败）的警告回调；不抛错（fail-closed：返回 null）
 * @returns 解析后的 ModelsJsonFile；文件不存在或解析失败返回 null
 *
 * G6：显式 onWarning 参数，让调用方决定如何上报（console.warn / telemetry / 静默）。
 */
export function loadModelsJson(
	onWarning?: (msg: string) => void,
	filePath?: string,
): ModelsJsonFile | null {
	const path = filePath ?? join(agentDir(), "models.json");
	if (!existsSync(path)) {
		return null;
	}
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			onWarning?.(`[pi-permission] models.json root is not an object: ${path}`);
			return null;
		}
		return parsed as ModelsJsonFile;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		onWarning?.(`[pi-permission] Failed to parse models.json at '${path}': ${message}`);
		return null;
	}
}

// ──────────────────────── 拍平 + 查找 ────────────────────────

const DEFAULT_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** 把 models.json 拍平成 ResolvedModelEntry 列表（每个 provider.model 一条） */
export function flattenModels(data: ModelsJsonFile): ResolvedModelEntry[] {
	const providers = data.providers ?? {};
	const out: ResolvedModelEntry[] = [];
	for (const [providerName, providerDef] of Object.entries(providers)) {
		if (!providerDef || typeof providerDef !== "object") continue;
		const hasApiKey = typeof providerDef.apiKey === "string" && providerDef.apiKey.length > 0;
		const apiKey = hasApiKey ? providerDef.apiKey : undefined;
		const modelDefs = Array.isArray(providerDef.models) ? providerDef.models : [];
		for (const m of modelDefs) {
			if (!m || typeof m.id !== "string") continue;
			const api = m.api ?? providerDef.api;
			if (typeof api !== "string" || api.length === 0) continue; // 无法构造 Model<Api>
			out.push({
				provider: providerName,
				id: m.id,
				name: typeof m.name === "string" ? m.name : m.id,
				api,
				baseUrl: typeof m.baseUrl === "string" ? m.baseUrl : typeof providerDef.baseUrl === "string" ? providerDef.baseUrl : undefined,
				cost: m.cost ?? DEFAULT_COST,
				hasApiKey,
				apiKey,
			});
		}
	}
	return out;
}

/**
 * 在可用模型（hasApiKey===true）中找 input cost 最低的。
 *
 * @returns 最便宜的 ResolvedModelEntry；无可用模型返回 null
 */
export function findCheapestModel(data: ModelsJsonFile): ResolvedModelEntry | null {
	const entries = flattenModels(data).filter((m) => m.hasApiKey);
	if (entries.length === 0) return null;
	// 升序按 input cost，并列时取首个稳定项
	entries.sort((a, b) => a.cost.input - b.cost.input);
	return entries[0];
}

// ──────────────────────── listAvailableModels（W7 model picker 用） ────────────────────────

/**
 * 列出所有「可用」（provider 配了 apiKey）的模型，按 provider 分组成 Map。
 *
 * model picker（/permission model）用：第一级选 provider，第二级选该 provider 下的 model。
 * 与 findCheapestModel 的区别：
 *  - findCheapestModel 只返回单个最便宜模型（'auto' 解析用）
 *  - listAvailableModels 返回全量分组（picker 展示用）
 *
 * 排序规则：
 *  - provider 内 model 按 cost.input 升序，并列时按 id 字母序 tiebreaker
 *  - provider 之间按字母序（Map 保持插入序，便于 picker 稳定展示）
 *
 * 文件缺失 / 解析失败 → 返回空 Map（不 throw，调用方据此降级为「无可选模型」提示）。
 *
 * @param onWarning 文件读取/解析问题的警告回调（透传给 loadModelsJson）
 * @param filePath 可选，自定义 models.json 路径（测试用）
 * @returns Map<providerName, ResolvedModelEntry[]>（仅含 hasApiKey=true 的 provider）
 */
export function listAvailableModels(
	onWarning?: (msg: string) => void,
	filePath?: string,
): Map<string, ResolvedModelEntry[]> {
	const file = loadModelsJson(onWarning, filePath);
	if (file === null) return new Map();

	const entries = flattenModels(file).filter((m) => m.hasApiKey);
	// 按 provider 分组
	const grouped = new Map<string, ResolvedModelEntry[]>();
	for (const entry of entries) {
		const list = grouped.get(entry.provider);
		if (list === undefined) {
			grouped.set(entry.provider, [entry]);
		} else {
			list.push(entry);
		}
	}

	// provider 内排序：cost.input 升序 + id 字母序 tiebreaker
	for (const list of grouped.values()) {
		list.sort((a, b) => {
			if (a.cost.input !== b.cost.input) return a.cost.input - b.cost.input;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});
	}

	// provider 间按字母序重排（新建 Map 保持插入序）
	if (grouped.size > 1) {
		const sortedProviders = [...grouped.keys()].sort();
		const reordered = new Map<string, ResolvedModelEntry[]>();
		for (const p of sortedProviders) {
			reordered.set(p, grouped.get(p)!);
		}
		return reordered;
	}
	return grouped;
}

// ──────────────────────── resolveClassifierModel ────────────────────────

/**
 * classifier 解析后的模型规格（用于在 classifier.ts 构造 Model<Api> 调用 streamSimple）。
 *
 * G4：携带 baseUrl?/name?/inputCost?，让构造 Model<Api> 时能填真实值。
 */
export interface ResolvedModel {
	provider: string;
	id: string;
	api: string;
	name?: string;
	baseUrl?: string;
	inputCost?: number;
	apiKey?: string;
}

/**
 * 把 ClassifierConfig.model 规格解析为具体模型。
 *
 * - 'auto'：findCheapestModel（最便宜 + hasApiKey）
 * - 'provider/model-id'：精确查找（hasApiKey 不强制，调用方负责报错）
 * - 其他格式：视为无效，返回 null
 *
 * @param modelSpec ClassifierConfig.model（'auto' 或 'provider/model-id'）
 * @param data 可选，预加载的 models.json（避免重复读盘）；未传则 loadModelsJson()
 * @param onWarning 可选警告回调（仅传给 loadModelsJson）
 */
export function resolveClassifierModel(
	modelSpec: string,
	data?: ModelsJsonFile | null,
	onWarning?: (msg: string) => void,
): ResolvedModel | null {
	const file = data !== undefined ? data : loadModelsJson(onWarning);
	if (file === null) return null;

	if (modelSpec === "auto") {
		const cheapest = findCheapestModel(file);
		if (cheapest === null) return null;
		return {
			provider: cheapest.provider,
			id: cheapest.id,
			api: cheapest.api,
			name: cheapest.name,
			baseUrl: cheapest.baseUrl,
			inputCost: cheapest.cost.input,
			apiKey: cheapest.apiKey,
		};
	}

	// 'provider/model-id' 拆分查找
	const slashIdx = modelSpec.indexOf("/");
	if (slashIdx <= 0 || slashIdx === modelSpec.length - 1) {
		return null;
	}
	const provider = modelSpec.slice(0, slashIdx);
	const modelId = modelSpec.slice(slashIdx + 1);
	const entries = flattenModels(file);
	const found = entries.find((m) => m.provider === provider && m.id === modelId);
	if (found === undefined) return null;
	return {
		provider: found.provider,
		id: found.id,
		api: found.api,
		name: found.name,
		baseUrl: found.baseUrl,
		inputCost: found.cost.input,
		apiKey: found.apiKey,
	};
}
