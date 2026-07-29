# statusline

Pi 自定义状态栏 — 显示上下文用量、Token 流量、Provider 套餐额度、搜索工具额度。

## 状态栏布局

```
Line 1: 父目录/子目录 · ⎇ branch │ worktree
Line 2: provider/model [thinking level]
Line 3: ctx 45.2K/200K 23% │ from 13:25 · run 34m40s · last 12s │ ↑↓ 128.3k/8.5k │ 253b75.jsonl
Line 4: tavily 234/1000次 23% | anysearch 250/500次 50%
Line 5+: zhipu-coding-plan   5h  23%  4h11m  · wk   ∞  · mh   ∞
        opencode-go         5h  45%  2h35m  · wk  12%  3d2h  · mh  78%  4d5h
        kimi-coding-plan    5h  32%  1h42m  · wk  45%  2d8h  · mh   ∞
        minimax-token-plan  5h  10%  4h55m  · wk   8%  5d1h  · mh  15%  12d
```

| 行 | 内容 | 说明 |
|---|------|------|
| 1 | 目录 + 分支 + worktree | 仓库路径显示倒数两级；worktree 文字标识 |
| 2 | `provider/model [thinking]` | 完整 provider/model；thinking level 灰显 |
| 3 | 上下文 + 时间 + 流量 + 会话 ID | `ctx` 百分比按区间配色（绿/黄/红）；`from` 启动时刻；`run` 运行时长；`last` 距上次 LLM 响应；`↑↓` 累计 input/output token；最后是 session 文件后缀 |
| 4 | 搜索工具额度 | 多个工具用 ` \| ` 分隔；格式 `{label} {used}/{total}次 {pct}%` |
| 5+ | token-plans 套餐 | 3 列：5h / wk / mh；去进度条纯文本；`∞` 表示无限；reset 时间右对齐 |

## 安装

```bash
# npm 方式（唯一正式方式）
pi install npm:@zhushanwen/pi-statusline

# 本地开发（symlink）
ln -s /path/to/xyz-pi-extensions-workspace/main/extensions/statusline \
      ~/.pi/agent/extensions/statusline
```

## 配置

扩展通过**声明式 JSON 配置**管理 provider 和凭证。首次使用需要运行：

```bash
/setup-statusline
```

命令行为：
- 配置文件都存在 → 加载并打印审查摘要
- 缺失 → 注入 LLM prompt，让 LLM 生成 demo 文件
  - `providers.json` 默认启用所有内置 provider（用户后续可禁用）
  - `secrets.json` 默认所有凭证用 `${ENV_VAR}` 引用（不写明文）
  - 支持中英文（基于 `Intl.DateTimeFormat().resolvedOptions().locale`）

### 配置文件位置

| 文件 | 路径 | 作用 |
|------|------|------|
| providers.json | `~/.pi/agent/config/providers.json` | provider 声明 |
| secrets.json | `~/.pi/agent/config/secrets.json` | 凭证（明文或 env 引用） |

路径通过 `getAgentDir()` 派生，**不写绝对路径**。

### providers.json schema

```json
{
  "token-plans": [
    {
      "id": "zhipu",
      "label": "zhipu-coding-plan",
      "enabled": true,
      "fetcher": "zhipu"
    }
  ],
  "search-tools": [
    {
      "id": "tavily",
      "label": "tavily",
      "enabled": true,
      "fetcher": "tavily"
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✓ | 在 cache 中的 key |
| `label` | ✓ | 状态栏显示名 |
| `enabled` | ✓ | `false` 跳过该 provider（保留配置便于回滚） |
| `fetcher` | ✓ | 内置 fetcher ID（见下方支持列表） |

### secrets.json schema

```json
{
  "zhipu": {
    "token": "${ZAI_AUTH_TOKEN}"
  },
  "tavily": {
    "apiKey": "tvly-plain-text-token-here"
  }
}
```

- 每个 provider 是一个 section
- value 字符串匹配 `^\$\{[A-Z_][A-Z0-9_]*\}$` → 当作环境变量引用，从 `process.env` 取
- 环境变量不存在 → 静默返回空串（该 provider 拉不到数据）
- 其它值 → 原样使用

## 内置 Provider

| fetcher | 类别 | 周期 | 说明 |
|---------|------|------|------|
| `zhipu` | token-plan | 5h | 智谱 GLM Coding |
| `opencode-go` | token-plan | 5h/wk/mh | Go API |
| `kimi-coding` | token-plan | 5h/wk/mh | Kimi |
| `minimax` | token-plan | 5h/wk/mh | MiniMax |
| `tavily` | search-tool | 次数 | 搜索 API |

- **token-plan**：按 3 窗口（5h / wk / mh）显示用量 + reset 时间
- **search-tool**：按 `used/total次` 显示搜索配额，多个工具用 `|` 分隔

## 添加新 Provider

三步走，**statusline 代码零修改**：

### 1. 实现 fetcher

在 `shared/quota-providers/src/providers/xxx.ts`：

```typescript
import type { QuotaProvider, NormalizedQuotaRow } from "./types.js";
import { INFINITE_WIN } from "./types.js";

export interface XxxData {
	// 你的原始数据结构
	pct: number;
	resetSec: number;
}

async function fetchXxx(): Promise<XxxData | null> {
	// 从 API 拉数据；失败/无凭证返回 null
	return null;
}

export const xxxProvider: QuotaProvider<XxxData> = {
	id: "xxx",
	label: "xxx-plan",
	category: "token-plan",  // 或 "search-tool"
	fetch: fetchXxx,
	normalize(raw): NormalizedQuotaRow | null {
		return {
			label: "xxx-plan",
			wins: [
				{ pct: raw.pct, resetSec: raw.resetSec },
				INFINITE_WIN,
				INFINITE_WIN,
			],
		};
	},
};
```

### 2. 在 registry.ts 注册

`shared/quota-providers/src/registry.ts` 的 `FETCHERS` 和 `NORMALIZERS` 表加一行：

```typescript
const FETCHERS: Record<string, Fetcher> = {
	// ...
	"xxx": xxxProvider.fetch as Fetcher,
};

const NORMALIZERS: Record<string, Normalize> = {
	// ...
	"xxx": xxxProvider.normalize as Normalize,
};
```

### 3. 用户在 providers.json 启用

```json
{
  "token-plans": [
    { "id": "xxx", "label": "xxx-plan", "enabled": true, "fetcher": "xxx" }
  ]
}
```

完事。状态栏下次渲染自动出现新行。

## 文件结构

```
statusline/
├── index.ts
└── src/
    ├── index.ts            # 入口 — Footer 渲染 + 状态机
    ├── setup.ts            # /setup-statusline 命令
    └── setup-prompts.ts    # i18n prompt 模板

shared/quota-providers/    # workspace 共享包
├── index.ts
└── src/
    ├── cache.ts            # TTL 缓存 + Token 速度追踪
    ├── config.ts           # providers.json 加载器
    ├── secrets.ts          # secrets.json 加载器
    ├── paths.ts            # 路径工具（getAgentDir）
    ├── registry.ts         # 运行时 provider 构建
    └── providers/
        ├── index.ts        # Provider 注册表
        ├── types.ts        # QuotaProvider 接口
        ├── zhipu.ts
        ├── opencode-go.ts
        ├── kimi-coding.ts
        ├── minimax.ts
        └── tavily.ts
```

## Footer Line 注册协议

statusline 是 footer 的 **canonical owner**。其他扩展可以通过 **globalThis Symbol 握手协议** 注册自己的 footer 行，避免 `ctx.ui.setFooter` 单例冲突（Pi 只有一个 footer 槽位，多扩展各自 setFooter 会互相覆盖）。

> 供其他扩展作者参考。参考实现见 [ADR-036](../../docs/adr/036-statusline-footer-aggregation.md) 与 `@zhushanwen/pi-permission` 的 `extensions/permission/src/footer-provider.ts`。

### 协议

- `FOOTER_HANDSHAKE_KEY = Symbol.for('@zhushanwen/pi-statusline.footerHandshake')`
- `REQUEST_RENDER_KEY = Symbol.for('@zhushanwen/pi-statusline.requestRender')`
- slot shape：`{version: 1, registry?: FooterLineRegistry, pending: PendingEntry[]}`
- **statusline 是 canonical owner**：唯一创建 registry（`getOrCreateFooterRegistry`），并向 `slot.registry` 写入实例。
- **consumer 永不创建 registry**：只通过 handshake key 读写 slot。registry 未就绪时 consumer 把 line entry push 到 `slot.pending`，等 statusline 后到时 flush（pending-flush 模式，沿用 ask-user #M4 修复）。
- renderer 带数字 `order`，`buildLines` 按 order 升序聚合 statusline 自身行 + 所有外部注册行。
- **加载顺序无关**：statusline 先到则直接注册；consumer 先到则入 pending 队列由 statusline flush。

### consumer 用法

consumer 端用**纯 globalThis 反射**（不静态 import statusline），定义本地等价的 `FooterLineRenderer` / `FooterLineRegistry` interface（结构匹配即可，TS 结构类型天然兼容）。这样 statusline 作为可选 `peerDep` 未安装时，静态 import 不会破坏 consumer —— 只是在反射时拿不到 registry，silent 降级。

```
session_start → 读 globalThis[FOOTER_HANDSHAKE_KEY]
  ├─ slot 已存在 & registry 就绪 → 直接 registry.register(...)
  └─ 否则 → push 到 slot.pending（statusline 后到时 flush）
```

详见 [ADR-036](../../docs/adr/036-statusline-footer-aggregation.md) 和 `@zhushanwen/pi-permission` 的 `extensions/permission/src/footer-provider.ts` 作为参考实现。

### 时序注意：首帧前 `requestFooterRender()` 为 noop

`getOrCreateFooterRegistry()`（line 注册入口）在 statusline 的 `session_start` handler 内同步执行并 flush pending，但 `requestFooterRender()`（重绘触发）依赖的 `REQUEST_RENDER_KEY` 句柄要等到 **footer factory 回调**（Pi 实际创建 TUI 时）内才通过 `registerRequestRender()` 挂到 `globalThis`，晚于 `session_start`。

因此存在一个窗口：**`session_start` 之后、footer factory 回调之前**，此间 consumer（如 permission）调 `requestFooterRender()` 会是 noop（`REQUEST_RENDER_KEY` 尚未就绪）。

- 实际影响轻微：statusline 有 `RENDER_INTERVAL_MS`（30s）兜底定时器，`onBranchChange` 也会触发重绘，所以 renderer 注册的内容不会永远丢失——只是 mode 切换后「立即重绘」的承诺在此窗口内不成立。
- 如果 consumer 需要在窗口内保证可见，可依赖兜底定时器，或在自身下次生命周期事件里再次调用 `requestFooterRender()`。

此为已知设计取舍（review #7），非 bug；无需强制修复。

## 性能 / 缓存

- provider 数据通过 `cache.ts` 缓存，TTL 5 分钟
- `triggerUpdate()` 在 `session_start` / `message_end` 触发，但实际请求受 TTL/2 节流
- `fetch` 失败 / 无凭证 → 保留旧值（Promise.allSettled 模式）
- Token 速度按模型分别存到 `~/.pi/agent/token-stats/<model>.json`，30 天滚动窗口

## 调试

- `npx tsc --noEmit` — 类型检查
- 修改 `providers.json` 后无需重启，下次 render 自动 reload
- provider 加载失败会在 console.warn（`unknown fetcher: xxx`）
