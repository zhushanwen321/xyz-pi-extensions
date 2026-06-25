# drawio 指南：架构 / 包依赖 / ER 图 + SVG 嵌入

本 skill 内置了 drawio-skill 的最小必需集（`scripts/` + `styles/`），用于复杂架构图（10+节点）、包依赖图、ER 图。**按需读**——只在 SKILL.md 的引擎决策选了 drawio 时查。

> 来源：从 [drawio-skill](https://github.com/Agents365-ai/drawio-skill) v1.15.0 精简 vendor。砍掉了语言 import 脚本（5个）、shapesearch + 10k 形状索引（436KB）、aiicons、style Learn 流程、备选预设——设计阶段从设计意图手写图，不需要代码扫描或云厂商图标。

## 前置：检查 CLI + 依赖安装确认

**`[MANDATORY]` 调用 drawio 功能前必须检查依赖，未装时 ask user，勿静默降级。**

### 1. 检查 draw.io CLI

```bash
if command -v drawio &>/dev/null; then DRAWIO="drawio"
elif command -v draw.io &>/dev/null; then DRAWIO="draw.io"
elif [ -f "/Applications/draw.io.app/Contents/MacOS/draw.io" ]; then DRAWIO="/Applications/draw.io.app/Contents/MacOS/draw.io"
elif grep -qi microsoft /proc/version 2>/dev/null && [ -f "/mnt/c/Program Files/draw.io/draw.io.exe" ]; then DRAWIO="/mnt/c/Program Files/draw.io/draw.io.exe"
else echo "NOT_FOUND"; fi
```

- ✅ 找到 → `$DRAWIO` 替代后续命令里的 `drawio`
- ❌ `NOT_FOUND` → **ask user**：「检测到 draw.io 未安装。复杂架构图需要它（SVG 导出）。是否现在安装？」
  - 同意 macOS → `brew install --cask drawio`；Linux → 下载 `.deb`；Windows → 下载 `.exe`。装完重检。
  - 拒绝 → 降级 Mermaid（拓扑）或手画 CSS 卡片（富内容），告知用户已降级。

**沙箱崩溃**（如 codex.app，`drawio --version` 无输出/崩溃）→ 不重试，等同未安装，走 ask user 或降级。

### 2. 检查 Graphviz（仅大图 autolayout 时）

```bash
command -v dot &>/dev/null && echo "OK" || echo "NOT_FOUND"
```

- ✅ `OK` → 可用 `scripts/autolayout.py`
- ❌ `NOT_FOUND` → **ask user**：「自动布局大图（>15节点）需要 Graphviz。是否现在安装？」
  - 同意 macOS → `brew install graphviz`；Linux → `sudo apt install graphviz`
  - 拒绝 → 改用手写 XML（仅 ≤15 节点可行），或降级 Mermaid

---

## 工作流（设计阶段简化版，4 步）

### 1. 生成 .drawio

**小图（≤15节点）：手写 XML**（结构见下节）。
**大图（>15节点/包依赖/多层嵌套）：用 autolayout**。

写 graph JSON 再跑 autolayout：
```bash
python3 scripts/autolayout.py graph.json -o diagram.drawio
```

graph JSON 格式（嵌套分组用 `/` 分隔路径，autolayout 会画成分层容器框）：
```json
{
  "direction": "TB",
  "nodes": [
    {"id": "api", "label": "API Gateway", "group": "gateway"},
    {"id": "order", "label": "Order Service", "group": "core/domain"},
    {"id": "db", "label": "PostgreSQL", "group": "infra", "style": "shape=cylinder3;whiteSpace=wrap;html=1"}
  ],
  "edges": [
    {"source": "api", "target": "order", "label": "路由"},
    {"source": "order", "target": "db", "label": "读写"}
  ]
}
```
- `group` 用 `/` 嵌套：`"core/domain"` → core 容器内的 domain 子容器
- `style` 可选（手写 style 覆盖默认）；无 style 的分组节点用 `styles/built-in/default.json` 的调色板按组着色
- `--mono` 禁用分组着色（单色框）

### 2. 校验

```bash
python3 scripts/validate.py diagram.drawio
```
快速结构校验（不需启动 drawio）：悬空边、重复/保留 id(0/1)、断裂的 parent 引用、非正尺寸、坐标偏离网格、兄弟重叠。exit 1 = 有错误。

### 3. 导出 SVG（设计阶段首选）

```bash
drawio -x -f svg -e -o diagram.svg diagram.drawio
```

`-e` 嵌入 XML（保持可编辑）；SVG 是纯文本，**没有 PNG 的 IEND 截断 bug**，没有 2576px 视觉上限。这是嵌入 HTML 的最干净路径。

> PNG 导出（若需）：`drawio -x -f png -e -s 2 -o diagram.drawio.png diagram.drawio`，然后 `python3 scripts/repair_png.py diagram.drawio.png`（修复 IEND 截断）。但设计阶段嵌入首选 SVG。

### 4. 嵌入 HTML

把导出的 SVG 内联进页面容器，加 zoom 控件（复用 `rendering-cookbook.md` 的 Mermaid zoom JS——它对任何元素生效）：

```html
<div class="drawio-wrap mermaid-wrap">  <!-- 复用 mermaid-wrap 样式 -->
  <div class="zoom-controls">...</div>
  <div class="mermaid-viewport">
    <!-- drawio -x -f svg -e 导出的 SVG 标记粘贴到这里 -->
  </div>
</div>
```

**[HISTORICAL] 不要手建 `data-mxgraph` 属性**。交互式嵌入（`drawio -x -f html`）的 JSON/HTML/XML 三重编码必须由 CLI 处理；手建会静默损坏 XML 实体。要么用 SVG 内联（首选），要么用 CLI 导出的 HTML 整体嵌入。

**配色对齐**：drawio 的 `default.json` 有自己的调色板。嵌入 visual-explainer 页面时，要么 (a) 在 graph JSON 里传匹配页面 CSS 变量的 style，要么 (b) 用 CSS 覆盖内联 SVG 的 fill/stroke。

---

## drawio XML 结构（手写小图时）

```xml
<mxfile>
  <diagram name="架构图">
    <mxGraphModel>
      <root>
        <mxCell id="0"/>              <!-- 必须有：根 cell -->
        <mxCell id="1" parent="0"/>   <!-- 必须有：默认 parent -->
        <!-- 用户形状从 id=2 开始 -->
        <mxCell id="2" value="API Gateway" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="100" y="40" width="120" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="3" value="Order Service" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1">
          <mxGeometry x="100" y="160" width="120" height="60" as="geometry"/>
        </mxCell>
        <!-- 边：必须有 mxGeometry 子元素，自闭合无效 -->
        <mxCell id="4" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="2" target="3">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

**铁律：**
- `id="0"` 和 `id="1"` 必须有，用户形状从 `id="2"` 起
- 所有形状 `parent="1"`（或在容器 id 里），`html=1` 必加
- **边的 mxCell 必须含 `<mxGeometry relative="1" as="geometry"/>` 子元素**——自闭合边无效
- 坐标对齐到 10 的倍数；换行用 `&#xa;`；转义 `&`/`<`/`>`/`"`
- XML 注释里**不要用 `--`**

---

## 常用形状速查（手写 style 字符串）

| 用途 | style |
|------|-------|
| 服务/组件（圆角框） | `rounded=1;whiteSpace=wrap;html=1` |
| 数据库（圆柱） | `shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1` |
| 队列 | `shape=queue;whiteSpace=wrap;html=1` |
| 判断（菱形） | `rhombus;whiteSpace=wrap;html=1` |
| 外部系统（云） | `shape=cloud;whiteSpace=wrap;html=1` |
| 容器/分层（泳道） | `swimlane;startSize=30;whiteSpace=wrap;html=1;container=1` |
| 边：正交连线 | `edgeStyle=orthogonalEdgeStyle;html=1` |
| 边：虚线（异步/可选） | `edgeStyle=orthogonalEdgeStyle;html=1;dashed=1` |
| ER 表 | `shape=table;startSize=30;container=1;collapsible=1;childLayout=tableLayout;fixedRows=1;rowLines=0;` |
| ER 行 | `shape=tableRow;horizontal=0;startSize=0;swimlaneHead=0;swimlaneBody=0;strokeColor=inherit;top=0;left=0;bottom=0;right=0;collapsible=0;dropTarget=0;fillColor=none;points=[[0,0.5],[1,0.5]];portConstraint=eastwest;` |

---

## 架构图布局要点

- **分层（tier）用 swimlane 容器**：每个 tier 一个 `swimlane` 容器，服务放里面
- **≥4 个 tier 用 TB（上到下）**；≤3 用 LR（左到右）
- **同层服务等宽对齐**；跨层用正交边
- **按 tier 着色**：gateway 蓝、domain 绿、infra 橙、external 灰
- **复杂图（>15节点）用 autolayout**——手算坐标易重叠，Graphviz 的 `splines=ortho` 自动避让

---

## ER 图要点

- 用 `shape=table` 容器 + `shape=tableRow` 行（结构化表格式 ER）
- 外键关系用 `ERmandOne`/`ERoneToMany` 等 edge style（虚线 + 箭头标记）
- 复杂 ER（9+ 实体）用 autolayout 的 `direction: "LR"`
- 简单 ER（≤8 实体）用 Mermaid `erDiagram` 更快——见引擎决策表

---

## 内置脚本清单

| 脚本 | 用途 | 依赖 |
|------|------|------|
| `scripts/autolayout.py` | graph JSON → Graphviz dot 布局 → .drawio XML（含坐标+正交边+分组容器框） | Graphviz `dot` + `styles/built-in/default.json` |
| `scripts/validate.py` | .drawio 结构校验（悬空边/重复id/断裂parent/坐标偏移/重叠） | 无（纯 stdlib） |
| `scripts/repair_png.py` | 修复 `-e` PNG 的 IEND 截断（issue #8）。SVG 导出不受影响 | 无 |

**不支持**（已砍掉，设计阶段不需要）：代码 import 扫描（pyimports/jsimports/goimports/rustimports/pyclasses）、10k 形状搜索（shapesearch + shape-index.json.gz）、AI 品牌图标（aiicons）、style Learn 流程、浏览器 URL fallback。
