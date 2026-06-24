/**
 * Ports 桥接 — Pi → ServicePorts 适配（adapters 层）
 *
 * 单一 ports 构造点（DRY）：command-adapter / event-adapter / index 共用。
 *
 * - persistence: pi.appendEntry 映射到 appendState / appendHistory（type 字符串区分）
 * - ui: ctx.ui 的 setWidget/setStatus/notify + hasUI + theme 的 fg/bold（满足 ThemeLike 形状）
 * - messaging: pi.sendMessage 映射到 sendContextMessage / sendUserMessage
 * - session: ctx.sessionManager.getEntries + best-effort splice + ctx.getContextUsage + ctx.signal
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { ENTRY_TYPE, HISTORY_ENTRY_TYPE } from "../persistence";
import type { MessagingPort, PersistencePort, SessionPort, UiPort } from "../ports";
import type { ServicePorts } from "../service";

/**
 * 把 Pi 的 pi / ctx 适配为 ServicePorts。
 *
 * persistence 的 appendState 用 ENTRY_TYPE，appendHistory 用 HISTORY_ENTRY_TYPE，
 * 与 serializeState / makeHistoryEntry 的输出对齐（session.ts reconstructGoalState 据此识别）。
 *
 * UiPort 接口未声明 fg/bold（D-22：只声明机器可检查的能力边界），
 * 构造满足 UiPort & ThemeLike 的对象后整体断言为 UiPort（多出的 fg/bold 运行时存在，
 * projection/widget.ts 的 asTheme 用 `as unknown as ThemeLike` 单步断言取出）。
 */
export function buildPorts(pi: ExtensionAPI, ctx: ExtensionContext): ServicePorts {
	const persistence: PersistencePort = {
		appendState: (state): void => {
			pi.appendEntry(ENTRY_TYPE, state);
		},
		appendHistory: (entry): void => {
			pi.appendEntry(HISTORY_ENTRY_TYPE, entry);
		},
	};

	const uiPort = {
		setWidget(name: string, content: string[] | string | undefined): void {
			ctx.ui.setWidget(name, content);
		},
		setStatus(name: string, text: string | undefined): void {
			ctx.ui.setStatus(name, text);
		},
		notify(text: string, level: "info" | "warning" | "error"): void {
			ctx.ui.notify(text, level);
		},
		get hasUI(): boolean {
			return Boolean(ctx.hasUI);
		},
		// ThemeLike 形状：透传 ctx.ui.theme 的 fg/bold。
		// `as never` 是合法的单步断言（ThemeColor 是 string 子集，运行时安全）。
		fg(color: string, text: string): string {
			return ctx.ui.theme.fg(color as never, text);
		},
		bold(text: string): string {
			return ctx.ui.theme.bold(text);
		},
	} as UiPort;

	const messaging: MessagingPort = {
		sendContextMessage: (content, deliverAs, customType): void => {
			pi.sendMessage(
				{
					customType: customType ?? "goal-context",
					content,
					display: false,
				},
				{ deliverAs },
			);
		},
		sendUserMessage: (content, deliverAs): void => {
			pi.sendUserMessage(content, { deliverAs });
		},
	};

	const session: SessionPort = {
		getEntries: () => ctx.sessionManager.getEntries(),
		// best-effort splice：对 getEntries() 返回的数组执行 splice（reconstructGoalState 的 entry GC 用）。
		spliceEntry: (index, count): void => {
			ctx.sessionManager.getEntries().splice(index, count);
		},
		getContextUsage: () => {
			const usage = ctx.getContextUsage();
			return usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow } : null;
		},
		get signal(): AbortSignal | undefined {
			return ctx.signal;
		},
	};

	return { persistence, ui: uiPort, messaging, session };
}
