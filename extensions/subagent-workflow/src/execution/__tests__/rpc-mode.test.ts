// src/__tests__/rpc-mode.test.ts
//
// RPC 模式相关功能
// 1. buildSpawnArgs 返回 --mode rpc（而非 json）
// 2. parseSpawnLine 正确解析 Pi 原生 RpcResponse（type:response + command + success + data|error）

import { describe, expect, it } from "vitest";

import { buildSpawnArgs } from "../session-runner.ts";
import { parseSpawnLine } from "../spawn-event-adapter.ts";

describe("buildSpawnArgs - RPC mode", () => {
  const baseParams = {
    model: "gpt-4",
    thinkingLevel: undefined,
    agentTools: undefined,
    appendSystemPromptPath: undefined,
    sessionDir: "/tmp/sessions",
    forkSource: undefined,
    skillPaths: undefined,
  };

  it("生成 --mode rpc 参数（非 json）", () => {
    const args = buildSpawnArgs(baseParams);
    // 应包含 --mode rpc
    expect(args).toContain("--mode");
    const modeIdx = args.indexOf("--mode");
    expect(args[modeIdx + 1]).toBe("rpc");
  });

  it("不包含 --mode json", () => {
    const args = buildSpawnArgs(baseParams);
    const modeIdx = args.indexOf("--mode");
    expect(args[modeIdx + 1]).not.toBe("json");
  });
});

describe("parseSpawnLine - RpcResponse", () => {
  // Pi 原生 RpcResponse 格式（rpc-types.ts）：{type:"response", id?, command, success, data?, error?}
  // W1 修复后 isRpcResponse 判 type:response + command:string + success:boolean（SR-1 根因 1b）

  it("解析 Pi 原生 success response（kind=response）", () => {
    const rpcResponse = JSON.stringify({
      type: "response",
      id: "req-123",
      command: "run",
      success: true,
      data: { answers: [{ question: "Q1", answer: "A1" }] },
    });
    const result = parseSpawnLine(rpcResponse);
    expect(result?.kind).toBe("response");
    if (result?.kind === "response") {
      expect(result.id).toBe("req-123");
      expect(result.command).toBe("run");
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ answers: [{ question: "Q1", answer: "A1" }] });
    }
  });

  it("解析 Pi 原生 error response（kind=response）", () => {
    const rpcError = JSON.stringify({
      type: "response",
      id: "req-456",
      command: "run",
      success: false,
      error: "task failed: timeout",
    });
    const result = parseSpawnLine(rpcError);
    expect(result?.kind).toBe("response");
    if (result?.kind === "response") {
      expect(result.id).toBe("req-456");
      expect(result.success).toBe(false);
      expect(result.error).toBe("task failed: timeout");
    }
  });

  it("旧 JSON-RPC 2.0 格式不再归类为 response（W1 废弃）", () => {
    // SR-1: 旧 {jsonrpc:"2.0", id, result} 无 type:response 字段，应落入 invalid
    const oldRpc = JSON.stringify({ jsonrpc: "2.0", id: "req-old", result: { x: 1 } });
    const result = parseSpawnLine(oldRpc);
    expect(result?.kind).not.toBe("response");
  });

  it("非 response 类型的 JSON 不归类为 response", () => {
    const normalEvent = JSON.stringify({ type: "tool_execution_start", toolName: "bash" });
    const result = parseSpawnLine(normalEvent);
    expect(result?.kind).not.toBe("response");
  });
});
