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
 * W6 阶段（footer-provider 重构）：session_start / session_tree 通过握手协议注册 footer
 * line renderer（consumer 端，statusline 是 canonical owner），显示当前 mode + enabled +
 * rule count + classifier model（auto 模式）。所有权限信息聚合到 footer 一行（order=2），
 * 不再使用 setWidget，避免与 statusline widget 区域重复。
 *  - footer line 不再独占 Pi footer 槽位，而是作为 statusline footer 的一行（order=2），
 *    与 statusline 自身行共存（解决旧 setFooter 单例覆盖问题）。
 *  - session_tree：分支切换后重建 renderer 闭包，避免持有过期 config。
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	} from "@earendil-works/pi-coding-agent";

import { listAvailableModels } from "./classifier/model-resolver.js";
import { handlePermissionCommand, handlePermissionModelCommand, handlePermissionRuleCommand } from "./commands.js";
import { getConfigPath, loadAndWatchConfig, saveConfig } from "./config.js";
import { setDefaultListAvailableModels } from "./model-picker.js";
import { editRulesViaOverlay } from "./rule-editor.js";
import { makeNextIdCounter } from "./rule-templates.js";
import { checkPermission, type CheckPermissionDeps } from "./pipeline.js";
import { createPipelineDeps } from "./production.js";
import {
	registerPermissionFooterLine,
	requestFooterRender,
	renderPermissionFooterLine,
	type FooterLineRenderer,
} from "./footer-provider.js";
import { paletteFromTheme, type PermissionPalette } from "./statusline-palette.js";
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

	// W6 T2（footer-provider 重构）：footer line dispose 句柄。session_start /
	// session_tree 注册 renderer 时由 registerPermissionFooterLine 返回（statusline 未安装
	// 或 headless 时仍返回合法 dispose，内部 noop）。分支切换时调用以注销旧 renderer，
	// 避免持有过期 config 闭包。mode/enabled 切换后调 requestFooterRender() 触发重绘。
	let disposeFooterLine: () => void = () => {};

	// ──────────────────────── session_start：重载配置 + 注册 footer line ────────────────────────
	pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
		refreshConfig();
		// footer-provider：通过握手协议注册 footer line renderer（consumer 端）。
		// statusline 是 canonical owner；permission 永不创建 registry，只 push pending 或
		// 直接 register（owner 已就绪时）。duck typing：headless/mock ctx 无 theme 时跳过。
		disposeFooterLine = registerFooterLineFor(ctx);
	});

	// ──────────────────────── session_tree：分支切换后重建 renderer 闭包 ────────────────────────
	// 分支切换（worktree/leaf 变化）后，旧 renderer 闭包可能持有过期 config；重建确保读到新值。
	// 同时重载 config（用户可能在分支里手动改过 permission-config.json）。
	pi.on("session_tree", (_event: unknown, ctx: ExtensionContext) => {
		refreshConfig();
		disposeFooterLine();
		disposeFooterLine = registerFooterLineFor(ctx);
	});

	// ──────────────────────── /permission 命令 ────────────────────────
	pi.registerCommand("permission", {
		description: "View or switch permission mode. Usage: /permission [mode|status|rule|model]",
		getArgumentCompletions(prefix: string) {
			const trimmed = prefix.trimStart().toLowerCase();
			const opts = [
				{ label: "status", value: "status", description: "查看详细权限配置" },
				{ label: "rule", value: "rule", description: "编辑用户规则（overlay）" },
				{ label: "model", value: "model", description: "选择 classifier 模型（overlay）" },
				{ label: "yolo", value: "yolo", description: "无保护，允许全部" },
				{ label: "auto", value: "auto", description: "规则 + AI 分类器" },
				{ label: "approve", value: "approve", description: "规则，非安全→手动批准" },
				{ label: "strict", value: "strict", description: "全部需批准" },
			];
			return trimmed === "" ? opts : opts.filter((o) => o.label.startsWith(trimmed));
		},
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
							notify: (msg: string, type?: "info" | "warning" | "error") => ctx.ui.notify(msg, type),
							select: (title: string, options: string[], opts?: Parameters<typeof ctx.ui.select>[2]) =>
								ctx.ui.select(title, options, opts),
							custom: <T,>(
								factory: (tui: unknown, theme: unknown, kb: unknown, done: (result: T) => void) => unknown,
								options?: { overlay?: boolean },
							) =>
								ctx.ui.custom<T>(factory as Parameters<typeof ctx.ui.custom<T>>[0], options),
							// 连接 ctx.ui.input（rule-editor custom 模板文本输入用）。
							// approval.ts 已声明可选 input（SDK 提供，mock 可能缺失）。
							...(typeof ctx.ui.input === "function"
								? { input: (title: string, placeholder?: string, opts?: Parameters<typeof ctx.ui.input>[2]) => ctx.ui.input(title, placeholder, opts) }
								: {}),
						},
					},
					config,
					makeNextIdCounter(config.userRules),
					{
						save: (newConfig) => {
							const result = saveConfig(newConfig);
							if (result.success) {
								config = newConfig; // 更新闭包状态
								// userRules 数量变化 → 请求 statusline 重绘 footer（rule count 部分）。
								requestFooterRender();
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
							notify: (msg: string, type?: "info" | "warning" | "error") => ctx.ui.notify(msg, type),
							select: (title: string, options: string[], opts?: Parameters<typeof ctx.ui.select>[2]) =>
								ctx.ui.select(title, options, opts),
							custom: <T,>(
								factory: (tui: unknown, theme: unknown, kb: unknown, done: (result: T) => void) => unknown,
								options?: { overlay?: boolean },
							) =>
								ctx.ui.custom<T>(factory as Parameters<typeof ctx.ui.custom<T>>[0], options),
							// 连接 ctx.ui.input（与 rule handler 一致；model picker 当前不用，但保持 ctx 对称）。
							...(typeof ctx.ui.input === "function"
								? { input: (title: string, placeholder?: string, opts?: Parameters<typeof ctx.ui.input>[2]) => ctx.ui.input(title, placeholder, opts) }
								: {}),
						},
					},
					config,
					{
						listModels: () => listAvailableModels((m) => console.warn(m)),
						save: (newConfig) => {
							const result = saveConfig(newConfig);
							if (result.success) {
								config = newConfig; // 更新闭包状态
								// classifier model 变化 → 请求 statusline 重绘 footer（auto 模式显示 model）。
								requestFooterRender();
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
					// mode/enabled 切换后请求 statusline 重绘 footer，避免显示旧 mode 直到 resize/timer。
					requestFooterRender();
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

	// ──────────────────────── footer line 辅助（闭包内，捕获 config） ────────────────────────

	/**
	 * 从 ctx.ui.theme 构造 palette 并注册 permission footer line renderer。
	 * duck typing：headless/mock ctx 无 theme（或 theme.fg 非函数）时跳过，
	 * 返回 noop dispose（不抛异常）。renderer 闭包读最新 config（refreshConfig/切换后生效）。
	 */
	function registerFooterLineFor(ctx: ExtensionContext): () => void {
		const theme = (ctx.ui as { theme?: { fg?: unknown } }).theme;
		if (!theme || typeof theme.fg !== "function") return () => {};
		const palette = paletteFromTheme(theme as { fg(token: string, text: string): string });
		return registerPermissionFooterLine(makePermissionFooterRenderer(palette));
	}

	/**
	 * 构造 footer line renderer。render 闭包读最新 config.mode/enabled/userRules/classifier，
	 * 故 session 内任意字段切换后 statusline 重绘即可见新值（无需重建 renderer）。
	 */
	function makePermissionFooterRenderer(palette: PermissionPalette): FooterLineRenderer {
		return {
			order: 2,
			render: () => renderPermissionFooterLine(
				config.mode,
				config.enabled,
				config.userRules.length,
				config.classifier.model,
				palette,
			),
		};
	}
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
			notify: (msg: string, type?: "info" | "warning" | "error") => ctx.ui.notify(msg, type),
			select: (title: string, options: string[], opts?: Parameters<typeof ctx.ui.select>[2]) => ctx.ui.select(title, options, opts),
			custom: <T,>(
				factory: (tui: unknown, theme: unknown, kb: unknown, done: (result: T) => void) => unknown,
				options?: { overlay?: boolean },
			) =>
				ctx.ui.custom<T>(factory as Parameters<typeof ctx.ui.custom<T>>[0], options),
			// W6 T9 G3：Reject-with-Reason。ctx.ui.input 存在则透传（采集真实拒绝理由）。
			// approval.ts 的 collectRejectReason 会用 typeof 判断是否可用，不可用则 fallback。
			...(typeof ctx.ui.input === "function"
				? { input: (title: string, placeholder?: string, opts?: Parameters<typeof ctx.ui.input>[2]) => ctx.ui.input(title, placeholder, opts) }
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
