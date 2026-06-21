// src/__tests__/agent-registry.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentRegistry, createPackageBuiltinRegistry, parseAgentFrontmatter } from "../core/agent-registry.ts";
import type { BuiltinAgentRegistry } from "../core/agent-registry.ts";

// ============================================================
// helpers
// ============================================================

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-reg-test-"));
}

function writeAgent(dir: string, name: string, body: string): string {
  const filePath = path.join(dir, `${name}.md`);
  fs.writeFileSync(filePath, body, "utf-8");
  return filePath;
}

const emptyBuiltin: BuiltinAgentRegistry = { get: () => undefined, list: () => [] };

// ============================================================
// parseAgentFrontmatter
// ============================================================

describe("parseAgentFrontmatter", () => {
  it("parses name from filename + body as systemPrompt when no frontmatter", () => {
    const cfg = parseAgentFrontmatter("/x/worker.md", "You are a worker.");
    expect(cfg.name).toBe("worker");
    expect(cfg.systemPrompt).toBe("You are a worker.");
  });
  it("extracts model/thinkingLevel/tools from frontmatter", () => {
    const cfg = parseAgentFrontmatter("/x/coder.md", `---
model: anthropic/claude-sonnet-4-5
thinkingLevel: high
tools: bash, read, edit
---
You write code.`);
    expect(cfg.name).toBe("coder");
    expect(cfg.model).toBe("anthropic/claude-sonnet-4-5");
    expect(cfg.thinkingLevel).toBe("high");
    expect(cfg.tools).toEqual(["bash", "read", "edit"]);
    expect(cfg.systemPrompt).toBe("You write code.");
  });
});

// ============================================================
// AgentRegistry.discoverAll — directory scan + priority
// ============================================================

describe("AgentRegistry.discoverAll", () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("discovers all .md agents in a directory", () => {
    writeAgent(dir, "worker", "do work");
    writeAgent(dir, "scout", "explore");
    const reg = new AgentRegistry([dir]);
    reg.discoverAll(emptyBuiltin);
    expect(reg.list().sort()).toEqual(["scout", "worker"]);
  });

  it("earlier directory overrides later on name clash (priority)", () => {
    const hi = tmpDir();
    const lo = tmpDir();
    writeAgent(hi, "worker", "high-priority body");
    writeAgent(lo, "worker", "low-priority body");
    const reg = new AgentRegistry([hi, lo]);
    reg.discoverAll(emptyBuiltin);
    expect(reg.get("worker")?.systemPrompt).toBe("high-priority body");
    fs.rmSync(hi, { recursive: true, force: true });
    fs.rmSync(lo, { recursive: true, force: true });
  });

  it("file agents override builtin on name clash", () => {
    writeAgent(dir, "worker", "file-worker");
    const builtin: BuiltinAgentRegistry = {
      get: (n) => (n === "worker" ? { name: "worker", systemPrompt: "builtin-worker" } : undefined),
      list: () => ["worker"],
    };
    const reg = new AgentRegistry([dir]);
    reg.discoverAll(builtin);
    expect(reg.get("worker")?.systemPrompt).toBe("file-worker");
  });

  it("builtin fills in when no file agent exists", () => {
    const builtin: BuiltinAgentRegistry = {
      get: (n) => (n === "oracle" ? { name: "oracle", systemPrompt: "builtin-oracle" } : undefined),
      list: () => ["oracle"],
    };
    const reg = new AgentRegistry([dir]);
    reg.discoverAll(builtin);
    expect(reg.get("oracle")?.systemPrompt).toBe("builtin-oracle");
  });

  it("get with require=true throws listing discovered agents", () => {
    writeAgent(dir, "worker", "x");
    const reg = new AgentRegistry([dir]);
    reg.discoverAll(emptyBuiltin);
    expect(() => reg.get("nonexistent", true)).toThrow(/Agent "nonexistent" not found.*Discovered: worker/);
  });

  it("ignores files not ending in .md or starting with _", () => {
    writeAgent(dir, "real", "body");
    writeAgent(dir, "_skip", "ignored");
    fs.writeFileSync(path.join(dir, "readme.txt"), "not an agent");
    const reg = new AgentRegistry([dir]);
    reg.discoverAll(emptyBuiltin);
    expect(reg.list()).toEqual(["real"]);
  });

  it("nonexistent directory is silently skipped", () => {
    const reg = new AgentRegistry([path.join(dir, "does-not-exist")]);
    expect(() => reg.discoverAll(emptyBuiltin)).not.toThrow();
    expect(reg.list()).toEqual([]);
  });
});

// ============================================================
// createPackageBuiltinRegistry — 包内 agents/ 扫描
// ============================================================

describe("createPackageBuiltinRegistry", () => {
  it("discovers packaged agents/*.md (worker, reviewer, scout, etc.)", () => {
    // [HISTORICAL] S6: 包内 agents/ 此前未被接通——discoverAll 从未调用，
    // 导致 pi install 后包内 agent 定义开箱不可用。
    const builtin = createPackageBuiltinRegistry();
    const names = builtin.list();
    // 包内至少有 worker/reviewer/scout 等核心 agent
    expect(names).toEqual(expect.arrayContaining(["worker", "reviewer", "scout", "researcher", "planner", "oracle", "context-builder"]));
    // 每个 agent 都有 systemPrompt
    for (const name of names) {
      const cfg = builtin.get(name);
      expect(cfg).toBeDefined();
      expect(cfg?.systemPrompt.length).toBeGreaterThan(0);
    }
  });
});
