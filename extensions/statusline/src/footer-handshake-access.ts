// src/footer-handshake-access.ts
//
// footer 握手协议的 **owner 端**（statusline 是 canonical owner）。
//
// 设计动机（沿用 ask-user #M4 修复模式，见 extensions/ask-user/src/channel-registry-register.ts）：
//  - statusline 是 registry 唯一创建方（canonical owner）
//  - 其他扩展（如 pi-permission）是 consumer：永不创建 registry 实例，永不写 slot.registry 字段
//  - slot 形状 {version, registry?, pending:[]}；registry 未就绪时 consumer 只 push pending
//
// 加载顺序鲁棒（三个分支，见 getOrCreateFooterRegistry）：
//  1. 无合规 slot → 建新 slot + 立即创建 canonical registry
//  2. slot 存在但 registry 未就绪（consumer 先到过，塞过 pending）→ 创建 canonical registry + flush pending
//  3. slot 存在且 registry 已就绪 → 返回同一实例引用（===），不重建、不重复 flush

/** 协议契约字面量。必须与 extensions/permission/src/footer-provider.ts 完全一致。 */
export const FOOTER_HANDSHAKE_KEY = Symbol.for(
	"@zhushanwen/pi-statusline.footerHandshake",
);
export const REQUEST_RENDER_KEY = Symbol.for(
	"@zhushanwen/pi-statusline.requestRender",
);

/** 握手协议版本号。读写 slot 时校验 version !== 1 视为不兼容（warn + 丢弃重建）。 */
const HANDSHAKE_VERSION = 1 as const;

/**
 * footer line renderer 的本地等价接口（与 permission 实际渲染函数形状一致）。
 * 本模块不静态 import permission（permission 是可选 peerDep，未安装时静态 import
 * 会致整个 statusline 加载失败）；运行时结构兼容即可。
 */
export interface FooterLineRenderer {
	/** 显示顺序权重：0=line1, 1=line2, 2=line3, ... */
	order: number;
	/** 纯函数：返回单行字符串（无内容返回 null，statusline 跳过） */
	render(ctx: unknown, theme: unknown): string | null;
}

/** canonical registry —— 仅由 getOrCreateFooterRegistry 创建 */
export interface FooterLineRegistry {
	register(id: string, renderer: FooterLineRenderer): void;
	unregister(id: string): void;
	entries(): Iterable<[string, FooterLineRenderer]>;
}

interface PendingEntry {
	id: string;
	renderer: FooterLineRenderer;
}

export interface FooterHandshakeSlot {
	version: typeof HANDSHAKE_VERSION;
	registry?: FooterLineRegistry;
	pending: PendingEntry[];
}

/** 从 globalThis 读 slot；version !== 1 或结构不合规视为无 slot（返回 undefined）。 */
function readSlot(): FooterHandshakeSlot | undefined {
	const slot = Reflect.get(globalThis, FOOTER_HANDSHAKE_KEY) as unknown;
	if (slot === undefined) return undefined;
	if (typeof slot !== "object" || slot === null) return undefined;
	const version = (slot as { version?: unknown }).version;
	if (version !== HANDSHAKE_VERSION) {
		console.warn(
			`[pi-statusline] footer handshake version mismatch (got ${String(version)}, expected ${HANDSHAKE_VERSION}); discarding and recreating.`,
		);
		return undefined;
	}
	const candidate = slot as FooterHandshakeSlot;
	if (!Array.isArray(candidate.pending)) return undefined;
	return candidate;
}

/** 内部 Map 实现的 registry —— 仅本文件创建 */
function createRegistry(): FooterLineRegistry {
	const map = new Map<string, FooterLineRenderer>();
	return {
		register(id, r) {
			map.set(id, r);
		},
		unregister(id) {
			map.delete(id);
		},
		entries() {
			return map.entries();
		},
	};
}

function flushPending(
	registry: FooterLineRegistry,
	pending: PendingEntry[],
): void {
	for (const e of pending) registry.register(e.id, e.renderer);
}

/**
 * 唯一创建点。三个分支：
 *  1. 无合规 slot → 建新 slot + 立即创建 canonical registry
 *  2. slot 存在但 registry 未就绪（permission 先到过） → 创建 canonical registry + flush pending
 *  3. slot 存在且 registry 已就绪 → 返回同一实例引用（===）
 *
 * @returns 进程级 canonical FooterLineRegistry 单例（永不返回 undefined）
 */
export function getOrCreateFooterRegistry(): FooterLineRegistry {
	let slot = readSlot();
	if (slot === undefined) {
		// 分支 1：无合规槽位，新建并立即创建 canonical registry
		const registry = createRegistry();
		slot = { version: HANDSHAKE_VERSION, registry, pending: [] };
		Reflect.set(globalThis, FOOTER_HANDSHAKE_KEY, slot);
		return registry;
	}
	if (slot.registry === undefined) {
		// 分支 2：permission 先到过，flush pending 进 canonical registry
		const registry = createRegistry();
		flushPending(registry, slot.pending);
		slot.pending = [];
		slot.registry = registry;
		return registry;
	}
	// 分支 3：registry 已就绪，返回同一实例
	return slot.registry;
}

/**
 * 渲染触发器。其他扩展调它让 statusline 立即重绘（mode 切换后用）。
 * statusline session_start 时把自身的 requestRender 句柄挂到 globalThis；
 * permission 端调 requestFooterRender() 即触发。
 *
 * 用 identity check 避免覆盖更新的 fn：unregister 时只在当前槽位仍是本 fn 时才删除，
 * 防止 A 注册→B 注册→A unregister 误删 B 的句柄。
 *
 * @returns unregister 函数：从 globalThis 移除句柄（仅当槽位仍是本 fn 时）
 */
export function registerRequestRender(fn: () => void): () => void {
	Reflect.set(globalThis, REQUEST_RENDER_KEY, fn);
	return () => {
		if (Reflect.get(globalThis, REQUEST_RENDER_KEY) === fn) {
			Reflect.deleteProperty(globalThis, REQUEST_RENDER_KEY);
		}
	};
}
