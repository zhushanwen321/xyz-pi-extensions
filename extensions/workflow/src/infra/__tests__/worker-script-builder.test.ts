// 测试框架：vitest
// 运行命令：npx vitest run src/infra/__tests__/worker-script-builder.test.ts

import { describe, expect, it } from "vitest";

import { buildWorkerScript } from "../worker-script-builder.js";

describe("buildWorkerScript (T11)", () => {
  const userScript = 'log("hello from user script");';
  const result = buildWorkerScript(userScript);

  // ── Required injected globals (format契约) ─────────────────

  describe("required injected globals", () => {
    it("contains 'use strict' declaration", () => {
      expect(result).toContain('"use strict";');
    });

    it("contains async IIFE entry (async () => {", () => {
      expect(result).toContain("(async () => {");
    });

    it("references parentPort and workerData", () => {
      expect(result).toContain("parentPort");
      expect(result).toContain("workerData");
    });

    it("injects agent() function definition", () => {
      expect(result).toContain("async function agent(firstArg, secondArg)");
    });

    it("injects parallel() function definition", () => {
      expect(result).toContain("async function parallel(calls)");
    });

    it("injects pipeline() function definition", () => {
      expect(result).toContain("async function pipeline(firstArg, ...restStages)");
    });

    it("injects $ARGS / $WORKSPACE / $BUDGET constants", () => {
      expect(result).toContain("const $ARGS");
      expect(result).toContain("const $WORKSPACE");
      expect(result).toContain("const $BUDGET");
    });

    it("injects args alias for $ARGS (CC compat)", () => {
      expect(result).toContain("const args = $ARGS");
    });

    it("injects phase() / log() globals", () => {
      expect(result).toContain("function phase(name)");
      expect(result).toContain("function log(msg)");
    });

    it("handles WorkflowAbortedError on abort message", () => {
      expect(result).toContain("WorkflowAbortedError");
      expect(result).toContain('msg.type === "abort"');
    });
  });

  // ── User script injection ──────────────────────────────────

  describe("user script injection", () => {
    it("embeds the user script verbatim", () => {
      const marker = 'log("UNIQUE_MARKER_12345");';
      const r = buildWorkerScript(marker);
      expect(r).toContain(marker);
    });

    it("auto-invokes execute() for module.exports pattern", () => {
      const r = buildWorkerScript("module.exports = {};");
      expect(r).toContain('typeof module.exports.execute === "function"');
      expect(r).toContain("module.exports.execute(");
    });

    it("posts return/error messages with runId from workerData.args._runId", () => {
      expect(result).toContain('type: "return"');
      expect(result).toContain('type: "error"');
      expect(result).toContain("args._runId");
    });
  });

  // ── Call cache replay (pause/resume contract) ─────────────

  describe("call cache replay (G3-001 pause/resume)", () => {
    it("initializes _callCache from workerData.callCache", () => {
      expect(result).toContain("workerData.callCache instanceof Map");
    });

    it("replays cached result without posting agent-call when callId cached", () => {
      expect(result).toContain("_callCache.has(callId)");
      expect(result).toContain("cached.parsedOutput ?? cached.content");
    });

    it("rejects cached error path (cached.error throws)", () => {
      expect(result).toContain("if (cached && cached.error)");
    });
  });

  // ── Communication protocol ─────────────────────────────────

  describe("communication protocol", () => {
    it("posts agent-call with callId + opts + phase", () => {
      expect(result).toContain('type: "agent-call"');
      expect(result).toContain("opts, phase: _effectivePhase");
    });

    it("handles agent-result message and resolves/rejects pending call", () => {
      expect(result).toContain('msg.type === "agent-result"');
      expect(result).toContain("pending.resolve(msg.result.parsedOutput ?? msg.result.content)");
    });

    it("handles budget-update message", () => {
      expect(result).toContain('msg.type === "budget-update"');
    });
  });

  // ── Worker thread guard ────────────────────────────────────

  describe("worker thread guard", () => {
    it("throws if parentPort is null (not in Worker thread)", () => {
      expect(result).toContain("parentPort is null");
    });
  });
});
