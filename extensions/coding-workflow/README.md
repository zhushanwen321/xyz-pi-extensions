# coding-workflow

5 阶段编码工作流编排（spec → plan → dev → test → pr），自动门控检查 + review + retrospect + compact。

## 功能

- **5 阶段流水线**：每阶段 AI 只能看到当前阶段内容，阶段间自动门控检查
- **自动 review**：阶段完成后自动派遣 review subagent
- **Retrospect**：每个 phase gate 通过后自动生成回顾记录
- **Compact**：阶段切换时自动压缩上下文
- **配套 skills**：内置 xyz-harness 全套技能（brainstorming、writing-plans、phase-dev 等）
- **配套 agents**：内置 7 个 review agent（架构、BLR、数据流、集成、健壮性、规范、品味）

## 安装

```bash
# symlink 方式（开发推荐）
ln -s /path/to/xyz-pi-extensions-workspace/main/packages/coding-workflow \
      ~/.pi/agent/extensions/coding-workflow

# npm 方式（正式）
pi install npm:@zhushanwen/pi-coding-workflow
```

## 使用

通过 `coding-workflow-gate` 和 `coding-workflow-phase-start` 工具由 AI 自动调度，或手动使用命令：

| 命令 | 说明 |
|------|------|
| `/coding-workflow` | 启动工作流 |
| `/coding-workflow-status` | 查看当前状态 |
| `/coding-workflow-abort` | 中止工作流 |

## 文件结构

```
coding-workflow/
├── index.ts           # 入口 — 工具、命令、事件注册
├── lib/
│   ├── gate-runner.ts      # 门控脚本执行
│   ├── model.ts            # 阶段模型定义
│   ├── process-manager.ts  # 子进程管理
│   ├── review-dispatcher.ts# Review subagent 调度
│   ├── skill-resolver.ts   # Skill 发现
│   └── subagent.ts         # Subagent 工具封装
├── scripts/
│   └── gate-check.py       # 门控检查 Python 脚本
├── skills/             # xyz-harness 全套 skills
├── agents/             # 7 个 review agent
└── commands/           # 命令模板
```
