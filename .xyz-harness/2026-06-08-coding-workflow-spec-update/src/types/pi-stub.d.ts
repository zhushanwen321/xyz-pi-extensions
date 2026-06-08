// Pi SDK type stubs for standalone implementation

declare module "typebox" {
  export const Type: {
    Object(props: Record<string, unknown>, options?: Record<string, unknown>): unknown;
    String(options?: Record<string, unknown>): unknown;
    Number(options?: Record<string, unknown>): unknown;
  };
}

interface ExtensionAPI {
  registerTool(tool: unknown): void;
  registerCommand(name: string, handler: unknown): void;
  sendUserMessage(message: string, options?: Record<string, unknown>): void;
  appendEntry(type: string, data: unknown): void;
  events: { emit: (event: string, data: unknown) => void };
  getSessionName(): string;
}

interface ExtensionContext {
  sessionManager: {
    getSessionId(): string;
    getEntries(): unknown[];
    getSessionFile(): string | undefined;
    getLeafId(): string | null;
  };
  ui: {
    notify(message: string, type: string): void;
    theme: unknown;
    setWidget(name: string, content: unknown): void;
    setStatus(name: string, status: unknown): void;
  };
  hasUI: boolean;
  modelRegistry: { getAvailable(): unknown[] };
  model?: { provider: string };
  cwd: string;
}

interface ImportMeta {
  dirname: string;
}

declare const MAX_SLUG_LENGTH = 60;
declare const MIN_SLUG_LENGTH = 2;

declare module "@zhushanwen/pi-workflow" {
  export class WorkflowOrchestrator {
    constructor(pi: ExtensionAPI, ctx: ExtensionContext, maxConcurrency?: number);
    run(
      name: string,
      args: Record<string, unknown>,
      budgetTokens?: number,
      budgetTimeMs?: number,
      signal?: AbortSignal,
    ): Promise<string>;
    getInstance(runId: string): { status?: string; scriptResult?: unknown } | undefined;
  }
}
