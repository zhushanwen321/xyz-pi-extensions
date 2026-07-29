import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CONFIG, countAssistantReplies, extractTitle, isEnabled, setSwitch } from "../pure.js";

// ────────────────────────────────────────────────────
// countAssistantReplies
// ────────────────────────────────────────────────────

describe("countAssistantReplies", () => {
	it("[user, assistant] → 1", () => {
		const entries = [
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant" } },
		];
		expect(countAssistantReplies(entries)).toBe(1);
	});

	it("[user, assistant, user, assistant] → 2", () => {
		const entries = [
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant" } },
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant" } },
		];
		expect(countAssistantReplies(entries)).toBe(2);
	});

	it("过滤非 message（thinkingLevelChange / modelChange）→ 1", () => {
		const entries = [
			{ type: "thinkingLevelChange" },
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant" } },
			{ type: "modelChange" },
		];
		expect(countAssistantReplies(entries)).toBe(1);
	});

	it("[user, assistant, toolResult] → 1（toolResult 不计入）", () => {
		const entries = [
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant" } },
			{ type: "toolResult" },
		];
		expect(countAssistantReplies(entries)).toBe(1);
	});
});

// ────────────────────────────────────────────────────
// extractTitle
// ────────────────────────────────────────────────────

describe("extractTitle", () => {
	it("trim 首尾空白 → '修复登录 bug'", () => {
		const resp = { content: [{ type: "text", text: "  修复登录 bug  \n" }] };
		expect(extractTitle(resp, 50)).toBe("修复登录 bug");
	});

	it("去引号 + markdown 强调 → '重构 API 层'", () => {
		const resp = { content: [{ type: "text", text: "\"**重构 API 层**\"" }] };
		expect(extractTitle(resp, 50)).toBe("重构 API 层");
	});

	it("超长文本截断到 <=50 字符", () => {
		const long = "这是一个非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常长的标题".repeat(3);
		const resp = { content: [{ type: "text", text: long }] };
		const result = extractTitle(resp, 50);
		expect(Array.from(result).length).toBe(50);
	});

	it("仅 toolCall 块（无 text）→ ''", () => {
		const resp = { content: [{ type: "toolCall", name: "x", arguments: {} }] };
		expect(extractTitle(resp, 50)).toBe("");
	});

	it("空 content → ''", () => {
		const resp = { content: [] };
		expect(extractTitle(resp, 50)).toBe("");
	});
});

// ────────────────────────────────────────────────────
// isEnabled
// ────────────────────────────────────────────────────

describe("isEnabled", () => {
	let tmpDir: string;

	afterEach(() => {
		if (tmpDir) {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("文件存在 → true", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rename-test-"));
		const switchFile = path.join(tmpDir, "auto-rename-enabled");
		fs.writeFileSync(switchFile, "");
		expect(isEnabled(switchFile)).toBe(true);
	});

	it("文件不存在 → false", () => {
		expect(isEnabled(path.join(os.tmpdir(), "rename-not-exist-" + Date.now()))).toBe(false);
	});

	it("fs.existsSync 抛错 → false（当作关闭）", () => {
		const spy = vi.spyOn(fs, "existsSync").mockImplementation(() => {
			throw new Error("EACCES");
		});
		try {
			expect(isEnabled("/whatever")).toBe(false);
		} finally {
			spy.mockRestore();
		}
	});
});

// ────────────────────────────────────────────────────
// setSwitch
// ────────────────────────────────────────────────────

describe("setSwitch", () => {
	let tmpDir: string;

	afterEach(() => {
		if (tmpDir) {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("enabled=true 创建文件（含父目录）", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rename-set-"));
		const switchFile = path.join(tmpDir, "sub", "auto-rename-enabled");
		const msg = setSwitch(switchFile, true);
		expect(msg).toContain("已开启");
		expect(fs.existsSync(switchFile)).toBe(true);
	});

	it("enabled=false 删除已存在的文件", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rename-set-"));
		const switchFile = path.join(tmpDir, "auto-rename-enabled");
		fs.writeFileSync(switchFile, "");
		const msg = setSwitch(switchFile, false);
		expect(msg).toContain("已关闭");
		expect(fs.existsSync(switchFile)).toBe(false);
	});

	it("enabled=false 文件不存在 → 提示已是关闭状态", () => {
		const switchFile = path.join(os.tmpdir(), "rename-not-exist-" + Date.now());
		const msg = setSwitch(switchFile, false);
		expect(msg).toContain("已是关闭状态");
	});

	it("enabled=true 文件已存在 → 幂等，仍提示已开启", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rename-set-"));
		const switchFile = path.join(tmpDir, "auto-rename-enabled");
		fs.writeFileSync(switchFile, "");
		const msg = setSwitch(switchFile, true);
		expect(msg).toContain("已开启");
	});
});

// ────────────────────────────────────────────────────
// CONFIG smoke
// ────────────────────────────────────────────────────

describe("CONFIG", () => {
	it("包含 switchFilePath / maxTitleLength / renameInstruction", () => {
		expect(typeof CONFIG.switchFilePath).toBe("string");
		expect(CONFIG.switchFilePath.length).toBeGreaterThan(0);
		expect(CONFIG.maxTitleLength).toBe(50);
		expect(typeof CONFIG.renameInstruction).toBe("string");
	});
});
