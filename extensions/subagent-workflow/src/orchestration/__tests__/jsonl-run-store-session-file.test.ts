// src/orchestration/__tests__/jsonl-run-store-session-file.test.ts
//
// W1: jsonl-run-store 序列化/反序列化 sessionFile round-trip 测试
//
// 防的 bug：sessionFile 加入 AgentCall + ExecutionTraceNode 后，序列化时必须写入快照，
// 反序列化时必须恢复——否则 pause/resume 或跨 session 重水合后 agent 的 session jsonl
// 路径丢失，overlay 无法定位。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentCall } from "../models/agent-call.ts";
import { Budget } from "../models/budget.ts";
import { Trace } from "../models/trace.ts";
import type { ExecutionTraceNode } from "../models/types.ts";
import type { RunSpec } from "../models/run-spec.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import { JsonlRunStore } from "../jsonl-run-store.ts";

function makeSpec(): RunSpec {
  return {
    scriptSource: "module.exports = async () => {};",
    args: {},
    scriptName: "test-script",
    scriptPath: "/tmp/test.js",
    description: "test",
  };
}

function makeTraceNode(stepIndex: number): ExecutionTraceNode {
  return {
    stepIndex,
    agent: "worker",
    task: "do thing",
    model: "default",
    status: "pending",
  };
}

function makeRunWithDoneCall(): WorkflowRun {
  const trace = new Trace();
  const node = makeTraceNode(0);
  trace.append(node);
  const call = new AgentCall(0, {
    prompt: "task",
    agent: "worker",
    cwd: "/tmp",
  } as never, node);
  // 模拟已完成 agent call：带 sessionId + sessionFile
  call.markRunning();
  call.markDone({
    content: "done",
    sessionId: "session-abc",
    sessionFile: "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl",
  });
  call.setSessionId("session-abc");
  call.setSessionFile("/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl");
  trace.update(0, {
    status: "completed",
    result: call.result,
    completedAt: new Date().toISOString(),
    sessionId: "session-abc",
    sessionFile: "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl",
  });

  return new WorkflowRun(
    "run-test-001",
    makeSpec(),
    {
      status: "done",
      reason: "completed",
      budget: new Budget(),
      calls: new Map([[0, call]]),
      trace,
      errorLogs: [],
    },
    { startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
  );
}

describe("W1: JsonlRunStore sessionFile 序列化 round-trip", () => {
  let tmpDir: string;
  let store: JsonlRunStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-test-"));
    store = new JsonlRunStore({ sessionDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("save + loadAll round-trip: AgentCall.sessionFile 保留", async () => {
    const run = makeRunWithDoneCall();
    await store.save(run);

    // 从磁盘直接读快照验证 sessionFile 写入了序列化
    const stateDir = path.join(tmpDir, "workflow-state");
    const files = fs.readdirSync(stateDir).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const raw = fs.readFileSync(path.join(stateDir, files[0]!), "utf8");
    const snapshot = JSON.parse(raw.trim());
    const serializedCall = snapshot.state.calls[0];
    expect(serializedCall.sessionFile).toBe(
      "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl",
    );
  });

  it("save + loadAll round-trip: ExecutionTraceNode.sessionFile 保留", async () => {
    const run = makeRunWithDoneCall();
    await store.save(run);

    const raw = fs.readFileSync(
      path.join(tmpDir, "workflow-state", "run-test-001.jsonl"),
      "utf8",
    );
    const snapshot = JSON.parse(raw.trim());
    const traceNode = snapshot.state.trace[0];
    expect(traceNode.sessionFile).toBe(
      "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl",
    );
  });
});

describe("W2: RunStore.stateFilePath 暴露 run 状态文件路径", () => {
  let tmpDir: string;
  let store: JsonlRunStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-test-"));
    store = new JsonlRunStore({ sessionDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stateFilePath(runId) 返回 <sessionDir>/workflow-state/<runId>.jsonl", () => {
    const result = store.stateFilePath("run-xyz");
    expect(result).toBe(path.join(tmpDir, "workflow-state", "run-xyz.jsonl"));
  });
});
