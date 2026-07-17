// mocks/pi-coding-agent.ts
//
// Vitest mock for @mariozechner/pi-coding-agent.
// Provides runtime values and minimal type stubs needed by the extension factory.

// ── Value exports ──
export function getAgentDir(): string {
  return "/home/user/.pi/agent";
}

// ── Type exports (minimal stubs for vitest resolution) ──
// These approximate the real SDK shapes enough for structural tests.

/** Pi run mode. Mirrors `ExtensionMode` from the real SDK
 *  (core/extensions/types.ts:207). Used by host-mode.ts. */
export type ExtensionMode = "tui" | "rpc" | "json" | "print";

export interface ExtensionAPI {
  registerTool(tool: unknown): void;
  registerCommand(cmd: unknown): void;
  registerMessageRenderer(name: string, renderer: unknown): void;
  on(event: string, handler: (...args: unknown[]) => void | Promise<void>): void;
  appendEntry(type: string, data: unknown): void;
  events: {
    emit(event: string, data: unknown): void;
    on(event: string, handler: (...args: unknown[]) => void): void;
  };
}

export interface ExtensionContext {
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getSessionDir(): string;
  };
  modelRegistry: unknown;
  model: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ResourcesDiscoverEvent {
  // marker interface
}

export interface ResourcesDiscoverResult {
  skillPaths?: string[];
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SessionStartEvent {
  // marker interface
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SessionShutdownEvent {
  // marker interface
}

// Re-exported from subagent-service.ts for PiLike
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Component {
  // marker interface for TUI components
}

export interface Theme {
  fg(token: string, text: string): string;
}

export interface AgentToolResult<T = unknown> {
  content: Array<{ type: string; text: string }>;
  details: T;
}
