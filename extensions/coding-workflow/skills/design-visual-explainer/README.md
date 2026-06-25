# design-visual-explainer（设计阶段可视化渲染器）

> 这是一个**可调用的 skill**——有 `SKILL.md`，会被 skill-resolver 识别。专门服务 design-workflow 的 6 个设计阶段（①-⑥）的 Step 5b HTML 渲染。

## 定位

把定稿的 `.md`（真相源）渲染成自包含 `.html`（可视化视图）。**不产生新内容**——只做可视化呈现。

与 `design-shared/` 的关系：`design-shared` 是不可调用的共享参考目录（无 `SKILL.md`）；本 skill 是可调用的渲染器，被 `design-shared/references/loop-skeleton.md` Step 5b 的 fresh subagent 加载。

## 资产来源

本 skill 的 `templates/`、`references/css-patterns.md`、`references/libraries.md`、`references/responsive-nav.md`、`scripts/share.sh` 从 [visual-explainer](https://github.com/nicobailon/visual-explainer)（v0.7.1）vendor 而来，做了以下裁剪：

| 复用 | 裁剪掉 | 原因 |
|------|--------|------|
| 4 个 templates（architecture / mermaid-flowchart / data-table / slide-deck） | `commands/*.md`（8 个通用命令模板） | 设计阶段不用 diff-review/plan-review/project-recap 等通用命令 |
| 3 个 references（css-patterns / libraries / responsive-nav） | `slide-patterns.md`（1406 行） | 幻灯片是次要场景；按需才加载，保留 slide-deck.html 模板即可 |
| share.sh | `.claude-plugin/plugin.json` | 非本包机制 |

vendor 后这两个版本（本包内 vs `~/.agents/skills/visual-explainer`）会分别演化。**本包内版本为设计工作流的权威版本。**

## 与 drawio-skill 的关系

本 skill **不内联** drawio-skill。当引擎决策选 drawio（复杂架构图）时：

1. 检查 `which drawio` 是否可用
2. 可用 → delegate 到已安装的 `drawio-skill`（`~/.agents/skills/drawio-skill`）生成 `.drawio` + 导出 SVG
3. 把 SVG 内联进本 skill 产出的 HTML 页面
4. 不可用 → 降级到 Mermaid（简单拓扑）或手画 HTML/CSS（富卡片）

drawio-skill 保持独立 skill，可单独升级。本 skill 只负责「把 drawio 产物嵌入页面」。

## 文件清单

| 文件 | 作用 | 何时读 |
|------|------|--------|
| `SKILL.md` | 渲染路由 + 各阶段主角图规范 + 自检清单 | Step 5b 加载本 skill 时必读 |
| `references/rendering-engine-guide.md` | drawio vs Mermaid vs 手画 HTML 决策矩阵 + drawio 嵌入工作流 | 选引擎时按需读 |
| `references/css-patterns.md` | CSS 布局/SVG 连线/代码块/折叠区/Mermaid zoom 模式 | 需要具体 CSS 模式时查对应段（勿整读） |
| `references/libraries.md` | Mermaid/Chart.js/anime.js 的 CDN + theming | 用这些库时查对应段 |
| `references/responsive-nav.md` | 4+ section 页面的侧栏 TOC + 移动端导航条 | 渲染大文档（多 section）时读 |
| `templates/*.html` | 4 种页面类型的参考模板 | 按内容类型读对应的一个 |
| `scripts/share.sh` | Vercel 部署（可选，发布公开 URL） | 用户明确要分享时 |
