// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）
// 运行命令：npx vitest run src/__tests__/worker-runtime.test.ts
//
// 运行时验证 buildWorkerScript 生成的脚本在隔离上下文中的行为。
// 使用 vm.runInNewContext 模拟 Worker 线程环境。

import { EventEmitter } from "node:events";
import * as vm from "node:vm";

import { describe, expect, it } from "vitest";

import { buildWorkerScript } from "../engine/worker-script";

// ── Helpers ─────────────────────────────────────────────────

/** Create a mock parentPort that captures postMessage calls. */
function createMockParentPort() {
  const port = new EventEmitter() as EventEmitter & { postMessage: (msg: unknown) => void };
  const messages: unknown[] = [];
  port.postMessage = (msg: unknown) => {
    messages.push(msg);
    // Intentional self-echo: simulates parent→child message passing.
    // In a real Worker, postMessage sends to parent and on("message") receives from parent.
    // This mock conflates both directions, which is sufficient for testing the worker script's
    // internal message handling but cannot detect bugs where the worker incorrectly receives
    // its own outbound messages.
    port.emit("message", msg);
  };
  return { port, messages };
}

/**
 * Execute the generated worker script in a sandboxed VM context.
 * Returns captured postMessage calls and any error.
 */
function evalWorkerScript(
  userScript: string,
  workerDataOverrides: Record<string, unknown> = {},
  timeoutMs = 3000,
): Promise<{ messages: unknown[]; error?: string }> {
  const script = buildWorkerScript(userScript);
  const { port, messages } = createMockParentPort();

  const workerData = {
    scriptPath: "/test/workflow.js",
    args: {},
    callCache: new Map(),
    budget: { usedTokens: 0, usedCost: 0, maxTokens: 10000 },
    workspace: "/test",
    meta: {},
    ...workerDataOverrides,
  };

  return new Promise<{ messages: unknown[]; error?: string }>((resolve) => {
    let settled = false;
    const settle = (err?: string) => {
      if (settled) return;
      settled = true;
      resolve({ messages: [...messages], error: err });
    };

    const timer = setTimeout(() => settle(), timeoutMs);

    // Auto-reply to agent-call messages with a generic agent-result.
    // Uses setTimeout to defer the reply so agent() has time to register
    // its pending promise before the result arrives.
    port.on("message", (msg: unknown) => {
      const m = msg as Record<string, unknown>;
      if (m.type === "agent-call") {
        setTimeout(() => {
          port.postMessage({
            type: "agent-result",
            callId: m.callId,
            result: { content: `result-${m.callId}`, parsedOutput: `output-${m.callId}` },
            cached: false,
          });
        }, 0);
        return;
      }
      if (m.type === "return" || m.type === "error") {
        clearTimeout(timer);
        settle();
      }
    });

    try {
      // Build sandbox with Node.js globals + mock require
      const sandbox = vm.createContext({
        // Node globals
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        Map,
        Set,
        Promise,
        JSON,
        Math,
        Error,
        Array,
        Object,
        Number,
        String,
        Boolean,
        Symbol,
        RegExp,
        Date,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        queueMicrotask,
        // Module system
        module: { exports: {} },
        exports: {},
        require: (mod: string) => {
          if (mod === "node:worker_threads") {
            return { parentPort: port, workerData };
          }
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          return require(mod);
        },
        // Additional globals that the generated script may need
        process: { argv: ["node", "test"], cwd: () => "/test", env: {} },
      });

      vm.runInNewContext(script, sandbox, { timeout: timeoutMs });
    } catch (err) {
      clearTimeout(timer);
      settle(err instanceof Error ? err.message : String(err));
    }
  });
}

// ═══════════════════════════════════════════════════════════════

describe("worker-runtime", () => {
  // ── AC-2.2: args alias for $ARGS ─────────────────────────

  it("args is an alias for $ARGS and both resolve from workerData", async () => {
    const script = `
      return { argsVal: args, dargsVal: $ARGS, hasProp: args.maxIterations === 5 };
    `;

    const { messages, error } = await evalWorkerScript(script, {
      args: { maxIterations: 5, _runId: "test-run" },
    });

    expect(error).toBeUndefined();
    const returnMsg = messages.find((m) => (m as Record<string, unknown>).type === "return");
    expect(returnMsg).toBeDefined();
    const result = (returnMsg as Record<string, unknown>).result as Record<string, unknown>;
    expect(result.hasProp).toBe(true);
  });

  // ── AC-2.3: phase propagation to agent-call message ─────

  it("agent() sends phase from global _currentPhase in agent-call message", async () => {
    const script = `
      phase("Review");
      agent("check code");
    `;

    const { messages } = await evalWorkerScript(script);

    const agentCall = messages.find(
      (m) => (m as Record<string, unknown>).type === "agent-call",
    ) as Record<string, unknown> | undefined;
    expect(agentCall).toBeDefined();
    expect(agentCall!.phase).toBe("Review");
  });

  // ── AC-2.6: explicit phase overrides global ─────────────

  it("agent() explicit phase overrides global _currentPhase", async () => {
    const script = `
      phase("Review");
      agent("fix typo", { phase: "Fix" });
    `;

    const { messages } = await evalWorkerScript(script);

    const agentCall = messages.find(
      (m) => (m as Record<string, unknown>).type === "agent-call",
    ) as Record<string, unknown> | undefined;
    expect(agentCall).toBeDefined();
    expect(agentCall!.phase).toBe("Fix");
  });

  // ── AC-2.4: parallel thunk execution ────────────────────

  it("parallel([fn, fn]) executes thunk functions concurrently", async () => {
    const script = `
      parallel([
        () => agent("task-a"),
        () => agent("task-b"),
      ]);
    `;

    const { messages } = await evalWorkerScript(script);

    const agentCalls = messages.filter(
      (m) => (m as Record<string, unknown>).type === "agent-call",
    );
    expect(agentCalls).toHaveLength(2);

    const prompts = agentCalls.map(
      (m) => ((m as Record<string, unknown>).opts as Record<string, unknown>).prompt,
    );
    expect(prompts).toContain("task-a");
    expect(prompts).toContain("task-b");
  });

  // ── AC-2.5: pipeline cartesian product ──────────────────

  it("pipeline cartesian product applies stages to each item", async () => {
    // Use sync stages (no agent) to test pipeline semantics in isolation.
    // This verifies that pipeline([items], fn1, fn2) runs each item through
    // all stages sequentially and returns the array of results.
    const script = `
      const results = pipeline(
        [1, 2, 3],
        (x) => x * 10,
        (x) => x + 1,
      );
      return results;
    `;

    const { messages, error } = await evalWorkerScript(script);
    expect(error).toBeUndefined();

    const returnMsg = messages.find(
      (m) => (m as Record<string, unknown>).type === "return",
    ) as Record<string, unknown> | undefined;
    expect(returnMsg).toBeDefined();
    const result = returnMsg!.result as unknown[];
    expect(result).toEqual([11, 21, 31]);
  });

  // ── AC-2.9: pipeline error isolation ────────────────────

  it("pipeline error isolation: one item fails, others succeed", async () => {
    const script = `
      const results = pipeline(
        ["a", "b", "c"],
        (item) => {
          if (item === "b") throw new Error("boom");
          return item.toUpperCase();
        },
      );
      return results;
    `;

    const { messages, error } = await evalWorkerScript(script);
    expect(error).toBeUndefined();

    const returnMsg = messages.find(
      (m) => (m as Record<string, unknown>).type === "return",
    ) as Record<string, unknown> | undefined;
    expect(returnMsg).toBeDefined();
    const result = returnMsg!.result as unknown[];
    // "a" → "A", "b" → null (error), "c" → "C"
    expect(result).toEqual(["A", null, "C"]);
  });

  // ── AC-2.7: budget.spent() returns current token count ──

  it("budget.spent() returns initial value from workerData", async () => {
    const script = `
      return { spent: $BUDGET.spent() };
    `;

    const { messages } = await evalWorkerScript(script, {
      budget: { usedTokens: 500, usedCost: 0.1, maxTokens: 10000 },
    });

    const returnMsg = messages.find(
      (m) => (m as Record<string, unknown>).type === "return",
    ) as Record<string, unknown> | undefined;
    expect(returnMsg).toBeDefined();
    const result = returnMsg!.result as Record<string, unknown>;
    expect(result.spent).toBe(500);
  });

  // ── AC-2.8: budget.remaining() ──────────────────────────

  it("budget.remaining() returns total - spent", async () => {
    const script = `
      return { remaining: $BUDGET.remaining() };
    `;

    const { messages } = await evalWorkerScript(script, {
      budget: { usedTokens: 3000, usedCost: 0.5, maxTokens: 10000 },
    });

    const returnMsg = messages.find(
      (m) => (m as Record<string, unknown>).type === "return",
    ) as Record<string, unknown> | undefined;
    expect(returnMsg).toBeDefined();
    const result = returnMsg!.result as Record<string, unknown>;
    expect(result.remaining).toBe(7000);
  });

  it("budget.total returns maxTokens from workerData", async () => {
    const script = `
      return { total: $BUDGET.total };
    `;

    const { messages } = await evalWorkerScript(script, {
      budget: { usedTokens: 0, usedCost: 0, maxTokens: 50000 },
    });

    const returnMsg = messages.find(
      (m) => (m as Record<string, unknown>).type === "return",
    ) as Record<string, unknown> | undefined;
    expect(returnMsg).toBeDefined();
    const result = returnMsg!.result as Record<string, unknown>;
    expect(result.total).toBe(50000);
  });

  // ── budget-update message updates cached values ─────────

  it("budget values update on budget-update message", async () => {
    const script = `
      const before = { spent: $BUDGET.spent(), remaining: $BUDGET.remaining() };
      parentPort.postMessage({ type: 'budget-update', budget: { usedTokens: 8000, usedCost: 1.0 } });
      return { before, after: { spent: $BUDGET.spent(), remaining: $BUDGET.remaining() } };
    `;

    const { messages } = await evalWorkerScript(script, {
      budget: { usedTokens: 2000, usedCost: 0.2, maxTokens: 10000 },
    });

    const returnMsg = messages.find(
      (m) => (m as Record<string, unknown>).type === "return",
    ) as Record<string, unknown> | undefined;
    expect(returnMsg).toBeDefined();
    const result = returnMsg!.result as Record<string, unknown>;

    const before = result.before as Record<string, unknown>;
    const after = result.after as Record<string, unknown>;
    expect(before.spent).toBe(2000);
    expect(before.remaining).toBe(8000);
    // After posting budget-update, the message handler updates _budgetData synchronously
    expect(after.spent).toBe(8000);
    expect(after.remaining).toBe(2000);
  });

  // ── module.exports.execute auto-invocation ──────────────

  it("module.exports.execute is auto-invoked with context", async () => {
    const script = `
      module.exports = {
        meta: { name: 'test-wf' },
        execute: async ({ agent, parallel, pipeline, phase, log, $ARGS, $WORKSPACE, $BUDGET }) => {
          return {
            hasAgent: typeof agent === 'function',
            hasParallel: typeof parallel === 'function',
            hasPipeline: typeof pipeline === 'function',
            hasPhase: typeof phase === 'function',
            hasLog: typeof log === 'function',
            hasARGS: typeof $ARGS === 'object',
            hasWORKSPACE: typeof $WORKSPACE === 'string',
            hasBUDGET: typeof $BUDGET === 'object',
          };
        },
      };
    `;

    const { messages } = await evalWorkerScript(script, {
      args: { _runId: "test" },
      budget: { usedTokens: 0, usedCost: 0, maxTokens: 10000 },
    });

    const returnMsg = messages.find(
      (m) => (m as Record<string, unknown>).type === "return",
    ) as Record<string, unknown> | undefined;
    expect(returnMsg).toBeDefined();
    const result = returnMsg!.result as Record<string, unknown>;
    expect(result.hasAgent).toBe(true);
    expect(result.hasParallel).toBe(true);
    expect(result.hasPipeline).toBe(true);
    expect(result.hasPhase).toBe(true);
    expect(result.hasLog).toBe(true);
    expect(result.hasARGS).toBe(true);
    expect(result.hasWORKSPACE).toBe(true);
    expect(result.hasBUDGET).toBe(true);
  });
});
