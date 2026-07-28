/**
 * Pi Permission statusline — footer 集成（W6 T1）。
 *
 * 通过 ctx.ui.setFooter(factory) 注册一个 footer factory，在 TUI 底部显示当前
 * 权限模式标签（YOLO/AUTO/APPROVE/STRICT）+ enabled 状态。
 *
 * 设计参考 extensions/statusline/src/index.ts:84-136 的 UiWithFooter 桥接模式：
 *  - SDK 未声明 setFooter 的精确类型（stub 为 `setFooter(factory: unknown): void`），
 *    故本地定义 UiWithFooter 接口，用 `ctx.ui as unknown as UiWithFooter` 桥接。
 *  - factory 返回 FooterHandle（dispose/invalidate/render），render(width) 返回行数组。
 *
 * 单例限制：Pi 只有一个 footer 槽位，本扩展的 footer 会覆盖（或被覆盖）其他扩展
 * （如 @zhushanwen/pi-statusline）的 footer。已知限制，README 注明。
 *
 * 可测试性：createPermissionFooter 是纯函数（输入 mode+enabled，返回 factory）；
 * renderPermissionLine 是纯函数（输入 mode+enabled+palette，返回行数组），便于单测。
 */

import type { PermissionMode } from "./types.js";
import { MODE_LABELS } from "./types.js";

// ──────────────────────── Footer API 适配类型 ────────────────────────

/** Tui 句柄（Pi TUI 提供的渲染接口，最小子集）。 */
interface TuiHandle {
	requestRender(): void;
}

/** Footer 渲染句柄（setFooter 回调的返回值）。 */
export interface FooterHandle {
	dispose(): void;
	invalidate(): void;
	render(width: number): string[];
}

/** Footer factory 的签名（setFooter 的回调参数类型）。 */
export type FooterFactory = (
	tui: TuiHandle,
	theme: unknown,
	footerData: unknown,
) => FooterHandle;

/**
 * SDK 缺失的 setFooter 类型 —— 仅本扩展需要。
 *
 * 绕过 `as any`：用 `as unknown as` 明确意图，配合本地接口提供类型检查。
 * SDK 补齐 setFooter 类型后可移除本接口。
 */
export interface UiWithFooter {
	setFooter(fn: FooterFactory): void;
}

// ──────────────────────── 渲染（纯函数） ────────────────────────

/** 语义色 token 到字符串着色器的映射（与 statusline 扩展的 Pallet 对齐）。 */
export interface PermissionPalette {
	/** dim 文本（次要信息） */
	dim(s: string): string;
	/** 主文本 */
	text(s: string): string;
	/** accent（模式标签高亮） */
	accent(s: string): string;
	/** success（enabled 状态） */
	success(s: string): string;
	/** warning（disabled 状态） */
	warning(s: string): string;
}

/** 模式对应的 accent 色建议（调用方可参考，非强制）。 */
export const MODE_ACCENT_TOKEN: Record<PermissionMode, "accent" | "warning" | "success"> = {
	yolo: "warning",
	auto: "accent",
	approve: "accent",
	strict: "success",
};

/**
 * 渲染权限状态行（纯函数，便于单测）。
 *
 * 输出格式：`[pi-permission] MODE · <enabled|disabled>`
 *  - mode 标签用 MODE_LABELS（YOLO/Auto/Approve/Strict）
 *  - enabled=true → success 色 "enabled"
 *  - enabled=false → warning 色 "disabled"（等同 yolo 但保留配置）
 *
 * yolo 模式额外提示 "all tools allowed"，strict 提示 "all require approval"。
 *
 * @param mode 当前权限模式
 * @param enabled 扩展是否启用
 * @param palette 色彩映射（测试可传纯字符串透传的 palette）
 * @returns 渲染行（单行，数组包装便于 footer render 统一接口）
 */
export function renderPermissionLine(
	mode: PermissionMode,
	enabled: boolean,
	palette: PermissionPalette,
): string[] {
	const label = MODE_LABELS[mode];
	const statePart = enabled
		? palette.success("enabled")
		: palette.warning("disabled");
	const detail = enabled ? modeDetail(mode) : "passthrough (config preserved)";
	return [`${palette.dim("[pi-permission]")} ${palette.accent(label)} ${palette.dim("·")} ${statePart} ${palette.dim(detail)}`];
}

/** 各模式的简短补充说明（renderPermissionLine 用）。 */
function modeDetail(mode: PermissionMode): string {
	switch (mode) {
		case "yolo":
			return "all tools allowed";
		case "auto":
			return "AST + rules + AI classifier";
		case "approve":
			return "rules + manual approval";
		case "strict":
			return "all require approval";
	}
}

// ──────────────────────── FooterHandle 实现 ────────────────────────

/**
 * 创建 footer factory（注册给 ctx.ui.setFooter）。
 *
 * factory 返回的 FooterHandle：
 *  - dispose()：noop（无定时器/订阅需清理；mode 变化由 session_start 重建 factory）
 *  - invalidate()：清渲染缓存
 *  - render(width)：返回 renderPermissionLine 结果（缓存 + 截断到 width）
 *
 * @param getMode 返回当前 PermissionMode 的闭包（session 内 mode 可变，闭包读最新值）
 * @param getEnabled 返回当前 enabled 状态的闭包
 * @param palette 色彩映射（生产用 theme.fg 构造，测试用透传 palette）
 */
export function createPermissionFooter(
	getMode: () => PermissionMode,
	getEnabled: () => boolean,
	palette: PermissionPalette,
): FooterFactory {
	return (_tui: TuiHandle, _theme: unknown, _footerData: unknown): FooterHandle => {
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;

		return {
			dispose() {
				/* noop — 无定时器/订阅 */
			},
			invalidate() {
				cachedWidth = undefined;
				cachedLines = undefined;
			},
			render(width: number): string[] {
				if (cachedWidth === width && cachedLines) {
					return cachedLines;
				}
				const lines = renderPermissionLine(getMode(), getEnabled(), palette);
				cachedWidth = width;
				cachedLines = lines;
				return lines;
			},
		};
	};
}

// ──────────────────────── 生产 palette 构造 ────────────────────────

/**
 * 从 Pi Theme 构造 PermissionPalette（生产用）。
 *
 * theme.fg(token, text) 是 Pi 的语义着色 API（token 如 "dim"/"text"/"success"）。
 * 本地包装为 PermissionPalette 接口，便于 footer 与测试共用纯函数。
 *
 * @param theme Pi Theme 对象（ctx.ui.theme）
 */
export function paletteFromTheme(theme: { fg(token: string, text: string): string }): PermissionPalette {
	return {
		dim: (s) => theme.fg("dim", s),
		text: (s) => theme.fg("text", s),
		accent: (s) => theme.fg("accent", s),
		success: (s) => theme.fg("success", s),
		warning: (s) => theme.fg("warning", s),
	};
}

/**
 * 注册权限 footer 到 ctx.ui（生产入口）。
 *
 * 在 session_start handler 里调用。用 `ctx.ui as unknown as UiWithFooter` 桥接
 * SDK 未声明的 setFooter 类型。
 *
 * 防御：headless（json/print）模式或 mock ctx 可能无 setFooter/theme —— 此时跳过
 * footer 注册（footer 仅 TUI 有意义）。用 duck typing 检查，不抛异常。
 *
 * @param ctxUi ctx.ui 对象（需含 setFooter + theme，缺失则跳过）
 * @param getMode 返回当前 PermissionMode 的闭包
 * @param getEnabled 返回当前 enabled 状态的闭包
 */
export function registerPermissionFooter(
	ctxUi: { setFooter?: unknown; theme?: unknown },
	getMode: () => PermissionMode,
	getEnabled: () => boolean,
): void {
	// duck typing：setFooter 必须是函数，theme 必须有 fg 函数（headless/mock 缺失则跳过）
	if (typeof ctxUi.setFooter !== "function") return;
	const theme = ctxUi.theme as { fg?: unknown } | undefined;
	if (!theme || typeof theme.fg !== "function") return;

	const palette = paletteFromTheme(theme as { fg(token: string, text: string): string });
	const factory = createPermissionFooter(getMode, getEnabled, palette);
	(ctxUi as unknown as UiWithFooter).setFooter(factory);
}
