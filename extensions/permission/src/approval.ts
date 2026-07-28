/**
 * 用户审批 UI（W5 集成层）。
 *
 * 三分支（按 ctx.mode 分发，ctx 由 caller 从 Pi ExtensionContext 提取）：
 *  - tui：ctx.ui.custom 自定义 Component（ApprovalComponent，G4 补 invalidate）。
 *    G3：调 ctx.ui.custom 前先检查 signal.aborted 短路（AI 先于 UI factory 执行时
 *    controller.abort() 触发但 comp 尚未创建，cancel 落空）。
 *  - rpc：ctx.ui.select（GUI 对话框）。先查 SDK select 签名：Promise<string | undefined>。
 *  - headless（json/print）：deny + notify（无交互 UI，fail-closed 拒绝）。
 *
 * ApprovalComponent 是简化版 TUI 组件（参考 ask-user AskUserComponent）：
 *  - 显示工具名 + 命令 + 触发原因 + 可选 AI 预分类。
 *  - y/approve、n/deny、Esc/cancel。
 *  - signal abort → comp.cancel()（复用 _resolved 守卫，避免二次 done）。
 *
 * 若 pi-tui API 后续有阻碍，fallback 已就位（RPC/headless 完整），TUI 标 TODO W6 完善。
 */

import { type Component, matchesKey, type SelectItem, truncateToWidth } from "@mariozechner/pi-tui";

import type { ApprovalRequest } from "./pipeline.js";
import type { ToolInvocationContext, UserDecision } from "./types.js";

// ──────────────────────── ApprovalContext（从 ExtensionContext 提取的最小子集） ────────────────────────

/**
 * 审批 UI 上下文（从 Pi ExtensionContext 提取的最小子集）。
 *
 * 提取为独立接口便于：
 *  - 测试 mock（不依赖完整 ExtensionContext）。
 *  - 明确 requestUserApproval 只用 mode + ui.{custom,select,notify}。
 *
 * mode 来自 ExtensionContext.mode（"tui"|"rpc"|"json"|"print"）。
 * headless = mode !== "tui" && mode !== "rpc"（json/print 无交互 UI）。
 */
export interface ApprovalContext {
	mode: "tui" | "rpc" | "json" | "print";
	ui: {
		notify(msg: string, type?: string): void;
		select(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
		custom<T = void>(
			factory: (tui: unknown, theme: unknown, kb: unknown, done: (result: T) => void) => Component,
			options?: { overlay?: boolean },
		): Promise<T>;
	};
}

// ──────────────────────── requestUserApproval ────────────────────────

/**
 * 请求用户审批（按 mode 分发）。
 *
 * @param req 审批请求数据（工具名 + 命令 + 原因 + 可选 AI 预分类）
 * @param _ctxUnused 未使用（保留签名对称性；实际 UI ctx 在 approvalCtx）
 * @param signal abort signal（racing 用：AI 赢时 abort，UI 短路）
 * @param approvalCtx UI 上下文（mode + ui.*）
 * @returns UserDecision（approved + reason）
 */
export async function requestUserApproval(
	req: ApprovalRequest,
	_ctxUnused: ToolInvocationContext,
	signal: AbortSignal | undefined,
	approvalCtx: ApprovalContext,
): Promise<UserDecision> {
	switch (approvalCtx.mode) {
		case "tui":
			return await requestTui(req, signal, approvalCtx);
		case "rpc":
			return await requestRpc(req, approvalCtx);
		case "json":
		case "print":
		default:
			return requestHeadless(req, approvalCtx);
	}
}

// ──────────────────────── TUI 分支（G3 + G4） ────────────────────────

/** TUI 模式：ctx.ui.custom + ApprovalComponent。G3：先检查 signal.aborted。 */
async function requestTui(
	req: ApprovalRequest,
	signal: AbortSignal | undefined,
	approvalCtx: ApprovalContext,
): Promise<UserDecision> {
	// G3 修正：AI 先于 UI factory 执行时，controller.abort() 已触发但 comp 未创建。
	// 在调 ctx.ui.custom 前检查 signal.aborted，短路返回 deny（fail-closed）。
	if (signal?.aborted) {
		approvalCtx.ui.notify(`[pi-permission] approval aborted before prompt: ${req.toolName}`, "warning");
		return { approved: false, reason: "aborted before prompt (AI won the race)" };
	}

	return approvalCtx.ui.custom<UserDecision>((tui, _theme, _kb, done) => {
		const comp = new ApprovalComponent(req, tui as TuiLike, done);
		// signal abort → comp.cancel()（复用 _resolved 守卫，避免二次 done）
		if (signal) {
			signal.addEventListener("abort", () => comp.cancel(), { once: true });
		}
		return comp;
	});
}

// ──────────────────────── RPC 分支 ────────────────────────

/** RPC 模式：ctx.ui.select（GUI 单选对话框）。 */
async function requestRpc(req: ApprovalRequest, approvalCtx: ApprovalContext): Promise<UserDecision> {
	const title = formatTitle(req);
	const options = ["Approve (once)", "Deny"];
	const choice = await approvalCtx.ui.select(title, options);
	if (choice === undefined) {
		return { approved: false, reason: "user dismissed the prompt" };
	}
	if (choice.startsWith("Approve")) {
		return { approved: true, reason: "approved via rpc", scope: "once" };
	}
	return { approved: false, reason: "denied via rpc" };
}

// ──────────────────────── headless 分支 ────────────────────────

/** headless（json/print）：无交互 UI → fail-closed deny + notify。 */
function requestHeadless(req: ApprovalRequest, approvalCtx: ApprovalContext): UserDecision {
	approvalCtx.ui.notify(`[pi-permission] headless mode auto-deny: ${req.reason}`, "warning");
	return { approved: false, reason: `headless mode (${approvalCtx.mode}): cannot prompt, auto-deny` };
}

// ──────────────────────── 辅助：标题格式化 ────────────────────────

/** 格式化审批标题（RPC select / TUI 顶部）。 */
function formatTitle(req: ApprovalRequest): string {
	const lines: string[] = [];
	lines.push(`[pi-permission] Approval required`);
	lines.push(`Tool: ${req.toolName}`);
	if (req.command !== undefined && req.command.length > 0) {
		lines.push(`Command: ${req.command}`);
	}
	lines.push(`Reason: ${req.reason}`);
	if (req.preClassification) {
		const pc = req.preClassification;
		lines.push(`AI: risk=${pc.risk_level} outcome=${pc.outcome} (conf=${pc.confidence})`);
	}
	return lines.join("\n");
}

// ──────────────────────── ApprovalComponent（TUI 组件，G4 invalidate） ────────────────────────

/** 最小 TUI 接口（满足真实 TUI 和测试 stub）。 */
interface TuiLike {
	requestRender(): void;
}

/**
 * TUI 审批组件（简化版，参考 ask-user AskUserComponent）。
 *
 * 显示：标题 + 工具名 + 命令 + 原因 + 可选 AI 预分类 + 操作提示。
 * 键位：y/Enter → approve；n/Esc → deny/cancel。
 *
 * G4：implements Component，补 invalidate()（调 tui.requestRender()）。
 * signal abort → cancel()（复用 _resolved 守卫）。
 *
 * TODO W6：若需更丰富的 TUI（方向键选择 once/session/always scope、高亮风险等级），
 * 参考 ask-user AskUserComponent 的 SelectList 集成。当前简化版满足核心审批流。
 */
export class ApprovalComponent implements Component {
	private readonly req: ApprovalRequest;
	private readonly tui: TuiLike;
	private readonly done: (result: UserDecision) => void;
	private _resolved = false;

	// 渲染缓存（width → lines），invalidate 清空。
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(req: ApprovalRequest, tui: TuiLike, done: (result: UserDecision) => void) {
		this.req = req;
		this.tui = tui;
		this.done = done;
		this.invalidate();
	}

	/** G4：Component 接口要求。失效渲染缓存 + 请求重绘。 */
	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private rerender(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) {
			return this.cachedLines;
		}
		const lines = renderApprovalView(this.req, width);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	handleInput(data: string): void {
		if (this._resolved) return;
		// y / Enter → approve
		if (matchesKey(data, "enter") || matchesKey(data, "y")) {
			this.approve();
			return;
		}
		// n / Esc → deny
		if (matchesKey(data, "escape") || matchesKey(data, "n")) {
			this.deny();
			return;
		}
		// 其他键 no-op（不泄漏）
	}

	private approve(): void {
		if (this._resolved) return;
		this._resolved = true;
		this.done({ approved: true, reason: "approved via tui", scope: "once" });
	}

	private deny(): void {
		if (this._resolved) return;
		this._resolved = true;
		this.done({ approved: false, reason: "denied via tui" });
	}

	/** 取消（signal abort 调用）。复用 _resolved 守卫，避免二次 done。 */
	cancel(): void {
		if (this._resolved) return;
		this._resolved = true;
		this.done({ approved: false, reason: "cancelled (signal abort)" });
	}
}

/** box 边框左右各占用 1 列（│ × 2） */
const BORDER_OVERHEAD = 2;

/** 渲染审批视图（纯函数，便于单测）。 */
export function renderApprovalView(req: ApprovalRequest, width: number): string[] {
	const innerWidth = Math.max(0, width - BORDER_OVERHEAD); // 减去左右边框
	const inner: string[] = [];
	inner.push("[pi-permission] Approval required");
	inner.push("");
	inner.push(`Tool: ${req.toolName}`);
	if (req.command !== undefined && req.command.length > 0) {
		inner.push(`Command: ${req.command}`);
	}
	inner.push(`Reason: ${req.reason}`);
	if (req.preClassification) {
		const pc = req.preClassification;
		inner.push("");
		inner.push(`AI classification:`);
		inner.push(`  risk: ${pc.risk_level}`);
		inner.push(`  outcome: ${pc.outcome}`);
		inner.push(`  confidence: ${pc.confidence}`);
		inner.push(`  reasoning: ${pc.reasoning}`);
	}
	inner.push("");
	inner.push("[y/Enter] Approve  [n/Esc] Deny");

	// 用 box 边框包裹
	const lines: string[] = [];
	lines.push(`┌${"─".repeat(innerWidth)}┐`);
	for (const line of inner) {
		const padded = truncateToWidth(line, innerWidth, "", true);
		lines.push(`│${padded}│`);
	}
	lines.push(`└${"─".repeat(innerWidth)}┘`);
	return lines;
}

// re-export SelectItem 仅为测试便利（mock ctx.ui.select 时构造选项）
export type { SelectItem };
