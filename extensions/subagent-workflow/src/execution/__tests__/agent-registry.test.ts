// src/__tests__/agent-registry.test.ts
//
// AgentRegistry 测试（ADR-031 统一资源发现版）。
//
// agent 发现走 shared/resource-discovery，扫描路径由 workspaceRoot + agentDir 推导：
// - project 级：workspaceRoot/.pi/agents/ + workspaceRoot/.agents/agents/
// - user 级：agentDir/agents/ + ~/.agents/agents/
// - npm/dev：agentDir/npm/node_modules/*/ + agentDir/extensions/*/
//
// 测试用 tmp 目录作 workspaceRoot，在约定路径下放 agent 文件验证发现 + 优先级。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BuiltinAgentRegistry } from "../agent-registry.ts";
import { AgentRegistry, createPackageBuiltinRegistry, parseAgentFrontmatter } from "../agent-registry.ts";

// ============================================================
// helpers
// ============================================================

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-reg-test-"));
}

function writeAgent(dir: string, name: string, body: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.md`);
  fs.writeFileSync(filePath, body, "utf-8");
  return filePath;
}

const emptyBuiltin: BuiltinAgentRegistry = { get: () => undefined, list: () => [] };

/** 构造 AgentRegistry，workspaceRoot=ws，agentDir=ws/.fake-agent（隔离 user 级） */
function newRegistry(ws: string): AgentRegistry {
  return new AgentRegistry({
    workspaceRoot: ws,
    agentDir: path.join(ws, ".fake-agent"),
  });
}

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
// AgentRegistry.discoverAll — 统一资源发现
// ============================================================

describe("AgentRegistry.discoverAll", () => {
  let ws: string;
  beforeEach(() => { ws = tmpWorkspace(); });
  afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

  it("discovers all .md agents in project .pi/agents/", () => {
    const piAgents = path.join(ws, ".pi", "agents");
    writeAgent(piAgents, "worker", "do work");
    writeAgent(piAgents, "scout", "explore");
    const reg = newRegistry(ws);
    reg.discoverAll(emptyBuiltin);
    expect(reg.list().sort()).toEqual(["scout", "worker"]);
  });

  it("project .agents/agents overrides project .pi/agents on name clash (priority)", () => {
    writeAgent(path.join(ws, ".pi", "agents"), "worker", "pi-body");
    writeAgent(path.join(ws, ".agents", "agents"), "worker", "agents-body");
    const reg = newRegistry(ws);
    reg.discoverAll(emptyBuiltin);
    // .agents 优先级高于 .pi（buildScanTargets 顺序：project-pi 先于 project-agents）
    expect(reg.get("worker")?.systemPrompt).toBe("agents-body");
  });

  it("file agents override builtin on name clash", () => {
    writeAgent(path.join(ws, ".pi", "agents"), "worker", "file-worker");
    const builtin: BuiltinAgentRegistry = {
      get: (n) => (n === "worker" ? { name: "worker", systemPrompt: "builtin-worker" } : undefined),
      list: () => ["worker"],
    };
    const reg = newRegistry(ws);
    reg.discoverAll(builtin);
    expect(reg.get("worker")?.systemPrompt).toBe("file-worker");
  });

  it("builtin fills in when no file agent exists", () => {
    const builtin: BuiltinAgentRegistry = {
      get: (n) => (n === "oracle" ? { name: "oracle", systemPrompt: "builtin-oracle" } : undefined),
      list: () => ["oracle"],
    };
    const reg = newRegistry(ws);
    reg.discoverAll(builtin);
    expect(reg.get("oracle")?.systemPrompt).toBe("builtin-oracle");
  });

  it("get with require=true throws listing discovered agents", () => {
    writeAgent(path.join(ws, ".pi", "agents"), "worker", "x");
    const reg = newRegistry(ws);
    reg.discoverAll(emptyBuiltin);
    expect(() => reg.get("nonexistent", true)).toThrow(/Agent "nonexistent" not found.*Discovered: worker/);
  });

  it("ignores files not ending in .md, starting with _, or .chain.md", () => {
    const piAgents = path.join(ws, ".pi", "agents");
    writeAgent(piAgents, "real", "body");
    writeAgent(piAgents, "_skip", "ignored");
    writeAgent(piAgents, "trace", "ignored"); // trace.chain.md → 被跳过
    fs.renameSync(path.join(piAgents, "trace.md"), path.join(piAgents, "trace.chain.md"));
    fs.writeFileSync(path.join(piAgents, "readme.txt"), "not an agent");
    const reg = newRegistry(ws);
    reg.discoverAll(emptyBuiltin);
    expect(reg.list()).toEqual(["real"]);
  });

  it("nonexistent directory is silently skipped", () => {
    // workspaceRoot 下无任何 agents 目录 → 空结果，不抛错
    const reg = newRegistry(ws);
    expect(() => reg.discoverAll(emptyBuiltin)).not.toThrow();
    expect(reg.list()).toEqual([]);
  });
});

// ============================================================
// createPackageBuiltinRegistry — 包内 agents/ 扫描（走 pi.agents manifest）
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
