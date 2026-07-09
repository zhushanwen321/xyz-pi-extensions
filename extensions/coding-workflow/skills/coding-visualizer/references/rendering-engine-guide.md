# 渲染引擎决策指南：drawio vs Mermaid vs 手画 HTML/CSS

本文档是 SKILL.md「渲染引擎决策」段的展开。**按需加载**——只在需要详细决策依据或 drawio 嵌入流程时读。

## 核心权衡：谁控制布局？

| 引擎 | 谁放置节点 | 后果 |
|------|-----------|------|
| **Mermaid** | 引擎自动布局（dagre/ELK） | 写文字快、git-diffable，但**无法修正**特定重叠——auto-layout 烂了你没办法。这就是「渲染难看」的根因 |
| **drawio** | 你手动指定坐标（或内置 autolayout.py 用 Graphviz 处理大图） | 像素级控制，但费力，且需 CLI。本 skill 内置脚本 |
| **手画 HTML/CSS** | 你用 Grid/Flexbox | 节点能放富内容（描述/代码/列表），但没有自动连线——箭头要手画 |

## 每个引擎何时真正占优

**Mermaid 占优** → 拓扑重要但单节点美观不重要，且图够小（auto-layout 在 ≤8 节点时反而是优势）。失效点：节点超 8-10 或标签长，dagre 开始产生挤压重叠且你无法修复。

**drawio 占优** → 需要看起来「设计过」/ 图复杂到 Mermaid 崩 / 需要 Mermaid 没有的形状（云厂商图标）。成本：重工作流 + CLI 依赖。

**手画 HTML/CSS 占优** → 节点其实是「卡片」要装富内容，或本质是表格/矩阵/时间线。设计阶段大量产物（追溯表、AC 清单、决策表、签名表、热力图）都属于这类。

## 统一决策表

| 你在画什么 | 引擎 | 决定性因素 |
|-----------|------|-----------|
| 用例图（Actor × 用例 × 边界） | **Mermaid** `graph` | Actor/用例/边界适合 Mermaid 自动布局 |
| 流程图/管道，≤8 节点 | **Mermaid** | auto-layout 在这个规模是优势 |
| 流程图/管道，9+ 节点或长标签 | **drawio** | Mermaid 无法避免重叠/挤压 |
| 时序图（sequence） | **Mermaid** `sequenceDiagram` | 生命线+消息+激活框需要理解时序语义的引擎 |
| 状态机，简单标签 | **Mermaid** `stateDiagram-v2` | 注意 label 解析陷阱（见 SKILL.md） |
| 状态机，标签含特殊字符 | **Mermaid** `flowchart TD` | `stateDiagram-v2` 解析器对冒号/括号/`<br/>` 会静默失败 |
| ER/schema，≤8 实体 | **Mermaid** `erDiagram` | 关系线自动路由在这个规模干净 |
| ER/schema，9+ 实体 | **drawio** | 手动放置让更大 schema 保持可读 |
| 类图/UML | Mermaid（草稿）或 drawio（精美） | Mermaid 求快；drawio 若要像教科书 UML 图 |
| 思维导图/层级 | **Mermaid** `mindmap` | 径向/层级自动布局是 Mermaid 强项 |
| **架构 — 拓扑，简单**（≤8 服务） | **Mermaid** | auto-layout 够用；快 |
| **架构 — 复杂**（10+ 节点/分层/泳道/云图标） | **drawio** → 内联 SVG | Mermaid 渲染挤压难看；drawio 的形状库 + 手动放置专为这个场景 |
| **架构 — 文本密集**（每节点要描述/代码/列表） | **手画 CSS Grid** | 卡片装得下 label 节点装不下的富内容。见 `templates/architecture.html` |
| 决策 DAG（节点=issue，边=blocked_by） | **Mermaid** `graph TD` | 拓扑清晰，状态色标用 `classDef` |
| Wave 依赖 DAG（节点=Wave，并行组） | **Mermaid** `graph TD` + `subgraph` | 并行分组用 subgraph 表达 |
| **风险矩阵热力图**（issue × 维度） | **手画 HTML `<table>`** | 热力图本质是表格 + 单元格着色，Mermaid/drawio 都不如 table |
| 追溯表/AC 清单/签名表/决策表 | **手画 HTML `<table>`** | 结构化行列数据 |
| 时间线/路线图 | **手画 CSS**（中线 + 卡片） | 线性布局，无需路由引擎 |
| 仪表盘/指标 | **手画 CSS Grid + Chart.js** | 卡片网格内嵌图表 |

## 三句话总结

- **Mermaid** = "图小，让引擎帮我连线"（>8 节点或长标签会崩）
- **drawio** = "图复杂/要精美/要云图标"（需 CLI，内置 autolayout 脚本）
- **手画 CSS** = "节点是富卡片" 或 "这是表格/矩阵"

---

## drawio 嵌入（指向内置指南）

当引擎决策选了 drawio（② 分层架构、⑤ 包依赖图、复杂 ER），**完整工作流见 `references/drawio-guide.md`**——包括：CLI 检查、手写 XML 结构、autolayout（复杂图自动布局）、validate（结构校验）、SVG 导出与 HTML 嵌入、形状速查表。

核心路径（4步速查）：
1. `which drawio` 检查 → 不可用降级 Mermaid/CSS
2. 生成 `.drawio`（小图手写 XML / 大图 `scripts/autolayout.py graph.json -o out.drawio`）
3. `python3 scripts/validate.py out.drawio`（结构校验门）
4. `drawio -x -f svg -e -o out.svg out.drawio` → SVG 内联进页面 `.drawio-wrap` 容器 + zoom 控件

`[HISTORICAL]` 不手建 `data-mxgraph`（三重编码必须由 CLI 处理）；边的 mxCell 必须含 `<mxGeometry>` 子元素（自闭合无效）。详见 `drawio-guide.md`。
