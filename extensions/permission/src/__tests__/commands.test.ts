/**
 * commands.test.ts — W6 T7: handlePermissionCommand 单元测试。
 *
 * 覆盖 /permission 命令各参数分支：
 *  - 无参 → 显示菜单（当前模式 + 可用模式列表）
 *  - set yolo/auto/approve/strict → 切换模式
 *  - invalid mode → 错误提示
 *  - status → 详细配置
 *  - 当前状态（已是目标模式）→ "Already in X mode"
 *
 * handlePermissionCommand 是纯函数（输入 args + config + onSave，输出 string），
 * 不依赖 Pi 运行时，便于单测。
 */
import { describe, expect, it, vi } from "vitest";

import { handlePermissionCommand } from "../commands.js";
import { DEFAULT_CONFIG, type PermissionConfig } from "../types.js";

// ──────────────────────── mock helpers ────────────────────────

/** 构造一个可变 config 副本（默认 yolo）。 */
function makeConfig(overrides: Partial<PermissionConfig> = {}): PermissionConfig {
	return {
		mode: "yolo",
		enabled: true,
		classifier: { enabled: true, model: "auto", timeout: 90, autoApproveLowRisk: true, autoDenyHighRisk: true },
		userRules: [],
		...overrides,
	};
}

/** onSave mock：总是成功。 */
function successSave(): (config: PermissionConfig) => { success: boolean; error?: string } {
	return vi.fn(() => ({ success: true }));
}

// ──────────────────────── 无参：显示菜单 ────────────────────────

describe("/permission 无参 → 显示菜单", () => {
	it("无参显示当前模式 + 可用模式列表", () => {
		const config = makeConfig({ mode: "approve" });
		const msg = handlePermissionCommand(undefined, config, successSave());
		expect(msg).toContain("Current mode");
		expect(msg).toContain("approve");
		expect(msg).toContain("Available modes");
		expect(msg).toContain("yolo");
		expect(msg).toContain("auto");
		expect(msg).toContain("strict");
	});

	it("空字符串等同无参 → 显示菜单", () => {
		const msg = handlePermissionCommand("", makeConfig(), successSave());
		expect(msg).toContain("Current mode");
	});

	it("纯空白等同无参 → 显示菜单", () => {
		const msg = handlePermissionCommand("   ", makeConfig(), successSave());
		expect(msg).toContain("Current mode");
	});

	it("当前模式在列表中用 ► 标记", () => {
		const msg = handlePermissionCommand(undefined, makeConfig({ mode: "auto" }), successSave());
		expect(msg).toContain("► auto");
		expect(msg).not.toContain("► yolo");
	});
});

// ──────────────────────── status 子命令 ────────────────────────

describe("/permission status → 详细配置", () => {
	it("status 显示 mode/enabled/classifier/userRules", () => {
		const config = makeConfig({
			mode: "strict",
			classifier: { enabled: true, model: "zhipu/glm-4-flash", timeout: 30, autoApproveLowRisk: false, autoDenyHighRisk: true },
			userRules: [{ id: "u1", tool: "bash", pattern: "rm *", action: "deny", source: "user" }],
		});
		const msg = handlePermissionCommand("status", config, successSave());
		expect(msg).toContain("mode:");
		expect(msg).toContain("strict");
		expect(msg).toContain("enabled:");
		expect(msg).toContain("classifier:");
		expect(msg).toContain("zhipu/glm-4-flash");
		expect(msg).toContain("userRules:");
		expect(msg).toContain("1 rule(s)");
	});

	it("status 显示 autoApproveLowRisk=false", () => {
		const config = makeConfig({
			classifier: { enabled: true, model: "auto", timeout: 90, autoApproveLowRisk: false, autoDenyHighRisk: true },
		});
		const msg = handlePermissionCommand("status", config, successSave());
		expect(msg).toContain("autoApproveLow:");
		expect(msg).toContain("false");
	});
});

// ──────────────────────── 切换模式 ────────────────────────

describe("/permission <mode> → 切换模式", () => {
	it("set yolo（从 strict 切到 yolo）→ onSave 被调，返回切换成功", () => {
		const config = makeConfig({ mode: "strict" });
		const onSave = vi.fn(() => ({ success: true }));
		const msg = handlePermissionCommand("yolo", config, onSave);
		expect(msg).toContain("Switched to YOLO mode");
		expect(msg).toContain("完全无防护");
		expect(onSave).toHaveBeenCalledOnce();
		// onSave 收到的新 config mode=yolo
		const savedConfig = onSave.mock.calls[0]![0] as PermissionConfig;
		expect(savedConfig.mode).toBe("yolo");
	});

	it("set auto → 切换到 auto 模式", () => {
		const msg = handlePermissionCommand("auto", makeConfig({ mode: "yolo" }), successSave());
		expect(msg).toContain("Switched to Auto mode");
		expect(msg).toContain("安全命令规则直接放行");
	});

	it("set approve → 切换到 approve 模式", () => {
		const msg = handlePermissionCommand("approve", makeConfig({ mode: "yolo" }), successSave());
		expect(msg).toContain("Switched to Approve mode");
	});

	it("set strict → 切换到 strict 模式", () => {
		const msg = handlePermissionCommand("strict", makeConfig({ mode: "yolo" }), successSave());
		expect(msg).toContain("Switched to Strict mode");
		expect(msg).toContain("全部审批");
	});

	it("已是目标模式 → 'Already in X mode'，不调 onSave", () => {
		const onSave = vi.fn(() => ({ success: true }));
		const msg = handlePermissionCommand("yolo", makeConfig({ mode: "yolo" }), onSave);
		expect(msg).toContain("Already in YOLO mode");
		expect(onSave).not.toHaveBeenCalled();
	});

	it("onSave 失败 → 返回失败信息（含 error）", () => {
		const onSave = vi.fn(() => ({ success: false, error: "disk full" }));
		const msg = handlePermissionCommand("strict", makeConfig({ mode: "yolo" }), onSave);
		expect(msg).toContain("Failed to switch");
		expect(msg).toContain("disk full");
	});

	it("切换模式保留 enabled/classifier/userRules（仅改 mode）", () => {
		const config = makeConfig({
			mode: "yolo",
			enabled: false,
			classifier: { enabled: false, model: "custom", timeout: 10, autoApproveLowRisk: false, autoDenyHighRisk: false },
			userRules: [{ id: "u1", tool: "bash", pattern: "x", action: "deny", source: "user" }],
		});
		const onSave = vi.fn(() => ({ success: true }));
		handlePermissionCommand("strict", config, onSave);
		const saved = onSave.mock.calls[0]![0] as PermissionConfig;
		expect(saved.mode).toBe("strict");
		expect(saved.enabled).toBe(false); // 保留
		expect(saved.classifier.model).toBe("custom"); // 保留
		expect(saved.classifier.autoApproveLowRisk).toBe(false); // 保留
		expect(saved.userRules).toHaveLength(1); // 保留
	});
});

// ──────────────────────── invalid mode ────────────────────────

describe("/permission <invalid> → 错误提示", () => {
	it("未知 mode → 错误信息 + 可用模式列表", () => {
		const msg = handlePermissionCommand("invalid-mode", makeConfig(), successSave());
		expect(msg).toContain("Unknown mode");
		expect(msg).toContain("invalid-mode");
		expect(msg).toContain("yolo, auto, approve, strict");
	});

	it("拼错的 mode（yoloo）→ 错误提示", () => {
		const msg = handlePermissionCommand("yoloo", makeConfig(), successSave());
		expect(msg).toContain("Unknown mode");
		expect(msg).toContain("yoloo");
	});

	it("大小写敏感（YOLO 大写无效）", () => {
		const msg = handlePermissionCommand("YOLO", makeConfig(), successSave());
		expect(msg).toContain("Unknown mode");
		expect(msg).toContain("YOLO");
	});

	it("未知子命令（foo）当 invalid mode 处理", () => {
		const msg = handlePermissionCommand("foo", makeConfig(), successSave());
		expect(msg).toContain("Unknown mode");
	});
});

// ──────────────────────── 边界 ────────────────────────

describe("/permission 边界", () => {
	it("args 含前后空白 → trim 后识别模式", () => {
		const msg = handlePermissionCommand("  strict  ", makeConfig({ mode: "yolo" }), successSave());
		expect(msg).toContain("Switched to Strict mode");
	});

	it("default config 调无参 → 含 'yolo'（默认模式）", () => {
		const msg = handlePermissionCommand(undefined, DEFAULT_CONFIG, successSave());
		expect(msg).toContain("yolo");
	});
});
