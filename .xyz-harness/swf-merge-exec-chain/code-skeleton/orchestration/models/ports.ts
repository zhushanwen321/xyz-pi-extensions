// code-skeleton/orchestration/models/ports.ts
//
// 【增量骨架】合并到 extensions/subagents-workflow/src/orchestration/models/ports.ts
// 本文件只画 AgentRunner port 的 onEvent 签名升级（D-005 落地）。
// 其余 RunStore/WorkerHost/LifecycleDeps 迁移不动。
//
// 接线层级：[跨模块 port] —— AgentRunner interface 定义，execution/SAR implements。
//
// 设计基线：D-005（onEvent 透传保留 live-record）/ D-A8（AgentEvent 桥接）/
//   BC-10（live-record TUI 进度保持）。

import type { AgentEvent } from "../../shared/agent-event.ts";
import type { AgentCallOpts, AgentResult } from "./types.ts";

// ── Port 1: AgentRunner（onEvent 签名升级）──

/**
 * Agent 子进程执行 port。Infra 实现：SubprocessAgentRunner（合并后迁入 execution 层）。
 *
 * 【改动】onEvent 签名从 `(raw: Record<string, unknown>) => void` 升级为
 *        `(event: AgentEvent) => void`（D-005 落地）。
 *
 * 理由：委托后（SAR → executeAndAwait）不再有 raw JSONL 中间层——executeAndAwait
 *   直接出 AgentEvent（session-runner handleSdkEvent 出口）。dispatchAgentCall onEvent
 *   闭包删 jsonlToAgentEvent 翻译层，直接 updateFromEvent(liveRecord, event)。
 *   live/jsonl-to-agent-event.ts 删除（D-A7）。
 *
 * BC-10 影响：live-record TUI 进度保持——onEvent 语义升级（raw→AgentEvent），
 *   updateFromEvent 仍驱动 liveRecord，WorkflowsView 实时进度不变。
 *
 * onEvent（可选）：session-runner 每解析出一条 AgentEvent（tool_start/tool_end/turn_end/
 *   message_end/error/compaction）就回调一次，供调用方实时更新 live record 供 TUI 展示进度。
 *   不传则不回调（向后兼容；现有调用点不传不受影响）。
 */
export interface AgentRunner {
  run(
    opts: AgentCallOpts,
    signal: AbortSignal,
    onEvent?: (event: AgentEvent) => void, // ← 原: (raw: Record<string, unknown>) => void
  ): Promise<AgentResult>;
}

// ── 改动影响链（合并时同步）──
//
// 1. execute-agent-call.ts executeAgentCall 签名（透传 onEvent）：
//    现有: `(call, runner, budget, signal, trace, onEvent?: (raw: Record<string, unknown>) => void)`
//    改为: `(call, runner, budget, signal, trace, onEvent?: (event: AgentEvent) => void)`
//    函数体不变（onEvent 透传给 runner.run，类型跟随 port）。
//
// 2. error-recovery.ts dispatchAgentCall onEvent 闭包（见 error-recovery-onevent.ts 骨架）：
//    现有: `(raw) => { for (const e of jsonlToAgentEvent(raw)) updateFromEvent(live, e); }`
//    改为: `(event: AgentEvent) => updateFromEvent(liveRecord, event)`
//
// 3. live/jsonl-to-agent-event.ts: 删除（D-A7，不再需 raw→AgentEvent 翻译）
//
// 4. AgentEvent 类型来源：shared/agent-event.ts（两包合并后唯一出口）。
//    workflow 原本无 AgentEvent 概念（只有 raw JSONL），合并后从 subagents types.ts 收口到 shared。
