/**
 * Workflow Extension — Format Helpers
 *
 * 跨 spawn 路径共用的格式化工具（SubprocessAgentRunner + ConcurrencyGate）。
 *
 * 层归属：Infra。纯函数，零依赖，零副作用。
 */

/**
 * 格式化 schema 失败时的执行上下文（exitCode + stderr 摘要）。
 *
 * [HISTORICAL] schema-error 分支必须暴露真实失败原因。abort/崩溃场景下 pi 子进程
 * 未输出任何 JSONL，pipeline.hasToolCall=false，旧实现仅返回 "Agent did not call
 * structured-output tool" 覆盖了 stderr 里的 "Operation aborted, sending SIGKILL"
 * 等关键诊断信息。本 helper 把 exitCode + stderr（截断）拼到 error 字段尾部。
 *
 * 教训来源：daily-news-impact 三轮根因分析全被旧实现的误导信息带偏，误判为
 * model 故障 / 工具缺失 / turn-signal abort / ConcurrencyGate 异常，最终靠
 * 调用栈定位真因（worker IIFE fire-and-forget）。
 *
 * 仅在 stderr 非空或 exitCode≠0 时附加（成功 exit 0 + 空 stderr 时不附加，
 * 保持原有"纯 schema 错误"语义）。
 *
 * 由 SubprocessAgentRunner.run 和 ConcurrencyGate.run 共用——两处 spawn 路径
 * 各自有 schema-error 检查分支，逻辑对称。
 */
export function formatFailureContext(exitCode: number, stderr: string): string {
  const parts: string[] = [];
  if (exitCode !== 0) parts.push(`exitCode=${exitCode}`);
  const trimmed = stderr.trim();
  if (trimmed) parts.push(`stderr=${trimmed.slice(0, 500)}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}
