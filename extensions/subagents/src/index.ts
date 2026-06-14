// src/index.ts
import * as path from "node:path";

import type { ExtensionAPI, SessionStartEvent } from "@mariozechner/pi-coding-agent";

import { registerSubagentsCommand } from "./commands/config.ts";
import { getRuntime, setRuntime,SubagentRuntime } from "./runtime.ts";
import { registerSubagentTool } from "./tools/subagent-tool.ts";

/**
 * FR-10.2: Pi extension 工厂。
 * 创建 SubagentRuntime 骨架，在 session_start 注入 modelRegistry + pi。
 */
export default function subagentsExtension(pi: ExtensionAPI): void {
  registerSubagentsCommand(pi);
  registerSubagentTool(pi);

  pi.on("session_start", (ctx: SessionStartEvent) => {
    // ctx 形状随 SDK 版本变化，用结构化类型提取需要的字段
    const c = ctx as {
      cwd?: string;
      modelRegistry?: unknown;
      sessionManager?: { getEntries?: () => unknown[] };
      ui?: { setWidget?: (k: string, c: unknown) => void; setStatus?: (k: string, t: unknown) => void };
    };
    const existing = getRuntime();
    const cwd = (c.cwd ?? process.cwd()) as string;
    const homeDir = process.env.HOME || process.env.USERPROFILE || cwd;
    const agentDir = path.join(homeDir, ".pi", "agent");

    const rt = existing ?? new SubagentRuntime({ cwd, homeDir, agentDir });
    rt.injectPi(pi as never);
    rt.injectModelRegistry(c.modelRegistry as never);

    // Live widget: 注入 UI（setWidget/setStatus）
    if (c.ui?.setWidget && c.ui?.setStatus) {
      rt.attachWidgetUI({
        setWidget: (key, content) => c.ui!.setWidget!(key, content),
        setStatus: (key, text) => c.ui!.setStatus!(key, text),
      });
    }

    const entries = (c.sessionManager?.getEntries?.() ?? []) as unknown[];
    rt.restoreFromEntries(entries);

    if (!existing) setRuntime(rt);
  });
}
