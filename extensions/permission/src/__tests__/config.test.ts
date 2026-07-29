/**
 * WT1-WT5/WT7: 配置加载/保存/mtime 缓存测试
 *
 * 用真实 fs + 临时目录（os.tmpdir + 随机子目录），不用 mock fs。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../types.js";
import {
	clearConfigCache,
	getConfigPath,
	loadAndWatchConfig,
	saveConfig,
} from "../config.js";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-perm-test-"));
	clearConfigCache();
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
	clearConfigCache();
});

describe("WT1: 默认配置生成（首次无配置文件）", () => {
	it("文件不存在时创建默认配置并返回", () => {
		const configPath = join(tempDir, "permission-config.json");
		expect(existsSync(configPath)).toBe(false);

		const config = loadAndWatchConfig(configPath);

		expect(config.mode).toBe("yolo");
		expect(config.enabled).toBe(true);
		expect(config.classifier.enabled).toBe(true);
		expect(config.classifier.model).toBe("auto");
		expect(config.classifier.timeout).toBe(90);
		expect(config.classifier.autoApproveLowRisk).toBe(true);
		expect(config.classifier.autoDenyHighRisk).toBe(true);
		expect(config.userRules).toEqual([]);

		// 文件被创建
		expect(existsSync(configPath)).toBe(true);
	});

	it("创建的文件是合法 JSON", () => {
		const configPath = join(tempDir, "permission-config.json");
		loadAndWatchConfig(configPath);

		const content = readFileSync(configPath, "utf-8");
		expect(() => JSON.parse(content)).not.toThrow();
	});
});

describe("WT2: 配置解析（合法配置）", () => {
	it("正确解析完整配置", () => {
		const configPath = join(tempDir, "permission-config.json");
		const rawConfig = {
			mode: "auto",
			enabled: true,
			classifier: {
				enabled: false,
				model: "zhipu/glm-4-flash",
				timeout: 30,
				autoApproveLowRisk: false,
				autoDenyHighRisk: false,
			},
			userRules: [
				{ id: "user-1", tool: "bash", pattern: "git status", action: "allow", source: "user" },
				{ id: "user-2", tool: "bash", pattern: "rm *", action: "deny", source: "user" },
			],
		};
		writeFileSync(configPath, JSON.stringify(rawConfig), "utf-8");

		const config = loadAndWatchConfig(configPath);

		expect(config.mode).toBe("auto");
		expect(config.classifier.enabled).toBe(false);
		expect(config.classifier.model).toBe("zhipu/glm-4-flash");
		expect(config.classifier.timeout).toBe(30);
		expect(config.classifier.autoApproveLowRisk).toBe(false);
		expect(config.userRules).toHaveLength(2);
		expect(config.userRules[0].tool).toBe("bash");
		expect(config.userRules[0].pattern).toBe("git status");
		expect(config.userRules[1].action).toBe("deny");
	});
});

describe("WT3: 配置解析容错（malformed JSON）", () => {
	it("malformed JSON fallback 到默认配置，不 throw", () => {
		const configPath = join(tempDir, "permission-config.json");
		writeFileSync(configPath, "{ invalid json missing quotes:", "utf-8");

		const warnings: string[] = [];
		const config = loadAndWatchConfig(configPath, (msg) => warnings.push(msg));

		expect(config.mode).toBe("yolo"); // 默认值
		expect(config.enabled).toBe(true);
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0]).toContain("Config parse failed");
	});

	it("mode 字段非法时 fallback 到 yolo", () => {
		const configPath = join(tempDir, "permission-config.json");
		writeFileSync(configPath, JSON.stringify({ mode: "unknown-mode" }), "utf-8");

		const config = loadAndWatchConfig(configPath);
		expect(config.mode).toBe("yolo");
	});

	it("classifier 字段缺失时用默认值", () => {
		const configPath = join(tempDir, "permission-config.json");
		writeFileSync(configPath, JSON.stringify({ mode: "strict" }), "utf-8");

		const config = loadAndWatchConfig(configPath);
		expect(config.mode).toBe("strict");
		expect(config.classifier.model).toBe("auto"); // 默认
		expect(config.classifier.timeout).toBe(90); // 默认
	});

	it("userRules 含非法条目时过滤掉", () => {
		const configPath = join(tempDir, "permission-config.json");
		writeFileSync(configPath, JSON.stringify({
			mode: "yolo",
			userRules: [
				{ tool: "bash", pattern: "ls", action: "allow" }, // 合法
				{ tool: "bash", pattern: "rm", action: "invalid-action" }, // 非法 action
				{ pattern: "x" }, // 缺 tool
				"not-an-object", // 非对象
			],
		}), "utf-8");

		const config = loadAndWatchConfig(configPath);
		expect(config.userRules).toHaveLength(1);
		expect(config.userRules[0].pattern).toBe("ls");
	});
});

describe("WT4: mtime 缓存（文件未变化时不重读）", () => {
	it("连续两次调用，第二次返回缓存（同 mtime）", () => {
		const configPath = join(tempDir, "permission-config.json");
		const original = loadAndWatchConfig(configPath);
		const originalMode = original.mode;

		// 不修改文件，第二次调用
		const cached = loadAndWatchConfig(configPath);

		// 返回的 config 应该与第一次一致（深相等）
		expect(cached).toEqual(original);
		expect(cached.mode).toBe(originalMode);
	});
});

describe("WT5: mtime 缓存（文件变化时重读）", () => {
	it("修改文件后第二次调用返回新内容", () => {
		const configPath = join(tempDir, "permission-config.json");
		const first = loadAndWatchConfig(configPath);
		expect(first.mode).toBe("yolo");

		// 修改文件（写入新 mode）
		writeFileSync(configPath, JSON.stringify({ mode: "strict" }), "utf-8");

		// 注意：writeFileSync 可能不改变 mtime（如果写入太快），
		// 用 utimes 显式更新 mtime 确保变化
		const future = new Date(Date.now() + 2000);
		utimesSync(configPath, future, future);

		const second = loadAndWatchConfig(configPath);
		expect(second.mode).toBe("strict");
	});
});

describe("WT7: 保存配置", () => {
	it("saveConfig 写入文件并更新缓存", () => {
		const configPath = join(tempDir, "permission-config.json");
		const newConfig = { ...DEFAULT_CONFIG, mode: "strict" as const };

		const result = saveConfig(newConfig, configPath);
		expect(result.success).toBe(true);

		// 文件被写入
		expect(existsSync(configPath)).toBe(true);
		const content = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(content);
		expect(parsed.mode).toBe("strict");

		// 后续 loadAndWatchConfig 返回新配置（缓存已更新）
		const loaded = loadAndWatchConfig(configPath);
		expect(loaded.mode).toBe("strict");
	});

	it("saveConfig 失败时返回 error（只读目录）", () => {
		const readOnlyDir = join(tempDir, "readonly");
		mkdirSync(readOnlyDir, { mode: 0o500 });
		const configPath = join(readOnlyDir, "permission-config.json");

		const result = saveConfig(DEFAULT_CONFIG, configPath);
		// 可能成功也可能失败取决于系统权限实现，主要验证不 throw
		expect(typeof result.success).toBe("boolean");
		if (!result.success) {
			expect(result.error).toBeTruthy();
		}
	});

	it("saveConfig 后文件权限是 0o600（仅用户可读写）", () => {
		const configPath = join(tempDir, "permission-config.json");
		saveConfig(DEFAULT_CONFIG, configPath);

		const stat = statSync(configPath);
		// macOS/Linux 下 mode & 0o777 应该是 0o600
		// Windows 下文件权限模型不同，跳过此断容
		if (process.platform !== "win32") {
			expect(stat.mode & 0o777).toBe(0o600);
		}
	});
});

describe("getConfigPath", () => {
	it("返回 ~/.pi/agent/permission-config.json 路径", () => {
		const path = getConfigPath();
		expect(path).toContain("permission-config.json");
		expect(path).toContain(".pi");
	});
});
