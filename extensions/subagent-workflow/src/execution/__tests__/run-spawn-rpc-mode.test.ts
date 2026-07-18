// src/__tests__/run-spawn-rpc-mode.test.ts
//
// runSpawn 的 RPC mode 集成测试（从 run-spawn-integration.test.ts 拆出，保持该文件 < 1000 行）。
//
// 本文件覆盖 FR-4: RPC mode（pi --mode rpc）无 header 场景——record.sessionFile 无法靠
// stdout header 推导，必须通过 get_state RPC 握手回填。验证修复后的握手逻辑。
//
// mock 工厂 + FakeChild + 工具函数共享自 helpers/spawn-mock.ts（详见该文件头注释）。
// vi.mock 必须各文件独立声明（文件作用域），工厂内用 `await import` 取回 FakeChild。

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const { FakeChild } = await import("./helpers/spawn-mock.ts");
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

import { runSpawn } from "../session-runner.ts";
import {
  emitStdoutLine,
  type FakeChild,
  lastSpawnedChild as lastSpawnedChildOf,
  makeCtx,
  makeOpts,
  makeRecord,
  mockSessionFileExists as mockSessionFileExistsOf,
  waitForSpawn as waitForSpawnOf,
} from "./helpers/spawn-mock.ts";

const mockSpawn = vi.mocked(spawn);
const mockExec = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockAppendFileSync = vi.mocked(fs.appendFileSync);

// 绑定到本文件 mockSpawn/mockExistsSync 的 helper（需读 mock 状态）
const lastSpawnedChild = (): FakeChild => lastSpawnedChildOf(mockSpawn);
const waitForSpawn = (timeoutMs = 1000): Promise<void> => waitForSpawnOf(mockSpawn, timeoutMs);
const mockSessionFileExists = (p: string): void => mockSessionFileExistsOf(mockExistsSync, p);

// ============================================================
// 测试
// ============================================================

describe("runSpawn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExec.mockReturnValue("");
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── FR-4: RPC mode 无 header（get_state 握手回填 sessionFile）──
  //
  // RPC mode（pi --mode rpc）不向 stdout 输出 header 行，record.sessionFile 无法靠
  // header 推导，必须通过 get_state RPC 握手回填。json mode 测试 emit sessionHeader()
  // 模拟 header；本组测试不 emit header，靠 get_state response 回填，验证修复后的握手逻辑
  //（握手移出 header 块、spawn 后无条件启动、close handler 主动 settle 不阻塞）。
  describe("RPC mode 无 header（FR-4 get_state 握手）", () => {
    /**
     * 捕获握手发出的 get_state 命令并 emit 对应 response。
     *
     * 握手在 spawn 后发 get_state 到 child.stdin（id 随机）。测试监听 stdin 捕获 id，
     * emit get_state response 到 stdout，经 stdout pump 匹配 get_stateListeners 触发
     * finishHandshake 回填 record.sessionFile。
     */
    function captureAndRespondGetState(
      child: FakeChild,
      sessionFile: string,
      sessionId = "rpc-sess",
    ): void {
      child.stdin.on("data", (data: Buffer | string) => {
        const text = typeof data === "string" ? data : data.toString();
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const cmd = JSON.parse(line) as { type?: string; id?: string };
            if (cmd.type === "get_state" && cmd.id) {
              emitStdoutLine(child, {
                type: "response",
                command: "get_state",
                success: true,
                id: cmd.id,
                data: { sessionFile, sessionId },
              });
            }
          } catch {
            // 非 JSON 行（prompt 命令等）忽略
          }
        }
      });
    }

    it("无 header + get_state response 回填 sessionFile → identity 写入成功", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: rpc-no-header", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      const expectedSessionFile =
        "/tmp/test/agents/subagents/--tmp-test--/sessions/rpc-session.jsonl";
      // 进程退出后 existsSync(record.sessionFile) 校验通过 → 补写 identity
      mockSessionFileExists(expectedSessionFile);
      captureAndRespondGetState(child, expectedSessionFile);

      // 等待 stdin listener 触发 + response 经 stdout pump 处理 → finishHandshake 回填。
      // PassThrough attach data listener 后在 nextTick flush 缓冲，setTimeout(20) 足够覆盖。
      await new Promise((r) => setTimeout(r, 20));

      // RPC mode：只 emit 事件，不 emit header
      emitStdoutLine(child, { type: "turn_end" });
      child.stdout.end();
      child.emit("close", 0);

      const result = await promise;

      expect(result.success).toBe(true);
      expect(record.sessionFile).toBe(expectedSessionFile);
      expect(result.sessionFile).toBe(expectedSessionFile);
      // identity 经握手回填的 sessionFile 写入（不再依赖 sessionHeader 条件）
      expect(mockAppendFileSync).toHaveBeenCalledWith(
        expectedSessionFile,
        expect.stringContaining('"customType":"subagent-identity"'),
        "utf-8",
      );
    });

    it("无 header + get_state 无响应 → close 主动 settle 不阻塞，identity 不写入", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: rpc-no-response", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      // 消费 stdin 避免背压；不 emit get_state response（模拟握手超时/失败）
      child.stdin.on("data", () => {});

      emitStdoutLine(child, { type: "turn_end" });
      child.stdout.end();
      child.emit("close", 0);

      const result = await promise;

      // close handler 主动 settle，不等握手内部 6s 超时 → 测试不超时（5s 默认上限）
      expect(result.success).toBe(true);
      // 握手未完成 → sessionFile 未回填
      expect(record.sessionFile).toBeUndefined();
      // identity 不写入
      expect(mockAppendFileSync).not.toHaveBeenCalled();
    });
  });
});
