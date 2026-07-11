// code-skeleton/shared/agent-event.ts
//
// 【新模块骨架】合并到 extensions/subagents-workflow/src/shared/agent-event.ts
//
// 两包合并后 AgentEvent 类型的唯一出口。subagents 原 types.ts 定义 AgentEvent，
// workflow 原本无此概念（只有 raw JSONL Record<string, unknown>）。
// 合并后 workflow 的 AgentRunner port + error-recovery onEvent 闭包均 import 此类型。
//
// 内容：直接 re-export subagents 现有 AgentEvent（零改动收口）。

export type {
  AgentEvent,
  AgentUsage,
} from "../execution/types.ts";

// ── 类型来源说明（合并时）──
//
// subagents/src/types.ts 的 AgentEvent 类型迁移到 execution/types.ts（合并后路径）。
// 本文件作为 shared 层唯一 re-export 出口，供：
//   - orchestration/models/ports.ts（AgentRunner.run onEvent 参数类型）
//   - orchestration/error-recovery.ts（dispatchAgentCall onEvent 闭包参数类型）
//   - execution/subagent-service.ts（executeAndAwait onEvent 参数类型）
//   - execution/subprocess-agent-runner.ts（run onEvent 参数类型）
//   - execution/session-runner.ts（RunOptions.onEvent 参数类型，已存在）
//
// 不复制类型定义——单一来源（execution/types.ts），shared 层只 re-export（DRY）。
