# full-shared（共享参考文件）

> **物理载体 skill，不可主动调用。** 本目录带 `SKILL.md`，但 frontmatter 设了
> `disable-model-invocation: true`——pi 会 symlink 安装本目录、路径可解析，
> 但本 skill **不进** system prompt 的 `<available_skills>` 列表，AI 无法主动发现/调用。
> 详见 `SKILL.md`。

## 用途

6 个设计阶段 skill（full-clarity / full-architecture / full-issues / full-nfr / full-code-arch / full-execution-plan）**共用**的参考文件统一存放处。物理上从 full-clarity 中抽出，消除"full-clarity 借住全局文件"的耦合。

> 为何带 SKILL.md：pi 的 installer 按「目录含 SKILL.md」决定是否 symlink 安装。
> 不带 SKILL.md 的目录会被跳过——历史上 full-shared 因此未安装，导致所有
> `full-shared/references/...` 引用在安装态悬空（开发态能跑只是 CWD 巧合）。
> 带 SKILL.md + `disable-model-invocation: true` 既触发安装、又保持对 AI 不可见。

## 文件清单

| 文件 | 作用 | 何时读 |
|------|------|--------|
| `references/loop-skeleton.md` | 6 步操作骨架（Step 1-6c）+ subagent 派发模板 | 每个设计阶段 Step 1 前 read |
| `references/loop-method.md` | 方法论详解（Grilling 提问法、Question Hierarchy、gap 信号） | 仅首次执行工作流（clarity 阶段）read 一次 |
| `references/review-agent.md` | Step 6 独立审查 subagent 规范（机器检查优先 + 6 维审查） | Step 6 派审查 subagent 时注入 |
| `references/context-builder.md` | Step 1.0 上下文构建 subagent 规范（压缩上游→阶段工作摘要，对抗 compact 丢决策） | architecture 及之后各阶段 Step 1.0 派发时注入（L2/L3） |

## 引用约定

各设计阶段 SKILL.md 引用本目录文件，**必须用** `../full-shared/references/{file}.md`
（相对路径基准 = 当前 skill 的 baseDir = SKILL.md 的 dirname；`../` 跨到兄弟目录）。
裸路径 `full-shared/references/...` 会解析成 `{当前skill}/full-shared/...`，安装态下 broken。

> **HTML 渲染不在此处。** Step 5b 的 `.html` 渲染由本包内置的 **coding-visualizer**
> 技能承担（无需 `pi install`），派 fresh subagent 加载该技能生成。它整合了 Mermaid + drawio + 手画 HTML/CSS
> 三种渲染引擎，按各阶段主角图类型自动选择。设计阶段特有的「主角图表」
> 映射见 `loop-skeleton.md` Step 5b。
