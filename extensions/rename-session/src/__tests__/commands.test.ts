import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { executeAutoRenameCommand } from "../commands.js";

/**
 * executeAutoRenameCommand 依赖模块级 CONFIG.switchFilePath，用 vi.mock("./pure.js")
 * 注入可控路径，避免读写真实 ~/.pi/agent 目录。
 */
vi.mock("../pure.js", async (importActual) => {
	const actual = await importActual<typeof import("../pure.js")>();
	const tmpFile = path.join(os.tmpdir(), `rename-cmd-${Date.now()}-enabled`);
	return {
		...actual,
		CONFIG: { ...actual.CONFIG, switchFilePath: tmpFile },
		isEnabled: (p: string) => fs.existsSync(p),
		setSwitch: actual.setSwitch,
	};
});

// 被测模块须在 vi.mock 之后 import（vitest 提升 vi.mock）
import { CONFIG as MOCKED_CONFIG } from "../pure.js";

describe("executeAutoRenameCommand", () => {
	afterEach(() => {
		try { fs.unlinkSync(MOCKED_CONFIG.switchFilePath); } catch (e) { console.debug("cleanup skip:", e); }
	});

	it("无参数 → 显示当前状态 + 用法", () => {
		const msg = executeAutoRenameCommand("");
		expect(msg).toContain("自动重命名会话");
		expect(msg).toContain("用法");
	});

	it("status → 同无参数", () => {
		const msg = executeAutoRenameCommand("status");
		expect(msg).toContain("自动重命名会话");
	});

	it("on → 开启并创建文件", () => {
		const msg = executeAutoRenameCommand("on");
		expect(msg).toContain("已开启");
		expect(fs.existsSync(MOCKED_CONFIG.switchFilePath)).toBe(true);
	});

	it("off → 关闭并删除文件", () => {
		fs.writeFileSync(MOCKED_CONFIG.switchFilePath, "");
		const msg = executeAutoRenameCommand("off");
		expect(msg).toContain("已关闭");
		expect(fs.existsSync(MOCKED_CONFIG.switchFilePath)).toBe(false);
	});

	it("enable/disable 作为 on/off 别名", () => {
		expect(executeAutoRenameCommand("enable")).toContain("已开启");
		expect(fs.existsSync(MOCKED_CONFIG.switchFilePath)).toBe(true);
		expect(executeAutoRenameCommand("disable")).toContain("已关闭");
	});

	it("大小写不敏感（ON / Off）", () => {
		expect(executeAutoRenameCommand("ON")).toContain("已开启");
		expect(executeAutoRenameCommand("Off")).toContain("已关闭");
	});

	it("未知参数 → 提示用法", () => {
		const msg = executeAutoRenameCommand("xyz");
		expect(msg).toContain("未知参数");
		expect(msg).toContain("用法");
	});
});
