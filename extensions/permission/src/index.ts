/**
 * @zhushanwen/pi-permission — Pi permission 扩展
 *
 * 四档权限模式（yolo/auto/approve/strict）+ 三层管道（AST + 规则 + AI Classifier）。
 *
 * W5 阶段（本文件）：tool_call handler 接入三层管道（checkPermission）。
 *  - G5：显式 approvalChain promise chain 串行化（Pi 不保证 tool_call handler 串行，
 *    但权限检查涉及共享状态/UI 对话框，必须串行避免竞态）。
 *  - fail-closed：handler 异常 → block + reason（不放行）。
 *  - session 隔离：config 在 session_start 重建的闭包，每 session 独立。
 *  - yolo 快速路径：mode=yolo 或 enabled=false → 直接 return undefined（不跑管道）。
 *
 * statusline 集成（ctx.ui.setFooter 的 TUI Component）推到 W6，本 wave 不做。
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import { handlePermissionCommand } from "./commands.js";
import { getConfigPath, loadAndWatchConfig, saveConfig } from "./config.js";
import { checkPermission, type CheckPermissionDeps } from "./pipeline.js";
import { createPipelineDeps } from "./production.js";
import type { PermissionConfig } from "./types.js";

// ──────────────────────── tool_call event 最小子集 ────────────────────────

/**
 * Pi tool_call event 的最小子集（duck typing，不依赖完整 SDK 类型）。
 *
 * event.type='tool_call'，event.toolCallId，event.toolName，event.input。
 * bash input={command, timeout?}，其他工具 input={path, ...}。
 */
interface ToolCallEventLike {
	toolName: string;
	input: Record<string, unknown>;
	toolCallId?: string;
}

/** Pi tool_call handler 返回值：{block:true, reason} → Pi 转 isError tool_result；undefined → 放行。 */
interface ToolCallResult {
	block?: boolean;
	reason?: string;
}

// ──────────────────────── 扩展工厂 ────────────────────────

/**
 * 扩展工厂。每个 session 独立闭包状态（遵循 Pi session 隔离约束，
 * 不用模块级 let 避免多 session 共享）。
 */
export default function permissionExtension(pi: ExtensionAPI): void {
	// ──────────────────────── 闭包状态（每 session 独立） ────────────────────────
	let config: PermissionConfig = loadAndWatchConfig(getConfigPath(), (msg) => {
		console.warn(msg);
	});

	/** 读取最新配置到闭包变量（mtime 缓存内部去重，未变化不读 fs） */
	function refreshConfig(): void {
		config = loadAndWatchConfig(getConfigPath(), (msg) => console.warn(msg));
	}

	// ──────────────────────── session_start：重载配置 ────────────────────────
	pi.on("session_start", (_event: unknown, _ctx: ExtensionContext) => {
		refreshConfig();
	});

	// ──────────────────────── /permission 命令 ────────────────────────
	pi.registerCommand("permission", {
		description: "View or switch permission mode (yolo/auto/approve/strict). Usage: /permission [mode|status]",
		handler: (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			// 命令执行前重载配置（确保最新，用户可能手动改过文件）
			refreshConfig();
			const message = handlePermissionCommand(args, config, (newConfig) => {
				const result = saveConfig(newConfig);
				if (result.success) {
					config = newConfig; // 更新闭包状态
				}
				return result;
			});
			ctx.ui.notify(message, "info");
			return Promise.resolve();
		},
	});

	// ──────────────────────── tool_call handler（W5 三层管道 + G5 串行化） ────────────────────────
	// G5：显式 approvalChain promise chain。Pi 不保证 tool_call handler 串行调用，
	// 但权限检查可能弹出 UI 对话框（共享终端），必须串行避免多个对话框叠加。
	let approvalChain: Promise<ToolCallResult | undefined> = Promise.resolve(undefined);

	pi.on("tool_call", (event: unknown, ctx: ExtensionContext): Promise<ToolCallResult | undefined> => {
		const run = (): Promise<ToolCallResult | undefined> => processToolCall(event, ctx, () => config, refreshConfig);
		// 串行：前一个完成（无论 resolve/reject）后才跑下一个。失败不影响后续。
		approvalChain = approvalChain.then(run, run);
		return approvalChain;
	});
}

// ──────────────────────── processToolCall（单次工具调用处理） ────────────────────────

/**
 * 处理单次 tool_call：提 config → checkPermission → 映射为 Pi ToolCallResult。
 *
 * fail-closed：任何异常 → block + reason（不放行）。
 * yolo 快速路径：mode=yolo 或 enabled=false → return undefined（不跑管道，最小开销）。
 *
 * @param event tool_call event（duck typing 为 ToolCallEventLike）
 * @param ctx Pi ExtensionContext
 * @param getConfig 获取最新 config 的闭包（session 隔离）
 * @param _refreshConfig 重载配置（保留参数位，便于未来扩展）
 */
async function processToolCall(
	event: unknown,
	ctx: ExtensionContext,
	getConfig: () => PermissionConfig,
	_refreshConfig: () => void,
): Promise<ToolCallResult | undefined> {
	const cfg = getConfig();

	// 快速路径：yolo 或 disabled → 完全放行（不跑管道，最小开销）
	if (cfg.mode === "yolo" || !cfg.enabled) {
		return undefined;
	}

	// 提取 event 字段（duck typing，防御非预期形状）
	const evt = event as ToolCallEventLike;
	const toolName = typeof evt?.toolName === "string" ? evt.toolName : "";
	const input = evt?.input !== null && typeof evt?.input === "object" && !Array.isArray(evt.input)
		? (evt.input as Record<string, unknown>)
		: {};

	if (toolName.length === 0) {
		// 无法识别工具名 → fail-closed block
		return { block: true, reason: "[pi-permission] tool_call event missing toolName" };
	}

	// 装配 deps（每次 tool_call 重新装配，捕获当前 ctx.mode/ui；classifier 单例在 createPipelineDeps 内）
	const approvalCtx = {
		mode: ctx.mode,
		ui: {
			notify: (msg: string, type?: string) => ctx.ui.notify(msg, type),
			select: (title: string, options: string[], opts?: unknown) => ctx.ui.select(title, options, opts),
			custom: <T,>(
				factory: (tui: unknown, theme: unknown, kb: unknown, done: (result: T) => void) => unknown,
				options?: { overlay?: boolean },
			) =>
				ctx.ui.custom<T>(factory as Parameters<typeof ctx.ui.custom<T>>[0], options),
		},
	};
	const deps: CheckPermissionDeps = createPipelineDeps(approvalCtx);

	try {
		const decision = await checkPermission(
			toolName,
			input,
			cfg.mode,
			cfg.classifier,
			cfg.userRules,
			deps,
			{ cwd: ctx.cwd, signal: ctx.signal },
		);

		if (decision.action === "allow") {
			// 放行：return undefined（Pi 不拦截）
			return undefined;
		}
		// deny / ask → block + reason（Pi 转 isError tool_result）
		// ask 在 checkPermission 内已转 user 决策；若到这仍是 ask，fail-closed 当 deny
		return {
			block: true,
			reason: `[pi-permission] ${decision.action}: ${decision.reason} (source=${decision.source})`,
		};
	} catch (error) {
		// fail-closed：异常 → block + reason（绝不放行）
		const msg = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-permission] tool_call handler exception for ${toolName}: ${msg}`);
		return {
			block: true,
			reason: `[pi-permission] internal error (fail-closed): ${msg}`,
		};
	}
}
