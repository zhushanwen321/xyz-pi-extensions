# Skill 列表 (system-reminder 注入)

注入位置：msg[4] system-reminder

---

## 完整 skill 列表

以下 skill 可通过 `Skill` 工具调用：

| # | Skill 名称 | 描述 |
|---|-----------|------|
| 1 | anysearch | 垂直领域搜索（股票/CVE/论文/专利） |
| 2 | batch-tracer | 批量代码分析调度器 |
| 3 | browser-automation | 浏览器自动化调试 |
| 4 | bug-fix-recorder | 记录 bug 修复到知识库 |
| 5 | cc-agent-design | AI Coding Agent 设计评估 |
| 6 | chrome-automation | Chrome 自动化 |
| 7 | code-taste-review | 代码品味提炼工作流 |
| 8 | code-trace | 代码调用链路分析 |
| 9 | create-worktree | 创建 git worktree |
| 10 | handoff | 会话交接文档生成 |
| 11 | harness-retrospect | Harness 回顾分析 |
| 12 | intent-discovery | 用户意图发现 |
| 13 | issue-trace | 问题链路验证 |
| 14 | lightmerge-branch | 多分支合并测试 |
| 15 | meta-sk-agent-writer | Agent.md 文件编写 |
| 16 | meta-sk-skill-writer | Skill.md 文件编写 |
| 17 | pr-worktree | PR worktree 流程 |
| 18 | py-preference | Python 开发偏好 |
| 19 | python-refactor | Python 代码重构 |
| 20 | qwen-fast-coder | Qwen 快速编码 |
| 21 | recheck-code | 代码质量复查 |
| 22 | remotion-best-practices | Remotion 最佳实践 |
| 23 | remotion-tools | Remotion 共享工具 |
| 24 | remotion-video-design | Remotion 视频设计 |
| 25 | remotion-video-development | Remotion 视频开发 |
| 26 | remotion-video-review | Remotion 视频审查 |
| 27 | remove-worktree | 清理 git worktree |
| 28 | rethink | 思维框架（跳出局部修补） |
| 29 | review-tracer | 审查质量评估 |
| 30 | rust-taste-check | Rust 代码品味检查 |
| 31 | semble-code-search | 本地语义代码搜索 |
| 32 | skill-creator | 创建/编辑/测试 skill |
| 33 | skill-memory-keeper | Skill 使用经验记录 |
| 34 | task-group-planner | 任务分组规划 |
| 35 | tavily-web-search | 网络搜索 |
| 36 | token-counter | Token 数量计算 |
| 37 | ts-taste-check | TS/Vue 代码品味检查 |
| 38 | vision-analysis | 图像/视频分析 |
| 39 | web-fetch | URL 内容抓取 |
| 40 | workspace-worktree | Worktree 管理 |
| 41 | zcommit | 智能 git commit |
| 42 | deep-research | 深度多源研究 |
| 43 | frontend-design | 前端设计 |
| 44 | skill-creator:skill-creator | Skill 创建（命名空间） |
| 45 | update-config | Claude Code 配置管理 |
| 46 | keybindings-help | 快捷键自定义 |
| 47 | verify | 代码变更验证 |
| 48 | code-review | 代码审查 |
| 49 | simplify | 代码简化 |
| 50 | fewer-permission-prompts | 减少权限提示 |
| 51 | loop | 循环执行任务 |
| 52 | claude-api | Claude API 参考 |
| 53 | run | 启动运行项目 |
| 54 | init | 初始化 |
| 55 | review | 审查 |
| 56 | security-review | 安全审查 |

---

## 带详细描述的 Skill

### code-review

```
Review the current diff for correctness bugs and reuse/simplification/efficiency cleanups
at the given effort level (low/medium: fewer, high-confidence findings; high→max: broader
coverage, may include uncertain findings). Pass --comment to post findings as inline PR
comments, or --fix to apply the findings to the working tree after the review.
```

### simplify

```
Review the changed code for reuse, simplification, efficiency, and altitude cleanups,
then apply the fixes. Quality only — it does not hunt for bugs; use /code-review for that.
```

### deep-research

```
Deep research harness — fan-out web searches, fetch sources, adversarially verify claims,
synthesize a cited report. - When the user needs a deep, multi-source, fact-checked
research report on any topic. BEFORE invoking, check if the question is specific enough
to research directly — if underspecified ("what car to buy" without budget/use-case/region),
ask 2-3 clarifying questions to narrow scope. Then pass the refined question as args,
weaving the answers in.
```

### loop

```
Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo, defaults to 10m)
- When the user wants to set up a recurring task, poll for status, or run something on an
interval ("check the deploy every 5 minutes", "keep running /babysit-prs"). Do NOT invoke
for one-off tasks.
```

### claude-api

```
Reference for the Claude API / Anthropic SDK — model ids, pricing, params, streaming,
tool use, MCP, agents, caching, token counting, model migration.
TRIGGER — read BEFORE opening the target file; don't skip because it "looks like a one-liner"
— whenever: the prompt names Claude/Anthropic in any form (Claude, Anthropic, Opus, Sonnet,
Haiku, `anthropic`, `@anthropic-ai`, `claude-*`, `us.anthropic.*`, `[1m]`); the user asks
about an LLM (pricing/model choice/limits/caching) — never answer from memory; OR the task
is LLM-shaped with provider unstated (agent/MCP/tool-definition/multi-agent/RAG/LLM-judge/
computer-use; generate/summarize/extract/classify/rewrite/converse over NL; debugging
refusals/cutoffs/streaming/tool-calls/tokens).
```

### verify

```
Verify that a code change actually does what it's supposed to by running the app and
observing behavior. Use when asked to verify a PR, confirm a fix works, test a change
manually, check that a feature works, or validate local changes before pushing.
```

### update-config

```
Use this skill to configure the Claude Code harness via settings.json. Automated behaviors
("from now on when X happens", "whenever X", "always do X") require hooks configured in
settings.json - the harness executes these, not the AI, so memory/preferences cannot fulfill
them. Also use for: permissions ("allow X", "add permission", "move permission to"), env
vars ("set X=Y"), hook troubleshooting, or any changes to settings.json/settings.local.json.
Examples: "allow npm install", "add a hook to run lint on pre-commit", "set DEBUG=true",
"when claude stops show X". For simple settings like theme/model, suggest the /config command.
```
