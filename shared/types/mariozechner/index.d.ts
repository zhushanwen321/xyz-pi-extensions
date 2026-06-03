/**
 * CI type stubs for Pi runtime modules.
 *
 * Ambient module declarations that make all named imports resolve to `any`.
 * Locally, tsconfig.json paths take priority and resolve to real Pi types.
 */
declare module "@mariozechner/pi-coding-agent" {
	// Re-export everything as `any` — CI only verifies syntax/structure
	export type ExtensionAPI = any;
	export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

	export interface ExtensionContext {
		cwd: string;
		sessionManager: ReadonlySessionManager;
		modelRegistry: {
			getAvailable(): any[];
			find(provider: string, modelId: string): any | undefined;
		};
		getContextUsage(): ContextUsage | undefined;
		hasUI: boolean;
		ui: {
			notify(msg: string, type?: string): void;
			setStatus(id: string, msg: any): void;
			setWidget(id: string, widget: any): void;
			setFooter(factory: any): void;
			theme: Theme;
			custom<T = void>(factory: (tui: any, theme: any, kb: any, done: () => void) => any): Promise<T>;
		};
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
	export type AgentToolResult<T = any> = { content: Array<{ type: string; text: string }>; details: T };
	export type TurnEndEvent = any;
	export type SessionBeforeCompactEvent = any;
	export type SessionStartEvent = any;
	export type ExtensionHandler = any;
	export type RegisteredTool = any;
	export type RegisteredCommand = any;
	export type CustomMessageEntry = any;
	export type ToolCallEvent = any;
	export type ToolResultEvent = any;
	export type FileEntry = any;
	export type ReadonlyFooterDataProvider = any;
	export type ExtensionContextActions = any;
	export type ExtensionCommandContextActions = any;

	export function getAgentDir(): string;
	export function getMarkdownTheme(): Theme;
	export function parseFrontmatter<T = Record<string, unknown>>(text: string): { frontmatter: T; body: string };
	export function withFileMutationQueue(filePath: string, fn: () => Promise<void>): Promise<void>;
}

declare module "@mariozechner/pi-tui" {
	export class Text {
		constructor(text: string, x?: number, y?: number, width?: number);
	}
	export class Container {
		children: any[];
		constructor(children?: any[]);
		addChild(child: any): void;
	}
	export class Spacer {
		constructor(size?: number);
	}
	export class Markdown {
		constructor(text: string, x?: number, y?: number, theme?: any);
	}
	export class Component {}
	export function matchesKey(key: any, binding: any): boolean;
	export function truncateToWidth(text: string, width: number): string;
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
	export type AgentToolResult<T = any> = { content: Array<{ type: string; text: string }>; details: T };
	export function parseFrontmatter<T = Record<string, unknown>>(text: string): { frontmatter: T; body: string };
}
declare module "@earendil-works/pi-tui" {
	export * from "@mariozechner/pi-tui";
	export class MarkdownTheme {}
	export function matchesKey(key: any, binding: any): boolean;
	export function truncateToWidth(text: string, width: number): string;
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

declare module "js-yaml" {
	export function load(text: string, opts?: Record<string, unknown>): unknown;
	export function dump(obj: unknown, opts?: Record<string, unknown>): string;
}
