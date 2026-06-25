---
name: design-visual-explainer
description: >-
  Use when a design phase Step 5b needs a finalized .md rendered to a
  self-contained .html, or when the user says "可视化", "渲染", "画图", "render
  html", "visualize". Produces {deliverable-name}.html with the phase's mandated
  hero diagram. Serves design-clarity / design-architecture / design-issues /
  design-nfr / design-code-arch / design-execution. Delegates complex architecture
  to drawio-skill when available; Mermaid for simple diagrams; hand-built HTML/CSS
  for rich-card and table-heavy deliverables. Not for design decisions — only
  visualizes finalized content. Not for writing code.
---

# Design Visual Explainer

设计阶段（①-⑥）的可视化渲染器。消费定稿 `.md`（真相源），产出自包含 `.html`（可视化视图）。**不产生新内容**——HTML 只做可视化呈现。

> **标记说明：** `[MANDATORY]` = 流程强制要求。`[HISTORICAL]` = 踩坑总结的规则，不允许削弱。无标记 = 强建议。

## 核心目标

把 6 个设计阶段产出的结构化 `.md`（含 Mermaid 代码块、表格、决策记录、AC 清单）渲染成**美观、自包含、浏览器双击即开**的 HTML 页面。每个阶段有强制的「主角图」（hero diagram）放在 header 之后最显眼处。

渲染产物写到 `.xyz-harness/${主题}/{deliverable-name}.html`，与 `.md` 并列。配一段 TL;DR（3-5 行核心结论），让人不滚动就能 grasp 要点。

## 渲染引擎决策

**[MANDATORY] 渲染前先决定引擎。** 三选一：drawio / Mermaid / 手画 HTML/CSS。详细决策矩阵见 `references/rendering-engine-guide.md`（按需加载，勿一次全读）。速查：

| 引擎 | 适用 | 设计阶段典型场景 |
|------|------|-----------------|
| **drawio** | 复杂/精美架构，10+ 节点，云厂商图标 | ② 分层架构图、⑤ 包依赖图（需 `which drawio` + drawio-skill） |
| **Mermaid** | 拓扑图，≤8 节点，自动连线 | ① 用例图、③ 决策 DAG、⑤ 时序图、⑥ Wave DAG、② 状态机 |
| **手画 HTML/CSS** | 富卡片内容、表格矩阵、非节点-箭头图 | ④ 风险矩阵热力图、各阶段的追溯表/决策表/AC 清单 |

**三句话规则：**
- **Mermaid** = 图小、让引擎自动连线。>8 节点或长标签会崩（无法手动修正重叠）。
- **drawio** = 图复杂/要精美/要云图标。需 CLI；delegate 到 drawio-skill，导出 SVG 内联进页面。CLI 不可用则降级 Mermaid。
- **手画 HTML/CSS** = 节点是富卡片（含描述/代码/列表），或本质是表格/时间线。

## 各阶段主角图规范

[MANDATORY] 每个阶段的 HTML **必须**在 header 之后紧接该阶段的 hero 图。下表是 `design-shared/references/loop-skeleton.md` Step 5b 的展开实现：

| 阶段 | 主角图（hero） | 首选引擎 | 渲染要点 |
|------|---------------|---------|---------|
| ① 澄清需求 | **用例图**（Actor × 用例 × 系统边界） | Mermaid `graph` | Actor 用 `((Actor))`，用例用圆角框，系统边界用 `subgraph`。配目标树 + 数据流图作为辅图 |
| ② 系统设计 | **分层架构图** + **状态机图** | drawio 优先 / Mermaid 备选 | 分层图：复杂（10+ 模块/分层/边界）用 drawio 导出 SVG；简单用 Mermaid `graph TD` + `subgraph`。状态机用 Mermaid `stateDiagram-v2`（注意 label 解析陷阱，见下） |
| ③ Issue 拆分 | **决策 DAG**（节点=issue，边=blocked_by，状态色标） | Mermaid `graph TD` | 节点按 P 级着色（P0 红/P1 橙/P2 蓝/P3 灰），resolved/investigating/fog 用边样式区分。迷雾节点标 `?` |
| ④ 非功能设计 | **风险矩阵热力图**（issue × 7 维度） | 手画 HTML `<table>` | 这是手画 HTML 的典型场景——热力图本质是表格，Mermaid/drawio 都不如 `<table>` + 单元格着色（✅绿/⚠️橙/❌红/—灰）。配缓解项回灌表 |
| ⑤ 代码架构 | **包依赖图** + **核心时序图** | drawio 或 Mermaid | 包依赖图：复杂用 drawio；简单用 Mermaid `graph`。时序图用 Mermaid `sequenceDiagram`（含 alt/else 异常路径）。配方法签名表 + 测试矩阵表 |
| ⑥ 执行计划 | **Wave 依赖 DAG**（节点=Wave，标注并行组） | Mermaid `graph TD` | Wave 节点用 `subgraph` 分并行组，blocked_by 用虚线箭头。末尾验收 Wave 独立标注。配调度表 + 测试验收清单 |

## 渲染流程

**[MANDATORY] 按需加载模板与参考——勿一次全读。** 总资产约 3000 行；先确定内容类型，只读对应文件。

1. **Read 定稿 `.md`**（真相源）——确定阶段、主角图类型、内含的 Mermaid 代码块和表格结构
2. **选引擎**——按上面的「各阶段主角图规范」表 + `references/rendering-engine-guide.md` 决策
3. **按需读模板/参考**——只读你的内容类型需要的：

   | 你要渲染… | 读这个（只读这个） |
   |---|---|
   | Mermaid 图（用例/DAG/时序/状态机/Wave） | `templates/mermaid-flowchart.html`（含 zoom/pan JS） |
   | 富卡片架构（每节点带描述/代码/列表） | `templates/architecture.html` |
   | 表格（热力图/追溯表/AC 清单/签名表） | `templates/data-table.html` |
   | 4+ section 的页面（reviews/recaps/大文档） | `references/responsive-nav.md`（导航条） |
   | Mermaid/Chart.js theming 细节 | `references/libraries.md` 的对应段 |
   | CSS 布局/SVG 连线/代码块/折叠区 | `references/css-patterns.md` 的对应段（勿整读） |
   | drawio 嵌入 | `references/rendering-engine-guide.md` 的「Embedding drawio」段 |

4. **生成 HTML**——主角图紧随 header，配 TL;DR。`.md` 的 Mermaid 代码块**必须渲染成实际图表**，不是 `<pre>` 源码
5. **自检**（见下）→ 写到 `.xyz-harness/${主题}/{deliverable-name}.html` → `open` 打开

## Mermaid 关键约束

**[HISTORICAL] 禁用裸 `<pre class="mermaid">`。** 它无 zoom/pan 控件，图会变得极小不可用。必须用 `templates/mermaid-flowchart.html` 的完整 `diagram-shell` 模式（`.diagram-shell` > `.mermaid-wrap` > `.zoom-controls` + `.mermaid-viewport` > `.mermaid-canvas`）连同 ~200 行 zoom/pan JS 一起复制。这条规则来自反复出现的不可用输出。

**[HISTORICAL] `stateDiagram-v2` label 解析陷阱。** 转换标签的解析器极严格——冒号、括号、`<br/>`、HTML 实体会导致静默解析失败（"Syntax error in text"）。标签含这些字符时（如 `cancel()`、`curate: true`），改用 `flowchart TD` + 圆角节点 + 带引号的边标签。`stateDiagram-v2` 只留给单词/纯文本标签。

**[HISTORICAL] Mermaid `.node` CSS 类冲突。** 禁止把 `.node` 定义为页面级 CSS 类——Mermaid 内部用它做 SVG 定位，页面级 `.node` 样式会泄漏进图表破坏布局。卡片组件用命名空间的 `.ve-card` 类。样式化 Mermaid 的 `.node` 只能在 `.mermaid` 作用域下（如 `.mermaid .node rect`）。

**Mermaid theming：** 永远用 `theme: 'base'` + 自定义 `themeVariables`，让配色匹配页面调色板。复杂图用 `layout: 'elk'`（需额外 CDN import）。详见 `references/libraries.md`。

**[HISTORICAL] C4 用 flowchart，不用 native C4。** 用 `graph TD` + `subgraph` 表达 C4 边界。native `C4Context` 硬编码尖角/字体/蓝色图标，忽略 `themeVariables`，总与自定义调色板冲突。

## drawio 集成（可选，复杂架构时）

当引擎决策选了 drawio（② 分层架构、⑤ 包依赖图等复杂场景）：

1. 检查 `which drawio`——不可用则降级 Mermaid
2. **delegate 到 drawio-skill** 生成 `.drawio` + 导出 SVG（`drawio -x -f svg -e`）——**不要在本 skill 内手写 drawio XML**
3. 把导出的 SVG 内联进 HTML 页面容器，加 zoom 控件（复用 mermaid 的 zoom JS）
4. **[HISTORICAL] 不要手建 `data-mxgraph` 属性**——drawio 的 `-f html` 处理 JSON/HTML/XML 三重编码；手建会静默损坏 XML 实体。用 CLI 导出后整体嵌入。

详见 `references/rendering-engine-guide.md` 的「Embedding drawio diagrams」段。配色对齐：让 drawio-skill 用匹配页面 CSS 变量的调色板，或用 CSS 覆盖内联 SVG 的关键色。

## 副作用操作

| 操作 | 风险 | 规则 |
|------|------|------|
| 写 HTML 到 `.xyz-harness/` | 🟢 低 | 默认允许，核心产出 |
| `open` / `xdg-open` 打开浏览器 | 🟢 低 | 写完后默认允许 |
| `which drawio`（只读检查） | 🟢 低 | 允许 |
| ⚠️ `drawio -x ...` CLI 导出（经 drawio-skill） | ⚠️ 中 | 启动 Electron 进程写文件，沙箱可能崩溃。`which drawio` 成功后可跑；崩溃/卡住则停止重试，降级 Mermaid |
| 🔴 `surf gemini --generate-image` | 🔴 高 | prompt 发给外部 AI 服务。session 内首次调用前确认 |
| 🔴 `scripts/share.sh`（Vercel 部署） | 🔴 高 | 发布公开 URL，可能被缓存/索引。部署前确认 |

## 自检清单

**[MANDATORY] 这是交付门槛，不是建议。** 交付时声明哪些项通过——"看起来还行"不是证据。🔒 = 硬性技术正确性。

- 🔒 **Mermaid 实际渲染**：`.md` 的 Mermaid 代码块渲染成了图表（不是 `<pre>` 源码）。每个 `.mermaid-wrap` 有 zoom 控件 + click-to-expand
- 🔒 **无占位符/空章节**：无 `{占位符}`、无 TODO、无未填充的模板段
- 🔒 **TOC 锚点无死链**：4+ section 的页面导航锚点全部可跳转
- 🔒 **双主题**：light/dark mode 都正常，不是坏的
- 🔒 **无 overflow**：resize 到不同宽度无内容溢出。grid/flex 子元素加 `min-width: 0`
- **主角图就位**：该阶段的 hero 图紧随 header，最显眼位置
- **TL;DR 到位**：3-5 行核心结论，不滚动就能 grasp
- **UTF-8 中文正常**：中文渲染无乱码
- **信息完整**：`.md` 的所有章节都在 HTML 中有对应呈现（pretty but incomplete = 失败）

## 美学约束（防 AI slop）

- **字体**：禁用 Inter/Roboto/Arial/Helvetica/system-ui 作 `--font-body`。从 `references/libraries.md` 选配对字体，每次换不同配对
- **配色**：禁用 indigo/violet（`#8b5cf6` 等）、cyan-magenta-pink 霓虹组合。用 terracotta+sage / teal+slate / rose+cranberry / amber+emerald / deep blue+gold
- **禁用**：emoji 图标做 section header、渐变文字标题、发光 box-shadow 动画、三色窗口装饰的点
- **每次换风格**：上次 dark+technical，这次 light+editorial。swap test——换成通用 dark theme 若无区别，说明没设计

详细反模式见原 visual-explainer 的 Anti-Patterns 段（本 skill 的 CSS/templates 资产继承同一套审美标准）。
