---
name: coding-visualizer
description: >-
  Use when a full-* phase Step 5b needs a finalized .md rendered to a
  self-contained .html, or when the user says "可视化", "渲染", "画图", "render
  html", "visualize". Produces {deliverable-name}.html with the phase's mandated
  hero diagram. Serves full-clarity / full-architecture / full-issues /
  full-nfr / full-code-arch / full-execution-plan. Delegates complex architecture
  to drawio (built-in autolayout scripts) when available; Mermaid for simple diagrams; hand-built HTML/CSS
  for rich-card and table-heavy deliverables. Not for design decisions — only
  visualizes finalized content. Not for writing code.
---

# Coding Visual Explainer

设计阶段（①-⑥）的可视化渲染器。消费定稿 `.md`（真相源），产出自包含 `.html`（可视化视图）。**不产生新内容。**

> **标记：** `[MANDATORY]` 流程强制。`[HISTORICAL]` 踩坑铁律，不允许削弱。

## 核心目标

把 6 个设计阶段产出的结构化 `.md`（Mermaid 块、表格、决策记录、AC 清单）渲染成**自包含、双击即开**的 HTML。每个阶段的「主角图」(hero) 放在 header 之后最显眼处。配 TL;DR（3-5 行核心结论）。

产物：`.xyz-harness/${主题}/{deliverable-name}.html`，与 `.md` 并列。

## 渲染引擎决策

三选一：**drawio** / **Mermaid** / **手画 HTML/CSS**。详细决策矩阵见 `references/rendering-engine-guide.md`（按需读）。

**三句话规则：**
- **Mermaid** = 图小（≤8节点）、让引擎自动连线。>8节点或长标签会崩（auto-layout 烂了你无法修）。
- **drawio** = 图复杂/要精美/要云图标。需 CLI；内置 autolayout 脚本 + SVG 导出。CLI 不可用则降级 Mermaid。
- **手画 HTML/CSS** = 节点是富卡片（描述/代码/列表），或本质是表格/矩阵/时间线。

## 各阶段主角图规范

`[MANDATORY]` HTML header 之后紧接该阶段的 hero 图。这是 `../full-shared/references/loop-skeleton.md` Step 5b 的展开实现：

| 阶段 | 主角图 | 首选引擎 | 渲染要点 |
|------|--------|---------|---------|
| ① 澄清需求 | **用例图**（Actor×用例×边界） | Mermaid `graph` | Actor `(( ))`，用例圆角框，系统边界 `subgraph` |
| ② 系统设计 | **分层架构图** + **状态机图** | drawio优先/Mermaid备选 | 复杂(10+模块)用 drawio SVG；简单用 Mermaid `graph TD`+`subgraph`。状态机用 `stateDiagram-v2`（注意 label 陷阱） |
| ③ Issue 拆分 | **决策 DAG**（节点=issue，状态色标） | Mermaid `graph TD` | 节点按 P 级着色（P0红/P1橙/P2蓝/P3灰），`classDef` 控色 |
| ④ 非功能设计 | **风险矩阵热力图**（issue×7维度） | 手画 `<table>` | 热力图本质是表格，单元格 `--green-dim`/`--orange-dim`/`--red-dim` 着色。配 KPI 行 + legend |
| ⑤ 代码架构 | **包依赖图** + **核心时序图** | drawio 或 Mermaid | 依赖图复杂用 drawio；时序图用 `sequenceDiagram`（含 alt/else 异常路径） |
| ⑥ 执行计划 | **Wave 依赖 DAG**（并行组标注） | Mermaid `graph TD` | Wave 节点用 `subgraph` 分并行组，blocked_by 虚线箭头 |

## 渲染流程

`[MANDATORY]` **骨架填充模式**——不再从零写 HTML，而是复制阶段骨架 → 填 AGENT-FILL 槽位 → 跑 render.sh。

1. **read 定稿 `.md`**——定阶段、hero 类型、内含的 Mermaid 块和表格
2. **读对应阶段骨架** `templates/skeletons/{phase}.html`——它是该阶段的完整 HTML 外壳（含 TOC/header/固定 CSS/zoom JS 占位符 + AGENT-FILL 槽位注释）。每个骨架顶部注释说明该阶段的主角图类型和特有 CSS 类。

   | 阶段 | 骨架文件 | 主角图 | 特有 CSS |
   |---|---|---|---|
   | ① 澄清需求 | `skeletons/requirements.html` | flowchart LR 用例图 | .uc/.ac/.ac-normal/.ac-abnormal/.ac-boundary |
   | ② 系统设计 | `skeletons/system-architecture.html` | stateDiagram-v2 状态机 | （沿用公共类） |
   | ③ Issue 拆分 | `skeletons/issues.html` | graph LR 决策 DAG | .issue/.sol/.pick/.ac-list/.pill |
   | ④ 非功能设计 | `skeletons/non-functional-design.html` | HTML table 风险矩阵 | .risk-ok/.risk-warn/.risk-na |
   | ⑤ 代码架构 | `skeletons/code-architecture.html` | graph TD 包依赖 + sequenceDiagram 时序 | .dir-tree |
   | ⑥ 执行计划 | `skeletons/execution-plan.html` | graph LR Wave DAG | .wave-card/.wave-tag/.kv/.checklist |
3. **填 AGENT-FILL 槽位**——骨架里 `<!-- AGENT-FILL: xxx -->` 注释是填充指引，按它把定稿 `.md` 内容填进对应位置。槽位覆盖：TOC 锚点、badges、TL;DR、hero 主角图、各内容 section、footer。**不要改骨架的外壳结构（head/style 占位符/TOC 容器/script 占位符）**——它们由 render.sh 统一注入。
4. **跑 render.sh 内联公共资产**——填完槽位后：
   ```bash
   bash {skill_dir}/templates/render.sh {填好的骨架.html} {deliverable-name}.html
   ```
   render.sh 把 `/* INLINE: design.css */` 和 `/* INLINE: zoom.js */` 占位符替换为公共 CSS/JS 全文，输出单文件自包含 HTML。
5. **自检**（见下）→ `open` 打开

> **为何用骨架而非从零写**：骨架把 style（~200行）+ zoom JS（~70行）+ TOC + 外壳结构全部固化，agent 只填内容槽位——输入侧省 ~9K tokens（不再读 anatomy-demo + cookbook 样板），输出侧省 60%+（不写 CSS/JS/外壳）。一致性也保证：所有产物统一 teal 调色板 + 类名 + TOC 布局。

### 按需参考（可选，非必读）

骨架已自带该阶段所需的全部结构信息。以下文件仅当**骨架不够用**时查阅：

| 你要查… | 读这个 |
|---|---|
| 某形态的完整 HTML 示例（卡片/DAG/表格） | `templates/anatomy-demo.html`（三形态样例，可选） |
| 某组件的 CSS 变体 / 高级 theming | `references/rendering-cookbook.md` 对应节 |
| Mermaid themeVariables 细节 / 调色板 | `references/mermaid-theming.md`（注意：权威定义已在 `templates/zoom.js`） |
| drawio 复杂架构/包依赖/ER | `references/drawio-guide.md`（含内置 autolayout/validate 脚本） |
| drawio vs mermaid vs 手画HTML 决策 | `references/rendering-engine-guide.md` |

## 四条踩坑铁律

`[HISTORICAL]` 这些规则来自反复出现的实际失败，不允许削弱：

1. **禁用裸 `<pre class="mermaid">`**——无 zoom/pan，图变得极小不可用。骨架的 AGENT-FILL: hero-diagram 槽位已预埋完整的 `.diagram-shell` 结构（HTML + zoom-controls + viewport + canvas + `diagram-source` script 容器），zoom JS 由 render.sh 内联。填槽位时只改 `<script type="text/plain" class="diagram-source">` 里的 Mermaid 源码，不要拆掉外壳。
2. **`stateDiagram-v2` label 解析陷阱**——转换标签解析器极严格，冒号/括号/`<br/>`/HTML 实体会静默失败（"Syntax error"）。含这些字符的标签改用 `flowchart TD` + 圆角节点 + 带引号边标签。
3. **`.node` CSS 类冲突**——禁止把 `.node` 定义为页面级 CSS 类。Mermaid 内部用它做 SVG 定位，页面级 `.node` 样式会泄漏进图表破坏布局。卡片用 `.ve-card`（architecture）或 `.section` 类。
4. `[HISTORICAL]` **C4 用 flowchart 不用 native C4**——`C4Context` 硬编码尖角/字体/蓝色图标，忽略 `themeVariables`。用 `graph TD` + `subgraph` 表达边界。

## 依赖与安装

Mermaid（浏览器 CDN 加载）和手画 HTML/CSS（纯文本）**无外部依赖**，开箱即用。drawio 功能需要两个可选外部软件：

| 依赖 | 何时需要 | macOS | Linux (Debian/Ubuntu) | Windows |
|------|---------|-------|----------------------|---------|
| **draw.io desktop CLI** | drawio 导出 SVG/PNG/PDF | `brew install --cask drawio` | [下载 .deb](https://github.com/jgraph/drawio-desktop/releases) | [下载 .exe](https://github.com/jgraph/drawio-desktop/releases) |
| **Graphviz `dot`** | `autolayout.py`（复杂图 >15 节点自动布局） | `brew install graphviz` | `sudo apt install graphviz` | [下载](https://graphviz.org/download/) |

**[MANDATORY] 调用 drawio 功能前必须检查依赖。** 未安装时**不要静默降级**——先 `ask user` 是否安装，用户同意则安装，拒绝才降级 Mermaid/CSS。详见下方「drawio 集成」段。

## drawio 集成（复杂架构时，内置）

本 skill 内置了 drawio 的最小必需集（`scripts/autolayout.py` + `validate.py` + `repair_png.py` + `styles/built-in/default.json`）。复杂架构图（② 分层架构、⑤ 包依赖图、复杂 ER）不再依赖外部 drawio-skill。详细指南见 `references/drawio-guide.md`。

**`[MANDATORY]` 依赖检查 + 安装确认流程（调用 drawio 前必走）：**

1. **检查 draw.io CLI**：`which drawio || which draw.io`
   - ✅ 已装 → 继续
   - ❌ 未装 → **`ask user`：「检测到 draw.io 未安装。复杂架构图需要它。是否现在安装？」**
     - 用户同意 → 按平台安装（见「依赖与安装」表），装完重新检查
     - 用户拒绝 → 降级 Mermaid/CSS，告知用户

2. **检查 Graphviz**（仅当要用 autolayout 处理 >15 节点大图）：`which dot`
   - ✅ 已装 → 继续
   - ❌ 未装 → **`ask user`：「自动布局大图需要 Graphviz。是否现在安装？」**
     - 用户同意 → `brew install graphviz`（macOS）/ `sudo apt install graphviz`（Linux）
     - 用户拒绝 → 改用手写 XML 小图，或降级 Mermaid

3. 生成 `.drawio`：小图（≤15节点）手写 XML；大图跑 `python3 scripts/autolayout.py graph.json -o diagram.drawio`。**dark 主题页面加 `--theme dark`**（用 paletteDark，否则导出的浅色块在深色背景上刺眼，详见 `drawio-guide.md` 配色对齐段）
4. 校验：`python3 scripts/validate.py diagram.drawio`（结构门）
5. 导出 SVG 嵌入：`drawio -x -f svg -e -o diagram.svg`，SVG 内联进页面容器 + zoom 控件（复用 `templates/zoom.js` 的 zoom 逻辑）

**[HISTORICAL] 不手建 `data-mxgraph`**——交互式 HTML 嵌入的三重编码必须由 CLI 处理。设计阶段首选 SVG 内联（无 bug、无 JS 依赖）。

`[HISTORICAL]` 边的 mxCell 必须含 `<mxGeometry relative="1" as="geometry"/>` 子元素——自闭合边无效。详见 `drawio-guide.md`。

## 副作用操作

| 操作 | 风险 | 规则 |
|------|------|------|
| 写 HTML / `open` 浏览器 | 🟢 低 | 默认允许 |
| `which drawio` / `which dot` 检查 | 🟢 低 | 允许 |
| 🔴 安装软件（`brew install` 等） | 🔴 高 | 系统变更。**必须 ask user 确认**后才跑（见「依赖与安装」段） |
| ⚠️ `drawio -x` CLI 导出 | ⚠️ 中 | Electron 进程，沙箱可能崩溃。依赖检查通过后可跑；崩溃则停，降级 Mermaid |

## 自检清单

`[MANDATORY]` 交付门槛。交付时声明通过项——"看起来还行"不是证据。🔒 = 硬性技术正确性。

- 🔒 **Mermaid 实际渲染**：`.md` 的 Mermaid 块渲染成图表（非 `<pre>` 源码）。每个 `.mermaid-wrap` 有 zoom 控件 + click-to-expand
- 🔒 **无占位符/空章节**：无 `{占位符}`、TODO、未填充模板段
- 🔒 **TOC 锚点无死链**：4+ section 页面导航锚点全部可跳转
- 🔒 **双主题**：light/dark 都正常。Mermaid 用 `prefers-color-scheme` 自动切换；**drawio 导出 SVG 是静态的**——dark 页面必须用 `autolayout.py --theme dark` 或手写 dark 色值生成，不能复用 light 版
- 🔒 **无 overflow**：resize 到不同宽度无内容溢出。grid/flex 子元素 `min-width: 0`
- **主角图就位**：阶段 hero 图紧随 header
- **TL;DR 到位**：3-5 行核心结论
- **UTF-8 中文正常**
- **信息完整**：`.md` 所有章节都有对应呈现（pretty but incomplete = 失败）

## 美学约束（防 AI slop）

- **字体**：禁 Inter/Roboto/Arial/Helvetica/system-ui 作 `--font-body`。从 `mermaid-theming.md` / `rendering-cookbook.md` 选配对字体，每次换不同配对
- **配色**：禁 indigo/violet（`#8b5cf6` 等）、cyan-magenta-pink 霓虹组合。用 terracotta+sage / teal+slate / rose+cranberry / amber+emerald
- **禁用**：emoji 做 section header、渐变文字标题、发光 box-shadow 动画
- **每次换风格**：上次 dark+technical，这次 light+editorial。swap test——换成通用 dark theme 若无区别，说明没设计
