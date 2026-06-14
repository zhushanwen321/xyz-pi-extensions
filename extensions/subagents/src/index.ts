// src/index.ts
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext, SessionShutdownEvent, SessionStartEvent } from "@mariozechner/pi-coding-agent";

import { registerSubagentsCommand } from "./commands/config.ts";
import { cleanupOrphanedWorktreeDirs, pruneWorktrees } from "./core/worktree.ts";
import { maybeCleanupExpiredSessionFiles } from "./persistence/session-file-gc.ts";
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

    // ADR-024 L2: 概率性清理过期 subagent session 文件（TTL 30 天）
    maybeCleanupExpiredSessionFiles(homeDir, cwd);

    // V5: 崩溃恢复 —— 上次进程被 kill -9 / 断电时 session_shutdown 未触发，
    // tmpdir 下可能残留 pi-agent-* worktree 物理目录。每次 session_start 扫描清理。
    pruneWorktrees(cwd);

    if (!existing) setRuntime(rt);
  });

  // V5: 正常退出清理 —— Pi quit / reload / session 切换时清理 tmpdir 残留的
  // pi-agent-* worktree 物理目录。覆盖 Ctrl+C 退出、扩展热重载、session new/resume/fork。
  // 注：SessionShutdownEvent 不携带 cwd，且 git worktree prune（仓库级）会在下次
  // session_start 补跑，此处只做 cwd 无关的 tmpdir 扫描。
  // kill -9 / 断电不走此路径，靠下次 session_start 的 pruneWorktrees(cwd) 兜底。
  pi.on("session_shutdown", (_event: SessionShutdownEvent) => {
    cleanupOrphanedWorktreeDirs();
  });
}
