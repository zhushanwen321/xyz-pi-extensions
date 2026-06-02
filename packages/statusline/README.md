# statusline

Pi 自定义状态栏 — 显示上下文用量、Token 速度、Provider 套餐额度。

## 功能

- **Line 1**：目录/仓库名 · 分支 │ session-name │ provider : model [thinking level]
- **Line 2**：上下文用量 │ Token 速度（当前 + 日累计）│ 搜索配额
- **Line 3-5**：套餐用量（Z.ai-pro / opencode-go / kimi-coding 等），进度条可视化
- **Line 6**：时间 · 费用 · session ID

## 安装

```bash
# symlink 方式（开发推荐）
ln -s /path/to/xyz-pi-extensions-workspace/main/packages/statusline \
      ~/.pi/agent/extensions/statusline

# npm 方式（正式）
pi install npm:@zhushanwen/pi-statusline
```

## 使用

安装后自动生效，Pi 底部状态栏自动显示信息。

## 支持的 Provider

| Provider | 额度类型 |
|----------|---------|
| Z.ai-pro (智谱) | 5h 重置周期 |
| opencode-go (Go API) | 周期/周/月额度 |
| kimi-coding (Kimi) | 周期额度 |
| minimax | 周期额度 |
| tavily | 搜索次数 |

## 文件结构

```
statusline/
├── index.ts
└── src/
    ├── index.ts          # 入口 — Footer 渲染
    ├── cache.ts          # 数据缓存 + Token 速度追踪
    └── providers/
        ├── index.ts      # Provider 注册
        ├── types.ts      # 额度类型定义
        ├── zhipu.ts      # 智谱
        ├── opencode-go.ts# Go API
        ├── kimi-coding.ts# Kimi
        ├── minimax.ts    # MiniMax
        └── tavily.ts     # 搜索
```
