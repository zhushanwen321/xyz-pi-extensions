/**
 * @zhushanwen/pi-permission — Pi permission 扩展
 *
 * 四档权限模式（yolo/auto/approve/strict）+ 三层管道（AST + 规则 + AI Classifier）。
 *
 * W5 阶段：tool_call handler 接入三层管道（checkPermission）。
 *  - G5：显式 approvalChain promise chain 串行化（Pi 不保证 tool_call handler 串行，
 *    但权限检查涉及共享状态/UI 对话框，必须串行避免竞态）。
 *  - fail-closed：handler 异常 → block + reason（不放行）。
 *  - session 隔离：config 在 session_start 重建的闭包，每 session 独立。
 *  - yolo 快速路径：mode=yolo 或 enabled=false → 直接 return undefined（不跑管道）。
 *
 * W6 阶段：session_start 注册权限 footer（ctx.ui.setFooter），显示当前 mode + enabled。
 *  - 单例限制：Pi 只有一个 footer 槽位，会覆盖其他扩展的 footer（README 注明）。
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import { listAvailableModels } from "./classifier/model-resolver.js";
import { handlePermissionCommand, handlePermissionModelCommand, handlePermissionRuleCommand } from "./commands.js";
import { getConfigPath, loadAndWatchConfig, saveConfig } from "./config.js";
import { setDefaultListAvailableModels } from "./model-picker.js";
import { editRulesViaOverlay } from "./rule-editor.js";
import { makeNextIdCounter } from "./rule-templates.js";
import { checkPermission, type CheckPermissionDeps } from "./pipeline.js";
import { createPipelineDeps } from "./production.js";
import { registerPermissionFooter } from "./statusline.js";
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

	// W7：注入 listAvailableModels 真实实现（model-picker.ts 默认返回空 Map）。
	// G1 口径：(onWarning?, filePath?) → 封装读盘；warning 透传到 console.warn。
	setDefaultListAvailableModels((onWarning, filePath) =>
		listAvailableModels(onWarning ?? ((m) => console.warn(m)), filePath),
	);

	/** 读取最新配置到闭包变量（mtime 缓存内部去重，未变化不读 fs） */
	function refreshConfig(): void {
		config = loadAndWatchConfig(getConfigPath(), (msg) => console.warn(msg));
	}

	// ──────────────────────── session_start：重载配置 + 注册 footer ────────────────────────
	pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
		refreshConfig();
		// W6 T2：注册权限 footer（显示当前 mode + enabled）。
		// 单例限制：Pi 只有一个 footer 槽位，会覆盖（或被覆盖）其他扩展的 footer
		// （如 @zhushanwen/pi-statusline）。已知限制，README 注明。
		// getMode/getEnabled 闭包读最新 config（session 内 mode 可变）。
		// registerPermissionFooter 内部 duck typing：headless/mock ctx 无 setFooter/theme 时跳过。
		registerPermissionFooter(
			ctx.ui as { setFooter?: unknown; theme?: unknown },
			() => config.mode,
			() => config.enabled,
		);
	});

	// ──────────────────────── /permission 命令 ────────────────────────
	pi.registerCommand("permission", {
		description: "View or switch permission mode (yolo/auto/approve/strict). Usage: /permission [mode|status|model]",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			// 命令执行前重载配置（确保最新，用户可能手动改过文件）
			refreshConfig();
			const trimmed = (args ?? "").trim();
			// W8：/permission rule → overlay CRUD 编辑 userRules（异步路径）
			if (trimmed === "rule") {
				await handlePermissionRuleCommand(
					{
						mode: ctx.mode,
						ui: {
							notify: (msg: string, type?: string) => ctx.ui.notify(msg, type),
							select: (title: string, options: string[], opts?: unknown) =>
								ctx.ui.select(title, options, opts),
							custom: <T,>(
								factory: (tui: unknown, theme: unknown, kb: unknown, done: (result: T) => void) => unknown,
								options?: { overlay?: boolean },
							) =>
								ctx.ui.custom<T>(factory as Parameters<typeof ctx.ui.custom<T>>[0], options),
						},
					},
					config,
					makeNextIdCounter(config.userRules),
					{
						save: (newConfig) => {
							const result = saveConfig(newConfig);
							if (result.success) {
								config = newConfig; // 更新闭包状态
							}
							return result;
						},
						editRulesViaOverlay: (ctx, initialRules, sessionIdCounter, rpcDeps) =>
							editRulesViaOverlay(ctx, initialRules, sessionIdCounter, rpcDeps),
					},
				);
				return;
			}
			// W7：/permission model → overlay 选择 classifier model（异步路径）
			if (trimmed === "model") {
				await handlePermissionModelCommand(
					{
						mode: ctx.mode,
						ui: {
							notify: (msg: string, type?: string) => ctx.ui.notify(msg, type),
							select: (title: string, options: string[], opts?: unknown) =>
								ctx.ui.select(title, options, opts),
							custom: <T,>(
								factory: (tui: unknown, theme: unknown, kb: unknown, done: (result: T) => void) => unknown,
								options?: { overlay?: boolean },
							) =>
								ctx.ui.custom<T>(factory as Parameters<typeof ctx.ui.custom<T>>[0], options),
						},
					},
					config,
					{
						listModels: () => listAvailableModels((m) => console.warn(m)),
						save: (newConfig) => {
							const result = saveConfig(newConfig);
							if (result.success) {
								config = newConfig; // 更新闭包状态
							}
							return result;
						},
					},
				);
				return;
			}
			// 原同步路径（yolo/auto/approve/strict/status/无参）
			const message = handlePermissionCommand(args, config, (newConfig) => {
				const result = saveConfig(newConfig);
				if (result.success) {
					config = newConfig; // 更新闭包状态
				}
				return result;
			});
			ctx.ui.notify(message, "info");
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
			// W6 T9 G3：Reject-with-Reason。ctx.ui.input 存在则透传（采集真实拒绝理由）。
			// approval.ts 的 collectRejectReason 会用 typeof 判断是否可用，不可用则 fallback。
			...(typeof ctx.ui.input === "function"
				? { input: (title: string, placeholder?: string, opts?: unknown) => ctx.ui.input(title, placeholder, opts) }
				: {}),
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
