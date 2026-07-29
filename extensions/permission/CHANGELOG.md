# @zhushanwen/pi-permission

## 0.1.0 (unreleased)

### Breaking Changes

- **白名单扩张**：内置安全白名单从 24+5 扩至 50+9（新增 diff/jq/ps/du/file/sort/iconv 等）。auto/approve 模式下，这些命令从「需审批/AI 判」变为「静默放行」。已有用户若依赖这些命令触发审批，需自行添加 user rule。
- **approval 键位**：TUI 审批对话框移除 y/n 快捷键，仅保留 Enter（approve）/ Esc（deny）。
- **classifier prompt 改写**：auto 模式 AI 判定标准变化——写项目/cwd 目录的操作倾向 allow，写系统目录（~/.ssh、/etc）倾向 ask。

### Features

- 四档权限模式（yolo/auto/approve/strict）
- 三层管道（AST + 规则 + AI Classifier）
- rule editor（/permission rule overlay CRUD）
- model picker（/permission model）
- statusline footer 集成
