import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { CONFIG, countAssistantReplies, isEnabled } from "./pure.js";

/** turn_end 事件的宽松类型（参考 pi extensions/types.ts:704-710 的 TurnEndEvent） */
interface TurnEndLikeEvent {
	type: "turn_end";
	turnIndex: number;
	message: unknown;
	toolResults: unknown[];
}

/**
 * pi-rename-session extension 工厂函数。
 * 新 session 首 turn 完成后，自动生成会话标题并 setSessionName 落库。
 */
export default function renameSessionExtension(pi: ExtensionAPI): void {
	pi.on("turn_end", async (_event: TurnEndLikeEvent, ctx: ExtensionContext) => {
		try {
			// 1. 开关检查
			if (!isEnabled(CONFIG.switchFilePath)) return;

			// 2. 首 turn 判定（assistant 回复数 === 1）
			const entries = ctx.sessionManager.getEntries();
			const assistantCount = countAssistantReplies(entries);
			if (assistantCount !== 1) return;

			// 3. LLM 调用 + 标题提取 + setSessionName
			// TODO(rename-llm wave): 实现 buildRenameContext + completeSimple + extractTitle + setSessionName
			// 当前 wave 只实现核心判定逻辑骨架，LLM 部分由下一个 wave 补全
			// fire-and-forget 降级：turn_end handler 失败绝不能阻断 agent 循环。
			// rename 是 best-effort，任何失败（LLM 调用/提取/auth/读取）都静默跳过保留原 label。
			// eslint-disable-next-line taste/no-silent-catch
		} catch (e) {
			console.error("[pi-rename-session] failed:", e);
		}
	});
}
