import { describe, expect, it } from "vitest";

import { buildMessages, isSubagentSession, mapToolsToAiFormat } from "../llm.js";

describe("buildMessages", () => {
	it("LTC1: 从 entries 构造前缀 + 追加 rename 指令", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
		];
		const result = buildMessages(entries, "生成标题");
		expect(result).toHaveLength(3);
		expect(result[0]).toEqual({ role: "user", content: [{ type: "text", text: "hi" }] });
		expect(result[2]).toEqual({ role: "user", content: [{ type: "text", text: "生成标题" }] });
	});

	it("LTC2: 过滤非 message entry", () => {
		const entries = [
			{ type: "thinkingLevelChange", data: {} },
			{ type: "message", message: { role: "user", content: [] } },
			{ type: "message", message: { role: "assistant", content: [] } },
			{ type: "modelChange", data: {} },
		];
		const result = buildMessages(entries, "生成标题");
		// user + assistant + rename 指令
		expect(result).toHaveLength(3);
	});

	it("LTC3: toolResult message 保留（kvcache 前缀完整性）", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: [] } },
			{ type: "message", message: { role: "assistant", content: [] } },
			{ type: "message", message: { role: "toolResult", content: [] } },
			{ type: "message", message: { role: "assistant", content: [] } },
		];
		const result = buildMessages(entries, "生成标题");
		// 4 条前缀 + rename 指令
		expect(result).toHaveLength(5);
		expect((result[2] as { role: string }).role).toBe("toolResult");
	});
});

describe("isSubagentSession", () => {
	it("LTC4: subagents 路径返回 true", () => {
		expect(isSubagentSession("/home/u/.pi/agent/subagents/--proj--/sessions")).toBe(true);
	});

	it("LTC5: 主 session 路径返回 false", () => {
		expect(isSubagentSession("/home/u/.pi/agent/sessions")).toBe(false);
	});
});

describe("mapToolsToAiFormat", () => {
	it("LTC6: ToolInfo[] 转 pi-ai Tool[]（只留 name/description/parameters）", () => {
		const tools = [
			{
				name: "read",
				description: "read file",
				parameters: { type: "object" },
				promptGuidelines: ["x"],
				sourceInfo: {},
			},
		];
		const result = mapToolsToAiFormat(tools);
		expect(result).toEqual([{ name: "read", description: "read file", parameters: { type: "object" } }]);
		// 确认多余字段已去掉（toEqual 已校验结构无多余键，此处再显式断言 sourceInfo/promptGuidelines 不存在）
		expect("sourceInfo" in result[0]).toBe(false);
		expect("promptGuidelines" in result[0]).toBe(false);
	});
});
