// src/resolution/fork-context.ts
import type { ForkOptions, ForkResult } from "../types.ts";

const DEFAULT_MAX_EXCHANGES = 5;
const DEFAULT_MAX_TOKENS = 4000;
// 粗略 token 估算：中文约 1 字 = 1 token，英文约 4 字符 = 1 token。
// 这里用字符数 / 3 作为近似（保守）
const CHARS_PER_TOKEN = 3;

/** FR-5.1: 从父 session branch 提取 user/assistant 消息，跳过 toolResult。 */
export function forkContext(branch: ReadonlyArray<unknown>, opts: ForkOptions): ForkResult {
  const maxExchanges = opts.maxExchanges ?? DEFAULT_MAX_EXCHANGES;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  // 提取 user/assistant 文本对
  interface Exchange { userText?: string; assistantText?: string; }
  const exchanges: Exchange[] = [];
  let current: Exchange | null = null;

  for (const entry of branch) {
    const e = entry as { type?: string; content?: string | string[] };
    const text = extractText(e.content);
    if (e.type === "userMessage") {
      if (current) exchanges.push(current);
      current = { userText: text };
    } else if (e.type === "assistantMessage") {
      if (current) current.assistantText = text;
      else current = { assistantText: text };
    }
    // toolResult / 其他类型跳过
  }
  if (current) exchanges.push(current);

  // 取最后 N 轮
  const limited = exchanges.slice(-maxExchanges);

  // token 截断
  let totalChars = 0;
  let truncated = false;
  const kept: Exchange[] = [];
  for (let i = limited.length - 1; i >= 0; i--) {
    const ex = limited[i];
    const chars = (ex.userText?.length ?? 0) + (ex.assistantText?.length ?? 0);
    if (totalChars + chars > maxTokens * CHARS_PER_TOKEN) {
      truncated = true;
      break;
    }
    totalChars += chars;
    kept.unshift(ex);
  }

  // 格式化
  const lines: string[] = ["# Parent Conversation Context", ""];
  for (const ex of kept) {
    if (ex.userText) { lines.push(`**User:** ${ex.userText}`, ""); }
    if (ex.assistantText) { lines.push(`**Assistant:** ${ex.assistantText}`, ""); }
  }

  return {
    context: lines.join("\n"),
    exchangeCount: kept.length,
    truncated,
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : (c as { text?: string })?.text ?? "")).join("");
  return "";
}
