# context-engineering

渐进式上下文压缩 — L0 零成本清理、L1 规则化浓缩、L2 紧急截断，附带 recall 召回机制。

## 功能

- **L0（零成本清理）**：移除过期条目、截断冗长输出、清除 thinking block
- **L1（规则化浓缩）**：基于规则的上下文压缩，保留关键信息
- **L2（紧急截断）**：上下文窗口即将耗尽时的紧急保护
- **Recall 召回**：被压缩的内容可通过 `recall_context` 工具按 ID 取回
- **统计命令**：`/context-stats` 查看压缩统计

## 安装

```bash
# symlink 方式（开发推荐）
ln -s /path/to/xyz-pi-extensions-workspace/main/packages/context-engineering \
      ~/.pi/agent/extensions/context-engineering

# npm 方式（正式）
pi install npm:@zhushanwen/pi-context-engineering
```

## 使用

安装后自动生效，在 `context` 事件中执行压缩。

| 命令 | 说明 |
|------|------|
| `/context-engineering` | 手动触发压缩 |
| `/context-stats` | 查看压缩统计 |

LLM 可调用 `recall_context` 工具按 ID 取回被压缩的内容。

## 文件结构

```
context-engineering/
├── index.ts
└── src/
    ├── index.ts          # 入口 — 事件注册、工具注册
    ├── compressor.ts     # L0/L1/L2 压缩引擎
    ├── config.ts         # 配置加载
    ├── frozen-fresh.ts   # 冻结/新鲜状态管理
    ├── recall-store.ts   # 召回存储
    └── commands.ts       # 命令处理
```
