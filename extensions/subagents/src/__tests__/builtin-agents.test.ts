// src/__tests__/builtin-agents.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for loadBuiltinAgents() fallback paths.
 *
 * BUILTIN_AGENTS is computed at module load time via `loadBuiltinAgents()`.
 * We use `vi.hoisted()` + `vi.mock("node:fs")` to create mutable mock
 * functions, then dynamically re-import to capture the result per scenario.
 */

const FALLBACK_NAMES = [
  "context-builder", "oracle", "planner", "researcher", "reviewer", "scout", "worker",
];

const mockReaddirSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());

vi.mock("node:fs", () => ({
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("loadBuiltinAgents fallback", () => {
  it("returns FALLBACK_AGENTS when readdirSync throws (missing agents dir)", async () => {
    mockReaddirSync.mockImplementation(() => {
      throw new Error("ENOENT: no such directory");
    });

    const { BUILTIN_AGENTS } = await import("../registry/builtin-agents.ts");
    const names = BUILTIN_AGENTS.map((a) => a.name).sort();
    expect(names).toEqual(FALLBACK_NAMES);

    for (const agent of BUILTIN_AGENTS) {
      expect(agent.source).toBe("builtin");
    }
  });

  it("returns FALLBACK_AGENTS when readFileSync throws for all files", async () => {
    mockReaddirSync.mockReturnValue(["worker.md", "reviewer.md"]);
    mockReadFileSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    const { BUILTIN_AGENTS } = await import("../registry/builtin-agents.ts");
    const names = BUILTIN_AGENTS.map((a) => a.name).sort();
    expect(names).toEqual(FALLBACK_NAMES);
  });

  it("loads from .md files when fs operations succeed", async () => {
    mockReaddirSync.mockReturnValue(["worker.md"]);
    mockReadFileSync.mockReturnValue("---\nname: worker\nmodel: gpt-4o\n---\nCustom worker prompt.");

    const { BUILTIN_AGENTS } = await import("../registry/builtin-agents.ts");

    const worker = BUILTIN_AGENTS.find((a) => a.name === "worker");
    expect(worker).toBeDefined();
    expect(worker!.systemPrompt).toBe("Custom worker prompt.");
    expect(worker!.model).toBe("gpt-4o");
    expect(worker!.source).toBe("builtin");

    // Other agents should be filled from fallback
    expect(BUILTIN_AGENTS.length).toBeGreaterThanOrEqual(7);
  });
});
