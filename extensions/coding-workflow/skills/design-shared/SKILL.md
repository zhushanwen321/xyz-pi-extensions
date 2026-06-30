---
name: design-shared
description: "[internal] Shared reference files for the design workflow phases. Not invoked directly — sibling design-* skills resolve paths via ../design-shared/references/{file}.md. Kept hidden from model invocation."
disable-model-invocation: true
---

# design-shared（共享参考，不可主动调用）

> **这是一个物理载体 skill，不是可执行工作流。** 不要主动加载、不要 `/skill:design-shared`。
> 它存在的唯一目的：让 `references/` 目录被 pi 安装（symlink 到 `~/.agents/skills/design-shared/`），
> 从而使兄弟 skill 通过相对路径 `../design-shared/references/{file}.md` 能稳定命中本目录文件。
>
> `disable-model-invocation: true` 使本 skill **不进入** system prompt 的 `<available_skills>` 列表——
> AI 无法主动发现或调用它。但 pi 的发现管道仍会加载它（symlink 安装 + 进 resourceLoader），
> 其 `references/` 子目录随目录级 symlink 天然可达。

## 文件清单

| 文件 | 作用 | 何时读 |
|------|------|--------|
| `references/loop-skeleton.md` | 6 步操作骨架（Step 1-6c）+ subagent 派发模板 | 每个设计阶段 Step 1 前 read |
| `references/loop-method.md` | 方法论详解（Grilling 提问法、Question Hierarchy、gap 信号） | 仅首次执行工作流（clarity 阶段）read 一次 |
| `references/review-agent.md` | Step 6 独立审查 subagent 规范（机器检查优先 + 6 维审查） | Step 6 派审查 subagent 时注入 |
| `references/context-builder.md` | Step 1.0 上下文构建 subagent 规范（压缩上游→阶段工作摘要，对抗 compact 丢决策） | architecture 及之后各阶段 Step 1.0 派发时注入（L2/L3） |

## 引用约定（重要）

兄弟设计阶段 skill（design-clarity / design-architecture / ... / design-execution）引用本目录文件，
**必须用 `../design-shared/references/{file}.md`** —— 相对路径的解析基准是当前 skill 的 baseDir
（SKILL.md 的 dirname），`../` 跨到兄弟目录 `design-shared/`。

不要用裸路径 `design-shared/references/...`：那会解析成 `{当前skill}/design-shared/...`，安装态下 broken。

> **HTML 渲染不在此处。** Step 5b 的 `.html` 渲染由本包内置的 **design-visual-explainer**
> 技能承担（无需 `pi install`），派 fresh subagent 加载该技能生成。它整合了 Mermaid + drawio + 手画 HTML/CSS
> 三种渲染引擎，按各阶段主角图类型自动选择。设计阶段特有的「主角图表」
> 映射见 `loop-skeleton.md` Step 5b。
