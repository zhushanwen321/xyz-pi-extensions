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

## 性能 / 缓存

- provider 数据通过 `cache.ts` 缓存，TTL 5 分钟
- `triggerUpdate()` 在 `session_start` / `message_end` 触发，但实际请求受 TTL/2 节流
- `fetch` 失败 / 无凭证 → 保留旧值（Promise.allSettled 模式）
- Token 速度按模型分别存到 `~/.pi/agent/token-stats/<model>.json`，30 天滚动窗口

## 调试

- `npx tsc --noEmit` — 类型检查
- 修改 `providers.json` 后无需重启，下次 render 自动 reload
- provider 加载失败会在 console.warn（`unknown fetcher: xxx`）
