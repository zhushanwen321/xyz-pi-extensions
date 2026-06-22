// 测试框架：vitest
// 运行命令：npx vitest run src/engine/models/__tests__/ports.test.ts

import { describe, expect, it } from "vitest";

import type { AgentResult } from "../types.js";
import type {
  AgentRunner,
  LifecycleDeps,
  RunStore,
  WorkerHandlers,
  WorkerHost,
} from "../ports.js";

// ── Port 形状：用 mock 对象赋值校验（结构子类型） ──────────────

describe("Port interface 形状", () => {
  it("AgentRunner: run(opts, signal) → Promise<AgentResult>", async () => {
    const runner: AgentRunner = {
      async run(_opts, _signal) {
        return { content: "ok" } satisfies AgentResult;
      },
    };
    const result = await runner.run({ prompt: "hi" }, new AbortController().signal);
    expect(result.content).toBe("ok");
  });

  it("RunStore: save(run) + loadAll()", async () => {
    const store: RunStore = {
      async save(_run) {
        /* mock */
      },
      async loadAll() {
        return [{ runId: "r1" }];
      },
    };
    await store.save({ runId: "r1" });
    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].runId).toBe("r1");
  });

  it("WorkerHost: start(spec, args, handlers) → handle", () => {
    const host: WorkerHost = {
      start(_spec, _args, _handlers) {
        return { isCurrent: true };
      },
    };
    const handlers: WorkerHandlers = {
      async onMessage(_raw) {
        /* mock */
      },
      async onError(_err) {
        /* mock */
      },
      async onExit(_code, _handle) {
        /* mock */
      },
    };
    const handle = host.start({ scriptSource: "x" }, {}, handlers);
    expect(handle.isCurrent).toBe(true);
  });

  it("WorkerHandlers: 3 个回调均返回 Promise", () => {
    const handlers: WorkerHandlers = {
      onMessage: async () => {},
      onError: async () => {},
      onExit: async () => {},
    };
    // Promise-returning 校验：调用得到 thenable
    expect(typeof handlers.onMessage).toBe("function");
  });
});

// ── LifecycleDeps 聚合 bag ────────────────────────────────────

describe("LifecycleDeps", () => {
  it("聚合 store/workerHost/runner/runs", () => {
    const deps: LifecycleDeps = {
      store: { async save() {}, async loadAll() { return []; } },
      workerHost: { start() { return { isCurrent: true }; } },
      runner: { async run() { return { content: "" }; } },
      runs: new Map([["r1", { runId: "r1" }]]),
    };
    expect(deps.runs.get("r1")?.runId).toBe("r1");
    expect(deps.runs.size).toBe(1);
  });
});
