/**
 * Turn Timing Extension
 *
 * 记录每个 turn 中各阶段（thinking、text output、toolcall 生成、tool 执行）的耗时。
 * 通过 message_update 流式事件和 tool_execution 事件获取精确的时间边界，
 * turn 结束时写入 custom entry。
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { createTimingCollector } from "./collector.ts";

const CUSTOM_TYPE = "turn_timing";

/** message_update 事件中 assistantMessageEvent 的最小类型 */
interface MessageUpdateLike {
  assistantMessageEvent: { type: string };
}

/** tool_execution_start/end 事件的最小类型 */
interface ToolExecLike {
  toolCallId: string;
  toolName: string;
}

export default function turnTimingExtension(pi: ExtensionAPI): void {
  let collector = createTimingCollector();

  pi.on("message_update", (event: unknown) => {
    const e = event as MessageUpdateLike;
    if (!e.assistantMessageEvent) return;
    collector.onMessageUpdate(e.assistantMessageEvent.type, Date.now());
  });

  pi.on("tool_execution_start", (event: unknown) => {
    const e = event as ToolExecLike;
    collector.onToolExecutionStart(e.toolCallId, e.toolName, Date.now());
  });

  pi.on("tool_execution_end", (event: unknown) => {
    const e = event as ToolExecLike;
    collector.onToolExecutionEnd(e.toolCallId, Date.now());
  });

  pi.on("turn_end", () => {
    const data = collector.flush();
    if (data.phases.length > 0) {
      pi.appendEntry(CUSTOM_TYPE, data);
    }
    collector = createTimingCollector();
  });
}
