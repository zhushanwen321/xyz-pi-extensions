// src/index.ts
import type { ExtensionAPI, SessionStartEvent } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import { SubagentRuntime, setRuntime, getRuntime } from "./runtime.ts";
import { registerSubagentsCommand } from "./commands/config.ts";

/**
 * FR-10.2: Pi extension 工厂。
 * 创建 SubagentRuntime 骨架，在 session_start 注入 modelRegistry。
 */
export default function subagentsExtension(pi: ExtensionAPI): void {
  registerSubagentsCommand(pi);

  pi.on("session_start", (ctx: SessionStartEvent) => {
    const c = ctx as any;
    const existing = getRuntime();
    const cwd = c.cwd as string;
    const homeDir = process.env.HOME || process.env.USERPROFILE || cwd;
    const agentDir = path.join(homeDir, ".pi", "agent");

    const rt = existing ?? new SubagentRuntime({ cwd, homeDir, agentDir });
    rt.injectModelRegistry(c.modelRegistry as never);

    const entries = (c.sessionManager?.getEntries?.() ?? []) as unknown[];
    rt.restoreFromEntries(entries);

    if (!existing) setRuntime(rt);
  });
}
