// src/core/output-collector.ts
/**
 * FR-1.3: 从 session.messages 最后一条 assistant message 提取文本。
 * prompt() resolve 后 session.messages 已含最终 assistant message（同步属性）。
 * 只拼接 type === "text" 的 content part，跳过 thinking/tool_call。
 */
export function collectResponseText(messages: ReadonlyArray<{ role: string; content?: ReadonlyArray<{ type: string; text?: string }> }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    if (!msg.content) return "";
    return msg.content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text!)
      .join("");
  }
  return "";
}
