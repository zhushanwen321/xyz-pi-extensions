# skill-state

自动 skill 执行追踪器 — 状态机驱动的 skill 生命周期管理。

## 功能

- **自动检测**：监听 `tool_call` 事件，自动检测 skill 加载
- **状态流转**：`loaded` → `in_progress` → `completed` / `error` → `recorded`
- **异常累积**：skill 异常累积 2 次后自动触发问题记录
- **定期提醒**：每 10 轮提醒 AI 更新未完成的 skill 状态

## 安装

```bash
# symlink 方式（开发推荐）
ln -s /path/to/xyz-pi-extensions-workspace/main/packages/skill-state \
      ~/.pi/agent/extensions/skill-state

# npm 方式（正式）
pi install npm:@zhushanwen/pi-skill-state
```

## 使用

安装后自动生效，无需手动操作。AI 可调用 `skill_state` 工具：

| Action | 说明 |
|--------|------|
| `list` | 查看所有 TrackedItem |
| `update` | 更新 TrackedItem 状态（completed / error / recorded） |

## 文件结构

```
skill-state/
├── index.ts
└── src/
    ├── index.ts      # 入口 — 事件监听、工具注册
    ├── state.ts      # 状态机、类型、序列化
    └── templates.ts  # Steering prompt 模板
```
