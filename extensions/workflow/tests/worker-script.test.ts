// 测试框架: vitest | 运行命令: npx vitest run tests/worker-script.test.ts
import { describe, expect,it } from "vitest";

import { buildWorkerScript } from "../src/engine/worker-script";

describe("buildWorkerScript", () => {
  const userScript = 'log("hello from user script");';
  const result = buildWorkerScript(userScript);

  it("包含 'use strict' 声明", () => {
    expect(result).toContain('"use strict";');
  });

  it("包含 async IIFE 入口 (async () => {", () => {
    expect(result).toContain("(async () => {");
  });

  it("引用 parentPort 和 workerData", () => {
    expect(result).toContain("parentPort");
    expect(result).toContain("workerData");
  });

  it("注入 agent() 函数定义", () => {
    expect(result).toContain("async function agent(firstArg, secondArg)");
  });

  it("注入 parallel() 函数定义", () => {
    expect(result).toContain("async function parallel(calls)");
  });

  it("注入 pipeline() 函数定义", () => {
    expect(result).toContain("async function pipeline(firstArg, ...restStages)");
  });

  it("注入 $ARGS / $WORKSPACE / $BUDGET 常量", () => {
    expect(result).toContain("const $ARGS");
    expect(result).toContain("const $WORKSPACE");
    expect(result).toContain("const $BUDGET");
  });

  it("注入 phase() 和 log() 函数", () => {
    expect(result).toContain("function phase(name)");
    expect(result).toContain("function log(msg)");
  });

  it("嵌入用户脚本字符串", () => {
    expect(result).toContain(userScript);
  });

  it("从 workerData.callCache 恢复缓存", () => {
    expect(result).toContain("workerData.callCache");
    expect(result).toContain("_callCache");
  });

  it("包含 parentPort.on(\"message\") 处理 agent-result 和 abort", () => {
    expect(result).toContain('parentPort.on("message"');
    expect(result).toContain('"agent-result"');
    expect(result).toContain('"abort"');
  });

  it("包含 .then() / .catch() 发送 return/error 消息", () => {
    expect(result).toContain(".then(");
    expect(result).toContain(".catch(");
    expect(result).toContain('{ type: "return"');
    expect(result).toContain('{ type: "error"');
  });

  it("定义 WorkflowAbortedError 类", () => {
    expect(result).toContain("class WorkflowAbortedError extends Error");
  });

  it("包含 module.exports.execute 自动调用逻辑", () => {
    expect(result).toContain("module.exports.execute");
    expect(result).toContain('typeof module.exports.execute === "function"');
  });

  // ── agent() 字段透传（FR-3.3 + Task 2） ──

  it("agent() opts 包含 agent 字段（透传 firstArg.agent）", () => {
    // The generated worker script must set `agent: firstArg.agent` so the
    // main thread's AgentRegistry can resolve the agent by name.
    expect(result).toMatch(/agent:\s*firstArg\.agent/);
  });

  it("生成的脚本是可解析的合法 JavaScript（防 missing-comma 回归）", () => {
    // Regression guard: a missing comma in the object literal would cause
    // a SyntaxError at worker thread start. Validate with new Function().
    expect(() => {
      new Function(result);
    }).not.toThrow();
  });
});
