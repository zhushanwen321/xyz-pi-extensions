// code-skeleton/execution/session-runner-extend.ts
//
// 【增量骨架】合并到 extensions/subagents-workflow/src/execution/session-runner.ts
// 本文件画 RunOptions 加 schemaEnv + runSpawn childEnv 注入 + runAndFinalize onEvent 透传 三处改动。
// 其余 runSpawn 主体（spawn/pump stdout/handleSdkEvent/collectResult）迁移不动（§7 merge）。
//
// 接线层级：[模块内直调] —— runSpawn 内部 childEnv 构造真设 PI_WORKFLOW_SCHEMA。
//
// 设计基线：D-A6（schema bridge）/ BC-8（schema 契约保持）/ BC-6（tool 层不变）。

import type { AgentEvent } from "../shared/agent-event.ts";

// ── RunOptions 增量字段（D-A6）──
//
// 现有 RunOptions（session-runner.ts）字段：
//   resolved, agentConfig, appendSystemPrompt, skillPath, schema, maxTurns, graceTurns,
//   signal, onEvent, fork?, worktree?, parentForkDepth?
//
// 新增字段（合并时并入 RunOptions interface）：
//   schemaEnv?: string  -- D-A6 bridge：存在时 runSpawn 在 childEnv 设 PI_WORKFLOW_SCHEMA
//
// 语义保证（BC-6）：
//   - tool 层 execute → ExecuteOptions.schemaEnv 恒 undefined → RunOptions.schemaEnv undefined
//     → childEnv 不设 PI_WORKFLOW_SCHEMA → structured-output tool 不注册（与合并前 tool 层一致）
//   - SAR 委托 → mapToExecuteOptions 设 schemaEnv（从 AgentCallOpts.schemaEnv 透传）
//     → runAndFinalize 构造 RunOptions 时 schemaEnv = opts.schemaEnv
//     → runSpawn childEnv 设 PI_WORKFLOW_SCHEMA → structured-output tool 注册（BC-8 等价）

export interface RunOptionsSchemaEnvPatch {
  /** D-A6: schema JSON 字符串，存在时注入 childEnv.PI_WORKFLOW_SCHEMA。 */
  schemaEnv?: string;
}

// ── runSpawn childEnv 注入改动（D-A6）──
//
// 现有 runSpawn（session-runner.ts L380 附近）childEnv 构造：
//
//   const childEnv = { ...process.env };
//   if (opts.fork && opts.parentForkDepth !== undefined) {
//     childEnv.PI_SUBAGENT_FORK_DEPTH = String(opts.parentForkDepth + 1);
//   }
//
// 改动：在上述 fork env 之后追加 schemaEnv 注入（3 行）：
//
//   // D-A6 bridge: schema 激活 structured-output 扩展注册 tool（workflow 编排层需要）
//   if (opts.schemaEnv) {
//     childEnv.PI_WORKFLOW_SCHEMA = opts.schemaEnv;
//   }
//
// 接线验证（Level 1）：childEnv 是 runSpawn 内部局部变量，opts.schemaEnv 真读取 + 赋值。

/**
 * runSpawn childEnv 构造的增量逻辑（合并时嵌入现有 runSpawn）。
 *
 * [模块内直调] —— 纯 env 赋值，真接线 opts.schemaEnv。
 * 本函数只画增量部分；合并时把 fork env + schemaEnv 赋值合并到现有 childEnv 构造块。
 */
export function applySchemaEnvToChildEnv(
  childEnv: Record<string, string | undefined>,
  schemaEnv?: string,
): void {
  if (schemaEnv) {
    childEnv.PI_WORKFLOW_SCHEMA = schemaEnv;
  }
}

// ── runAndFinalize onEvent 透传改动（D-005 接线 gap 补齐）──
//
// 现有 runAndFinalize（subagent-service.ts）调 runSpawn 时构造 RunOptions：
//
//   runSpawn(record, opts.task, {
//     resolved, agentConfig, appendSystemPrompt, skillPath, schema, maxTurns, graceTurns,
//     signal,
//     onEvent,  // ← 当前从 opts.onUpdate 派生（tool 层 SubagentToolDetails 回流节流）
//     fork, worktree, parentForkDepth,
//   }, ctx)
//
// gap：executeAndAwait 需要把外部 onEvent（AgentEvent 回流，workflow live-record 用）
//      传到 runSpawn，但 runAndFinalize 当前只从 opts.onUpdate 派生 onEvent。
//
// 改动方案（合并时）：
//   1. runAndFinalize 签名加第七参数 `onEvent?: (e: AgentEvent) => void`
//   2. 构造 RunOptions 时 onEvent 优先用参数传入的（executeAndAwait 路径），
//      fallback 到 opts.onUpdate 派生（execute() 路径，行为不变）
//   3. 同步加 `schemaEnv: opts.schemaEnv`（ExecuteOptions 新字段透传 RunOptions）
//
// 接线伪码（合并时替换 runAndFinalize 内 runSpawn 调用块）：

/**
 * runAndFinalize → runSpawn 的 RunOptions 构造增量（合并时嵌入）。
 *
 * [模块内直调] —— 真接线 opts.schemaEnv + 外部 onEvent 参数。
 */
export function buildRunOptionsPatch(
  opts: { schemaEnv?: string; onUpdate?: unknown },
  externalOnEvent?: (e: AgentEvent) => void,
  derivedOnEvent?: (e: AgentEvent) => void,
): RunOptionsSchemaEnvPatch & { onEvent?: (e: AgentEvent) => void } {
  return {
    // D-A6: schemaEnv 透传（ExecuteOptions.schemaEnv → RunOptions.schemaEnv）
    schemaEnv: opts.schemaEnv,
    // D-005: onEvent 优先用外部传入（executeAndAwait 路径），fallback 派生（execute 路径）
    onEvent: externalOnEvent ?? derivedOnEvent,
  };
}

// ── runSpawn 契约不变声明 ──
//
// runSpawn 签名不变：`(record, task, opts: RunOptions, ctx) => Promise<AgentResult>`
// RunOptions 加 schemaEnv 是增量字段（optional），现有调用点不传 → undefined → 行为不变（BC-6）。
// schemaEnv 传入时 childEnv 设 PI_WORKFLOW_SCHEMA → structured-output tool 注册（BC-8 等价）。
