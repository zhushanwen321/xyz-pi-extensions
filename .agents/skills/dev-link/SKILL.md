---
name: dev-link
description: >-
  Use when developing Pi extensions locally. Switches between npm-installed
  and local symlink mode for @zhushanwen/pi-* packages. Triggers: "link local",
  "dev link", "switch to local", "symlink extension", "unlink extension",
  "restore npm". Not for installing new packages or managing non-pi extensions.
---

# Dev Link

在 npm 安装和本地 symlink 之间切换 Pi 扩展，用于开发调试。

## When to Use

- 用户说"symlink 到本地"、"链接本地开发"、"切换到本地"
- 用户说"恢复 npm"、"用 npm 版本"
- 开发 xyz-pi-extensions 项目中的 `@zhushanwen/pi-*` 包时

## Core Pattern

```bash
# 脚本位置（resolve against skill directory）
./dev-link.sh <package>          # npm → 本地 symlink
./dev-link.sh <package> --npm    # 本地 symlink → npm
./dev-link.sh --list             # 查看所有包状态
```

`<package>` 支持三种格式：
- 短名：`model-switch`
- pi-前缀：`pi-model-switch`
- npm 全名：`@zhushanwen/pi-model-switch`

## 操作详情

### 切换到本地（默认）

1. 从 `~/.pi/agent/settings.json` 的 `packages` 数组移除 `npm:@zhushanwen/pi-xxx`
2. 创建 `~/.pi/agent/extensions/xxx` → `$(pwd)/packages/xxx` symlink
3. 删除 npm 缓存 `node_modules/@zhushanwen/pi-xxx`

### 恢复 npm（`--npm`）

1. 向 `settings.json` 的 `packages` 添加 `npm:@zhushanwen/pi-xxx`
2. 删除 symlink
3. 删除 npm 缓存（Pi 启动时自动重装）

**两种模式都需要重启 Pi 生效。**

## Common Mistakes

| 错误 | 原因 |
|------|------|
| Tool conflict 报错 | npm 和本地 symlink 同时注册同名 tool。确保只用一种模式 |
| quota-providers 不应 symlink | 它是库包不是扩展，不需要放 extensions 目录 |
| worktree 切换后 symlink 指向旧目录 | 脚本用 `$(pwd)` 定位，确保在正确 worktree 根目录执行 |
