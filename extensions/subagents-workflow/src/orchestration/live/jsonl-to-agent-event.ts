// engine/live/jsonl-to-agent-event.ts
//
// 把 subprocess JSONL 事件翻译成 AgentEvent，喂给 updateFromEvent。
//
// 事件源同构：pi --mode json（print-mode.ts:104-108）把 SDK session.subscribe 的每个事件
// 原样 JSON.stringify 写进 stdout。所以 subprocess 的 JSONL 流 = subagents in-process 收到的
// SdkEvent，逐字节相同。本翻译器的 switch 逻辑照搬 subagents session-runner.ts:383-431 的
// handleSdkEvent，适配点仅是输入类型（Record<string, unknown> 而非强类型 SdkEvent）。
//
// 与 processJsonlEvent 的关系：并行旁路，不替换它。processJsonlEvent 仍负责填 pipeline
// 的终态字段（parsedOutput/output/usage 累积）；本翻译器负责把事件喂给 live record 供 TUI
// 实时展示。两者各司其职，从同一份 JSONL 事件各自取所需。

import type { AgentEvent, AgentUsage, ToolCallResult } from "./types.ts";

/** subprocess JSONL 事件（JSON.parse 结果）。duck-typed，对应 SDK SdkEvent。 */
type JsonlEvent = Record<string, unknown>;

/**
 * 把一条 JSONL 事件翻译成 AgentEvent。
 *
 * 返回 undefined 表示该事件不映射到任何 AgentEvent（如 session header、message_start、
 * tool_execution_update），调用方应跳过。
 *
 * 一个 JSONL 事件可能产出**多条** AgentEvent（message_end 的 usage + error 各一条），
 * 故返回数组。绝大多数情况长度为 0 或 1；message_end 最多 2 条。
 */
export function jsonlToAgentEvent(raw: JsonlEvent): AgentEvent[] {
  const type = raw.type;

  switch (type) {
    // ── session header：非执行事件，跳过 ──
    case "session":
    case "message_start":
    case "turn_start":
    case "tool_execution_update":
      return [];

    case "tool_execution_start": {
      const toolName = typeof raw.toolName === "string" ? raw.toolName : "";
      return [{ type: "tool_start", toolName, args: raw.args }];
    }

    case "tool_execution_end": {
      const toolName = typeof raw.toolName === "string" ? raw.toolName : "";
      // args 可能不在 tool_execution_end 里（SDK 契约：end 可能不带 args）。
      // 此处不强求回填——updateFromEvent 的 tool_end 分支会保留 tool_start 时记的 args。
      const isError = raw.isError === true;
      return [{
        type: "tool_end",
        toolName,
        args: raw.args,
        result: raw.result as ToolCallResult | undefined,
        isError,
      }];
    }

    case "message_update": {
      // assistantMessageEvent：{ type: "thinking_delta", delta } 或 { delta }（text）
      const ame = raw.assistantMessageEvent as Record<string, unknown> | undefined;
      if (ame?.type === "thinking_delta") {
        const delta = typeof ame.delta === "string" ? ame.delta : "";
        return [{ type: "thinking_delta", delta }];
      }
      if (ame !== undefined && ame.delta !== undefined) {
        const delta = typeof ame.delta === "string" ? ame.delta : String(ame.delta);
        return [{ type: "text_delta", delta }];
      }
      return [];
    }

    case "turn_end": {
      return [{ type: "turn_end" }];
    }

    case "message_end": {
      return accumulateMessageEnd(raw);
    }

    case "compaction_start": {
      return [{ type: "compaction" }];
    }

    default:
      // 未知事件类型：跳过（不报错，向前兼容未来新增的 SDK 事件）
      return [];
  }
}

/**
 * message_end 翻译：usage 拍平成 AgentUsage，stopReason=error/aborted 额外产 error 事件。
 *
 * 照搬 subagents session-runner.ts:367-381 的 accumulateMessageEnd 逻辑：
 * - 必须先产 message_end(usage)，再判断 error——LLM provider 常在错误响应里也携带 usage
 *   （计费需如此），若先判 error 跳过 usage 会丢计费数据。
 * - cost 形如 { total: number }，拍平成 AgentUsage.cost（number）。
 */
function accumulateMessageEnd(raw: JsonlEvent): AgentEvent[] {
  const events: AgentEvent[] = [];
  const msg = raw.message as Record<string, unknown> | undefined;
  const usageRaw = msg?.usage as Record<string, unknown> | undefined;

  if (usageRaw) {
    const costObj = usageRaw.cost as Record<string, unknown> | undefined;
    const { cost: _costField, ...usageBase } = usageRaw;
    void _costField;
    const usage: AgentUsage = {
      ...usageBase,
      cost: typeof costObj?.total === "number" ? costObj.total : undefined,
    } as AgentUsage;
    events.push({ type: "message_end", usage });
  }

  const stopReason = msg?.stopReason;
  if (stopReason === "error" || stopReason === "aborted") {
    const errorMessage = typeof msg?.errorMessage === "string"
      ? msg.errorMessage
      : (typeof raw.reason === "string" ? raw.reason : String(stopReason));
    events.push({ type: "error", message: errorMessage });
  }

  return events;
}
