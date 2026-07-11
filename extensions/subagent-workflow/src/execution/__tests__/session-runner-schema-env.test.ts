// src/__tests__/session-runner-schema-env.test.ts
//
// Wave 2 (issue #3): schemaEnv bridge 测试。
//
// 覆盖 test-matrix 用例:
//   - T3.9  (boundary): schemaEnv 透传——传入时 childEnv 含 PI_WORKFLOW_SCHEMA
//   - T3.11 (state):    schemaEnv 不传 → childEnv 无 PI_WORKFLOW_SCHEMA（BC-6 tool 层不变）
//   - T3.16 (NFR-compatibility): schemaEnv 不传时 BC-6 childEnv 等价——不传时与合并前
//     行为一致，不注入 PI_WORKFLOW_SCHEMA → structured-output tool 不注册
//
// 测试策略：
//   - applySchemaEnvToChildEnv 纯函数单测（不依赖 runSpawn/spawn mock）
//   - runSpawn 集成测试：通过 mock spawn 拦截 childEnv，验证 schemaEnv 实际注入
//
// D-A6: schemaEnv 经 RunOptions 透传到 runSpawn childEnv。
// BC-6: tool 层 execute 不传 schemaEnv → childEnv 不设 PI_WORKFLOW_SCHEMA → 行为不变。

import type { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── mock modules (与 run-spawn-integration.test.ts 同模式) ──

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");

  class FakeChild extends EventEmitter {
    pid = 12345;
    stdout = new PassThrough();
    stderr = new PassThrough();
    killed = false;
    killSignal: string | undefined;
    kill(sig?: string): boolean {
      this.killed = true;
      this.killSignal = sig;
      return true;
    }
  }

  return {
    spawn: vi.fn(() => new FakeChild()),
    execFileSync: vi.fn(() => ""),
  };
});

vi.mock("node:fs", async () => {
  const actual = await import("node:fs");
  return {
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => false),
      appendFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      readdirSync: vi.fn(() => []),
    },
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => false),
    appendFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    promises: actual.promises,
  };
});

vi.mock("../alive-store.ts", () => ({
  writeAliveMarker: vi.fn(),
}));

vi.mock("../temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string) => {
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";

import { createRecord } from "../execution-record.ts";
import {
  applySchemaEnvToChildEnv,
  type RunOptions,
  runSpawn,
  type SessionRunnerContext,
} from "../session-runner.ts";

const mockSpawn = vi.mocked(spawn);
const mockExec = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);

interface FakeChild {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  killSignal: string | undefined;
  kill(sig?: string): boolean;
  emit(event: string, ...args: unknown[]): boolean;
}

function getLastSpawnedChild(): FakeChild {
  const result = mockSpawn.mock.results.at(-1);
  if (!result) throw new Error("spawn was not called yet");
  return result.value as unknown as FakeChild;
}

function getLastSpawnEnv(): Record<string, string | undefined> {
  return mockSpawn.mock.calls.at(-1)?.[2]?.env as Record<string, string | undefined> ?? {};
}

/**
 * 等待 runSpawn 内部调到 spawn。
 * runSpawn 是 async，spawn 在 writePromptToTempFile await 之后才调。
 */
async function waitForSpawn(timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (mockSpawn.mock.results.length === 0) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`spawn was not called within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── 公共 fixture ──

function makeRecord() {
  return createRecord("test-1", {
    agent: "general-purpose",
    model: "test/model",
    mode: "sync",
    task: "test task",
    startedAt: Date.now(),
    rootSessionId: "s1",
    parentRecordId: undefined,
    depth: 0,
  });
}

function makeRunOpts(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    resolved: { model: { provider: "test", id: "model" }, thinkingLevel: undefined },
    agentConfig: undefined,
    appendSystemPrompt: undefined,
    skillPath: undefined,
    schema: undefined,
    maxTurns: undefined,
    graceTurns: undefined,
    signal: undefined,
    onEvent: undefined,
    ...overrides,
  };
}

function makeCtx(): SessionRunnerContext {
  return {
    cwd: "/fake/cwd",
    agentDir: "/fake/agent",
    skillDirs: [],
    mainCwd: "/fake/cwd",
  };
}

// ── applySchemaEnvToChildEnv 纯函数单测 ──

describe("applySchemaEnvToChildEnv (T3.9/T3.11/T3.16)", () => {
  // T3.11: schemaEnv 不传 → childEnv 无 PI_WORKFLOW_SCHEMA
  it("T3.11: schemaEnv 不传时 childEnv 不含 PI_WORKFLOW_SCHEMA（BC-6）", () => {
    const childEnv: Record<string, string | undefined> = { PATH: "/usr/bin" };
    applySchemaEnvToChildEnv(childEnv, undefined);
    expect(childEnv).not.toHaveProperty("PI_WORKFLOW_SCHEMA");
    expect(childEnv.PATH).toBe("/usr/bin"); // 其他 key 不受影响
  });

  // T3.16: schemaEnv 不传时 BC-6 childEnv 等价——合并前后行为一致
  it("T3.16: schemaEnv 不传时 childEnv 等价于合并前（BC-6，不注入 PI_WORKFLOW_SCHEMA）", () => {
    const childEnv: Record<string, string | undefined> = {};
    applySchemaEnvToChildEnv(childEnv, undefined);
    // 不传 schemaEnv 时，childEnv 应与调用前完全一致（不含 PI_WORKFLOW_SCHEMA）
    expect(Object.keys(childEnv)).toHaveLength(0);
    expect(childEnv.PI_WORKFLOW_SCHEMA).toBeUndefined();
  });

  // T3.16 补充: schemaEnv 为空串也不注入（空串不是有效 schema）
  it("T3.16 补充: schemaEnv 为空串时不注入（false-ish 语义）", () => {
    const childEnv: Record<string, string | undefined> = {};
    applySchemaEnvToChildEnv(childEnv, "");
    expect(childEnv).not.toHaveProperty("PI_WORKFLOW_SCHEMA");
  });

  // T3.9: schemaEnv 传入 → childEnv 含 PI_WORKFLOW_SCHEMA
  it("T3.9: schemaEnv 传入时 childEnv 含 PI_WORKFLOW_SCHEMA", () => {
    const childEnv: Record<string, string | undefined> = {};
    const schemaJson = '{"type":"object","properties":{"x":{"type":"number"}}}';
    applySchemaEnvToChildEnv(childEnv, schemaJson);
    expect(childEnv.PI_WORKFLOW_SCHEMA).toBe(schemaJson);
  });

  // T3.9 补充: schemaEnv 值为复杂 JSON 字符串时正确透传
  it("T3.9 补充: schemaEnv 值为复杂 JSON 字符串时完整透传", () => {
    const childEnv: Record<string, string | undefined> = {};
    const schemaJson = JSON.stringify({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number", minimum: 0 },
      },
      required: ["name"],
    });
    applySchemaEnvToChildEnv(childEnv, schemaJson);
    expect(childEnv.PI_WORKFLOW_SCHEMA).toBe(schemaJson);
    // 验证可以 parse 回原始结构
    expect(() => JSON.parse(childEnv.PI_WORKFLOW_SCHEMA!)).not.toThrow();
  });

  // T3.9 补充: schemaEnv 与已有 key 不冲突
  it("T3.9 补充: schemaEnv 注入不覆盖 childEnv 已有 key", () => {
    const childEnv: Record<string, string | undefined> = {
      PATH: "/usr/bin",
      HOME: "/home/user",
    };
    applySchemaEnvToChildEnv(childEnv, '{"x":1}');
    expect(childEnv.PATH).toBe("/usr/bin");
    expect(childEnv.HOME).toBe("/home/user");
    expect(childEnv.PI_WORKFLOW_SCHEMA).toBe('{"x":1}');
  });
});

// ── runSpawn 集成测试：schemaEnv 经 RunOptions → childEnv ──

describe("runSpawn schemaEnv childEnv 注入 (T3.9/T3.11)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockExec.mockReturnValue("");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // T3.11: schemaEnv 不传 → childEnv 的 PI_WORKFLOW_SCHEMA 保持 process.env 原值
  // BC-6: applySchemaEnvToChildEnv 不注入新值，但 process.env 可能已有此 key（子进程继承父环境）。
  // 验证点: 不传 schemaEnv 时我们的代码不修改 PI_WORKFLOW_SCHEMA。
  it("T3.11 (integration): RunOptions 无 schemaEnv → childEnv 继承 process.env 原值（BC-6）", async () => {
    const record = makeRecord();
    const opts = makeRunOpts({ schemaEnv: undefined });
    const ctx = makeCtx();

    const resultPromise = runSpawn(record, "test task", opts, ctx);
    await waitForSpawn();
    const childEnv = getLastSpawnEnv();
    // BC-6: schemaEnv 未传入 → PI_WORKFLOW_SCHEMA 应为 process.env 原值（我们的代码不注入）
    expect(childEnv.PI_WORKFLOW_SCHEMA).toBe(process.env.PI_WORKFLOW_SCHEMA);

    const child = getLastSpawnedChild();
    child.emit("close", 0);
    await resultPromise;
  });

  // T3.9: schemaEnv 传入 → childEnv 含 PI_WORKFLOW_SCHEMA
  it("T3.9 (integration): RunOptions 有 schemaEnv → childEnv 含 PI_WORKFLOW_SCHEMA", async () => {
    const record = makeRecord();
    const schemaJson = '{"type":"object","properties":{"result":{"type":"string"}}}';
    const opts = makeRunOpts({ schemaEnv: schemaJson });
    const ctx = makeCtx();

    const resultPromise = runSpawn(record, "test task", opts, ctx);
    await waitForSpawn();
    const childEnv = getLastSpawnEnv();
    expect(childEnv.PI_WORKFLOW_SCHEMA).toBe(schemaJson);

    // 关闭子进程
    const child = getLastSpawnedChild();
    child.emit("close", 0);
    await resultPromise;
  });

  // T3.9 + fork: schemaEnv 与 fork env 共存时不冲突
  it("T3.9 + fork: schemaEnv 与 fork depth env 共存不冲突", async () => {
    const record = createRecord("test-fork-1", {
      agent: "general-purpose",
      model: "test/model",
      mode: "sync",
      task: "test task",
      startedAt: Date.now(),
      rootSessionId: "s1",
      parentRecordId: undefined,
      depth: 1,
    });
    const schemaJson = '{"type":"object"}';
    const opts = makeRunOpts({
      schemaEnv: schemaJson,
      fork: true,
      parentForkDepth: 0,
    });
    const ctx = makeCtx();

    const resultPromise = runSpawn(record, "test task", opts, ctx);
    await waitForSpawn();
    const childEnv = getLastSpawnEnv();
    // fork depth env 应存在
    expect(childEnv.PI_SUBAGENT_FORK_DEPTH).toBe("1");
    // schemaEnv 也应存在
    expect(childEnv.PI_WORKFLOW_SCHEMA).toBe(schemaJson);

    const child = getLastSpawnedChild();
    child.emit("close", 0);
    await resultPromise;
  });
});
