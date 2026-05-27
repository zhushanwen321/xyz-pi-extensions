# todo — Pi 轻量任务清单扩展

三态任务清单（pending/in_progress/completed），`/todos` 命令 + `todo` tool。

## 功能

- `/todos` 命令：交互式查看和管理任务清单
- `todo` tool：供 LLM 调用的任务管理工具（add/update/delete/list/clear）

## 安装

```bash
# 全局安装
ln -s /path/to/xyz-pi-extensions/todo ~/.pi/agent/extensions/todo

# 项目级安装
mkdir -p .pi/extensions
ln -s /path/to/xyz-pi-extensions/todo .pi/extensions/todo
```

## 文件结构

```
todo/
├── index.ts          # 入口，re-export src/index.ts
├── package.json      # name + main
└── src/
    └── index.ts      # 扩展主逻辑：命令 + tool + 事件
```

## License

MIT
