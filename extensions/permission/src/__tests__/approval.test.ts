/**
 * approval.test.ts — requestUserApproval（TUI/RPC/headless）+ ApprovalComponent +
 * renderApprovalView 测试。覆盖 G3 abort 时序 + G4 invalidate。
 */
import { describe, expect, it, vi } from "vitest";

import {
	ApprovalComponent,
	type ApprovalContext,
	renderApprovalView,
	requestUserApproval,
} from "../approval.js";
import type { ApprovalRequest } from "../pipeline.js";
import type { ClassifierResult, ToolInvocationContext, UserDecision } from "../types.js";

// ──────────────────────── mock helpers ────────────────────────

function makeApprovalCtx(overrides: Partial<ApprovalContext> = {}): ApprovalContext {
	return {
		mode: "headless",
		ui: {
			notify: vi.fn(),
			select: vi.fn(() => Promise.resolve(undefined)),
			custom: vi.fn(() => Promise.resolve(undefined)),
		},
		...overrides,
	};
}

const req: ApprovalRequest = { toolName: "bash", command: "rm -rf /tmp", reason: "no allow rule" };
const ctx: ToolInvocationContext = { toolName: "bash", command: "rm -rf /tmp", cwd: "/tmp" };

// ──────────────────────── headless 分支 ────────────────────────

describe("requestUserApproval: headless 模式", () => {
	it("json 模式 → fail-closed deny + notify", async () => {
		const approvalCtx = makeApprovalCtx({ mode: "json" });
		const decision = await requestUserApproval(req, ctx, undefined, approvalCtx);
		expect(decision.approved).toBe(false);
		expect(decision.reason).toContain("headless");
		expect(approvalCtx.ui.notify).toHaveBeenCalledOnce();
	});

	it("print 模式 → fail-closed deny + notify", async () => {
		const approvalCtx = makeApprovalCtx({ mode: "print" });
		const decision = await requestUserApproval(req, ctx, undefined, approvalCtx);
		expect(decision.approved).toBe(false);
		expect(approvalCtx.ui.notify).toHaveBeenCalledOnce();
	});
});

// ──────────────────────── rpc 分支 ────────────────────────

describe("requestUserApproval: rpc 模式", () => {
	it("用户选 Approve → approved=true", async () => {
		const approvalCtx = makeApprovalCtx({
			mode: "rpc",
			ui: {
				notify: vi.fn(),
				select: vi.fn(() => Promise.resolve("Approve (once)")),
				custom: vi.fn(() => Promise.resolve(undefined)),
			},
		});
		const decision = await requestUserApproval(req, ctx, undefined, approvalCtx);
		expect(decision.approved).toBe(true);
		expect(decision.scope).toBe("once");
	});

	it("用户选 Deny → approved=false", async () => {
		const approvalCtx = makeApprovalCtx({
			mode: "rpc",
			ui: {
				notify: vi.fn(),
				select: vi.fn(() => Promise.resolve("Deny")),
				custom: vi.fn(() => Promise.resolve(undefined)),
			},
		});
		const decision = await requestUserApproval(req, ctx, undefined, approvalCtx);
		expect(decision.approved).toBe(false);
	});

	it("用户关闭对话框（undefined）→ approved=false", async () => {
		const approvalCtx = makeApprovalCtx({
			mode: "rpc",
			ui: {
				notify: vi.fn(),
				select: vi.fn(() => Promise.resolve(undefined)),
				custom: vi.fn(() => Promise.resolve(undefined)),
			},
		});
		const decision = await requestUserApproval(req, ctx, undefined, approvalCtx);
		expect(decision.approved).toBe(false);
		expect(decision.reason).toContain("dismissed");
	});
});

// ──────────────────────── tui 分支 + G3 ────────────────────────

describe("requestUserApproval: tui 模式", () => {
	it("G3：signal 已 aborted → 短路 deny，不调 ctx.ui.custom", async () => {
		const controller = new AbortController();
		controller.abort();
		const customMock = vi.fn(() => Promise.resolve({ approved: true } as UserDecision));
		const approvalCtx = makeApprovalCtx({
			mode: "tui",
			ui: { notify: vi.fn(), select: vi.fn(), custom: customMock },
		});
		const decision = await requestUserApproval(req, ctx, controller.signal, approvalCtx);
		expect(decision.approved).toBe(false);
		expect(decision.reason).toContain("aborted before prompt");
		expect(customMock).not.toHaveBeenCalled(); // G3：短路，不进 custom
	});

	it("G3：signal 未 aborted → 调 ctx.ui.custom，组件 done 决定结果", async () => {
		const approvalCtx = makeApprovalCtx({
			mode: "tui",
			ui: {
				notify: vi.fn(),
				select: vi.fn(),
				custom: vi.fn((_factory) => Promise.resolve({ approved: true, reason: "tui-ok", scope: "once" } as UserDecision)),
			},
		});
		const decision = await requestUserApproval(req, ctx, undefined, approvalCtx);
		expect(decision.approved).toBe(true);
		expect(approvalCtx.ui.custom).toHaveBeenCalledOnce();
	});
});

// ──────────────────────── ApprovalComponent + G4 ────────────────────────

describe("ApprovalComponent（G4 invalidate）", () => {
	it("G4：implements Component，invalidate() 清空渲染缓存", () => {
		const requestRender = vi.fn();
		const tui = { requestRender };
		const done = vi.fn();
		const comp = new ApprovalComponent(req, tui, done);
		// constructor 调 invalidate → 缓存为空（首次 render 必须实际渲染）
		const first = comp.render(80);
		expect(first.length).toBeGreaterThan(0);

		// invalidate 清缓存（不直接 requestRender；rerender 才 requestRender）
		requestRender.mockClear();
		comp.invalidate();
		// 再次 render → 重新计算（非缓存）
		const second = comp.render(80);
		expect(second).not.toBe(first); // 不同引用，说明缓存被清
	});

	it("render 返回非空行数组，含工具名和命令", () => {
		const comp = new ApprovalComponent(req, { requestRender: vi.fn() }, vi.fn());
		const lines = comp.render(80);
		expect(lines.length).toBeGreaterThan(0);
		const joined = lines.join("\n");
		expect(joined).toContain("bash");
		expect(joined).toContain("rm -rf /tmp");
		expect(joined).toContain("[y/Enter] Approve");
	});

	it("handleInput y → approve（done 调用一次）", () => {
		const done = vi.fn();
		const comp = new ApprovalComponent(req, { requestRender: vi.fn() }, done);
		// 模拟 y 键：matchesKey 对单字符 'y' 返回 true
		comp.handleInput("y");
		expect(done).toHaveBeenCalledOnce();
		const result = done.mock.calls[0]![0] as UserDecision;
		expect(result.approved).toBe(true);
	});

	it("handleInput n → deny", () => {
		const done = vi.fn();
		const comp = new ApprovalComponent(req, { requestRender: vi.fn() }, done);
		comp.handleInput("n");
		expect(done).toHaveBeenCalledOnce();
		const result = done.mock.calls[0]![0] as UserDecision;
		expect(result.approved).toBe(false);
	});

	it("handleInput 在 resolved 后 no-op（守卫）", () => {
		const done = vi.fn();
		const comp = new ApprovalComponent(req, { requestRender: vi.fn() }, done);
		comp.handleInput("y"); // 首次 approve
		comp.handleInput("n"); // resolved 后 no-op
		expect(done).toHaveBeenCalledOnce();
	});

	it("cancel()（signal abort）→ deny，resolved 后 no-op", () => {
		const done = vi.fn();
		const comp = new ApprovalComponent(req, { requestRender: vi.fn() }, done);
		comp.cancel();
		expect(done).toHaveBeenCalledOnce();
		expect((done.mock.calls[0]![0] as UserDecision).approved).toBe(false);
		comp.cancel(); // 二次 no-op
		expect(done).toHaveBeenCalledOnce();
	});

	it("render 缓存：同 width 第二次返回缓存（行数组引用相同）", () => {
		const comp = new ApprovalComponent(req, { requestRender: vi.fn() }, vi.fn());
		const first = comp.render(80);
		const second = comp.render(80);
		expect(second).toBe(first); // 同一引用（缓存命中）
		comp.invalidate();
		const third = comp.render(80);
		expect(third).not.toBe(first); // invalidate 后重新渲染
	});
});

// ──────────────────────── renderApprovalView（preClassification） ────────────────────────

describe("renderApprovalView（含 AI 预分类）", () => {
	it("无 preClassification → 不渲染 AI 块", () => {
		const lines = renderApprovalView(req, 80);
		const joined = lines.join("\n");
		expect(joined).not.toContain("AI classification");
	});

	it("有 preClassification → 渲染 risk/outcome/confidence", () => {
		const pc: ClassifierResult = {
			risk_level: "high",
			outcome: "deny",
			reasoning: "dangerous pipe to shell",
			confidence: 0.95,
		};
		const reqWithPc: ApprovalRequest = { ...req, preClassification: pc };
		const lines = renderApprovalView(reqWithPc, 80);
		const joined = lines.join("\n");
		expect(joined).toContain("AI classification");
		expect(joined).toContain("high");
		expect(joined).toContain("deny");
		expect(joined).toContain("0.95");
	});
});
