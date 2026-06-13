/**
 * Model resolver — resolves target model for workflow agent calls.
 *
 * 改造前：异步 dynamic import @zhushanwen/pi-model-switch 的 resolveModelForScene。
 * 改造后：调用 @zhushanwen/pi-subagents 的 resolveModelForScene()（通过 getRuntime()）。
 *
 * scene 名直接作为 agent 名传入 subagents 5 级配置链解析。
 */

import type { AgentCallOpts } from "../infra/agent-pool.js";
import { getRuntime } from "@zhushanwen/pi-subagents";

/**
 * 解析目标模型。
 * 优先级：显式 opts.model > subagents resolveModelForScene(scene) > undefined
 */
export async function resolveModel(opts: AgentCallOpts): Promise<string | undefined> {
  if (opts.model) return opts.model;

  if (opts.scene) {
    const runtime = getRuntime();
    if (!runtime) return undefined;

    try {
      const resolved = runtime.resolveModelForScene(opts.scene);
      return resolved;
    } catch {
      return undefined;
    }
  }

  return undefined;
}
