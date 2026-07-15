// src/execution/execute-options-mapper.ts
//
// D-A2: AgentCallOpts → ExecuteOptions 映射（adapter 职责）
// D-A9: per-call timeoutMs 合并进 AbortSignal
//
// 接线层级：[模块内直调] —— SAR.run 内调。

import type { AgentCallOpts } from "../orchestration/models/types.ts";
import type { ModelInfo } from "./model-resolver.ts";
import type { ExecuteOptions } from "./types.ts";

/**
 * slug 最大长度（字符）。subagent/workflow 创建时 slug 超过此值会被截断。
 * 与 subagent tool schema 的 maxLength: 20 保持一致。
 */
export const SLUG_MAX_LENGTH = 20;

/**
 * D-A2: AgentCallOpts → ExecuteOptions 映射。
 *
 * adapter 职责——SubagentService 的 ExecuteOptions 是稳定内部契约，不为 workflow 的
 * AgentCallOpts 做适配（映射归调用方 SAR）。
 *
 * 映射规则：
 *   prompt          → task
 *   description     → slug（≤20 字符，超长截断。缺失时回落 agent 名）
 *   agent           → agent
 *   schema          → schema
 *   schemaEnv       → schemaEnv（D-A6 bridge）
 *   cwd             → cwd
 *   model           → model（显式 override 透传，ctxModel 不再压扁为 id 填底）
 *   ctxModel        → ctxModel（完整 ModelInfo 对象透传，让 resolveModel 走第 3 层透明传递）
 *   skillPath       → skillPath
 *
 * 忽略字段（委托后由 executeAndAwait 内部机制替代）：
 *   systemPromptFiles —— resolveIdentity 从 agentConfig.systemPrompt 读
 *   timeoutMs         —— mergeTimeoutSignal 单独处理
 *   scene             —— subagents 不消费
 *
 * description 原先被忽略，现作为 slug 透传（ExecuteOptions.slug 必填）。
 */
export function mapToExecuteOptions(
  opts: AgentCallOpts,
  ctxModel?: ModelInfo,
): ExecuteOptions {
  // slug：优先 description，缺失回落 agent 名（保证非空）。超长截断。
  const rawSlug = opts.description ?? opts.agent ?? "workflow-agent";
  return {
    task: opts.prompt,
    slug: rawSlug.length > SLUG_MAX_LENGTH ? rawSlug.slice(0, SLUG_MAX_LENGTH) : rawSlug,
    agent: opts.agent,
    schema: opts.schema,
    schemaEnv: opts.schemaEnv,
    cwd: opts.cwd,
    model: opts.model,
    ctxModel,
    skillPath: opts.skillPath,
  };
}

/**
 * D-A9: per-call timeoutMs 合并进 AbortSignal。
 *
 * 墙钟 timeoutMs（per-call）+ 外部 signal（run 级 abort）都生效。
 * 缺此合并则 agent({timeoutMs:5000}) 静默无效（BC-9）。
 *
 * @param signal    外部 signal（workflow run 级 controller.signal）
 * @param timeoutMs per-call 墙钟超时；undefined/<=0 → 不设超时，原样返回 signal
 * @returns 合并后的 signal（timeoutMs 或外部 signal 任一 abort 都触发）
 */
export function mergeTimeoutSignal(
  signal: AbortSignal,
  timeoutMs?: number,
): AbortSignal {
  if (!timeoutMs || timeoutMs <= 0) {
    return signal;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();

  const onExternalAbort = (): void => controller.abort();
  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      if (!signal.aborted) signal.removeEventListener("abort", onExternalAbort);
    },
    { once: true },
  );

  return controller.signal;
}
