// src/core/spawn-event-adapter.ts
//
// pi 子进程 stdout JSON 事件流的解析器。Core 叶子原语（仅依赖 types.ts）。
//
// spawn 改造的基座模块。session-runner runSpawn 用 `pi --mode rpc` spawn 子进程。
// RPC mode 不向 stdout 输出 header 行（只有 json/print mode 才输出），故 runSpawn 额外
// 通过 get_state RPC 握手回填 sessionFile/sessionId。两种 stdout 行形态本模块统一解析：
//   1. header 行（json/print mode 首行）：{ type: "session", id, timestamp, cwd, ... }
//      —— session 元信息，含 session id（RPC mode 不发，靠 get_state 握手替代）
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

/** Pi 原生 extension_ui_request 的方法特定字段（按 method 平铺）。
 *  与 Pi rpc-types.ts L230-265 的 RpcExtensionUIRequest 1:1 对应。
 *  method 是判别字段；每个变体仅列出该 method 的已知字段（可选字段保持可选）。
 *  未知 method 走 string fallback（保留 raw 字段，避免协议演进时丢字段）。 */
export type ExtensionUiRequest =
  | { method: "select"; title: string; options: string[]; timeout?: number }
  | { method: "confirm"; title: string; message: string; timeout?: number }
  | { method: "input"; title: string; placeholder?: string; timeout?: number }
  | { method: "editor"; title: string; prefill?: string }
  | { method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { method: "setStatus"; statusKey: string; statusText: string | undefined }
  | {
      method: "setWidget";
      widgetKey: string;
      widgetLines: string[] | undefined;
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | { method: "setTitle"; title: string }
  | { method: "set_editor_text"; text: string }
  // 未知 method fallback：保留原始字段，避免协议演进时丢信息
  | { method: string; raw: Record<string, unknown> };

/** 解析后的 extension_ui_request 顶层形状（type 守卫用）。
 *  id 和 method 在顶层，method 特定字段平铺（与 Pi 原生格式一致）。 */
interface ExtensionUiRequestEnvelope {
  type: "extension_ui_request";
  id: string;
  method: string;
  [key: string]: unknown;
}

/** Pi 原生 RPC response 顶层形状（type 守卫用）。
 *  与 Pi rpc-types.ts 的 RpcResponse 一致：type:"response" + command + success。 */
interface RpcResponseEnvelope {
  type: "response";
  command: string;
  success: boolean;
  id?: string;
  data?: unknown;
  error?: string;
  [key: string]: unknown;
}

/** parseSpawnLine 的分类结果。
 *
 *  关键改动（W1 协议层重写）：
 *    - extension_ui_request 分支：从 {id, params:Record} 改为 {id, request: ExtensionUiRequest}
 *      （request 按 method 平铺，与 Pi rpc-types.ts 1:1）
 *    - response 分支：从 {id, result, error} 改为 {id?, command, success, data?, error?}
 *      （Pi 原生 RpcResponse 格式，SR-1 根因 1b） */
export type ParsedSpawnLine =
  | { kind: "header"; header: SpawnSessionHeader }
  | { kind: "event"; event: SdkEvent }
  | {
      kind: "response";
      id?: string;
      command: string;
      success: boolean;
      data?: unknown;
      error?: string;
    }
  | { kind: "extension_ui_request"; id: string; request: ExtensionUiRequest }
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
 * 判断解析出的 JSON 是否为 Pi 原生 RPC response。
 *
 * SR-1 根因 1b 修复：旧守卫判 JSON-RPC 2.0（jsonrpc + id + result/error），
 * 但 Pi 实际发 {type:"response", command, success, data?, error?}。
 * 新守卫只认 Pi 原生格式：
 *   - type === "response"
 *   - command: string（调用的命令名，如 "run_tool"）
 *   - success: boolean
 * id 可选（通知型 response 无 id）。
 *
 * 旧 JSON-RPC 2.0 response（{jsonrpc, id, result}）不再被识别 → 落 invalid 分支。
 */
function isRpcResponse(obj: unknown): obj is RpcResponseEnvelope {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return (
    r.type === "response" &&
    typeof r.command === "string" &&
    typeof r.success === "boolean"
  );
}

/**
 * 判断解析出的 JSON 是否为 Pi 原生 extension_ui_request。
 *
 * 关键改动（W1）：旧守卫判 JSON-RPC 2.0（jsonrpc + method:"extension_ui_request" + params），
 * 但 Pi 实际发平铺格式 {type:"extension_ui_request", id, method, ...method特定字段}。
 * 新守卫：
 *   - type === "extension_ui_request"（顶层 type 字段，非 method 字段值）
 *   - id: string
 *   - method: string（select/confirm/.../set_editor_text 等具体方法名）
 *
 * 删掉 jsonrpc 守卫（Pi 不发 JSON-RPC 2.0 envelope）和 params 守卫（字段平铺，无 params 包裹）。
 * 旧 JSON-RPC 2.0 格式（{jsonrpc, method:"extension_ui_request", params}）不再被识别。
 */
function isExtensionUiRequest(obj: unknown): obj is ExtensionUiRequestEnvelope {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return (
    r.type === "extension_ui_request" &&
    typeof r.id === "string" &&
    typeof r.method === "string"
  );
}

/**
 * 从已通过 isExtensionUiRequest 守卫的 envelope 构造 ExtensionUiRequest 变体。
 *
 * 按 method 平铺提取字段（与 Pi rpc-types.ts L230-265 1:1）。已知 method
 * 走对应变体；未知 method 走 string fallback（保留 raw 字段全量字段）。
 *
 * 字段类型容错：协议字段类型不符（如 options 非数组）时，该字段降级为空数组/undefined
 *（数组类字段做元素类型过滤，剔除非字符串元素），仍归类为已知 method（不丢 method 信息）。
 */
function buildExtensionUiRequest(env: ExtensionUiRequestEnvelope): ExtensionUiRequest {
  const r: Record<string, unknown> = env;
  switch (env.method) {
    case "select":
      return {
        method: "select",
        title: typeof r.title === "string" ? r.title : "",
        options: Array.isArray(r.options)
          ? r.options.filter((x): x is string => typeof x === "string")
          : [],
        ...(typeof r.timeout === "number" ? { timeout: r.timeout } : {}),
      };
    case "confirm":
      return {
        method: "confirm",
        title: typeof r.title === "string" ? r.title : "",
        message: typeof r.message === "string" ? r.message : "",
        ...(typeof r.timeout === "number" ? { timeout: r.timeout } : {}),
      };
    case "input":
      return {
        method: "input",
        title: typeof r.title === "string" ? r.title : "",
        ...(typeof r.placeholder === "string" ? { placeholder: r.placeholder } : {}),
        ...(typeof r.timeout === "number" ? { timeout: r.timeout } : {}),
      };
    case "editor":
      return {
        method: "editor",
        title: typeof r.title === "string" ? r.title : "",
        ...(typeof r.prefill === "string" ? { prefill: r.prefill } : {}),
      };
    case "notify":
      return {
        method: "notify",
        message: typeof r.message === "string" ? r.message : "",
        ...(r.notifyType === "info" || r.notifyType === "warning" || r.notifyType === "error"
          ? { notifyType: r.notifyType }
          : {}),
      };
    case "setStatus":
      return {
        method: "setStatus",
        statusKey: typeof r.statusKey === "string" ? r.statusKey : "",
        statusText: typeof r.statusText === "string" ? r.statusText : undefined,
      };
    case "setWidget": {
      const placement = r.widgetPlacement;
      const widgetLines = Array.isArray(r.widgetLines)
        ? r.widgetLines.filter((x): x is string => typeof x === "string")
        : undefined;
      return {
        method: "setWidget",
        widgetKey: typeof r.widgetKey === "string" ? r.widgetKey : "",
        widgetLines,
        ...(placement === "aboveEditor" || placement === "belowEditor"
          ? { widgetPlacement: placement }
          : {}),
      };
    }
    case "setTitle":
      return {
        method: "setTitle",
        title: typeof r.title === "string" ? r.title : "",
      };
    case "set_editor_text":
      return {
        method: "set_editor_text",
        text: typeof r.text === "string" ? r.text : "",
      };
    default:
      // 未知 method：保留全部原始字段，避免协议演进时丢信息
      return { method: env.method, raw: r };
  }
}

/**
 * 解析 pi stdout 的一行。
 *
 * @param line stdout 的一行（不含换行符；空行返回 null）
 * @returns 分类结果，或 null（空行/仅空白）
 *
 * 分类规则（判定顺序关键，见 W1 bug 修复）：
 *   - 空白行 → null（pi 可能输出空行，跳过）
 *   - 合法 JSON + type:"session" + 必需字段 → header
 *   - 合法 JSON + type:"extension_ui_request" + id + method → extension_ui_request
 *     （必须在 event 分支之前，否则被 typeof obj.type===string 吞为 event）
 *   - 合法 JSON + type:"response" + command + success → response
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

  // extension_ui_request：必须在 event 分支之前判定（W1 判定顺序 bug 修复）。
  // 原因：extension_ui_request 也有 type 字段，若 event 分支（typeof obj.type===string）
  // 在前，会被当 event 静默吞掉。现在先于 event 判定，命中后按 method 构造 request。
  if (isExtensionUiRequest(obj)) {
    return { kind: "extension_ui_request", id: obj.id, request: buildExtensionUiRequest(obj) };
  }

  // RPC response：Pi 原生格式 {type:"response", command, success, data?, error?}
  if (isRpcResponse(obj)) {
    return {
      kind: "response",
      ...(typeof obj.id === "string" ? { id: obj.id } : {}),
      command: obj.command,
      success: obj.success,
      ...(obj.data !== undefined ? { data: obj.data } : {}),
      ...(typeof obj.error === "string" ? { error: obj.error } : {}),
    };
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
