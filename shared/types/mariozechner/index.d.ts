/**
 * CI type stubs for Pi runtime modules.
 *
 * Ambient module declarations. Locally, tsconfig.json paths take priority and
 * resolve to real Pi types. These stubs approximate the real SDK shapes so that
 * CI (which lacks node_modules) can still catch type-level bugs — most notably
 * the ExtensionHandler two-parameter signature `(event, ctx)`.
 */
declare module "@mariozechner/pi-coding-agent" {
	// Re-export everything as `any` — CI only verifies syntax/structure
	// NOTE: ExtensionAPI / SessionStartEvent / ExtensionHandler are precise below
	//       so CI catches the ExtensionHandler `(event, ctx)` two-param signature.
	export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

	export interface ExtensionContext {
		cwd: string;
		sessionManager: ReadonlySessionManager;
		modelRegistry: {
			getAvailable(): Array<{ id: string; provider: string; name: string; reasoning: boolean; thinkingLevelMap?: Record<string, string | null>; contextWindow?: number }>;
			find(provider: string, modelId: string): { id: string; provider: string; name: string; reasoning: boolean; thinkingLevelMap?: Record<string, string | null>; contextWindow?: number } | undefined;
			hasConfiguredAuth(model: unknown): boolean;
		};
		getContextUsage(): ContextUsage | undefined;
		hasUI: boolean;
		ui: {
			notify(msg: string, type?: string): void;
			confirm(title: string, message: string, opts?: unknown): Promise<boolean>;
			select(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
			input(title: string, placeholder?: string, opts?: unknown): Promise<string | undefined>;
			setStatus(key: string, text: string | undefined): void;
			setWidget(key: string, content: unknown, options?: unknown): void;
			setFooter(factory: unknown): void;
			theme: Theme;
			custom<T = void>(factory: (tui: any, theme: any, kb: any, done: (result: T) => void) => any, options?: { overlay?: boolean; overlayOptions?: Record<string, unknown> }): Promise<T>;
		};
		theme: Theme;
		model: any;
		signal: AbortSignal | undefined;
		isIdle(): boolean;
		abort(): void;
		hasPendingMessages(): boolean;
		shutdown(): void;
		compact(options?: any): void;
		getSystemPrompt(): string;
	}
	export type ContextEvent = any;
	export type ContextUsage = any;
	export type ReadonlySessionManager = Pick<SessionManager, "getCwd" | "getSessionDir" | "getSessionId" | "getSessionFile" | "getLeafId" | "getLeafEntry" | "getEntry" | "getLabel" | "getBranch" | "getHeader" | "getEntries" | "getTree" | "getSessionName">;

	export interface SessionManager {
		getSessionId(): string;
		getSessionFile(): string | undefined;
		getSessionDir(): string;
		getCwd(): string;
		getEntries(): SessionEntry[];
		getBranch(): any[];
		getLeafId(): string | null;
		getLeafEntry(): SessionEntry | undefined;
		getEntry(id: string): SessionEntry | undefined;
		getHeader(): any | null;
		getTree(): any[];
		getSessionName(): string | undefined;
		// Write methods (available on full SessionManager, NOT on ReadonlySessionManager)
		appendMessage(message: any): string;
		appendCustomEntry(customType: string, data?: unknown): string;
		appendCustomMessageEntry<T = unknown>(customType: string, content: string | any[], display: boolean, details?: T): string;
		appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number, details?: unknown, fromHook?: boolean): string;
		appendThinkingLevelChange(thinkingLevel: string): string;
		appendModelChange(provider: string, modelId: string): string;
		appendSessionInfo(name: string): string;
		appendLabelChange(targetId: string, label: string | undefined): string;
		branch(branchFromId: string): void;
		branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromHook?: boolean): string;
		resetLeaf(): void;
		buildSessionContext(): { messages: any[]; thinkingLevel: string; model: any | null };
		setSessionFile(sessionFile: string): void;
		isPersisted(): boolean;
		newSession(options?: any): string | undefined;
	}

	export type SessionEntry = any;
	export type CustomEntry<T = Record<string, unknown>> = SessionEntry & { customType: string } & T;
	export type Theme = any;
	export type ThemeColor = string;
	export type ExtensionCommandContext = any;
	export type AgentToolResult<T = any> = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; details: T };
	export type TurnEndEvent = any;
	export type SessionBeforeCompactEvent = any;
	export type SessionBeforeCompactResult = any;
	export type SessionBeforeTreeEvent = any;
	export type SessionBeforeTreeResult = any;
	export type SessionShutdownEvent = any;
	export type SessionStartEvent = {
		type: "session_start";
		reason: "startup" | "reload" | "new" | "resume" | "fork";
		previousSessionFile?: string;
		// ⚠️ Note: modelRegistry / cwd / ui are NOT on this event.
		// They live on ExtensionContext (the 2nd handler parameter).
	};
	/** ExtensionHandler signature: (event, ctx) — TWO parameters. */
	export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;
	export type RegisteredTool = any;
	export type RegisteredCommand = any;
	export type CustomMessageEntry = any;
	export type ToolCallEvent = any;
	export type ToolResultEvent = any;
	export type FileEntry = any;
	export type ReadonlyFooterDataProvider = any;
	export type ExtensionContextActions = any;
	export type ExtensionCommandContext = ExtensionContext;
	export type BeforeAgentStartEvent = any;
	export type BeforeAgentStartEventResult = any;

	/** Pi ExtensionAPI — the `pi` object passed to extension factories.
	 * Precise subset of the real SDK interface covering all methods used by this
	 * monorepo's extensions. NOT `any` — so the compiler enforces:
	 *   1. `on("session_start", handler)` → handler is `(event, ctx) => ...` (two params),
	 *      reading modelRegistry/cwd/ui from the 2nd param (ExtensionContext).
	 *   2. method names actually exist (catches typos like `senduserMessage`).
	 * Methods are required (not optional) since the real SDK always provides them. */
	export interface ExtensionAPI {
		on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
		on(event: string, handler: (...args: any[]) => unknown): void;
		registerTool(tool: unknown): void;
		registerCommand(name: string, command: unknown): void;
		registerShortcut(shortcut: unknown, options: unknown): void;
		registerFlag(name: string, options: unknown): void;
		getFlag(name: string): boolean | string | undefined;
		registerMessageRenderer(customType: string, renderer: unknown): void;
		sendMessage(message: unknown, options?: unknown): void;
		sendUserMessage(content: string | unknown[], options?: unknown): void;
		appendEntry(customType: string, data?: unknown): void;
		setSessionName(name: string): void;
		getSessionName(): string | undefined;
		setLabel(entryId: string, label: string | undefined): void;
		exec(command: string, args: string[], options?: unknown): Promise<unknown>;
		getActiveTools(): string[];
		getAllTools(): Array<{ name: string }>;
		setActiveTools(toolNames: string[]): void;
		getCommands(): Array<{ name: string }>;
		getThinkingLevel(): string;
		setThinkingLevel(level: string): void;
		events: { emit(channel: string, data: unknown): void; on?(channel: string, handler: (...args: any[]) => void): void };
		// 扩展间私有协议（goal/workflow 用 __ 前缀注入字段）
		[key: `__${string}`]: unknown;
	}

	export function setActiveTools(tools: string[]): void;
	export function sendUserMessage(message: string, options?: Record<string, unknown>): void;
	export function appendEntry(customType: string, data?: unknown): void;
	export function registerTool(tool: unknown): void;
	export function registerCommand(name: string, command: unknown): void;
	export function on(event: string, handler: (...args: any[]) => Promise<unknown>): void;

	export function getAgentDir(): string;
	export function getMarkdownTheme(): Theme;
	export function parseFrontmatter<T = Record<string, unknown>>(text: string): { frontmatter: T; body: string };
	export function withFileMutationQueue(filePath: string, fn: () => Promise<void>): Promise<void>;
}

declare module "@mariozechner/pi-tui" {
	export class Text {
		constructor(text?: string, paddingX?: number, paddingY?: number, customBgFn?: (text: string) => string);
		setText(text: string): void;
		setCustomBgFn(customBgFn?: (text: string) => string): void;
		invalidate(): void;
		render(width: number): string[];
	}
	export class Box {
		constructor(paddingX?: number, paddingY?: number, bgFn?: (text: string) => string);
		children: any[];
		addChild(component: any): void;
		removeChild(component: any): void;
		clear(): void;
		setBgFn(bgFn?: (text: string) => string): void;
		invalidate(): void;
		render(width: number): string[];
	}
	export class Container {
		children: any[];
		constructor(children?: any[]);
		addChild(child: any): void;
		removeChild(child: any): void;
		clear(): void;
		invalidate(): void;
	}
	export class Spacer {
		constructor(size?: number);
	}
	export class Markdown {
		constructor(text: string, x?: number, y?: number, theme?: any);
	}
	export interface Component {
		render(width: number): string[];
		invalidate(): void;
		handleInput?(data: string): void;
		wantsKeyRelease?: boolean;
	}
	export function matchesKey(key: any, binding: any): boolean;
	export function truncateToWidth(text: string, width: number): string;
	export function visibleWidth(str: string): number;
	export const Key: {
		escape: string; up: string; down: string; left: string; right: string;
		enter: string; space: string; tab: string; backspace: string; delete: string;
		ctrl(k: string): string; shift(k: string): string; alt(k: string): string;
	};
	export interface SelectItem {
		value: string;
		label: string;
		description?: string;
	}
	export interface SelectListTheme {
		selectedPrefix: (text: string) => string;
		selectedText: (text: string) => string;
		description: (text: string) => string;
		scrollInfo: (text: string) => string;
		noMatch: (text: string) => string;
	}
	export class SelectList {
		constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme, layout?: unknown);
		onSelect?: (item: SelectItem) => void;
		onCancel?: () => void;
		setSelectedIndex(index: number): void;
		setFilter(filter: string): void;
		getSelectedItem(): SelectItem | null;
		handleInput(data: string): void;
		invalidate(): void;
		render(width: number): string[];
	}
	export class Input {
		onSubmit?: (value: string) => void;
		onEscape?: () => void;
		getValue(): string;
		setValue(value: string): void;
		handleInput(data: string): void;
		invalidate(): void;
		render(width: number): string[];
	}
	export interface KeybindingsManager {
		matches(data: string, keybinding: string): boolean;
		getKeys(keybinding: string): string[];
	}
	export function getKeybindings(): KeybindingsManager;
	export function setKeybindings(kb: KeybindingsManager): void;
	export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[];
}

declare module "@mariozechner/pi-ai" {
	export function StringEnum<T extends readonly string[]>(values: T, options?: Record<string, unknown>): T[number];
	export type Message = any;
	export type AssistantMessage = any;
}

declare module "@earendil-works/pi-coding-agent" {
	export * from "@mariozechner/pi-coding-agent";
	// Additional exports used by subagent/extension
	export type Message = any;
	export type AgentToolResult<T = any> = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; details: T };
	export function parseFrontmatter<T = Record<string, unknown>>(text: string): { frontmatter: T; body: string };
}
declare module "@earendil-works/pi-tui" {
	export * from "@mariozechner/pi-tui";
	export class MarkdownTheme {}
	export function matchesKey(key: any, binding: any): boolean;
	export function truncateToWidth(text: string, width: number): string;
	export function visibleWidth(str: string): number;
	export class Component {}
}
declare module "@earendil-works/pi-ai" {
	export * from "@mariozechner/pi-ai";
	export type Message = any;
}

declare module "typebox" {
	export const Type: {
		Object(properties: Record<string, any>, options?: Record<string, any>): any;
		String(options?: Record<string, any>): any;
		Number(options?: Record<string, any>): any;
		Boolean(options?: Record<string, any>): any;
		Array(items: any, options?: Record<string, any>): any;
		Optional(schema: any): any;
		Union(schemas: any[], options?: Record<string, any>): any;
		Literal(value: any): any;
		Record(key: any, value: any, options?: Record<string, any>): any;
		Unknown(options?: Record<string, any>): any;
	};
	export type Static<T> = Record<string, any>;
}

declare module "@sinclair/typebox" {
	export * from "typebox";
}

declare module "@zhushanwen/pi-quota-providers" {
	export function loadProviderConfig(...args: any[]): any;
	export function loadQuotaConfig(...args: any[]): any;
	export function readCache(...args: any[]): CacheData;
	export function triggerUpdate(...args: any[]): void;
	export function trackSpeed(...args: any[]): void;
	export function trackCacheRatio(...args: any[]): any;
	export function buildRuntimeProviders(...args: any[]): any[];
	export function getConfigDir(...args: any[]): string;
	export function getProvidersConfigPath(...args: any[]): string;
	export function getSecretsPath(...args: any[]): string;
	export function loadProvidersConfig(...args: any[]): any;
	export function loadSecrets(...args: any[]): any;
	export const PROVIDERS: any[];
	export const INFINITE_WIN: QuotaWindow;
	export type CacheData = any;
	export type SpeedData = any;
	export type CacheRatioData = any;
	export type QuotaWindow = any;
	export type QuotaProvider = any;
	export type NormalizedQuotaRow = any;
	export type ProviderConfig = any;
	export type QuotaConfig = any;
	export type ResolvedProvider = any;
}

declare module "@zhushanwen/pi-model-switch" {
	export function resolveModelByComplexity(...args: any[]): any;
	export function resolveModelForScene(...args: any[]): any;
	export type ModelAdvisorResult = any;
}

declare module "js-yaml" {
	export function load(text: string, opts?: Record<string, unknown>): unknown;
	export function dump(obj: unknown, opts?: Record<string, unknown>): string;
}
