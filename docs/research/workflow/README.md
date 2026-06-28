# Claude Code Dynamic Workflows 调研

调研目标:理解 Claude Code 在 2026-05-28 发布的 **Dynamic Workflows** 功能,然后对比 `~/Code/xyz-pi-extensions-workspace/main/extensions/workflow/`(项目内叫 `@zhushanwen/pi-workflow`,是 Pi 平台上的通用多 Agent 编排引擎)与其在功能、设计、能力上的差异。

## 文档结构

| 文件 | 内容 |
|------|------|
| `01-官方资料与背景.md` | 官方博客 + 官方文档要点,以及与早期 v2.1.147 "未发布"版本的关系 |
| `02-Claude-Code逆向拆解.md` | 用例、核心领域设计、整体架构、领域模型 |
| `03-Pi-Workflow逆向拆解.md` | 对 pi-extensions workflow 的同样维度拆解 |
| `04-功能差异对比.md` | 横向对比、能力差异、互不可替代的部分 |
| `05-结论与建议.md` | 给 pi-workflow 的演进建议 |

## 时间线

- **2026-05-21 / 22**:Claude Code v2.1.147 / v2.1.148 内置 "Workflow Tool",**默认关闭**,需 `CLAUDE_CODE_WORKFLOWS=1` 启用。Anthropic 在 Changelog 中**删除了相关条目**。社区通过逆向 CHANGELOG、二进制代码定位到功能(详见 `chat_project/workflow/Claude-Code-Workflow-调研报告.md`)。
- **2026-05-28**:Anthropic 正式官宣,命名为 **"Dynamic Workflows"**,作为 **research preview** 发布。配套官方文档 `code.claude.com/docs/en/workflows` 上线。
- **2026-06-02**:Reddit r/ClaudeAI 由 `ClaudeOfficial` 账号发布,Hacker News、InfoQ、Ken Huang 等同步报道。
- **本次调研时间**:2026-06-03。

## 关键来源

- [Introducing dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code) — 官方博客
- [Orchestrate subagents at scale with dynamic workflows](https://code.claude.com/docs/en/workflows) — 官方文档
- `~/Code/chat_project/workflow/Claude-Code-Workflow-调研报告.md` — monorepo 外的早期逆向调研(v2.1.147)
- `~/Code/xyz-pi-extensions-workspace/main/extensions/workflow/` — pi-workflow 源码
