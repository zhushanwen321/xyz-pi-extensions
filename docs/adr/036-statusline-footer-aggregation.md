# ADR-036: Statusline Footer Aggregation — 解决 pi-permission 与 pi-statusline 的 footer 单例冲突

- **Status**: proposed
- **Date**: 2026-07-29
- **Branch**: `feat-permission-guidance`
- **Supersedes**: —
- **Related**: [`extension-dependencies.json:96` ask-user → subagent-workflow 握手条目](../../extension-dependencies.json), [`extensions/ask-user/src/channel-registry-register.ts`](../../extensions/ask-user/src/channel-registry-register.ts), [`@zhushanwen/pi-permission` README § 已知限制](../../extensions/permission/README.md)

## Context

`@zhushanwen/pi-permission` 与 `@zhushanwen/pi-statusline` 都通过 `ctx.ui.setFooter(factory)` 注册自定义 footer。两个扩展同时安装时，**后注册者覆盖前者**——这是 Pi SDK 的设计，而非扩展 bug。

### SDK 行为确认（已读源码）

**`setFooter` 在 SDK 内是单例覆盖，不是栈。**

源码：`pi-mono-workspace/main/packages/coding-agent/src/modes/interactive/interactive-mode.ts:1950-1978`

```ts
private setExtensionFooter(factory | undefined): void {
  if (this.customFooter?.dispose) this.customFooter.dispose();  // 旧 footer dispose
  if (this.customFooter) this.ui.removeChild(this.customFooter); // 旧 footer 移除
  else this.ui.removeChild(this.footer);                         // 否则移除内置 footer
  if (factory) {
    this.customFooter = factory(this.ui, theme, this.footerDataProvider);
    this.ui.addChild(this.customFooter);
  } else {
    this.customFooter = undefined;
    this.ui.addChild(this.footer);  // undefined 还原内置
  }
  this.ui.requestRender();
}
```

`this.customFooter` 是**单字段**，不是数组。两次 `setFooter` 调用：第一次的 handle 被 `dispose()`（如 `unsub()` + `clearInterval`）并 `removeChild`；第二次的 handle 成为唯一持有者。

### 加载顺序无保证

Pi 加载扩展用 `loadExtensionsInternal` 的 `for (const extPath of paths)` 串行循环（`loader.ts:495-512`），顺序由 `mergePaths(primary, additional)` 决定（`resource-loader.ts:792-805`）：

- `primary` = CLI `--extension` 参数
- `additional` = `settings.json` 中的全局/项目扩展配置

**先 permission 还是先 statusline 取决于用户的安装来源**，不是扩展或 Pi 能保证的。

`session_start` handler 触发顺序 = `extensions` 数组顺序 = `orderedExtensions = extensionPaths.map(...).filter(...)`（`resource-loader.ts:559-561`，`runner.ts:770` `for (const ext of this.extensions)`）。

### 当前状态

`@zhushanwen/pi-permission` 在 `session_start` 注册自己的 footer（`extensions/permission/src/index.ts:91-95` 调用 `registerPermissionFooter`），显示：

```
[pi-permission] Auto · enabled · AST + rules + AI classifier
```

`@zhushanwen/pi-statusline` 同时也注册 footer，显示 5 行（line1 目录/分支、line2 provider/model/thinking/speed/cache、line3 ctx/流量/会话 ID、line4 search-tool、line5+ token-plan）。

**两者并存时，后注册者赢**——典型用户痛点：先装 statusline（v0.4.x），后装 permission（v0.0.1），permission 注册覆盖 statusline，line1-line5 全部消失只剩 `[pi-permission] Auto · enabled`。

### 约束

- **不做 Pi SDK 修改**（用户决策，2026-07-29）。setFooter 单例是上游设计缺陷，但我们不向 pi 提 PR——本仓库是扩展生态，不是 Pi 维护者
- **statusline 升级为 footer 聚合者**（用户决策）——它是事实上的 footer 中心（context/speed/quota/branch 都在它这里），应该承担聚合职责
- **permission 撤掉自己的 setFooter**——功能不丢，信息由 statusline 代为渲染
- **协议对加载顺序鲁棒**——permission 可能先 statusline 后，statusline 可能先 permission 后

## Decision

### 1. statusline 提供 footer line 注册协议（仿 ask-user 握手模式）

statusline 是 **canonical owner**（registry 实例唯一创建方），其他扩展是 **consumer**（永不创建 registry，仅 push pending 或调 `registry.register`）。

**关键架构原则**（沿用 ask-user 的 #M4 修复，[`extensions/ask-user/src/channel-registry-register.ts:1-15`](../../extensions/ask-user/src/channel-registry-register.ts)）：

- 槽位是 `{version, registry?, pending:[]}` 三元组，不是直接暴露的 Map
- registry 实例**仅**由 statusline 的 `getOrCreateFooterRegistry()` 创建
- consumer 永不持有 registry 实例，**永不写 slot.registry 字段**
- consumer 只读 slot：registry 就绪 → `registry.register(id, renderer)`；未就绪 → `pending.push({id, renderer})`

**为什么用 pending-flush 而不是 Map.put**：直接 Map.put 让 consumer 拥有 mutable shared state，会重新引入 ask-user #M4 修复要解决的 race——两个 consumer 各自初始化 Map 抢占槽位。pending-flush 保证 owner 拥有 canonical 实例的不可争议性。

#### 1.1 Symbol key 与协议契约

```
FOOTER_HANDSHAKE_KEY = Symbol.for('@zhushanwen/pi-statusline.footerHandshake')
REQUEST_RENDER_KEY  = Symbol.for('@zhushanwen/pi-statusline.requestRender')
```

**协议契约**（必须与 statusline 端字面量完全一致）：

- key 字面量：`'@zhushanwen/pi-statusline.footerHandshake'`（per Symbol.for，跨模块共享）
- handshake 形状：`{version: 1, registry?: FooterLineRegistry, pending: PendingEntry[]}`
- version 守卫：slot.version !== 1 时 console.warn + 丢弃重建

**隐式公开 API 契约**：Symbol 字面量 `'@zhushanwen/pi-statusline.footerHandshake'` 与 `'@zhushanwen/pi-statusline.requestRender'` 是 statusline 对外暴露的**隐式公开 API**——consumer（如 permission）通过硬编码此字符串、用 `Symbol.for(...)` 反射访问握手 slot，无静态 import。这意味着这两个字符串**没有 semver 的编译期保护**：改名时 consumer 端不会 typecheck 报错，只会运行时静默失效（拿不到 registry、`requestFooterRender()` noop）。因此改名（或删除）属于 **breaking change**，需要 statusline **major bump**，并在 ADR + 两端源码注释中同步更新（当前 permission 端 `footer-provider.ts` 与 statusline 端 `footer-handshake-access.ts` 各自定义字面量，靠注释互相提醒保持一致）。`HANDSHAKE_VERSION` 守卫只防御 slot 形状漂移，不覆盖 key 字面量改名。

#### 1.2 statusline 端：canonical owner 实现

新建 `extensions/statusline/src/footer-handshake-access.ts`：

```ts
// extensions/statusline/src/footer-handshake-access.ts

/** 协议契约字面量。必须与 extensions/permission/src/footer-provider.ts 完全一致。 */
export const FOOTER_HANDSHAKE_KEY = Symbol.for('@zhushanwen/pi-statusline.footerHandshake');
export const REQUEST_RENDER_KEY  = Symbol.for('@zhushanwen/pi-statusline.requestRender');

const HANDSHAKE_VERSION = 1 as const;

/** footer line renderer 的本地等价接口（与 permission 实际渲染函数形状一致）。
 *  本模块不静态 import permission（permission 是可选 peerDep，未安装时静态 import
 *  会致整个 statusline 加载失败）；运行时结构兼容即可。
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

interface PendingEntry { id: string; renderer: FooterLineRenderer; }

interface FooterHandshakeSlot {
  version: typeof HANDSHAKE_VERSION;
  registry?: FooterLineRegistry;
  pending: PendingEntry[];
}

function readSlot(): FooterHandshakeSlot | undefined {
  const slot = Reflect.get(globalThis, FOOTER_HANDSHAKE_KEY) as unknown;
  if (slot === undefined) return undefined;
  if (typeof slot !== 'object' || slot === null) return undefined;
  const version = (slot as { version?: unknown }).version;
  if (version !== HANDSHAKE_VERSION) {
    console.warn(`[pi-statusline] footer handshake version mismatch (got ${String(version)}, expected ${HANDSHAKE_VERSION}); discarding and recreating.`);
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
    register(id, r) { map.set(id, r); },
    unregister(id) { map.delete(id); },
    entries() { return map.entries(); },
  };
}

function flushPending(registry: FooterLineRegistry, pending: PendingEntry[]): void {
  for (const e of pending) registry.register(e.id, e.renderer);
}

/** 唯一创建点。三个分支：
 *  1. 无合规 slot → 建新 slot + 立即创建 canonical registry
 *  2. slot 存在但 registry 未就绪（permission 先到过） → 创建 canonical registry + flush pending
 *  3. slot 存在且 registry 已就绪 → 返回同一实例引用（===）
 */
export function getOrCreateFooterRegistry(): FooterLineRegistry {
  let slot = readSlot();
  if (slot === undefined) {
    const registry = createRegistry();
    slot = { version: HANDSHAKE_VERSION, registry, pending: [] };
    Reflect.set(globalThis, FOOTER_HANDSHAKE_KEY, slot);
    return registry;
  }
  if (slot.registry === undefined) {
    const registry = createRegistry();
    flushPending(registry, slot.pending);
    slot.pending = [];
    slot.registry = registry;
    return registry;
  }
  return slot.registry;
}

/** 渲染触发器。其他扩展调它让 statusline 立即重绘（mode 切换后用）。
 *  statusline session_start 时把自身的 requestRender 句柄挂到 globalThis；
 *  permission 端调 requestFooterRender() 即触发。
 */
export function registerRequestRender(fn: () => void): () => void {
  Reflect.set(globalThis, REQUEST_RENDER_KEY, fn);
  return () => {
    if (Reflect.get(globalThis, REQUEST_RENDER_KEY) === fn) {
      Reflect.deleteProperty(globalThis, REQUEST_RENDER_KEY);
    }
  };
}
```

**核心不变性**（与 ask-user 一致）：
- canonical registry 实例**只**由 `getOrCreateFooterRegistry()` 创建
- `pending` 字段只在 consumer push 时由 consumer 写入
- `registry` 字段只在 owner 写入
- 多次 `getOrCreateFooterRegistry()` 调用返回同一实例（===）

### 2. statusline 在 buildLines 中聚合外部行

**关键改动**：statusline 是 registry owner，在 `session_start` 调用 `getOrCreateFooterRegistry()` 获取/创建 canonical registry，存入闭包；`buildLines` 遍历 `registry.entries()` 收集外部行。

现有 `buildLines()`（`extensions/statusline/src/index.ts:409-433`）改造为：

```ts
// statusline 闭包内的 footer registry 引用（session_start 时获取）
let footerRegistry: FooterLineRegistry | undefined;

// 内部固定行（statusline 自己渲染的 5 个区域）
const INTERNAL_LINES: ReadonlyArray<{ id: string; order: number; render: InternalLineRender }> = [
  { id: 'sl:dir',        order: 0, render: buildLine1 },
  { id: 'sl:model',      order: 1, render: buildLine2 },
  { id: 'sl:ctx',        order: 3, render: buildLine3 },     // ← order 3（原 2）
  { id: 'sl:search',     order: 4, render: buildSearchLineFn },
  // token-plan 行 order=5（由 buildTokenPlanLines 返回数组展开成多个 order=5）
];

// session_start 时调用一次（idempotent）：
footerRegistry = getOrCreateFooterRegistry();

// buildLines 中聚合：
function buildLines(ctx, theme, fd, width, st) {
  const allLines: Array<{ order: number; text: string }> = [];

  // 内部行
  for (const line of INTERNAL_LINES) {
    const text = line.render(ctx, theme, fd, st);
    if (text) allLines.push({ order: line.order, text });
  }
  // token-plan 多行展开（order=5）
  for (const text of buildTokenPlanLinesFn(cache, providers, palette, themeFg)) {
    if (text) allLines.push({ order: 5, text });
  }

  // 外部行（含 permission 行）—— statusline 是 owner，直接遍历自己的 registry
  if (footerRegistry) {
    for (const [id, renderer] of footerRegistry.entries()) {
      const text = renderer.render(ctx, theme);
      if (text) allLines.push({ order: renderer.order, text });
    }
  }

  return allLines
    .sort((a, b) => a.order - b.order)
    .map((l) => truncateToWidth(l.text, width));
}

// 同时注册 requestRender 入口（其他扩展通过 requestFooterRender() 触发重绘）
const unregisterRender = registerRequestRender(() => tuiRef.current?.requestRender());
// dispose 时调 unregisterRender()
```

**关键点**：
- 内部行 order 重新编号：dir=0, model=1, **ctx=3**（原 2，留出位置给外部）
- 外部行的 `order=2` 区间插入到 line2（model）和 line3（ctx）之间
- search=4, token-plan=5——外部行若想插到这些位置，用对应 order
- statusline 是 owner，`footerRegistry` 是它闭包内 canonical 引用；permission 通过握手协议 register 进去，statusline 立即能看到

### 3. line2 精简：speed/cache 仅显示 current，去掉 "day" 标记

按用户决策（2026-07-29）。当前 line2（`extensions/statusline/src/index.ts:345-359` + `extensions/statusline/src/format.ts:96-116`）显示 `speed 12t/s · day 85t/s │ cache 85% · day 72%`（speed 和 cache 之间用 `│` 分隔，speed/cache 内部用 `·` 分隔 current 和 day）。

**改造**：只显示 current，移除 `day` 标记。

```ts
// format.ts
export function formatSpeedPart(sp: SpeedLike, p: PlainPallet): string {
  return sp.current > 0 ? `│ ${p.d("speed")} ${p.g(`${sp.current}`)}${p.d("t/s")}` : "";
}

export function formatCacheRatioPart(cr: CacheRatioLike, p: PlainPallet): string {
  return cr.current !== null ? `│ ${p.d("cache")} ${p.g(`${cr.current}`)}${p.d("%")}` : "";
}
```

**理由**：
- footer 宽度有限（80-120 字符），line2 副槽已塞 4 个数据点（model/thinking/speed/cache），再叠加 permission 标签会超宽
- `day` 数据保留在 `~/.pi/agent/token-stats/<model>.json` 的滚动窗口（statusline/src/index.ts 的 `speed.day/d7/d30`）——后续若需要看，单独命令查询即可
- `day` 标记占视觉位 5 字符 × 2 处，节省 10 字符空间给 permission 行

**数据保留**：`SpeedData` 和 `CacheRatioData` 的 `day/d7/d30` 字段保留，render 时不再调用，仅 `current` 被显示。

### 4. permission 撤掉自己的 setFooter，改成注册 line renderer

**关键约束（仿 ask-user）**：permission **绝不静态 import `@zhushanwen/pi-statusline`**（它是可选 peerDep，静态 import 会致 statusline 缺失时 typecheck 失败）。permission 只用 `Reflect.get(globalThis, KEY)` 反射访问握手 slot，类型用本地 structural interface。

#### 4.1 新建 `extensions/permission/src/footer-provider.ts`

```ts
// extensions/permission/src/footer-provider.ts
//
// permission 端的 footer line 注册入口（纯 globalThis 反射，无静态 import）。
//
// 设计动机（沿用 ask-user #M4 修复模式）：
//  - statusline 是 canonical owner（registry 唯一创建方）
//  - permission 是 consumer：永不创建 registry 实例，永不写 slot.registry 字段
//  - slot 形状 {version:1, registry?, pending:[]}；registry 未就绪时 push pending
//
// 加载顺序鲁棒（三种分支）：
//  1. statusline 先启动 → slot.registry 已就绪 → 直接 register
//  2. statusline 未启动 → slot 无 registry → push pending（statusline 启动时 flush）
//  3. statusline 完全未安装 → slot 不存在或无 registry → push pending 但无人 flush
//     （permission silent 降级，README 注明用户需安装 statusline 才能看到 mode 标签）

import { MODE_LABELS, type PermissionMode } from "./types.js";

// ──────────────────────── 协议契约字面量 ────────────────────────
// 必须与 extensions/statusline/src/footer-handshake-access.ts 的字面量完全一致。
// 改名必须两侧同步（Symbol.for 字符串匹配）。
export const FOOTER_HANDSHAKE_KEY = Symbol.for('@zhushanwen/pi-statusline.footerHandshake');
export const REQUEST_RENDER_KEY  = Symbol.for('@zhushanwen/pi-statusline.requestRender');

const HANDSHAKE_VERSION = 1 as const;
const FOOTER_LINE_ID = "pi-permission";

// ──────────────────────── 本地等价接口（结构兼容即可） ────────────────────────
// 不静态 import statusline（可选 peerDep，缺失时静态 import 会致 typecheck 失败）。
// 运行时通过 Reflect.get(globalThis, KEY) 拿到 canonical 实例，类型由 structural
// 兼容性保证。

interface FooterLineRenderer {
  order: number;
  render(ctx: unknown, theme: unknown): string | null;
}

interface FooterLineRegistry {
  register(id: string, renderer: FooterLineRenderer): void;
  unregister(id: string): void;
}

interface PendingEntry { id: string; renderer: FooterLineRenderer; }

interface FooterHandshakeSlot {
  version: number;
  registry?: FooterLineRegistry;
  pending: PendingEntry[];
}

// ──────────────────────── Slot 读取（version 守卫） ────────────────────────

function readSlot(): FooterHandshakeSlot | undefined {
  const slot = Reflect.get(globalThis, FOOTER_HANDSHAKE_KEY) as unknown;
  if (slot === undefined) return undefined;
  if (typeof slot !== 'object' || slot === null) return undefined;
  const version = (slot as { version?: unknown }).version;
  if (version !== HANDSHAKE_VERSION) {
    console.warn(`[pi-permission] footer handshake version mismatch (got ${String(version)}, expected ${HANDSHAKE_VERSION}); discarding.`);
    return undefined;
  }
  const candidate = slot as FooterHandshakeSlot;
  if (!Array.isArray(candidate.pending)) return undefined;
  return candidate;
}

function ensureSlot(): FooterHandshakeSlot {
  const slot: FooterHandshakeSlot = { version: HANDSHAKE_VERSION, pending: [] };
  Reflect.set(globalThis, FOOTER_HANDSHAKE_KEY, slot);
  return slot;
}

// ──────────────────────── 注册入口（consumer 唯一接口） ────────────────────────

/**
 * 注册 permission 的 footer line renderer。
 *
 * 行为分支（仿 ask-user 的 registerAskUserChannelHandler）：
 *  - slot 不存在或 version 不兼容 → 建 slot（仅 pending），renderer 入 pending
 *  - slot 存在但 registry 未就绪 → renderer 入 pending（statusline 启动时 flush）
 *  - slot 存在且 registry 就绪 → 直接 registry.register("pi-permission", renderer)
 *
 * 多次调用幂等：registry 就绪时同名覆盖；未就绪时 pending.length 增长
 * （statusline flush 时一次性消费所有 pending）。
 *
 * @returns dispose 函数：unregister + requestRender
 */
export function registerPermissionFooterLine(renderer: FooterLineRenderer): () => void {
  const slot = readSlot() ?? ensureSlot();
  if (slot.registry !== undefined) {
    slot.registry.register(FOOTER_LINE_ID, renderer);
  } else {
    slot.pending.push({ id: FOOTER_LINE_ID, renderer });
  }
  return () => {
    // 回滚：处理两条路径——
    //   1. registry 已就绪 → unregister（清除 map[id]）
    //   2. registry 未就绪（consumer 仍在 pending 中） → 从 pending 过滤掉自己的 entry
    //      否则 statusline 后启动 flushPending 时会把 stale renderer 一起 register 进去
    //      （map.set 同 id 覆盖只赢最后一次，但 stale 闭包仍持有过期 config，见 B2）
    const current = readSlot();
    if (current?.registry !== undefined) {
      current.registry.unregister(FOOTER_LINE_ID);
    } else if (current) {
      current.pending = current.pending.filter((p) => p.id !== FOOTER_LINE_ID);
    }
    requestFooterRender();
  };
}

/** 请求 statusline 立即重绘。statusline 未安装时 noop。 */
export function requestFooterRender(): void {
  const fn = Reflect.get(globalThis, REQUEST_RENDER_KEY) as (() => void) | undefined;
  fn?.();
}
```

#### 4.2 permission `src/index.ts` 改造

```ts
// 删除：
//   import { registerPermissionFooter } from "./statusline.js";
//   let invalidateFooter: () => void = () => {};

// 替换为：
import { registerPermissionFooterLine, requestFooterRender } from "./footer-provider.js";
import { paletteFromTheme } from "./statusline-palette.js";

let disposeFooterLine: () => void = () => {};

pi.on("session_start", (_e, ctx) => {
  refreshConfig();
  // 构造 renderer（闭包捕获 config 和 palette；permission 是 consumer，registry
  // 实例由 statusline 持有，permission 不创建 registry）
  const renderer = makePermissionFooterRenderer(ctx);
  disposeFooterLine = registerPermissionFooterLine(renderer);
});

// W6 兼容：mode 切换后调用 requestFooterRender() 让 statusline 立即重绘
// （不重建 renderer，renderer 闭包持有 () => config.mode 引用，refreshConfig
//  reassign config 后闭包会读到新值）
```

#### 4.3 `makePermissionFooterRenderer` 工厂

```ts
function makePermissionFooterRenderer(ctx: ExtensionContext): FooterLineRenderer {
  const palette = makePalette(ctx);
  return {
    order: 2,  // 插在 line2（model, order=1）和 line3（ctx, order=3）之间
    render: (_c, _t) => renderPermissionLine(
      config.mode,
      config.enabled,
      config.classifier.model,  // 仅 auto 模式使用
      palette,
    ),
  };
}

function renderPermissionLine(
  mode: PermissionMode,
  enabled: boolean,
  classifierModel: string,
  palette: PermissionPalette,
): string | null {
  if (!enabled) {
    return `[permission] ${palette.warning("disabled")}`;
  }
  const label = MODE_LABELS[mode];
  const detail = modeDetail(mode);
  const baseLine = `[permission] ${palette.accent(label)} · ${palette.success("enabled")} · ${palette.dim(detail)}`;
  if (mode === "auto" && classifierModel) {
    return `${baseLine} · ${palette.dim(`ai=${classifierModel}`)}`;
  }
  return baseLine;
}

function modeDetail(mode: PermissionMode): string {
  switch (mode) {
    case "yolo": return "all tools allowed";
    case "auto": return "AST + rules + AI";
    case "approve": return "rules + manual";
    case "strict": return "all require approval";
  }
}
```

**关键点**：
- **renderer 闭包捕获 `config` 引用**（permission/src/index.ts:62 `let config = loadAndWatchConfig(...)`）。`refreshConfig()` 在 session_start 重读配置时是 `config = newConfig`（reassign let 变量），**闭包通过 `config.mode` 访问会自动读到最新值**——这是 JS 闭包语义保证的
- **session_tree 时刷新闭包**：permission 当前没有 `session_tree` handler（permission/src/index.ts:73-75 `refreshConfig` 只在 session_start 调）。需要在 session_tree 时也调一次 refreshConfig + 重新构造 renderer。statusline 的 session_tree handler rebuild state + 不重建 registry（同 id `Map.set` 覆盖语义下，单纯 `registerPermissionFooterLine` 已能取代旧 renderer），但**dispose + re-register 仍是必要的防御性做法**——因为 statusline 启动前 consumer 可能处于 pending 状态，dispose 必须清理 pending entry，否则 statusline 后续 flushPending 时会同时 register 进 stale + new 两条 entry（虽然 id 覆盖只赢最后一次，但 stale 闭包仍持有过期 config——见 B2 dispose 函数的两路径清理逻辑）

#### 4.4 session_tree 兼容性

permission 必须新增 `session_tree` handler（W2 实施时）：

```ts
pi.on("session_tree", (_e, ctx) => {
  // 分支切换后 config 可能变化；重新读盘 + 重建 renderer
  refreshConfig();
  disposeFooterLine();
  disposeFooterLine = registerPermissionFooterLine(makePermissionFooterRenderer(ctx));
});
```

**为什么必须**：renderer 闭包捕获 `config` 是 reassign 后的 let 变量（仍可读到），但 session_tree 后 statusline 也会 rebuild state（statusline/src/index.ts:243-252）——statusline 的 session_tree handler 不清 registry，所以旧 renderer 仍占位，必须 unregister + re-register 才能反映新 session 的 config。

#### 4.5 删除/重命名的文件

- **删除**：`extensions/permission/src/statusline.ts`（226 行，原 227 行 reviewer 纠正）
- **新增**：`extensions/permission/src/footer-provider.ts`（握手协议 + 注册入口）
- **新增**：`extensions/permission/src/statusline-palette.ts`（从 statusline.ts:173-181 提取 `paletteFromTheme`）

### 5. 依赖关系

**关键原则**（仿 ask-user）：permission **不静态 import statusline**。依赖通过纯 globalThis 反射 + 可选 peerDep 声明。

**`extension-dependencies.json` 新增**：

```json
{
  "name": "@zhushanwen/pi-permission",
  "directory": "extensions/permission",
  "dependsOn": [
    {
      "package": "@zhushanwen/pi-statusline",
      "type": "optional",
      "reason": "permission 模式标签通过 globalThis Symbol 握手协议（FOOTER_HANDSHAKE_KEY = Symbol.for('@zhushanwen/pi-statusline.footerHandshake')）注册为 statusline footer 的一行（order=2，line2 和 line3 之间）。协议沿用 ask-user 的 {version, registry, pending} 模式（extension-dependencies.json:96 + extensions/ask-user/src/channel-registry-register.ts:80-108），permission 是 consumer 不创建 registry 实例，statusline 是 canonical owner。无代码层 import（纯 globalThis 反射，加载顺序无关）。缺失时 silent 降级：permission 功能完整，仅 footer 不显示 mode 标签。"
    }
  ]
}
```

**`extensions/permission/package.json` 新增**：

```json
{
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "@zhushanwen/pi-statusline": "*"
  },
  "peerDependenciesMeta": {
    "@earendil-works/pi-ai": { "optional": true },
    "@earendil-works/pi-tui": { "optional": true },
    "@zhushanwen/pi-statusline": { "optional": true }
  }
}
```

注意：`peerDependenciesMeta.optional: true` 让 pnpm 不强制安装 statusline——permission 在 statusline 缺失时仍能 typecheck + 加载（因为没有静态 import）。这与 ask-user 处理 `pi-subagent-workflow` 的模式完全一致（参考 [`extensions/ask-user/src/channel-registry-register.ts:36-43`](../../extensions/ask-user/src/channel-registry-register.ts) 注释说明）。

**statusline `package.json` 不变**——它是协议主人（owner），被消费者。

**关键区别 vs 之前的草案**：
- ❌ 之前：`import { registerFooterLine } from "@zhushanwen/pi-statusline/line-registry"`（静态 import，pnpm 不装时 typecheck 失败——reviewer #M1）
- ✅ 现在：`Reflect.get(globalThis, FOOTER_HANDSHAKE_KEY)`（无 import，可选 peerDep 仅声明意图）

### 6. 行视觉示例

最终 footer 渲染（permission auto 模式，classifier.model="zhipu/glm-4-flash"）：

```
<repo>/sub-dir · ⎇ feat-permission-guidance │ worktree
zhipu/glm-4-flash [high] │ speed 12t/s │ cache 85%
[permission] Auto · enabled · AST + rules + AI · ai=zhipu/glm-4-flash
ctx 45.2K/200K 23% │ from 13:25 · run 34m40s · last 12s │ ↑↓ 128.3k/8.5k │ 253b75.jsonl
tavily 234/1000次 23%
zhipu-coding-plan   5h  23%  4h11m  · wk   ∞  · mh   ∞
opencode-go         5h  45%  2h35m  · wk  12%  3d2h  · mh  78%  4d5h
```

vs 当前 statusline + permission 共存（permission 覆盖 statusline）：

```
[pi-permission] Auto · enabled · AST + rules + AI classifier
```

vs 当前仅 statusline（无 permission）：

```
<repo>/sub-dir · ⎇ feat-permission-guidance │ worktree
zhipu/glm-4-flash [high] │ speed 12t/s · day 85t/s │ cache 85% · day 72%
ctx 45.2K/200K 23% │ from 13:25 · run 34m40s · last 12s │ ↑↓ 128.3k/8.5k │ 253b75.jsonl
tavily 234/1000次 23%
zhipu-coding-plan   5h  23%  4h11m  · wk   ∞  · mh   ∞
```

**变化点**：
- line2 去掉 `· day 85t/s` 和 `· day 72%`（精简）
- line2 与 line3 之间新增 permission 行（含 `ai=...` 标注，仅 auto 模式）
- 其他行不变

## Alternatives Considered

### A1. 保留两边 footer，做"合并扩展"打包

把 `@zhushanwen/pi-statusline-with-permission` 作为新包发布，runtime 检测到两边都装时自动切换到合并版 footer。

**评估**：
- 短期方案属性极强：用户升级 statusline 或 permission 都要重新打合并包
- 没改变"单 setFooter 槽位"的根本问题——下次加第三个 footer 扩展（subagent/scheduler/todo）又要合并
- 引入新包 = 新发布/版本管理负担

**结论**：拒绝。短期方案属性 > 长期方案属性的典型案例。

### A2. 给 Pi SDK 提 issue：setFooter 改 push 栈

让 Pi 团队把 `setExtensionFooter` 改成多注册栈，扩展各自 setFooter，由 SDK 内部垂直拼成 LayeredRenderer。

**评估**：
- 真正的根方案——零扩展间耦合，协议由 SDK 维护
- 等 SDK 改动时间不可控（pi 上游不在我们手里）
- 用户当前痛点需要现在解决，不能等

**结论**：拒绝作为唯一方案。可作为长期演进方向记录在"Future Work"章节。

### A3. statusline 行注册 key 放顶层 `@zhushanwen/pi-extensions.footerRegistry`

不挂在 statusline 下，挂顶层 workspace 命名空间。

**评估**：
- `xyz-pi-extensions` 不是 npm 包，没有 SDK 级标识；顶层 key 概念模糊
- 与 ask-user/subagent-workflow 握手风格不一致（ask-user 的 key 挂在 subagent-workflow 下）
- statusline 是协议主人，其他扩展是消费者——key 应挂在协议主人下

**结论**：拒绝。命名一致性 + 概念清晰性都更差。

### A4. permission 行 order=5（token-plan 之后）

把 permission 行放在最末尾（order=5，与 token-plan 同级）。

**评估**：
- footer 总行数最多 +1，比 line2-line3 之间插入视觉权重更低
- 但 permission 模式是用户主动切换的安全状态，应有较高视觉权重
- token-plan 行有多个，permission 行位置会不稳定

**结论**：拒绝。用户决策 order=2（line2 与 line3 之间）。

### A5. classifier model 显示解析后的真实模型

`classifier.model === "auto"` 时调用 `resolveClassifierModel("auto")` 展开成 `zhipu/glm-4-flash`。

**评估**：
- 用户视角更有信息量（直接看到 AI 实际用什么）
- 但 statusline 要新增 models.json 解析依赖（与 permission 的 `model-resolver.ts` 重复）
- 加载时读盘 + 解析会增加 statusline 启动时间

**结论**：拒绝原始方案对当前需求过重。用户决策：原始值（`auto` 或 `provider/model-id`），仅 auto 模式显示。

## Consequences

### Positive

- **根本解决 footer 单例冲突**——setFooter 只由 statusline 调用一次，permission 不再注册 footer
- **statusline 升级为通用 footer 中心**——未来其他扩展（subagent/scheduler/todo/goal）想往 footer 加一行都走同一个协议，无需重复解决单例问题
- **握手协议对加载顺序鲁棒**——permission 先 statusline 后、statusline 先 permission 后、单独安装任意一方都正常工作
- **line2 视觉更紧凑**——去掉 `· day` 标记后 line2 副槽有空间容纳 model/thinking/speed/cache 四个数据点
- **permission label 与 statusline 视觉对齐**——同一渲染管线、同一 palette、同一 truncateToWidth 逻辑
- **可演进路径清晰**——SDK 修复 setFooter 栈后，本协议可平滑降级（statusline 不再 setFooter，每个扩展各自注册；或保留协议作为兼容性增强）

### Negative

- **引入跨扩展隐式耦合**——通过 globalThis Symbol 握手（与 ask-user 模式一致，是已建立的架构风格，不是新增风险）
- **statusline 是事实上的 footer 中心**——以后想 fork 或替换 statusline 的用户会丢失所有附加行（含 permission）。可接受，statusline 本就是高黏性扩展
- **permission 不再独立显示 footer 状态**——若用户卸载 statusline，permission label 完全消失（README 注明，详见下方 Migration 章节）
- **line2 失去 day 数据展示**——`speed.day` 和 `cache.day` 仍保留在数据结构中，仅不渲染。后续需要时可通过命令查询
- **协议设计有"key 命名空间挂协议主人"的设计取舍**——`@zhushanwen/pi-statusline.footerHandshake` 暗示 statusline 是协议 owner；若未来需要其他非 statusline 的 footer 中心，需新增 key 或调整

### Migration

**影响范围**：当前已安装 `@zhushanwen/pi-permission` v0.0.1 且**未安装** `@zhushanwen/pi-statusline` 的用户。占 permission 用户的大多数（典型安装是「只装 permission」）。

**升级后用户看到的现象**：

| 用户类型 | 当前（v0.0.1） | 升级后（v0.1.0） |
|----------|----------------|------------------|
| 仅装 permission | TUI 底部显示 `[pi-permission] Auto · enabled ...` | TUI 底部**无 permission 行**，需 `/permission status` 查 mode |
| 装了 permission + statusline | 单 setFooter 冲突，后注册者赢（结果不可预测） | TUI 底部显示完整 6 行 footer，permission 行嵌在 line2-line3 之间 |
| 仅装 statusline | 5 行 footer | 5 行 footer（不变） |

**迁移路径**：

1. permission v0.1.0 README「升级须知」新增显式章节：「v0.0.1 的内置 footer 已被移除——mode 标签现在由 `@zhushanwen/pi-statusline` 提供（这是我们推荐的 footer 聚合中心）。如果你想继续看 mode 标签：
   - 安装 `@zhushanwen/pi-statusline`（`pi install npm:@zhushanwen/pi-statusline`），footer 会自动显示 permission 行
   - 或者用 `/permission status` 命令随时查看当前 mode」
2. 在 v0.0.1 → v0.1.0 的 changeset 中加入 `permission: removed built-in footer (now provided by pi-statusline)` 作为 breaking change 描述
3. 如果未来用户基数显示「无 statusline 的 permission 用户」比例仍高（如 > 30%），再考虑回滚或在 permission 内置一个简易 setFooter 作为 fallback

**测试覆盖**：W3 实施时新增手动验证矩阵
- 单独安装 permission：确认无报错，footer 无 permission 行
- 单独安装 statusline：确认 5 行不变
- 两个都装：确认 6 行显示，permission 行在 line2-line3 之间
- 切换 mode：确认 permission 行内容立即更新（依赖 requestFooterRender）

### Neutral

- **撤掉 `extensions/permission/src/statusline.ts`（226 行）**——该文件同时承载 footer 集成逻辑和 palette 工具。改造后拆成 `footer-provider.ts`（line renderer 注册 + 协议入口）+ `statusline-palette.ts`（palette 工具），单一职责更清晰
- **permission 不再有 `invalidateFooter` 闭包**——mode 切换后调用 `requestFooterRender()`（全局函数）替代，semantically 相当于 requestRender 而非 dispose+re-register
- **statusline 新增 `footer-handshake-access.ts` 模块**——导出 `FOOTER_HANDSHAKE_KEY` / `REQUEST_RENDER_KEY` / `getOrCreateFooterRegistry()` / `registerRequestRender()`（owner 端 API）
- **permission 新增 `footer-provider.ts` 模块**——导出 `FOOTER_HANDSHAKE_KEY` / `REQUEST_RENDER_KEY` / `registerPermissionFooterLine()` / `requestFooterRender()`（consumer 端 API）

## Implementation Outline

```
W1: statusline footer-handshake 模块 + buildLines 聚合
  - 新增 extensions/statusline/src/footer-handshake-access.ts（owner 端：getOrCreateFooterRegistry + registerRequestRender）
  - 修改 extensions/statusline/src/index.ts:initFooter() 注册 requestRender 入口
  - 修改 extensions/statusline/src/index.ts:buildLines() 聚合外部行
  - 修改 extensions/statusline/src/format.ts:formatSpeedPart/formatCacheRatioPart 去掉 day 标记
  - 修改 extensions/statusline/src/index.ts:buildLine3 order: 2 → 3
  - 新增 extensions/statusline/src/__tests__/footer-handshake-access.test.ts：
    * slot 不存在 → 创建 + 立即建 registry
    * slot 存在但 registry undefined → 创建 registry + flush pending
    * slot 存在且 registry 已就绪 → 返回 === 同一实例（idempotent）
    * version mismatch → warn + 重建
  - 新增 extensions/statusline/src/__tests__/build-lines-aggregation.test.ts：
    * 内部 5 行 + 1 外部行（order=2） → 6 行按 order 排序
    * 外部行 renderer.render 返回 null → 该行被跳过
    * session_tree 后 buildLines 重调 → 仍能读到 registry（owner 持续性）

W2: permission footer-provider 替换 statusline.ts
  - 新增 extensions/permission/src/footer-provider.ts（consumer 端：registerPermissionFooterLine + requestFooterRender）
  - 新增 extensions/permission/src/statusline-palette.ts（从 statusline.ts:173-181 提取 paletteFromTheme）
  - 删除 extensions/permission/src/statusline.ts（226 行）
  - 修改 extensions/permission/src/index.ts：
    * 删除 registerPermissionFooter 调用，替换为 registerPermissionFooterLine
    * mode 切换路径（/permission handler 内）调用 requestFooterRender()
    * 新增 session_tree handler：dispose + re-register renderer（避免旧闭包持有过期 config）
  - 新增 extensions/permission/src/__tests__/footer-provider.test.ts：
    * 模拟 statusline 未启动（slot 不存在）→ push pending
    * 模拟 statusline 已启动（slot.registry 就绪）→ 直接 register
    * 模拟 version mismatch → warn + 建新 slot
    * dispose → unregister + requestRender
    * 多次 register 同 id → 后注册覆盖前注册（幂等性）
  - 已有 statusline.test.ts（如有） → 删除（被 footer-provider.test.ts 替代）

W3: 依赖声明 + README + 集成验证
  - 修改 extension-dependencies.json（permission → statusline optional）
  - 修改 extensions/permission/package.json（peerDependencies + peerDependenciesMeta）
  - 修改 extensions/permission/README.md：
    * 删除"已知限制 > Footer 单例覆盖"章节（已解决）
    * 更新"statusline 集成"章节描述新协议（注册到 statusline footer，不是自己 setFooter）
    * 新增"升级须知：v0.0.1 → v0.1.0 升级后无 statusline 用户将看不到 mode 标签"
  - 修改 extensions/statusline/README.md：新增"Footer Line 注册协议"章节（供其他扩展作者参考；引用本 ADR）
  - pnpm -r typecheck && pnpm -r lint && pnpm -r test
  - 手动验证矩阵（W3 末尾）：
    * 单独安装 permission：确认无报错，footer 无 permission 行
    * 单独安装 statusline：确认 5 行不变
    * 两个都装：确认 6 行显示，permission 行在 line2-line3 之间
    * /permission auto 切换：确认 permission 行内容立即更新（requestFooterRender 生效）
    * session_tree（branch 切换）：确认 permission 行不显示过期数据
```

## Future Work

- **SDK 提案**（用户已确认不做 Pi 修改，但作为演进方向记录）：向 pi-mono 提 issue，建议 `setFooter` 改 push/pop 栈。若 Pi 采纳，本协议可平滑迁移（statusline 不再 setFooter，permission 直接调 Pi 的新 API，footer-handshake 作为兼容层保留）
- **更多 footer 集成方**：ask-user（subagent 模式下显示当前 pending 提问）、scheduler（下次定时任务时间）、pending-notifications（pending 数量）等，都可走同一协议
- **footer line 配置化**：用户可在 `~/.pi/agent/statusline-config.json` 中启用/禁用每条 line（包含 permission 行），类似 providers.json 的 `enabled` 字段
- **mode 切换实时同步**：当前依赖 statusline 30s 兜底定时器（statusline/src/index.ts:62-63 RENDER_INTERVAL_MS）。permission 端在 mode 切换处显式调 `requestFooterRender()` 即可触发 statusline 立即重绘（无需等兜底）

## References

- Pi SDK 源码（`~/Code/git-fork/pi-mono-workspace/main`）：
  - `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1950-1978` — `setExtensionFooter` 单例实现
  - `packages/coding-agent/src/core/extensions/loader.ts:481-527` — `loadExtensionsInternal` 串行加载
  - `packages/coding-agent/src/core/resource-loader.ts:792-805` — `mergePaths` primary/additional 合并
  - `packages/coding-agent/src/core/resource-loader.ts:559-561` — `orderedExtensions` 数组顺序决定 session_start 触发顺序
  - `packages/coding-agent/src/core/extensions/runner.ts:766-798` — `emit` 按 extensions 数组顺序触发 handler
  - `packages/coding-agent/examples/extensions/custom-footer.ts` — `setFooter(undefined)` 还原内置 footer
- 本仓库：
  - `extensions/permission/src/statusline.ts:201-226` — `registerPermissionFooter` 当前实现（待删除）
  - `extensions/permission/src/index.ts:91-95` — `session_start` 注册 footer（待替换）
  - `extensions/permission/README.md:396` — "已知限制 > Footer 单例覆盖"（待删除）
  - `extensions/statusline/src/index.ts:111-136` — `initFooter` 单 setFooter 调用（保留）
  - `extensions/statusline/src/index.ts:409-433` — `buildLines` 当前 5 行渲染（待聚合外部行）
  - `extensions/statusline/src/format.ts:96-116` — `formatSpeedPart`/`formatCacheRatioPart` 待精简
  - `extensions/ask-user/src/channel-registry-register.ts:1-108` — 握手协议参考（consumer 端，pending-flush 模式）
  - `extensions/subagent-workflow/src/execution/channel-registry-access.ts:117-136` — `getOrCreateChannelRegistry()` canonical owner 实现参考
  - `extension-dependencies.json:96` — ask-user → subagent-workflow 握手条目（含 Symbol 字面量 + 加载顺序无关说明）
- 设计参考：用户决策日志 2026-07-29（"不做 Pi 修改 / statusline 整合 footer OK / 插入 line2-line3 之间 / line2 精简 / classifier 原始值"）