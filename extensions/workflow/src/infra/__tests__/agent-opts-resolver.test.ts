/**
 * resolveAgentOpts 单元测试（BL-1）
 *
 * 测试框架：vitest
 * 运行命令：npx vitest run src/infra/__tests__/agent-opts-resolver.test.ts
 *
 * 覆盖 resolveAgentOpts 的 3 条解析路径：
 *   1. agent → AgentRegistry.resolve → systemPrompt 写临时文件 → systemPromptFiles
 *   2. skill → resolveSkillPath → skillPath
 *   3. schema → 结构化输出指令写临时文件 → systemPromptFiles + schemaEnv
 *
 * 以及错误路径：agent 未找到 / skill 未找到 / 临时文件注册到 activeTempFiles。
 *
 * resolveSkillPath 内部用 process.cwd() 与 os.homedir()——skill 测试需 chdir 到
 * tmp fixture 或改 homeDir，见 skill-discovery.test.ts 同款隔离模式。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentCallOpts } from "../../engine/models/types";
import { AgentRegistry } from "../agent-discovery";
import { cleanupAllTempFiles, resolveAgentOpts } from "../agent-opts-resolver";

// ── Fixtures ─────────────────────────────────────────────────

interface Fixture {
  root: string;
  homeDir: string;
  sessionDir: string;
  activeTempFiles: Set<string>;
  cleanup: () => void;
}

function createFixture(agentFiles?: Record<string, string>): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opts-resolver-test-"));
  const homeDir = path.join(root, "__home__");
  fs.mkdirSync(homeDir, { recursive: true });
  const sessionDir = path.join(root, "session");
  fs.mkdirSync(sessionDir, { recursive: true });
  if (agentFiles) {
    for (const [relPath, content] of Object.entries(agentFiles)) {
      const fullPath = path.join(root, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, "utf-8");
    }
  }
  return {
    root,
    homeDir,
    sessionDir,
    activeTempFiles: new Set<string>(),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const AGENT_REVIEW = `---
name: code-review
description: "Code reviewer"
model: ds-flash
---

You are a meticulous code reviewer.
`;

// ── Tests ────────────────────────────────────────────────────

describe("resolveAgentOpts (BL-1)", () => {
  let fixture: Fixture | undefined;
  let origCwd: string | undefined;

  afterEach(() => {
    if (origCwd !== undefined) {
      process.chdir(origCwd);
      origCwd = undefined;
    }
    fixture?.cleanup();
    fixture = undefined;
  });

  // ── agent 解析 ──

  it("agent 已找到 → 写 systemPrompt 临时文件 + 填 systemPromptFiles + model fallback", () => {
    fixture = createFixture({ ".pi/agents/code-review.md": AGENT_REVIEW });
    const registry = new AgentRegistry(fixture.root, fixture.homeDir);
    registry.discoverAll();

    const opts: AgentCallOpts = { prompt: "review this" };
    const result = resolveAgentOpts(
      { ...opts, agent: "code-review" },
      registry,
      fixture.sessionDir,
      fixture.activeTempFiles,
    );

    expect(result.error).toBeUndefined();
    expect(result.opts.systemPromptFiles).toBeDefined();
    expect(result.opts.systemPromptFiles!.length).toBe(1);
    // model fallback：opts 未传 model → 用 agent 注册的 model
    expect(result.opts.model).toBe("ds-flash");
    // 临时文件已注册到 activeTempFiles
    expect(fixture.activeTempFiles.size).toBe(1);
    // 临时文件内容 = agent systemPrompt
    const tmpFile = result.opts.systemPromptFiles![0];
    expect(fs.readFileSync(tmpFile, "utf-8").trim()).toBe("You are a meticulous code reviewer.");
  });

  it("agent 未找到 → 返回 error", () => {
    fixture = createFixture();
    const registry = new AgentRegistry(fixture.root, fixture.homeDir);
    registry.discoverAll();

    const result = resolveAgentOpts(
      { prompt: "x", agent: "nonexistent" },
      registry,
      fixture.sessionDir,
      fixture.activeTempFiles,
    );

    expect(result.error).toBe("Agent not found: nonexistent");
    expect(result.opts.systemPromptFiles).toBeUndefined();
    expect(fixture.activeTempFiles.size).toBe(0);
  });

  it("agent 有 model 时 opts.model 优先（不被 agent model 覆盖）", () => {
    fixture = createFixture({ ".pi/agents/code-review.md": AGENT_REVIEW });
    const registry = new AgentRegistry(fixture.root, fixture.homeDir);
    registry.discoverAll();

    const result = resolveAgentOpts(
      { prompt: "x", agent: "code-review", model: "my-explicit-model" },
      registry,
      fixture.sessionDir,
      fixture.activeTempFiles,
    );

    expect(result.opts.model).toBe("my-explicit-model");
  });

  it("agent systemPrompt 为空 → 不写临时文件（systemPromptFiles 不加）", () => {
    fixture = createFixture({ ".pi/agents/empty.md": "---\nname: empty\n---\n\n" });
    const registry = new AgentRegistry(fixture.root, fixture.homeDir);
    registry.discoverAll();

    const result = resolveAgentOpts(
      { prompt: "x", agent: "empty" },
      registry,
      fixture.sessionDir,
      fixture.activeTempFiles,
    );

    expect(result.error).toBeUndefined();
    expect(result.opts.systemPromptFiles).toBeUndefined();
    expect(fixture.activeTempFiles.size).toBe(0);
  });

  // ── skill 解析 ──

  it("skill 已找到 → 填 skillPath（项目 .agents/skills 目录）", () => {
    fixture = createFixture();
    // resolveSkillPath 搜索 process.cwd()/.agents/skills/<name> —— chdir 到 fixture root
    const skillDir = path.join(fixture.root, ".agents", "skills", "my-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    origCwd = process.cwd();
    process.chdir(fixture.root);
    const registry = new AgentRegistry(fixture.root, fixture.homeDir);
    registry.discoverAll();

    const result = resolveAgentOpts(
      { prompt: "x", skill: "my-skill" },
      registry,
      fixture.sessionDir,
      fixture.activeTempFiles,
    );

    expect(result.error).toBeUndefined();
    // resolveSkillPath 内部用 path.resolve（会解析 macOS /var → /private/var 符号链接），
    // 故预期值需 realpathSync 标准化。
    expect(result.opts.skillPath).toBe(fs.realpathSync(skillDir));
  });

  it("skill 未找到 → 返回 error", () => {
    fixture = createFixture();
    origCwd = process.cwd();
    process.chdir(fixture.root);
    const registry = new AgentRegistry(fixture.root, fixture.homeDir);
    registry.discoverAll();

    const result = resolveAgentOpts(
      { prompt: "x", skill: "nonexistent-skill" },
      registry,
      fixture.sessionDir,
      fixture.activeTempFiles,
    );

    expect(result.error).toContain("Skill not found: nonexistent-skill");
    expect(result.opts.skillPath).toBeUndefined();
  });

  // ── schema 解析 ──

  it("schema 提供 → 写 structured-output 指令临时文件 + 填 schemaEnv", () => {
    fixture = createFixture();
    const registry = new AgentRegistry(fixture.root, fixture.homeDir);
    registry.discoverAll();

    const schema = { type: "object", properties: { score: { type: "number" } } };
    const result = resolveAgentOpts(
      { prompt: "x", schema },
      registry,
      fixture.sessionDir,
      fixture.activeTempFiles,
    );

    expect(result.error).toBeUndefined();
    expect(result.opts.schemaEnv).toBe(JSON.stringify(schema));
    expect(result.opts.systemPromptFiles).toBeDefined();
    expect(result.opts.systemPromptFiles!.length).toBe(1);
    // 临时文件内容含 structured-output 指令
    const content = fs.readFileSync(result.opts.systemPromptFiles![0], "utf-8");
    expect(content).toContain("Structured Output Requirement");
    expect(content).toContain(JSON.stringify(schema));
    expect(fixture.activeTempFiles.size).toBe(1);
  });

  // ── 组合 + cleanup ──

  it("agent + skill + schema 组合 → 2 个临时文件（agent prompt + schema 指令）+ skillPath", () => {
    fixture = createFixture({ ".pi/agents/code-review.md": AGENT_REVIEW });
    const skillDir = path.join(fixture.root, ".agents", "skills", "combo-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    origCwd = process.cwd();
    process.chdir(fixture.root);
    const registry = new AgentRegistry(fixture.root, fixture.homeDir);
    registry.discoverAll();

    const result = resolveAgentOpts(
      { prompt: "x", agent: "code-review", skill: "combo-skill", schema: { type: "object" } },
      registry,
      fixture.sessionDir,
      fixture.activeTempFiles,
    );

    expect(result.error).toBeUndefined();
    expect(result.opts.systemPromptFiles!.length).toBe(2); // agent prompt + schema 指令
    // resolveSkillPath 用 path.resolve（macOS /var → /private/var），需 realpathSync 标准化
    expect(result.opts.skillPath).toBe(fs.realpathSync(skillDir));
    expect(result.opts.schemaEnv).toBe(JSON.stringify({ type: "object" }));
    expect(fixture.activeTempFiles.size).toBe(2);
  });

  it("无 agent/skill/schema → opts 原样返回，无临时文件", () => {
    fixture = createFixture();
    const registry = new AgentRegistry(fixture.root, fixture.homeDir);
    registry.discoverAll();

    const result = resolveAgentOpts(
      { prompt: "x", model: "m1" },
      registry,
      fixture.sessionDir,
      fixture.activeTempFiles,
    );

    expect(result.error).toBeUndefined();
    expect(result.opts.systemPromptFiles).toBeUndefined();
    expect(result.opts.skillPath).toBeUndefined();
    expect(result.opts.schemaEnv).toBeUndefined();
    expect(fixture.activeTempFiles.size).toBe(0);
  });

  it("cleanupAllTempFiles 删除所有临时文件并清空集合", () => {
    fixture = createFixture({ ".pi/agents/code-review.md": AGENT_REVIEW });
    const registry = new AgentRegistry(fixture.root, fixture.homeDir);
    registry.discoverAll();

    resolveAgentOpts(
      { prompt: "x", agent: "code-review", schema: { type: "object" } },
      registry,
      fixture.sessionDir,
      fixture.activeTempFiles,
    );
    expect(fixture.activeTempFiles.size).toBe(2);
    const files = Array.from(fixture.activeTempFiles);

    cleanupAllTempFiles(fixture.activeTempFiles);

    expect(fixture.activeTempFiles.size).toBe(0);
    for (const fp of files) {
      expect(fs.existsSync(fp)).toBe(false);
    }
  });
});
