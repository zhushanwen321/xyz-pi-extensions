// src/runtime/ui-request-observability.ts
//
// UI 请求可观测性状态（从 subagent-service.ts 提取，降低主文件行数）。
// 持有 sessionMode + handler 缺失告警去重集合，供 SubagentService 委托调用。

import type { ExtensionMode } from "@mariozechner/pi-coding-agent";

/** UI 请求可观测性状态。
 *  持有 sessionMode（主进程运行模式，W4 守卫透传）+ handler 缺失告警去重集合。
 *  外部通过 setMode/resetMissingHandlerWarnings/notifyMissingHandler 驱动。 */
export class UiRequestObservability {
  private sessionMode: ExtensionMode | undefined;
  private warnedMissingHandlerSessions = new Set<string>();

  setMode(mode: ExtensionMode | undefined): void {
    this.sessionMode = mode;
  }

  getMode(): ExtensionMode | undefined {
    return this.sessionMode;
  }

  /** handler 变化时重置告警去重（新 handler 就位后允许重新 warn）。 */
  resetMissingHandlerWarnings(): void {
    this.warnedMissingHandlerSessions.clear();
  }

  /** 记录 handler 缺失（per-session 去重，每 session 只 warn 一次）。
   *  W2: console.warn 兜底。W3 接入 pi.appendEntry("subagent:ui-request-missing-handler", ...)。 */
  notifyMissingHandler(sessionId: string): void {
    if (this.warnedMissingHandlerSessions.has(sessionId)) return;
    this.warnedMissingHandlerSessions.add(sessionId);
    console.warn(`[subagents] uiRequestHandler missing (session=${sessionId}, mode=${this.sessionMode})`);
  }
}
