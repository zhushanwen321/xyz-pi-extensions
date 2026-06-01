# pi-ask-user — 直接安装分析

## 基本信息

| 维度 | 信息 |
|------|------|
| 原始仓库 | [edlsh/pi-ask-user](https://github.com/edlsh/pi-ask-user) |
| npm 包 | `pi-ask-user` (0.11.1) |
| 安装方式 | direct-install |
| 安装日期 | 2026-06-01 |
| 类型 | Pi 扩展（extension） |

## 选择直接安装的理由

1. **功能最完备**：在 7+ 个同类 Pi 扩展中功能最全，是唯一的"全功能"实现
2. **解决真实痛点**：LLM 在遇到歧义时猜测而非提问，导致错误决策。结构化问答让模型主动向用户确认
3. **独立性强**：不与 goal/todo/subagent/context-engineering 等扩展冲突
4. **headless fallback**：RPC 模式下自动降级到 `ctx.ui.select()` / `ctx.ui.input()`，兼容 xyz-agent GUI
5. **活跃维护**：npm 持续更新，社区有 46.7K/mo 下载量（rpiv 套件内）

## 核心功能

| 功能 | 说明 |
|------|------|
| 单选列表 | 上下选择 + Enter 确认 |
| 多选（checkbox） | Space toggle + Enter 提交 |
| 自由文本 | Editor 内联编辑 |
| Split-pane 预览 | 终端宽度 ≥ 84 时，左侧选项 + 右侧 Markdown 详情 |
| Fuzzy search | 输入即过滤选项 |
| Comment mode | 选择后可写附加评论 |
| Overlay/Inline 双模式 | overlay 弹窗可隐藏/显示，inline 内联渲染 |
| Timeout | 自动超时取消 |
| Headless fallback | 无 UI 时降级到 `ctx.ui.select()` / `ctx.ui.input()` |
| 事件系统 | `ask:answered` / `ask:cancelled` 事件，可供其他扩展监听 |

## 技术实现要点

- 注册 `ask_user` 工具，含 `promptSnippet` / `promptGuidelines` 引导模型使用
- `ctx.ui.custom<T>()` 构建交互式 TUI 组件
- overlay 模式通过 `ctx.ui.onTerminalInput()` 注册全局按键监听
- 附带 `ask-user` skill，自动引导模型在决策点使用该工具
- 环境变量配置：`PI_ASK_USER_DISPLAY_MODE`, `PI_ASK_USER_OVERLAY_TOGGLE_KEY`

## 同类扩展对比（调研结论）

| 扩展 | 特色 | 不足 |
|------|------|------|
| **edlsh/pi-ask-user** | 功能最全，overlay + split-pane + fuzzy search | 单文件 1795 行，大量 `as any` |
| ghoseb/pi-askuserquestion | 多问题 Tab UI，108 单元测试 | 无 overlay/fuzzy/search |
| juicesharp/rpiv-ask-user-question | rpiv 工作流套件一部分，高下载量 | 绑定 rpiv 工作流 |
| tomsej/pi-ext | 与 ghoseb 几乎相同 | 无独特功能 |
| eko24ive/pi-ask | 访谈式问答流 | 功能较少 |
| Pi 官方 question.ts | 教学示例 ~220 行 | 仅示例，非生产级 |

## 与我们扩展的关系

- **goal**：goal 的 `create_tasks` 阶段可用 ask-user 做 spec interview，但 goal 已有自己的 steering prompt，不强制依赖
- **subagent**：subagent 执行中不能调用 ask-user（Pi 限制：`ctx.ui.custom()` 只在主 session 可用），headless fallback 可用于 RPC 模式
- **context-engineering**：无冲突
- **todo**：无冲突
- **_render 协议**：ask-user 不输出 `_render` 描述符，不影响 xyz-agent GUI 渲染

## 后续计划

- 安装后观察模型是否自然使用（有 `promptGuidelines` 引导）
- 评估 overlay vs inline 哪种模式更适合日常工作流
- 如果发现需要多问题 Tab UI（ghoseb 的特色），考虑补充安装或贡献 PR
