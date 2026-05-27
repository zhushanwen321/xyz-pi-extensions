# usage-tracker — Pi 使用信号采集扩展

被动采集 skill/agent 使用计数 + evolution 信号（工具执行、token 消耗、session 元信息）。无需用户操作，自动在后台运行。

## 功能

- **Skill 使用追踪**：检测 SKILL.md 被读取（`read` tool），递增对应 skill 计数
- **Agent 使用追踪**：检测 `subagent` tool 调用，提取 agent 名称并递增计数
- **工具执行统计**：记录每个 tool 的调用次数和失败次数
- **Token 使用统计**：每轮 assistant 消息的 input/output token 数
- **Session 元信息**：记录 session 启动/关闭、turn 数、总 token 数

## 数据存储

| 文件 | 说明 |
|------|------|
| `~/.pi/agent/usage-stats.json` | Skill/agent 累计使用次数（向后兼容） |
| `~/.pi/agent/evolution-data/daily/YYYY-MM-DD.json` | 每日汇总（工具统计、token 使用、skill/agent 触发） |
| `~/.pi/agent/evolution-data/tool-stats.json` | 工具执行累积统计 |
| `~/.pi/agent/evolution-data/skill-triggers.json` | Skill 触发累积统计 |
| `~/.pi/agent/evolution-data/session-manifest.json` | Session 清单 |
| `~/.pi/agent/logs/usage-tracker-YYYY-MM-DD.log` | 运行日志 |

## 日志

运行日志写入文件（`~/.pi/agent/logs/usage-tracker-YYYY-MM-DD.log`），不输出到控制台，避免 TUI 干扰。通过环境变量 `PI_LOG_LEVEL`（debug/info/warn/error）控制日志级别，默认 `info`。

## 安装

```bash
# 全局安装
ln -s /path/to/xyz-pi-extensions/usage-tracker ~/.pi/agent/extensions/usage-tracker

# 项目级安装
mkdir -p .pi/extensions
ln -s /path/to/xyz-pi-extensions/usage-tracker .pi/extensions/usage-tracker
```

## 文件结构

```
usage-tracker/
├── index.ts          # 入口，re-export src/index.ts
├── package.json      # name + main
└── src/
    ├── index.ts      # 扩展主逻辑：事件监听 + 数据采集
    ├── storage.ts    # Evolution data 持久化
    └── types.ts      # 数据类型定义
```

## License

MIT
