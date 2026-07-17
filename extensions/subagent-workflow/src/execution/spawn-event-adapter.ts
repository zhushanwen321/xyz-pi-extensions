// src/core/spawn-event-adapter.ts
//
// pi 子进程 stdout JSON 事件流的解析器。Core 叶子原语（仅依赖 types.ts）。
//
// spawn 改造的基座模块。pi --mode json 子进程通过 stdout 输出两种行：
//   1. header 行（首行）：{ type: "session", id, timestamp, cwd, ... }
//      —— session 元信息，含 session id（文件路径由 W2 runSpawn 配合 --session-dir 推导）
//   2. 事件行：{ type: "tool_execution_start" | "message_end" | ..., ... }
//      —— 与 in-process session.subscribe 收到的 SdkEvent 同源同构
//
// 本模块只做「行 → 分类事件对象」的纯解析，不做累积/翻译（那是 runSpawn +
// handleSdkEvent 的职责）。刻意保持薄，便于单测。
//
// 与 session-runner.handleSdkEvent 的契约：parseSpawnLine 返回 kind:"event" 的
// event 字段即为 SdkEvent，可直接喂给 handleSdkEvent（事件 type schema 一致，
// 由 print-mode.ts:106 JSON.stringify(event) 保证同源）。

import * as fs from "node:fs";
import * as path from "node:path";

import type { SdkEvent } from "./types.ts";

/** pi stdout header 行（session 元信息）。type 固定为 "session"。 */
export interface SpawnSessionHeader {
  readonly type: "session";
  readonly id: string;
  readonly timestamp: string;
  readonly cwd: string;
  readonly parentSession?: string;
  readonly version?: number;
}

/** parseSpawnLine 的分类结果。 */
export type ParsedSpawnLine =
  | { kind: "header"; header: SpawnSessionHeader }
  | { kind: "event"; event: SdkEvent }
  | { kind: "response"; id: string; result?: unknown; error?: unknown }
  | { kind: "extension_ui_request"; id: string; params: Record<string, unknown> }
  | { kind: "invalid"; raw: string; error: string };

/**
 * 判断解析出的 JSON 是否为 header 行（type === "session"）。
 * 校验所有必需字段（id/timestamp/cwd），缺任一则不收窄——避免下游
 * deriveSessionFilePath 访问 undefined 字段时抛 TypeError。
 */
function isSessionHeader(obj: unknown): obj is SpawnSessionHeader {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return (
    r.type === "session" &&
    typeof r.id === "string" &&
    typeof r.timestamp === "string" &&
    typeof r.cwd === "string"
  );
}

/**
 * 判断解析出的 JSON 是否为 JSON-RPC 2.0 response（有 jsonrpc + id，无 method）。
 * RPC response 有两种：成功（有 result）或失败（有 error）。
 */
function isRpcResponse(obj: unknown): obj is { id: string; result?: unknown; error?: unknown } {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return (
    r.jsonrpc === "2.0" &&
    typeof r.id === "string" &&
    !("method" in r) &&
    ("result" in r || "error" in r)
  );
}

/**
 * 判断解析出的 JSON 是否为 extension_ui_request（JSON-RPC 2.0 request，method 固定）。
 * 子进程通过 stdout 发出 UI 交互请求（如 ask_user），父进程处理后通过 stdin 回写响应。
 */
function isExtensionUiRequest(obj: unknown): obj is { id: string; params: Record<string, unknown> } {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return (
    r.jsonrpc === "2.0" &&
    typeof r.id === "string" &&
    r.method === "extension_ui_request" &&
    typeof r.params === "object" &&
    r.params !== null
  );
}

/**
 * 解析 pi stdout 的一行。
 *
 * @param line stdout 的一行（不含换行符；空行返回 null）
 * @returns 分类结果，或 null（空行/仅空白）
 *
 * 分类规则：
 *   - 空白行 → null（pi 可能输出空行，跳过）
 *   - 合法 JSON + type:"session" + 有 id → header
 *   - 合法 JSON + 有 type 字段 → event（SdkEvent，type schema 由调用方校验）
 *   - 合法 JSON 但无 type → invalid
 *   - 非法 JSON → invalid（记录 error，不抛——单行损坏不应中断整个流）
 *
 * 容错原则：stdout 是流式输出，任何单行解析失败都不应中断进程。invalid 归类
 * 由 runSpawn 决定是否记录/忽略，本函数不丢弃信息。
 */
export function parseSpawnLine(line: string): ParsedSpawnLine | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch (err) {
    return {
      kind: "invalid",
      raw: trimmed,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (isSessionHeader(obj)) {
    return { kind: "header", header: obj };
  }

  // RPC response：JSON-RPC 2.0 response（有 jsonrpc + id + result/error，无 method）
  if (isRpcResponse(obj)) {
    const r = obj as Record<string, unknown>;
    return { kind: "response", id: r.id as string, result: r.result, error: r.error };
  }

  // extension_ui_request：JSON-RPC 2.0 request（jsonrpc + id + method:extension_ui_request + params）
  if (isExtensionUiRequest(obj)) {
    const r = obj as Record<string, unknown>;
    return { kind: "extension_ui_request", id: r.id as string, params: r.params as Record<string, unknown> };
  }

  // 事件行：必须有 type 字段（SdkEvent 契约）
  if (
    typeof obj === "object" &&
    obj !== null &&
    typeof (obj as Record<string, unknown>).type === "string"
  ) {
    return { kind: "event", event: obj as SdkEvent };
  }

  return {
    kind: "invalid",
    raw: trimmed,
    error: "JSON missing string 'type' field",
  };
}

/**
 * 从已收集的 header + 事件流推导子进程的 session 文件路径。
 *
 * pi session 文件命名规则（session-manager.ts:846）：
 *   `${fileTimestamp}_${sessionId}.jsonl`
 * 其中 fileTimestamp = header.timestamp.replace(/[:.]/g, "-")
 * （ISO 时间里的冒号和点替换为连字符，如 2026-07-03T12-34-56-789Z）。
 *
 * @param header spawn 解析出的 session header
 * @param sessionDir 指定的 session 目录（spawn 时通过 --session-dir 传入）
 * @returns 推导的 session 文件绝对路径（不保证文件存在——子进程可能仍在写入）
 *
 * 注意：这是基于 pi 命名规则的推导。runSpawn 会在进程结束后校验文件实际存在，
 * 不存在时用 sessionId 后缀匹配兜底。
 */
export function deriveSessionFilePath(
  header: SpawnSessionHeader,
  sessionDir: string,
): string {
  const fileTimestamp = header.timestamp.replace(/[:.]/g, "-");
  return `${sessionDir}/${fileTimestamp}_${header.id}.jsonl`;
}

/**
 * 在 sessionDir 中按 sessionId 后缀匹配查找实际存在的 session 文件。
 *
 * 兜底机制：deriveSessionFilePath 基于命名规则推导，若 pi 命名规则变化导致
 * 推导路径不存在，用 sessionId 作为后缀匹配实际文件。sessionId 是 header
 * 的稳定标识，文件名必含它，匹配可靠。
 *
 * @returns 匹配到的文件绝对路径，或 undefined（无匹配）
 */
export function findSessionFileByHeaderId(
  sessionDir: string,
  sessionId: string,
): string | undefined {
  try {
    const files = fs.readdirSync(sessionDir);
    // 文件名格式：<fileTimestamp>_<sessionId>.jsonl，sessionId 是后缀（去掉 .jsonl）
    const match = files.find((f) => f.endsWith(`_${sessionId}.jsonl`));
    return match ? path.join(sessionDir, match) : undefined;
  } catch {
    return undefined;
  }
}
