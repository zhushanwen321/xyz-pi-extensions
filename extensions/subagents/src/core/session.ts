// src/core/session.ts
import type { ManagedSession, ManagedSessionOptions, AgentResult } from "../types.ts";
import type { RunAgentContext } from "./run-agent.ts";
import { runAgent } from "./run-agent.ts";

/**
 * FR-1.2: createManagedSession — 创建长生命周期 session，支持多次 prompt/steer/abort。
 * V1 实现：每次 prompt() 内部调用 runAgent()（创建新 session），steer/abort 通过
 * 闭包持有当前 runAgent 的 AbortSignal + steer 回调。
 */
export function createManagedSession(options: ManagedSessionOptions, ctx: RunAgentContext): ManagedSession {
  let disposed = false;
  let currentAbort: AbortController | null = null;
  const steerBuffer: string[] = [];

  const session: ManagedSession = {
    get sessionId() { return currentAbort ? "pending" : ""; },
    get alive() { return !disposed; },

    async prompt(task, promptOpts): Promise<AgentResult> {
      if (disposed) throw new Error("ManagedSession disposed");
      const controller = new AbortController();
      currentAbort = controller;

      const mergedSignal = promptOpts?.signal
        ? mergeSignals(promptOpts.signal, controller.signal)
        : controller.signal;

      const result = await runAgent({
        task,
        agent: options.agent,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        skillPath: options.skillPath,
        appendSystemPrompt: options.appendSystemPrompt,
        onEvent: options.onEvent,
        signal: mergedSignal,
        maxTurns: promptOpts?.maxTurns,
      }, ctx);

      currentAbort = null;
      return result;
    },

    steer(message: string): void {
      if (disposed) return;
      steerBuffer.push(message);
      // V1: steer buffer 在当前 runAgent 的 turn-limiter 层面暂未消费
    },

    abort(): void {
      if (disposed) return;
      currentAbort?.abort();
    },

    dispose(): void {
      disposed = true;
      currentAbort?.abort();
      currentAbort = null;
    },
  };

  return session;
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}
