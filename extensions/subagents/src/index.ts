// src/index.ts
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@mariozechner/pi-coding-agent";

import { registerSubagentsCommand } from "./commands/config.ts";
import { getRuntime, setRuntime,SubagentRuntime } from "./runtime.ts";
import { registerSubagentTool } from "./tools/subagent-tool.ts";

/**
 * FR-10.2: Pi extension 工厂。
 * 创建 SubagentRuntime 骨架，在 session_start 注入 modelRegistry + pi。
 *
 * ⚠️ 类型安全要点：ExtensionHandler 签名是 `(event, ctx) => ...`（两个参数）。
 * SessionStartEvent 只有 { type, reason, previousSessionFile? } —— modelRegistry、
 * cwd、ui 等运行时字段全部在第二个参数 ExtensionContext 上。
 * 此前代码错误地从 event 读取这些字段（通过 `as { ... }` 断言绕过检查），
 * 导致 modelRegistry 永远 undefined。
 */
export default function subagentsExtension(pi: ExtensionAPI): void {
  registerSubagentsCommand(pi);
  registerSubagentTool(pi);

  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const existing = getRuntime();
    const cwd = ctx.cwd;
    const homeDir = process.env.HOME || process.env.USERPROFILE || cwd;
    const agentDir = path.join(homeDir, ".pi", "agent");

    const rt = existing ?? new SubagentRuntime({ cwd, homeDir, agentDir });
    rt.injectPi(pi);
    rt.injectModelRegistry(ctx.modelRegistry);

    // widget UI 不再附加：subagent 进度通过 renderResult 渲染在对话流中。
    // widget tracker 仍保留（供 /subagents list 获取 running agents 数据）。
    // 不调用 attachWidgetUI() → render() 始终 no-op → 无 spinner/淡出动画。

    const entries = ctx.sessionManager.getEntries() ?? [];
    rt.restoreFromEntries(entries);

    if (!existing) setRuntime(rt);
  });
}
