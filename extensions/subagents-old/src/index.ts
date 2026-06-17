// src/index.ts
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext, SessionShutdownEvent, SessionStartEvent } from "@mariozechner/pi-coding-agent";

import { registerSubagentsCommand } from "./commands/config.ts";
import { cleanupOrphanedWorktreeDirs, pruneWorktrees } from "./core/worktree.ts";
import { maybeCleanupExpiredSessionFiles } from "./persistence/session-file-gc.ts";
import { getRuntime, setRuntime,SubagentRuntime } from "./runtime.ts";
import { registerSubagentTool } from "./tools/subagent-tool.ts";
import { renderBgNotifyMessage } from "./tui/bg-notify-render.ts";
import { SubagentsProgressWidget } from "./tui/progress-widget.ts";
import type { ThemeLike } from "./tui/subagent-render.ts";

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

  // background 完成通知的对话流渲染器（display:true 后由 CustomMessageComponent 调用）。
  // 把 subagent-bg-notify 渲染成与 tool block 同风格的完成块，让异步任务完成有显式信号。
  pi.registerMessageRenderer("subagent-bg-notify", renderBgNotifyMessage);

  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const existing = getRuntime();
    const cwd = ctx.cwd;
    const homeDir = process.env.HOME || process.env.USERPROFILE || cwd;
    const agentDir = path.join(homeDir, ".pi", "agent");

    const rt = existing ?? new SubagentRuntime({ cwd, homeDir, agentDir });
    // Bug 修复：复用 existing runtime 时重读 config.json。跨进程/手动编辑配置后，
    // 内存不再停留旧值（否则首次 category 确认界面显示的是过时默认模型）。
    if (existing) rt.reloadGlobalConfig();
    rt.injectPi(pi);
    rt.injectModelRegistry(ctx.modelRegistry);
    // Round 4 MF3: 若上一 session session_shutdown 时 dispose() 设了 _disposed=true，
    // 新 session 必须复活——否则 notifyBgCompletion 顶部 if (this._disposed) return 短路，
    // 所有 background 完成回注（FR-O1）在第一次 /resume /fork /new 后整体失效。
    if (existing) rt.revive();
    // 注入当前 session id——/subagents list 按此过滤 history，只显示当前 session 的记录。
    rt.setSessionId(ctx.sessionManager.getSessionId());

    // input 下方常驻进度 widget：有 subagent 运行时显示计数 + /subagents list 指引。
    // background 执行进度无法回流到对话流 tool block（SDK onUpdate 生命周期限制），
    // 此 widget 作为可观测性补偿。count=0 时 render 返回 [] 不占位。
    // factory 只在 setWidget 时执行一次，返回的持久组件订阅 runtime.onChange 驱动重渲。
    // hasUI=false（RPC/print 模式）时跳过——widget 是交互式 UI 概念，无 UI 环境无意义。
    if (ctx.hasUI) {
      ctx.ui.setWidget(
        "subagents-progress",
        (tui: { requestRender(): void }, theme: ThemeLike) => new SubagentsProgressWidget(rt, theme, tui),
        { placement: "belowEditor" },
      );
    }

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
    // FR-O1.5 G-029: flush 合并窗口中 pending 的 background 完成通知，
    // 清理定时器。否则 session quit/reload 时已入队但未 flush 的通知会静默丢失。
    getRuntime()?.dispose();
    cleanupOrphanedWorktreeDirs();
  });
}
