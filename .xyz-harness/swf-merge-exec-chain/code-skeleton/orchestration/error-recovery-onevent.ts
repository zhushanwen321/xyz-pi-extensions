// code-skeleton/orchestration/error-recovery-onevent.ts
//
// 【增量骨架】合并到 extensions/subagents-workflow/src/orchestration/error-recovery.ts
// 本文件只画 dispatchAgentCall 内 onEvent 闭包的简化改动（D-005/D-A7 落地）。
// 其余 dispatchAgentCall 主体（resolveAgentCall/AgentCall 构造/gate.withSlot/postAgentResult）迁移不动。
//
// 接线层级：[模块内直调] —— onEvent 闭包真调 updateFromEvent（删 jsonlToAgentEvent 中间层）。
//
// 设计基线：D-005（onEvent 透传）/ D-A7（删 live/jsonl-to-agent-event.ts）/ BC-10。

import type { AgentEvent } from "../../shared/agent-event.ts";
import type { ExecutionRecord } from "../../execution/execution-record.ts";
import { updateFromEvent } from "../../execution/execution-record.ts";

// ── dispatchAgentCall onEvent 闭包改动 ──
//
// 现有（error-recovery.ts L280-285 附近）：
//
//   const onEvent = (raw: Record<string, unknown>): void => {
//     for (const agentEvent of jsonlToAgentEvent(raw)) {
//       updateFromEvent(liveRecord, agentEvent);
//     }
//   };
//
// 改为（D-005：executeAndAwait 直接出 AgentEvent，删 jsonlToAgentEvent 翻译）：
//
//   const onEvent = (event: AgentEvent): void => {
//     updateFromEvent(liveRecord, event);
//   };
//
// 接线验证（Level 1）：
//   - updateFromEvent 真调（execution/execution-record.ts 导出，合并后唯一）
//   - liveRecord 是 dispatchAgentCall 上方 createRecord 创建（workflow live-record，挂 trace node.live）
//   - AgentEvent 类型来自 shared/agent-event.ts（合并后从 subagents types.ts 收口）

/**
 * onEvent 闭包的简化版（合并时替换现有 dispatchAgentCall 内闭包）。
 *
 * [模块内直调] updateFromEvent —— 真调，驱动 liveRecord 累积 text/thinking/toolCalls。
 * TUI 靠 tick 轮询 trace.toArray() 读 node.live，无需显式通知（与现有机制一致）。
 *
 * @param liveRecord dispatchAgentCall 创建的 per-call live record（挂 trace node.live）
 * @param event      AgentEvent（SAR 委托后从 executeAndAwait 桥接而来，强类型）
 */
export function createOnEventClosure(
  liveRecord: ExecutionRecord,
): (event: AgentEvent) => void {
  return (event: AgentEvent): void => {
    updateFromEvent(liveRecord, event);
  };
}

// ── 删除项（D-A7）──
//
// live/jsonl-to-agent-event.ts: 删除
//   - 现有职责：raw JSONL → AgentEvent[] 翻译（jsonlToAgentEvent 函数）
//   - 删除理由：SAR 委托后 executeAndAwait 直接出 AgentEvent（session-runner handleSdkEvent
//     已完成 SdkEvent → AgentEvent 翻译），不再需 raw→AgentEvent 二次翻译
//   - import 清理：error-recovery.ts 删 `import { jsonlToAgentEvent } from "../infra/jsonl-to-agent-event.ts"`

// ── import 调整（合并时）──
//
// error-recovery.ts 现有 import：
//   import { updateFromEvent } from "../engine/live/types.ts";  // 或 live/execution-record.ts
//
// 改为（合并后用 execution 层唯一版本，D-A7）：
//   import { updateFromEvent } from "../../execution/execution-record.ts";
//   import type { AgentEvent } from "../../shared/agent-event.ts";
//
// 注：live/execution-record.ts + live/types.ts 删除后（D-A7 直接删），用 execution/execution-record.ts。
//     需处理 projectLiveProgress 差异（workflow liveRecord 独有字段）—— 见 §7 处置行。
