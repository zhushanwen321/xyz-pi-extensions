import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerAutoRenameCommand } from "./commands.js";
import { callRenameLLM, isSubagentSession } from "./llm.js";
import { CONFIG, countAssistantReplies, isEnabled } from "./pure.js";

/** turn_end 事件的宽松类型（参考 pi extensions/types.ts:704-710 的 TurnEndEvent） */
interface TurnEndLikeEvent {
	type: "turn_end";
	turnIndex: number;
	message: unknown;
	toolResults: unknown[];
}

/** ToolInfo 的宽松类型（pi 的 ToolInfo = Pick<ToolDefinition,...> & {sourceInfo}，用宽松类型避免强耦合）。 */
interface ToolInfoLike {
	name: string;
	description: string;
	parameters: object;
}

/**
 * pi-rename-session extension 工厂函数。
 * 新 session 首 turn 完成后，自动生成会话标题并 setSessionName 落库。
 */
export default function renameSessionExtension(pi: ExtensionAPI): void {
	registerAutoRenameCommand(pi);

	pi.on("turn_end", async (_event: TurnEndLikeEvent, ctx: ExtensionContext) => {
		try {
			// 1. 开关检查
			if (!isEnabled(CONFIG.switchFilePath)) return;

			// 2. 排除 subagent 子进程 session（子 session 是临时产物，rename 产生噪音）
			if (isSubagentSession(ctx.sessionManager.getSessionDir())) return;

			// 3. 首 turn 判定（assistant 回复数 === 1）
			const entries = ctx.sessionManager.getEntries();
			const assistantCount = countAssistantReplies(entries);
			if (assistantCount !== 1) return;

			// 4. LLM 生成标题并落库。pi 运行时的事件链是 await 的（runner.emit → await handler），
			// 若 await callRenameLLM 会阻塞 agent 进入下一次迭代。这里用 detached promise 脱离 await 链，
			// 真正实现 fire-and-forget：handler 立即 resolve，LLM 调用与 setSessionName 在后台异步完成。
			// pi.getAllTools() 的 .d.ts 因 pi-ai 泛型未完全解析而被降级，经 unknown 收窄到宽松 ToolInfoLike。
			void callRenameLLM(ctx, pi.getAllTools() as unknown as ReadonlyArray<ToolInfoLike>)
				.then((title) => {
					if (title) pi.setSessionName(title);
				})
				.catch((e) => console.error("[pi-rename-session] rename LLM failed:", e));
			// rename 是 best-effort，任何 LLM 失败（网络/提取/auth）都静默跳过保留原 label，不进 session history。
			// 同步部分（开关/子 session/首 turn 判定）的错误兜底：绝不阻断 agent 循环。
			// eslint-disable-next-line taste/no-silent-catch
		} catch (e) {
			console.error("[pi-rename-session] failed:", e);
		}
	});
}
