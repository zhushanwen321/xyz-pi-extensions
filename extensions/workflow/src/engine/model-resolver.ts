/**
 * Model resolver — resolves target model for workflow agent calls.
 *
 * Spawn 架构回归后，model 解析退化为直传：仅当调用方显式传入 opts.model
 * 时返回该值，否则返回 undefined（由 pi 子进程使用默认模型）。
 *
 * 旧的 scene→model 解析（依赖 model-switch / subagents）已删除——workflow
 * 不再承担按 scene 选模型的职责。
 */

import type { AgentCallOpts } from "../infra/agent-pool.js";

/**
 * 解析目标模型。
 * 仅返回显式传入的 opts.model（空串视为未指定，归一为 undefined）；
 * 其余情况返回 undefined。
 * 保留 async 签名以减少调用点改动。
 */
export async function resolveModel(opts: AgentCallOpts): Promise<string | undefined> {
  return opts.model || undefined;
}
