import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 配置：开关文件路径、标题最大长度、rename 指令。readonly，集中管理便于测试注入。 */
export interface RenameConfig {
	readonly switchFilePath: string;
	readonly maxTitleLength: number;
	readonly renameInstruction: string;
}

/** pi 实际使用的根数据目录（与 pi 的 getAgentDir 同源，读 PI_CODING_AGENT_DIR env） */
const ROOT = process.env.PI_CODING_AGENT_DIR
	?? path.join(os.homedir(), ".pi", "agent");

export const CONFIG: RenameConfig = {
	switchFilePath: path.join(ROOT, "auto-rename-enabled"),
	maxTitleLength: 50,
	renameInstruction: "根据以上对话，为这个会话生成一个简短标题（3-8 个词）。用对话所用的语言。只输出标题文本，不要解释，不要 emoji，不要引号或 markdown 标记。",
};

/** entry 的宽松类型（structural typing，兼容 pi 的 SessionEntry[] 但不依赖 pi 类型） */
interface EntryLike {
	type: string;
	message?: { role?: string };
}

/**
 * 数 session 中 assistant 回复数。用于判定首 turn（===1）。
 * 判定条件：entry.type === "message" && entry.message.role === "assistant"
 * （pi 内部 session-manager.ts:367/937/1392 同款模式）
 */
export function countAssistantReplies(entries: ReadonlyArray<EntryLike>): number {
	let count = 0;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message?.role === "assistant") {
			count++;
		}
	}
	return count;
}

/** AssistantMessage.content 的宽松元素类型 */
interface ContentBlockLike {
	type: string;
	text?: string;
}

/**
 * 从 completeSimple 返回的 AssistantMessage.content 提取标题文本。
 * 遍历 content 取 type==='text' 的 .text 拼接，trim，去首尾引号/markdown 包装，截断。
 * 仅 toolCall 块（无 text）或空 content → 返回空串。
 */
export function extractTitle(resp: { content: ReadonlyArray<ContentBlockLike> }, maxLength: number): string {
	const rawText = resp.content
		.filter((block) => block.type === "text" && block.text)
		.map((block) => block.text as string)
		.join("");

	const trimmed = rawText.trim();
	if (!trimmed) return "";

	// 去首尾成对引号（单/双/中文）和 markdown 强调标记（* ** ` _）
	const cleaned = trimmed
		.replace(/^["“”'`*_]+|["“”'`*_]+$/g, "")
		.trim();

	if (!cleaned) return "";

	// 按 Unicode 码点截断（避免截断多字节字符）
	const chars = Array.from(cleaned);
	if (chars.length <= maxLength) return cleaned;
	return chars.slice(0, maxLength).join("");
}

/**
 * 检查开关文件是否存在。文件存在=开启。
 * try/catch 包裹，读失败（权限/IO）返回 false（当作关闭）。
 */
export function isEnabled(switchFilePath: string): boolean {
	try {
		return fs.existsSync(switchFilePath);
	} catch {
		return false;
	}
}

/**
 * 设置开关状态。enabled=true 创建文件（含父目录），false 删除文件。
 * 返回操作结果描述（供 command 反馈）。IO 失败时返回错误信息，不抛。
 */
export function setSwitch(switchFilePath: string, enabled: boolean): string {
	try {
		if (enabled) {
			fs.mkdirSync(path.dirname(switchFilePath), { recursive: true });
			fs.writeFileSync(switchFilePath, "", { flag: "a" });
			return `已开启：自动重命名会话（${switchFilePath}）`;
		}
		if (fs.existsSync(switchFilePath)) {
			fs.unlinkSync(switchFilePath);
			return "已关闭：自动重命名会话";
		}
		return "已是关闭状态，无需操作";
	} catch (e) {
		return `设置失败：${e instanceof Error ? e.message : String(e)}`;
	}
}
