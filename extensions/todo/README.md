# todo

轻量级 AI 任务清单 — 三态（pending / in_progress / completed），支持 session 持久化、状态栏、批量操作。

## 功能

- **三态任务**：`pending` → `in_progress` → `completed`
- **批量操作**：add / update / delete / clear
- **Session 持久化**：任务状态保存在 session entries 中，重启后恢复
- **状态栏**：底部显示任务进度（如 `2/5 done`）
- **自动清理**：所有任务完成后自动清空

## 安装

```bash
# symlink 方式（开发推荐）
ln -s /path/to/xyz-pi-extensions-workspace/main/packages/todo \
      ~/.pi/agent/extensions/todo

# npm 方式（正式）
pi install npm:@zhushanwen/pi-todo
```

## 使用

AI 可调用 `todo` 工具：

| Action | 说明 |
|--------|------|
| `list` | 查看所有 todo |
| `add` | 批量添加 todo |
| `update` | 更新 todo（状态/文本） |
| `delete` | 批量删除 |
| `clear` | 清空所有 |

用户命令：`/todos` 交互式面板。

## 文件结构

```
todo/
├── index.ts
└── src/
    └── index.ts    # 入口 — 工具、命令、事件、状态栏
```
