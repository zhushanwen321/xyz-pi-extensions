# /goal — Pi 目标驱动模式

Codex 风格的 `/goal` 命令，让 Pi 进入自主循环，持续工作直到目标达成。支持任务追踪、证据验证、Token/时间预算、阻塞检测。

## 安装

```bash
# 全局安装（所有项目生效）
git clone https://github.com/zhushanwen321/xyz-pi-extensions.git
ln -s $(pwd)/xyz-pi-extensions/goal ~/.pi/agent/extensions/goal

# 项目级安装
mkdir -p .pi/extensions
ln -s /path/to/xyz-pi-extensions/goal .pi/extensions/goal
```

安装后重启 Pi session 生效。

## 快速开始

```
/goal 修复项目中所有失败的测试
/goal 实现用户认证功能 --tokens 500000 --timeout 30
```

Pi 会自动：拆分任务 → 逐个执行 → 收集证据 → 完成目标。

## 命令参考

| 命令 | 说明 |
|------|------|
| `/goal <目标>` | 设定新目标（会替换当前未完成的目标） |
| `/goal status` | 查看当前目标状态、进度、预算 |
| `/goal pause` | 暂停目标 |
| `/goal resume` | 恢复暂停/阻塞的目标 |
| `/goal clear` | 清除目标 |
| `/goal update <新目标>` | 更新目标描述（清除旧任务，重新规划） |

## 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--tokens N` | 不限制 | Token 预算上限 |
| `--timeout N` | 不限制 | 时间预算（分钟） |
| `--max-turns N` | 50 | 最大轮次 |
| `--max-stall N` | 5 | 连续无进展轮次，超过后自动阻塞 |

示例：

```
/goal 重构 auth 模块 --tokens 200000 --timeout 15 --max-turns 30
/goal 写单元测试 --tokens 100000 --max-stall 3
```

## 工作流程

```
用户: /goal 修复登录bug
  │
  ▼
Pi 注入上下文 → LLM 拆分任务 (create_tasks)
  │
  ▼
┌─────────────────────────────┐
│  每个 turn:                  │
│  1. LLM 执行任务             │
│  2. 完成后调用 complete_task │
│     (必须提供具体证据)        │
│  3. 检查预算/进展/阻塞        │
│  4. 注入 continuation 继续   │
└─────────┬───────────────────┘
          │ 全部完成
          ▼
LLM 调用 complete_goal (提供整体证据)
```

## 目标状态

```
         ┌──────────┐
    ┌───►│  active  │◄─── resume
    │    └────┬─────┘
    │         │
  clear    ┌──┴──┬──────────┬───────────┬──────────┐
    │      ▼     ▼          ▼           ▼          ▼
    │  paused  blocked  complete  budget_limited time_limited
    │    ▲     ▲
    │    │     │
    └────┴─────┘ (resume 恢复)

可恢复: paused, blocked → active
终态: complete, budget_limited, time_limited, cancelled
```

## 内置保护机制

| 机制 | 说明 |
|------|------|
| 证据验证 | `complete_task` / `complete_goal` 必须提供具体证据，不能空口完成 |
| 预算预警 | Token/时间达 70% 提示注意，90% 注入收尾 steering |
| 预算终止 | Token 100% → budget_limited 终态 |
| 阻塞检测 | 连续 N 轮无进展 → blocked，需用户手动 resume |
| 去抖保护 | 本轮 token 消耗为 0 时不发 continuation，防止无限循环 |
| 防重入 | `before_agent_start` 注入的上下文不会在 `agent_end` 重复发送 |
| Resume 预算重检 | 恢复暂停目标时，如果预算已耗尽，直接拒绝 |
| 零预算拒绝 | `--tokens 0` 会被拒绝 |
| 空白目标拒绝 | `/goal ""` 或 `/goal "   "` 会被拒绝 |
| 目标长度限制 | 超过 4000 字符会被拒绝 |
| 上下文空间保护 | 上下文窗口 >85% 时暂停，防止 OOM |

## goal_manager 工具

Pi 注册了 `goal_manager` 工具供 LLM 调用，用户不需要直接操作：

| Action | 说明 |
|--------|------|
| `create_tasks` | 拆分目标为任务清单 |
| `complete_task` | 标记任务完成（需 taskId + evidence） |
| `list_tasks` | 查看任务进度和剩余预算 |
| `complete_goal` | 标记目标完成（需 evidence，且所有任务已完成） |
| `cancel_goal` | 取消目标（用户要求退出/停止时，LLM 直接调用，一步退出） |
| `report_blocked` | 报告阻塞原因 |

每个工具响应都包含当前预算信息（已用/剩余），让 LLM 自我调节。

## 注意事项

- 目标描述会被 XML 转义，防止 prompt 注入
- `/goal update` 会清除已有任务和计数器，允许重新规划
- 已暂停的目标 resume 时会重新检查预算，超限则直接终止
- 状态通过 session entries 持久化，session 重启后自动恢复
- Token 统计排除 cached input，避免跨 turn 双重计算
- **退出方式有三种**：`/goal clear`（用户手动）、`/goal pause`（暂停稍后继续）、或直接告诉 LLM「停止/取消/退出」，LLM 会调用 `cancel_goal` 一步退出

## 文件结构

```
goal/
├── index.ts          # 入口 — 命令、事件、工具注册
├── src/
│   ├── index.ts      # Extension 主逻辑
│   ├── state.ts      # 状态机、类型、序列化
│   ├── commands.ts   # 命令参数解析
│   ├── templates.ts  # Steering prompt 模板
│   └── widget.ts     # TUI 状态栏渲染
└── package.json      # 元数据（仅标识用）
```

## License

MIT
