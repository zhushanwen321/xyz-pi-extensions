/**
 * Mock for @mariozechner/pi-coding-agent — minimal runtime surface for tests.
 *
 * Tests don't need real SDK runtime; they inject fakes via GateContext.pi.
 * The type-only imports (`import type { ExtensionAPI }`) resolve to this module
 * at test time via vitest alias, and the runtime exports here are unused.
 */
export interface ExtensionAPI {
  __workflowRun?: (...args: unknown[]) => Promise<unknown>;
  [key: string]: unknown;
}

export interface ExtensionContext {
  sessionManager: {
    getSessionId(): string;
    getEntries(): unknown[];
  };
  [key: string]: unknown;
}
