# Claude Code 核心工具描述

共 81 个工具。本文档收录非 MCP 的核心工具（约 30 个），MCP 工具见 `tool-descriptions-mcp.md`。

---

## Agent

**用途**：启动子 agent 处理复杂多步任务

**Schema**：`{description, prompt, subagent_type, model, run_in_background, isolation}`

**可用 agent 类型**（共 25+ 种）：

| Agent 类型 | 描述 | 可用工具 |
|-----------|------|---------|
| claude | 通用兜底 | *（全部） |
| general-purpose | 研究/搜索/多步任务 | *（全部） |
| Explore | 只读搜索（不 review） | 除 Agent/Edit/Write 外全部 |
| Plan | 架构设计/实现规划 | 除 Agent/Edit/Write 外全部 |
| code-reviewer | 代码审查（bug/逻辑/性能/安全） | 全部 |
| code-fixer | 代码修复（最小变更） | 全部 |
| claude-code-guide | Claude Code 使用指南 | Bash, Read, WebFetch, WebSearch |
| batch-code-tracer | 调用链路分析 | 全部 |
| batch-issue-tracer | 问题验证 | 全部 |
| batch-review-tracer | 审查质量评估 | 全部 |
| bug-fixer | Bug 修复知识库 | 全部 |
| rebase-conflict-resolver | Git rebase 冲突解决 | 全部 |
| review-architecture | 架构合规审查 | 全部 |
| review-blr | 业务逻辑审查 | 全部 |
| review-dataflow | 数据流审查 | 全部 |
| review-integration | 集成审查 | 全部 |
| review-robustness | 健壮性审查 | 全部 |
| review-standards | 编码规范审查 | 全部 |
| review-taste | 代码品味审查 | 全部 |
| rust-taste-check | Rust 品味审查 | 全部 |
| ts-taste-check | TS/Vue 品味审查 | 全部 |
| statusline-setup | 状态栏配置 | Read, Edit |

**关键行为**：
- agent 的最终文本是返回值，不展示给用户
- `isolation: "worktree"` 给 agent 独立 git worktree
- `run_in_background: true` 异步执行
- 多个独立 agent 在同一 message 中并发启动

---

## Skill

**用途**：在主对话中执行 skill

**Schema**：`{skill, args}`

**关键规则**：
- skill 名称必须与 system-reminder 中列出的完全一致
- 匹配用户请求时，**必须在生成任何其他响应之前**调用 Skill 工具
- 禁止猜测或编造 skill 名称
- 禁止提及 skill 但不实际调用
- 如果看到 `<command-name>` 标签，skill 已加载，直接执行

---

## Workflow

**用途**：执行编排多个子 agent 的工作流脚本

**Schema**：`{script, name, description, title, args, scriptPath, resumeFromRunId}`

**触发条件**（必须显式 opt-in）：
1. 用户 prompt 包含 `ultracode` 关键词
2. Session 级 ultracode 开启
3. 用户直接要求 "use a workflow" / "run a workflow"
4. Skill 指示调用 Workflow
5. 用户要求运行特定命名/保存的 workflow

**脚本规范**：
```javascript
export const meta = {
  name: 'workflow-name',        // 必需
  description: '...',           // 必需
  phases: [{ title, detail }], // 可选
}
```

**脚本 hooks**：
- `agent(prompt, opts)` — 子 agent
- `parallel(thunks)` — 并发执行（barrier）
- `pipeline(items, stage1, stage2)` — 流水线（无 barrier）
- `log(message)` — 进度消息
- `phase(title)` — 阶段标记
- `args` — 输入参数
- `budget` — token 预算控制
- `workflow(nameOrRef, args)` — 嵌套 workflow（仅一层）

**限制**：
- 禁止 `Date.now()` / `Math.random()` / `new Date()`
- 禁止文件系统/Node.js API
- 并发上限 `min(16, cpu cores - 2)`
- 总 agent 上限 1000
- 单次 parallel/pipeline 上限 4096 items

**质量模式**：
- Adversarial verify — N 个怀疑者，多数否决则 kill
- Perspective-diverse verify — 不同视角验证
- Judge panel — N 个独立方案 + 并行评分
- Loop-until-dry — 连续 K 轮无新发现才停止
- Multi-modal sweep — 多角度并行搜索
- Completeness critic — 质疑"还缺什么"
- Loop-until-budget — 基于 token 预算控制深度

**Resume 机制**：
- 返回 `runId`
- 重新调用 `Workflow({scriptPath, resumeFromRunId})` 恢复
- 未变更的 agent() 调用返回缓存结果

---

## Bash

**用途**：执行 bash 命令

**Schema**：`{command, timeout, description, run_in_background, dangerouslyDisableSandbox}`

**关键规则**：
- 工作目录在调用间持久化，但优先用绝对路径
- `timeout` 单位毫秒，默认 120000，最大 600000
- `run_in_background` 异步执行，跨 turn 持久化
- 禁止交互式 git 标志（`-i`）
- Git commit 末尾追加 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

## Read

**用途**：读取文件

**Schema**：`{file_path, offset, limit, pages}`

**关键行为**：
- 默认读 2000 行
- 支持图片（PNG/JPG）、PDF（`pages` 参数）、Jupyter notebook
- 结果用 `cat -n` 格式（行号从 1 开始）
- 禁止重新读取刚编辑的文件验证

---

## Write

**用途**：写入文件（覆盖）

**Schema**：`{file_path, content}`

**规则**：覆盖已有文件必须先 Read

---

## Edit

**用途**：精确字符串替换

**Schema**：`{file_path, old_string, new_string, replace_all}`

**规则**：
- 必须先 Read
- `old_string` 必须精确匹配（含缩进），且唯一
- `replace_all: true` 替换所有匹配

---

## EnterPlanMode / ExitPlanMode

**用途**：进入/退出规划模式

**适用场景**：
- 新功能实现
- 多种可行方案
- 架构决策
- 多文件变更
- 需求不明确

**不适用**：单行修复、简单任务、纯研究

---

## EnterWorktree / ExitWorktree

**用途**：创建/退出 git worktree 隔离环境

**规则**：
- 仅在用户明确要求或 CLAUDE.md 指示时使用
- `ExitWorktree` 仅操作 `EnterWorktree` 创建的 worktree
- `action: "keep"` 保留，`"remove"` 删除

---

## CronCreate / CronDelete / CronList

**用途**：定时任务调度

**Schema**：`{cron, prompt, recurring, durable}`

**关键规则**：
- 5 字段 cron（分钟 时 日 月 周）
- 避免 :00 和 :30 分钟标记（API 峰值）
- `durable: false` 仅 session 内，`true` 写入 `.claude/scheduled_tasks.json`
- 循环任务 7 天自动过期

---

## ScheduleWakeup

**用途**：/loop 动态模式的唤醒调度

**Schema**：`{delaySeconds, reason, prompt}`

**缓存策略**：
- <5 分钟：缓存保持温暖
- 5 分钟-1 小时：缓存 miss
- 不选 300s（最差：miss + 未摊销）
- 空闲默认 1200-1800s（20-30 分钟）

---

## AskUserQuestion

**用途**：向用户提问（仅在真正阻塞时）

**Schema**：`{questions, answers, annotations, metadata}`

**规则**：
- 保留给用户决策真正改变后续行为的场景
- 支持 `preview` 字段（ASCII mockup、代码片段）
- 推荐选项加 "(Recommended)"

---

## TaskCreate / TaskGet / TaskList / TaskUpdate / TaskStop / TaskOutput

**用途**：结构化任务列表管理

**TaskCreate Schema**：`{subject, description, activeForm, metadata}`

**TaskUpdate Schema**：`{taskId, subject, description, activeForm, status, addBlocks, addBlockedBy, owner, metadata}`

**状态流**：`pending` → `in_progress` → `completed`（或 `deleted`）

---

## WaitForMcpServers

**用途**：等待 MCP 服务器连接完成

**Schema**：`{servers}`

---

## WebFetch

**用途**：获取 URL 内容，转 markdown，回答 prompt

**Schema**：`{url, prompt}`

**限制**：不支持认证/私有 URL，响应缓存 15 分钟

---

## WebSearch

**用途**：网络搜索

**Schema**：`{query, allowed_domains, blocked_domains}`

---

## ListMcpResourcesTool / ReadMcpResourceTool

**用途**：列出/读取 MCP 服务器资源

---

## NotebookEdit

**用途**：编辑 Jupyter notebook 单元格

**Schema**：`{notebook_path, cell_id, new_source, cell_type, edit_mode}`
