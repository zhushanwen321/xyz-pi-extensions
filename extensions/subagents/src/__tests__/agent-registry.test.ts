// src/__tests__/agent-registry.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { beforeEach,describe, expect, it } from "vitest";

import { AgentRegistry } from "../registry/agent-registry.ts";
import { BUILTIN_AGENTS, BuiltinAgentRegistry } from "../registry/builtin-agents.ts";

let tempDir: string;
let tempHome: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sub-cwd-"));
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "sub-home-"));
});

describe("BUILTIN_AGENTS", () => {
  it("has 7 builtin agents", () => {
    const names = BUILTIN_AGENTS.map((a) => a.name).sort();
    expect(names).toEqual(
      ["context-builder", "oracle", "planner", "researcher", "reviewer", "scout", "worker"]
    );
  });

  it("worker has extensions=true and builtin=all(undefined)", () => {
    const worker = BUILTIN_AGENTS.find((a) => a.name === "worker")!;
    expect(worker.extensions).toBe(true);
    expect(worker.builtinTools).toBeUndefined();
  });

  it("reviewer has extensions=false and builtin=[read]", () => {
    const reviewer = BUILTIN_AGENTS.find((a) => a.name === "reviewer")!;
    expect(reviewer.extensions).toBe(false);
    expect(reviewer.builtinTools).toEqual(["read"]);
  });
});

describe("BuiltinAgentRegistry", () => {
  it("allows registering custom builtin agents", () => {
    const reg = new BuiltinAgentRegistry();
    reg.register({
      name: "my-agent", systemPrompt: "custom",
      source: "builtin", builtinTools: ["read"], extensions: false,
    });
    expect(reg.get("my-agent")?.systemPrompt).toBe("custom");
  });

  it("get returns undefined for unknown", () => {
    const reg = new BuiltinAgentRegistry();
    expect(reg.get("nope")).toBeUndefined();
  });

  it("list returns all including defaults", () => {
    const reg = new BuiltinAgentRegistry();
    expect(reg.list().length).toBeGreaterThanOrEqual(7);
  });
});

describe("AgentRegistry", () => {
  it("discovers project-level .pi/agents/*.md", () => {
    const agentsDir = path.join(tempDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "custom.md"), `---
name: custom
model: deepseek-router/ds-flash
---
Custom prompt.`);
    const reg = new AgentRegistry(tempDir, tempHome);
    reg.discoverAll(new BuiltinAgentRegistry());
    expect(reg.get("custom")?.model).toBe("deepseek-router/ds-flash");
    expect(reg.get("custom")?.source).toBe("project");
  });

  it("builtin agents available when no file agents", () => {
    const reg = new AgentRegistry(tempDir, tempHome);
    reg.discoverAll(new BuiltinAgentRegistry());
    expect(reg.get("worker")?.source).toBe("builtin");
  });

  it("project-level overrides user-level (last writer wins)", () => {
    // user 级
    const userAgents = path.join(tempHome, ".pi", "agent", "agents");
    fs.mkdirSync(userAgents, { recursive: true });
    fs.writeFileSync(path.join(userAgents, "shared.md"), `---
name: shared
description: user version
---
user`);
    // project 级（优先级更高，后扫描覆盖）
    const projAgents = path.join(tempDir, ".pi", "agents");
    fs.mkdirSync(projAgents, { recursive: true });
    fs.writeFileSync(path.join(projAgents, "shared.md"), `---
name: shared
description: project version
---
project`);

    const reg = new AgentRegistry(tempDir, tempHome);
    reg.discoverAll(new BuiltinAgentRegistry());
    expect(reg.get("shared")?.description).toBe("project version");
    expect(reg.get("shared")?.source).toBe("project");
  });

  it("get throws for unknown agent when throwOnMissing=true", () => {
    const reg = new AgentRegistry(tempDir, tempHome);
    reg.discoverAll(new BuiltinAgentRegistry());
    expect(() => reg.get("nonexistent", true)).toThrow(/nonexistent/);
  });
});
