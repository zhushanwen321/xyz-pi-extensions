# 01. 官方资料与背景

## 1.1 官方博客核心要点

**来源**:[Introducing dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)
- 发布日期:**2026-05-28**
- 类别:Product announcements
- 阅读时长:5 分钟
- 状态:**Research preview**

### 一句话定位

> Dynamic workflows 是 Claude Code 的**编排层(orchestration layer)**:Claude 动态写出编排脚本,在单个会话里并行运行 **tens to hundreds** 个 subagent,所有结果在到达用户之前**被检查(checked before reaching you)**。

### 关键引述

> Work you'd normally plan in quarters now finishes in days.

> Claude dynamically writes orchestration scripts that run tens to hundreds of parallel subagents in a single session, checking its work before anything reaches you.

### 解决的问题(博客原话)

> Some problems are too big for one pass by a single agent, especially in complex, legacy codebases: a bug hunt across an entire service, a migration that touches hundreds of files, a plan you want stress-tested from every angle before you commit to it.

### 三类典型用例

1. **Codebase-wide bug hunts / profiler-guided optimization / security audits** — 全代码库扫描,并行独立验证每个发现
2. **Large migrations and modernization** — 跨千文件的框架替换、API 弃用、语言移植
3. **Critical work you need checked twice** — 高代价答案的多角度 + 对抗 agent 校验

### 标杆案例:Bun 从 Zig 移植到 Rust

Jarred Sumner 使用 dynamic workflows 移植 Bun:
- **99.8% 测试套件通过**
- **约 75 万行 Rust 代码**
- **首次 commit 到 merge 用 11 天**
- Phase 1:一个 workflow 映射每个 Zig struct 字段的 Rust lifetime
- Phase 2:写每个 `.rs` 文件,hundreds of agents 平行,每个文件 2 个 reviewer
- Phase 3:fix loop 推动 build/test 直到干净
- Phase 4:overnight workflow 处理不必要的数据拷贝,每个开 PR 等最终 review

> While not yet in production, all of this was handled by dynamic workflows.

### 客户引用

| 公司 | 引用人 | 评价 |
|------|--------|------|
| **Klarna** | Alessio Vallero (Senior Engineering Manager) | "对大型代码库的发现和审查任务特别有价值,能识别传统静态分析漏掉的死代码" |
| **CyberAgent** | Ken Takao (Lead Systems Engineer) | "填了单 subagent 和完整 agent team 之间的缺口,从计划到实现自然流畅" |

### 触发方式

1. **关键词触发** — prompt 中包含 `workflow`,Claude 自动为该任务写一个 workflow 脚本
2. **`/effort ultracode`** — Claude Code-specific 设置,effort 设为 xhigh,**自动为每个实质任务规划 workflow**

### 可用性

| 平台 | 是否支持 |
|------|---------|
| Claude Code CLI | ✅ |
| Desktop | ✅ |
| VS Code 扩展 | ✅ |
| Claude API | ✅ |
| Amazon Bedrock | ✅ |
| Google Cloud Vertex AI | ✅ |
| Microsoft Foundry | ✅ |

| 套餐 | 默认状态 |
|------|---------|
| Pro | 关闭,需 `/config` 打开 |
| Max | 开启 |
| Team | 开启 |
| Enterprise | **关闭,需 admin 在 settings 打开** |

### 关闭方式

- `/config` → 关闭 Dynamic workflows(会话间持久)
- `~/.claude/settings.json` → `"disableWorkflows": true`
- 环境变量 `CLAUDE_CODE_DISABLE_WORKFLOWS=1`
- 组织级:`managed settings` 设置 `disableWorkflows: true`

### 关键提示(博客原话)

> Dynamic workflows can consume substantially more tokens than a typical Claude Code session, so we recommend starting on a scoped task to get a feel for usage in your work.
>
> For the best experience, turn on auto mode when using dynamic workflows.

---

## 1.2 官方文档核心要点

**来源**:[Orchestrate subagents at scale with dynamic workflows](https://code.claude.com/docs/en/workflows)

### 形态定义

> A dynamic workflow is a **JavaScript script** that orchestrates subagents at scale. Claude writes the script for the task you describe, and a runtime executes it in the background while your session stays responsive.

### 版本要求

**Claude Code v2.1.154+**(对比 v2.1.147/148 的"未发布"版,154 应该是改名 + 修复后的稳定 release)

### 何时使用 workflow

文档给出了一个**对比表**来区分 Subagent / Skill / Workflow:

| 维度 | Subagents | Skills | Workflows |
|------|-----------|--------|-----------|
| 本质 | Claude 派生的 worker | Claude 遵循的指令 | **运行时执行的脚本** |
| 谁决定下一步 | Claude,逐轮 | Claude,按 prompt 走 | **脚本** |
| 中间结果位置 | Claude 上下文 | Claude 上下文 | **脚本变量** |
| 可复现的是什么 | worker 定义 | 指令 | **编排本身** |
| 规模 | 每轮几个 | 同 subagent | **每 run 几十到几百** |
| 中断 | 重新开始当前轮 | 重新开始当前轮 | **同会话内可恢复** |

> A workflow moves the plan into code. With subagents and skills, Claude is the orchestrator: it decides turn by turn what to spawn next, and every result lands in Claude's context. A workflow script holds the loop, the branching, and the intermediate results itself, so Claude's context holds only the final answer.

### 内置 workflow

`/deep-research <question>` — 跨多角度 web 搜索、抓取+交叉验证来源、对每个声明投票、返回带引用的报告(声明未通过交叉验证会被过滤)。

要求 WebSearch 工具可用。

### 触发方式

1. **prompt 中包含 `workflow`** — 关键字高亮,Claude 写一个 workflow 脚本
2. **`/effort ultracode`** — 自动为每个实质任务规划 workflow

### 计划审批

第一次运行一个 workflow 时,CLI 会弹提示,选项:
- **Yes, run it**
- **Yes, and don't ask again for `<name>` in `<path>`**
- **View raw script** — 读脚本后再决定
- **No** — 取消

`Ctrl+G` 在编辑器中打开脚本,`Tab` 调整 prompt。

按权限模式区分:

| 权限模式 | 提示频率 |
|---------|---------|
| Default / accept edits | 每次都问,除非选了"don't ask again" |
| Auto | 首次启动问,之后 `Yes` 写入用户设置,跳过提示;ultracode 时完全跳过 |
| Bypass permissions / `claude -p` / Agent SDK | **永不提示**,直接开始 |

> The subagents the workflow spawns always run in `acceptEdits` mode and inherit your tool allowlist, regardless of your session's mode. **File edits are auto-approved.**

### 保存为可复用命令

`/workflows` 选中 run,按 `s`:
- `.claude/workflows/` 项目级(共享给所有 clone 的人)
- `~/.claude/workflows/` 个人级(跨项目,只对自己)

### 行为与限制

| 约束 | 原因 |
|------|------|
| **无 mid-run user input** | 只有 agent 权限提示能暂停;分阶段 sign-off 需跑多个 workflow |
| **Workflow 自身无 FS/shell 访问** | 脚本只协调 agents;文件读写由 agent 完成 |
| **最多 16 个并发 agent** | 受机器 CPU 核心数限制 |
| **单 run 最多 1000 个 agent** | 防 runaway loop |

### 关键运行机制

> The workflow runtime executes the script in an **isolated environment, separate from your conversation**. Intermediate results stay in script variables instead of landing in Claude's context.
>
> The runtime tracks each agent's result as the run progresses, which is what makes a run **resumable** within the same session.

### 恢复运行

`/workflows` 选中按 `p`,或让 Claude 重新跑同一个脚本:
- 已完成的 agent 返回**缓存结果**
- 剩下的 live 重跑
- 仅在**同会话**有效;退出 Claude Code 后下次会话**重新开始**

### 成本

> A workflow spawns many agents, so a single run can use meaningfully more tokens than working through the same task in conversation. Runs count toward your plan's usage and rate limits like any other session. You can stop a running workflow from `/workflows` at any time without losing completed work.

控制成本:
- `/model` 检查模型
- 让 Claude 在 prompt 里指定阶段使用小模型

### 关闭后行为

> When workflows are disabled, the bundled workflow commands are unavailable, the `workflow` keyword no longer triggers a run, and `ultracode` is removed from the `/effort` menu.

---

## 1.3 与 v2.1.147 "未发布"版本的关系

项目内 `chat_project/workflow/Claude-Code-Workflow-调研报告.md`(调研日期 2026-05-25)详细记录了 v2.1.147/148 的逆向发现。对比看,**v2.1.147 是 dynamic workflows 的前身**,命名不同但内核一致。

| 维度 | v2.1.147 未发布版 | v2.1.154 正式版 (dynamic workflows) |
|------|------------------|-----------------------------------|
| 启用方式 | `CLAUDE_CODE_WORKFLOWS=1` 环境变量 | 默认(按 plan 决定)/`/effort ultracode`/prompt 关键词 |
| 关键字 | 无明确关键字 | 包含 `workflow` 触发 |
| 文档 | 无(社区逆向) | 完整官方文档 |
| 关闭 | 删除环境变量 | `/config` / `disableWorkflows: true` / `CLAUDE_CODE_DISABLE_WORKFLOWS=1` |
| 形态 | JS 脚本,`agent/parallel/pipeline/phase/$ARGS` | JS 脚本,API 保持一致 |

**v2.1.147 公开的 API**(根据逆向报告):

```javascript
// Meta 块
const meta = {
  name: "triage-sentry",
  description: "...",
  phases: ["load-issues", "fix-issues", "verify-fixes"]
};

// 参数处理
const minUsers = $ARGS.minUsers ?? 20;

// Agent 调用
const issues = await agent({
  prompt: "...",
  schema: { type: "array", items: { ... } },
  model: "opus",                  // 可选
  description: "..."             // 在 /workflows 中显示
});

// 控制流原语
await parallel([...agents]);
await pipeline([...stages]);      // 每阶段可含 parallel
phase(name, fn);                  // 命名阶段

// 结构化输出:schema 约束
const schema = {
  type: "object",
  properties: { ... }
};
```

**v2.1.154 (官方文档确认) 的 API 表面**:
- `agent()` / `parallel()` / `pipeline()` — 三种核心原语
- `phase()` 命名阶段
- `$ARGS` 访问参数
- 结构化 schema 返回
- 6 种编排模式(pipeline / fan-out / adversarial / judge panel / accumulate / nested)

> 推断:5/28 正式发布时,核心 API 形态未变,主要差异是命名/启用方式/产品化包装。

---

## 1.4 Twitter(X)同步信息

- **@_catwu**(Anthropic 员工,常发新功能介绍):"Excited to share our most powerful new Claude Code feature. Mention 'workflow' in a prompt and Claude will dynamically create an orchestration plan that it strictly follows, allowing you to confidently trust that every..."(被截断)

- **Reddit r/ClaudeAI**:由 [ClaudeOfficial] 账号发帖,标题就是 "Introducing dynamic workflows in Claude Code"

---

## 1.5 媒体报道

- [InfoQ: Claude Code Adds Dynamic Workflows for Parallel Agent Coordination](https://www.infoq.com/news/2026/06/dynamic-workflows-claude-code)
- [Hacker News: Dynamic Workflows in Claude Code](https://news.ycombinator.com/item?id=48311705)
- [YouTube: Anthropic's Dynamic Workflows: What Everyone Gets Wrong!](https://www.youtube.com/watch?v=WnmVGVOPtrA) — Prompt Engineering 频道,提到"2B-token example"的滥用警告
- [YouTube: The Claude Update Everyone Missed (Dynamic Workflows)](https://www.youtube.com/watch?v=-tLlZqrXpo8)
- [Ken Huang: Claude Code Orchestration — Dynamic Workflows, Subagents, Agent Teams](https://kenhuangus.substack.com/p/claude-code-orchestration-dynamic) — 三种原语对比
- [MindStudio: Claude Opus 4.8 Dynamic Workflows: How to Run Hundreds of Parallel Sub-Agents](https://www.mindstudio.ai/blog/claude-opus-4-8-dynamic-workflows-parallel-sub-agents)

---

## 1.6 关键事实速查

| 项 | 值 |
|----|----|
| 名称 | Dynamic Workflows |
| 发布日期 | 2026-05-28 |
| 状态 | Research preview |
| 版本要求 | Claude Code v2.1.154+ |
| 形态 | JavaScript 脚本(由 Claude 写) |
| 触发 | prompt 包含 `workflow` 或 `/effort ultracode` |
| 内置 workflow | `/deep-research` |
| 项目级路径 | `.claude/workflows/` |
| 全局路径 | `~/.claude/workflows/` |
| 限制 | 16 并发 / 1000 agent/run |
| 取消 | `/workflows` 中按 `x`,中断可 `p` 恢复 |
| Plan 审批 | 第一次 / "don't ask again" 选过 / Auto 模式 ultracode |
| 子 agent 模式 | 总是 `acceptEdits` |
| Subagent 总线 | 内部实现,**子 agent 总在 `acceptEdits`** |
| 跨会话恢复 | **不支持** |
