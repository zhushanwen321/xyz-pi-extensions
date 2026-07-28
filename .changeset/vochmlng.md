---
"@zhushanwen/pi-permission": minor
---

@zhushanwen/pi-permission 首个正式发布（0.1.0 为开发期占位版本号，本 changeset 为首个正式发布）。

Pi permission 扩展 — 四档权限模式（yolo/auto/approve/strict）+ 三层安全管道（AST 结构分析 + 规则匹配 + AI Classifier），为 bash 工具调用提供可配置的安全门。

## 核心功能

- **四档权限模式**：yolo（完全放行）/ auto（AST+规则+AI 三层管道）/ approve（规则+人工审批）/ strict（全部审批）
- **三层管道**（auto 模式）：tree-sitter-bash AST 结构分析 → 规则匹配（白名单 + builtin-danger + user rules）→ AI Classifier + 用户审批竞速
- **内置规则**：12 条 builtin-danger 规则 + 24+5 条 Codex 安全命令白名单
- **用户自定义规则**：OpenCode wildcard 语法，last-match-wins 语义（user 可覆盖 builtin）
- **AI Classifier**：LLM 评估未知命令风险（low/medium/high），WT7 偏差补丁（autoApproveLowRisk/autoDenyHighRisk）
- **用户审批 UI**：TUI（自定义 Component）/ RPC（select 对话框）/ headless（fail-closed deny）
- **Reject-with-Reason**：用户拒绝时可输入真实理由（ctx.ui.input 存在时采集，否则 fallback）
- **statusline 集成**：TUI 底部 footer 显示当前权限模式标签
- **fail-closed**：任何异常路径 → block（绝不静默放行）
