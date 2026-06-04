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

## 两个脚本

```bash
# 脚本位置（resolve against skill directory）
./link-local.sh <package>   # npm → 本地 symlink（卸载 npm + 创建 symlink + 注册 settings.json）
./link-npm.sh <package>     # 本地 symlink → npm（删除 symlink + 安装 npm 包）
```

`<package>` 支持三种格式：
- 短名：`model-switch`
- pi-前缀：`pi-model-switch`
- npm 全名：`@zhushanwen/pi-model-switch`

## 行为说明

### link-local.sh — 切换到本地开发

1. 卸载 npm 版本（如果已安装，容错处理）
2. 清理 `~/.pi/agent/extensions/<short>`（仅删 symlink；普通目录报错退出，防止误删）
3. 创建 symlink：`~/.pi/agent/extensions/<short>` → `$(pwd)/extensions/<short>`
4. 用 `pi install` 注册本地路径到 `settings.json`
5. **幂等**：已是本地 symlink 且注册正确时直接跳过

### link-npm.sh — 恢复 npm 版本

1. 清理 `~/.pi/agent/extensions/<short>` symlink（只删 symlink，不删普通目录）
2. 清理 `settings.json` 中残留的 `extensions/<short>` 条目
3. 用 `pi install npm:@zhushanwen/pi-<short>` 安装 npm 包
4. **幂等**：npm 包已安装且无 symlink 且无残留条目时直接跳过

**两种模式都需要重启 Pi 生效。**

## 常见错误

| 错误 | 原因 |
|------|------|
| Tool conflict 报错 | npm 和本地 symlink 同时注册同名 tool。确保只用一种模式 |
| quota-providers 不应 symlink | 它是库包不是扩展，不需要放 extensions 目录 |
| worktree 切换后 symlink 指向旧目录 | 脚本用 `$(pwd)` 定位，确保在正确 worktree 根目录执行 |
| 运行后 Pi 重启仍看不到扩展 | 确认 `settings.json` 的 `packages` 中有 `"extensions/<short>"`（link-local.sh 会自动处理） |
