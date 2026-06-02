# claude-rules-loader

将 `.claude/rules/*.md` 规则文件加载到 Pi 系统提示中，匹配 Claude Code 的无条件规则加载行为。

## 功能

- 按优先级加载规则：`~/.claude/rules/*.md`（全局）→ `.claude/rules/*.md`（项目，离 CWD 越近优先级越高）
- 自动解析 YAML frontmatter 中的 `paths:` 条件规则（列出但不自动加载）
- 规则排序后以固定位置注入 system prompt，保证 KV cache 稳定

## 安装

```bash
# symlink 方式（开发推荐）
ln -s /path/to/xyz-pi-extensions-workspace/main/packages/claude-rules-loader \
      ~/.pi/agent/extensions/claude-rules-loader

# npm 方式（正式）
pi install npm:@zhushanwen/pi-claude-rules-loader
```

## 使用

安装后自动生效，无需配置。只要项目中存在 `.claude/rules/` 目录，规则就会被加载。

## 文件结构

```
claude-rules-loader/
├── index.ts       # 入口 — 规则发现、排序、system prompt 注入
└── package.json
```
