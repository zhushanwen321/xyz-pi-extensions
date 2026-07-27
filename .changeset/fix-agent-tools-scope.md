---
"@zhushanwen/pi-subagent-workflow": patch
---

修正内置 agent 模板的 `tools:` 字段与 body 描述：

- `researcher`：tools 由 `read` 改为 `read, bash`（tavily-web-search 是 CLI 类型 skill，必须 bash 执行）。body 重写 skill 调用方式——Pi 没有 `Skill` 工具，skill 通过 `<available_skills>` 注入，LLM 用 `read` 读 SKILL.md 再用 `bash` 跑命令。同时 body 收窄了 read-only 范围（仅禁止改源文件，不禁止跑 tavily CLI）。
- `explorer`：tools 增 `find, ls`（结构化文件/目录查询工具，优于 shell `find`/`ls`）。body free-to-run 列表移除 `find`/`grep`/`ls` 字眼（避免与 Pi 工具语义混淆），新增工具优先级提示。
- `orchestrator`：tools 增 `ask_user`（扩展工具，由 `@zhushanwen/pi-ask-user` 提供）。body 提示该工具在未装 ask-user 扩展的 pi 环境中静默兼容（Pi 端 `_rebuildSystemPrompt` 静默过滤未注册工具，subagent-workflow 不做特殊处理，纯透传 `--tools` 参数）。新增「遇到需求歧义时反问用户」指引。
- 测试断言补齐：原 `arrayContaining(["worker", ...7 个])` 改为全部 9 个 agent 精确断言 + 每个 agent 的 `tools` 字段精确匹配 frontmatter（`worker`/`general-purpose` 为 `undefined`、其余为具体数组）。未来改 frontmatter 会立即报错。

未变更：`worker` / `general-purpose` 模板保持工具全开 + prompt 软约束（按用户要求不增加 Tool scope 风险标注）。