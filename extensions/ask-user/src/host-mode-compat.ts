// src/host-mode-compat.ts
//
// host-mode 兼容层——复制自 subagent-workflow/src/execution/host-mode.ts 的 resolveHostMode。
//
// 设计动机（PR #85 #13）：channel-handler.ts 需按主进程模式分流（TUI vs GUI），但 ask-user
// 不能静态 import @zhushanwen/pi-subagent-workflow（可选 peerDep，未安装时 import 会导致整个
// ask-user 加载失败——见 channel-handler.ts 顶部约束）。resolveHostMode 是纯函数（3 行逻辑，
// 仅依赖 ExtensionMode 类型），复制成本远低于经 globalThis Symbol 暴露的方案。
//
// ⚠️ 保持同步：subagent-workflow/src/execution/host-mode.ts 的 resolveHostMode 若修改判定逻辑，
// 本文件必须同步更新，两处逻辑必须一致。完整版还导出 willRespondToAskUser / hasInteractiveUI，
// 但 channel-handler 当前只需 resolveHostMode，故只复制这一项（YAGNI）。

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

/** 主进程运行模式分类（与 subagent-workflow host-mode.ts 的 HostMode 一致）。
 *  - "tui"：纯 Pi TUI，ctx.ui.custom 可用
 *  - "gui"：xyz-agent GUI，sidecar 通道可用
 *  - "headless"：无交互 UI 通道（json/print 输出模式，或 mode 未穿透） */
export type HostMode = "tui" | "gui" | "headless";

/** 从 ExtensionContext.mode 解析主进程模式分类。
 *  - "tui" → tui
 *  - "rpc" → gui
 *  - "json"/"print"/undefined → headless（向后兼容：mode 未穿透时按「无 UI」保守处理）
 *
 *  入参类型用 ExtensionContext["mode"] 而非直接 import ExtensionMode：后者在单包 tsconfig
 *  解析路径下未从 @mariozechner/pi-coding-agent 直接导出（仅全量 stub 有），索引访问
 *  避开导出差异，类型等价（ExtensionContext.mode 的类型即 ExtensionMode）。 */
export function resolveHostMode(mode: ExtensionContext["mode"] | undefined): HostMode {
	if (mode === "tui") return "tui";
	if (mode === "rpc") return "gui";
	return "headless"; // json/print/undefined
}
