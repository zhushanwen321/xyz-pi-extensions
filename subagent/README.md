# subagent — Pi 任务委派与并行执行扩展

支持 single/parallel/chain/background 四种模式，每个 subagent 运行在隔离的 Pi 进程中。

## 功能

- **single**：单个 agent 执行单个任务
- **parallel**：多个 agent 并发执行多个任务
- **chain**：串行执行，前一步输出作为后一步输入
- **background**：非阻塞执行，主 agent 可继续其他工作

## 日志

运行日志写入文件（`~/.pi/agent/logs/subagent-YYYY-MM-DD.log`），不输出到控制台，避免 TUI 干扰。通过环境变量 `PI_LOG_LEVEL`（debug/info/warn/error）控制日志级别，默认 `info`。

## 安装

```bash
# 全局安装
ln -s /path/to/xyz-pi-extensions/subagent ~/.pi/agent/extensions/subagent

# 项目级安装
mkdir -p .pi/extensions
ln -s /path/to/xyz-pi-extensions/subagent .pi/extensions/subagent
```

## 文件结构

```
subagent/
├── index.ts          # 入口，re-export src/index.ts
├── package.json      # name + main
└── src/
    ├── index.ts      # 扩展主逻辑：tool 注册 + 事件监听
    ├── model.ts      # 模型选择逻辑（taskComplexity 路由）
    ├── vision.ts     # 视觉模型配置与选择
    ├── spawn.ts      # 子进程管理
    ├── agents.ts     # Agent 发现
    └── render.ts     # TUI 渲染
```

## License

MIT
