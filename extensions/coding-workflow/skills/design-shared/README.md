# design-shared（共享参考文件）

> **这不是一个可调用的 skill**——没有 `SKILL.md`，不会出现在 skill 列表中。
> skill-resolver 按 `skills/{name}/SKILL.md` 精确查找，本目录无该文件故不被识别。

## 用途

6 个设计阶段 skill（design-clarity / design-architecture / design-issues / design-nfr / design-code-arch / design-execution）**共用**的参考文件统一存放处。物理上从 design-clarity 中抽出，消除"design-clarity 借住全局文件"的耦合。

## 文件清单

| 文件 | 作用 | 何时读 |
|------|------|--------|
| `references/loop-skeleton.md` | 6 步操作骨架（Step 1-6c）+ subagent 派发模板 | 每个设计阶段 Step 1 前 read |
| `references/loop-method.md` | 方法论详解（Grilling 提问法、Question Hierarchy、gap 信号） | 仅首次执行工作流（clarity 阶段）read 一次 |
| `references/review-agent.md` | Step 6 独立审查 subagent 规范（机器检查优先 + 6 维审查） | Step 6 派审查 subagent 时注入 |

## 引用约定

各设计阶段 SKILL.md 用相对路径 `design-shared/references/{file}.md` 引用本目录文件。

> **HTML 渲染不在此处。** Step 5b 的 `.html` 渲染由本包内置的 **design-visual-explainer**
> 技能承担（无需 `pi install`），派 fresh subagent 加载该技能生成。它整合了 Mermaid + drawio + 手画 HTML/CSS
> 三种渲染引擎，按各阶段主角图类型自动选择。设计阶段特有的「主角图表」
> 映射见 `loop-skeleton.md` Step 5b。
