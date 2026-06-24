# 可视化交付物（Visual Deliverable）

> 移植自 [nicobailon/visual-explainer](https://github.com/nicobailon/visual-explainer)。
> 6 个设计阶段 skill 在 Step 5 定稿后，按本规范把 .md 渲染成自包含 .html。
> **.md 是真相源，.html 是视图**——HTML 只做可视化呈现，不产生新内容。

## 目录

- [核心原则](#核心原则)
- [技术约束](#技术约束)
- [页面结构](#页面结构)
- [各阶段可视化重点](#各阶段可视化重点)
- [Anti-Slop 清单](#anti-slop-清单)
- [最小骨架模板](#最小骨架模板)

---

## 核心原则

1. **自包含（Self-contained）** — 单个 .html 文件，内联所有 CSS/JS。不外链本地文件、不依赖构建工具、不依赖 CDN（Mermaid 用内联库或用户本地已有）。双击即可打开。
2. **从定稿 .md 渲染** — HTML 内容严格对应 .md。章节顺序、表格数据、决策结论一一对应。**不要在 HTML 里凭空增加 .md 没有的内容**。
3. **图表优先** — 人类看图比看文字快。.md 里的 Mermaid 代码块在 HTML 里必须渲染成实际图表，不是 `<pre>` 代码块。
4. **打开即评审** — 页面要让人 30 秒内 grasp 住本阶段的核心结论。关键决策、风险、依赖关系要视觉突出。

## 技术约束

| 约束 | 要求 |
|------|------|
| 文件 | 单个 `{deliverable-name}.html`，与 .md 同目录 |
| Mermaid | 用 mermaid.js 渲染。优先内联（`<script>` 标签内嵌 minified 库）；若体积过大，用 CDN script tag 并在页面顶部标注「需联网渲染图表」 |
| CSS | 内联 `<style>`，不外链 |
| JS | 内联 `<script>`，不外链（Mermaid 除外） |
| 字体 | 用系统字体栈（`-apple-system, "Segoe UI", Roboto, sans-serif`），不加载 Web Font |
| 编码 | UTF-8（`<meta charset="utf-8">`），中文正常显示 |
| 响应式 | 基础响应式（`<meta name="viewport">`），桌面优先，移动端可读 |

## 页面结构

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{阶段名} — {主题}</title>
  <style>/* 内联样式，见下方设计语言 */</style>
</head>
<body>
  <header>
    <h1>{阶段名}：{主题}</h1>
    <div class="meta">
      <span>阶段 {N}/6</span> ·
      <span>verdict: pass</span> ·
      <span>生成于 {date}</span>
    </div>
  </header>

  <nav class="toc"><!-- 章节锚点导航 --></nav>

  <main>
    <!-- 按 .md 章节顺序渲染 -->
    <section id="{section-slug}">...</section>
  </main>

  <footer>
    <p>本文档由 {skill-name} 生成。真相源：{deliverable}.md</p>
  </footer>

  <script>/* Mermaid 初始化 */</script>
</body>
</html>
```

### 设计语言（内联 CSS 要点）

- **配色**：中性背景（`#fafafa` / 白），深灰文字（`#1a1a1a`），一个强调色用于标题/链接/关键决策（如 `#2563eb` 蓝）。状态色：✅绿 `#16a34a`、⚠️橙 `#d97706`、❌红 `#dc2626`。
- **排版**：最大宽度 `~860px` 居中，`line-height: 1.7`，章节间距充足。代码块等宽字体 + 浅灰背景。
- **表格**：斑马纹（偶数行浅灰），表头加粗 + 底边框。单元格 `padding: 8px 12px`。
- **决策/风险卡片**：关键决策、❌风险用带左边框的 callout 卡片（`border-left: 4px solid {accent}`），视觉突出。
- **Mermaid 容器**：图表居中，`background: white; padding: 16px; border-radius: 8px;`，防止与页面背景混淆。

## 各阶段可视化重点

每个阶段的 HTML 页面应有不同的「主角图表」——最能体现本阶段结论的图表要放最显眼位置（紧随 header 之后）。

| 阶段 | 主角图表（hero） | 其他图表 |
|------|----------------|---------|
| ① 澄清需求 | **用例图**（Actor × 用例 × 系统边界）| 数据流图、系统间关联图、目标树 |
| ② 系统设计 | **分层架构图** + **状态机图** | Context Map、泳道图、模块划分图 |
| ③ Issue 拆分 | **决策 DAG 图**（节点=issue，边=blocked_by，状态色标）| issue 详情卡片、P 级分布 |
| ④ 非功能设计 | **风险矩阵热力图**（issue × 7 维度，✅⚠️❌着色）| 残余风险登记表、prototype 结论 |
| ⑤ 代码架构 | **包依赖图** + **核心时序图** | 工程目录树、方法签名表、Deep Module 决策 |
| ⑥ 执行计划 | **Wave 依赖 DAG 图**（节点=Wave，标注并行组）| Wave 调度表、并行约束 |

### Hero 图放置规则

主角图表放在 header 之后、正文之前，配一段 **TL;DR**（3-5 行）：本阶段的核心结论是什么。让人不滚动就能 grasp 要点。

```html
<section class="hero">
  <div class="tldr">
    <h2>TL;DR</h2>
    <ul>
      <li>{核心结论 1}</li>
      <li>{核心结论 2}</li>
    </ul>
  </div>
  <div class="mermaid">{主角图表 mermaid 代码}</div>
</section>
```

## Anti-Slop 清单

生成 HTML 前自检——以下情况必须修复：

- [ ] **Mermaid 语法错误** — 所有 ```mermaid 代码块在浏览器能渲染（不是显示源码）。常见错：中文 label 没引号、节点 ID 含特殊字符、`graph` vs `flowchart` 混用
- [ ] **占位符未替换** — 无 `{主题}`、`{TODO}`、`Lorem ipsum`。所有占位符已被实际内容替换
- [ ] **空章节** — 无只有标题没有内容的 section。每个 section 都 substantive
- [ ] **表格错位** — 表格列数与表头一致，无跨行错乱。Markdown 表格转 HTML 时 `|` 对齐正确
- [ ] **死链锚点** — TOC 锚点能跳转到对应 section（`id` 与 `href` 匹配）
- [ ] **外链依赖** — 除 Mermaid 库外无外链 CSS/JS/Font。断网也能看（Mermaid CDN 除外，需标注）
- [ ] **中文乱码** — `<meta charset="utf-8">` 存在，HTML 文件以 UTF-8 保存
- [ ] **颜色对比度** — 文字与背景对比度足够（WCAG AA），浅灰背景上不用浅灰字

## 最小骨架模板

以下是生成 HTML 时可复用的骨架（Mermaid 用 CDN，标注需联网）：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{阶段} — {主题}</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <style>
    :root {
      --bg: #fafafa; --surface: #ffffff; --text: #1a1a1a; --muted: #6b7280;
      --accent: #2563eb; --ok: #16a34a; --warn: #d97706; --err: #dc2626;
      --border: #e5e7eb;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text);
      font-family: -apple-system, "Segoe UI", Roboto, "PingFang SC", sans-serif;
      line-height: 1.7; }
    main, header, footer { max-width: 860px; margin: 0 auto; padding: 0 24px; }
    header { padding-top: 40px; padding-bottom: 24px; border-bottom: 2px solid var(--accent); }
    header h1 { margin: 0 0 8px; }
    .meta { color: var(--muted); font-size: 14px; }
    .toc { max-width: 860px; margin: 24px auto; padding: 0 24px; }
    .toc ul { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
    .toc a { display: inline-block; padding: 4px 12px; background: var(--surface);
      border: 1px solid var(--border); border-radius: 16px; text-decoration: none;
      color: var(--accent); font-size: 14px; }
    section { background: var(--surface); margin: 24px 0; padding: 24px 32px;
      border-radius: 8px; border: 1px solid var(--border); }
    h2 { color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    h3 { margin-top: 28px; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14px; }
    th, td { padding: 8px 12px; border: 1px solid var(--border); text-align: left; }
    th { background: #f3f4f6; font-weight: 600; }
    tbody tr:nth-child(even) { background: #f9fafb; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
    pre { background: #1e293b; color: #e2e8f0; padding: 16px; border-radius: 8px; overflow-x: auto; }
    pre code { background: none; padding: 0; }
    .mermaid { background: var(--surface); padding: 16px; border-radius: 8px;
      border: 1px solid var(--border); text-align: center; margin: 16px 0; }
    .hero { background: var(--surface); border: 1px solid var(--border); border-left: 4px solid var(--accent);
      border-radius: 8px; padding: 24px 32px; margin: 24px 0; }
    .tldr h2 { border: none; margin-top: 0; }
    .callout { border-left: 4px solid var(--accent); padding: 12px 16px; margin: 16px 0;
      background: #eff6ff; border-radius: 0 8px 8px 0; }
    .callout.warn { border-color: var(--warn); background: #fffbeb; }
    .callout.err { border-color: var(--err); background: #fef2f2; }
    .callout.ok { border-color: var(--ok); background: #f0fdf4; }
    footer { padding: 40px 24px; color: var(--muted); font-size: 13px; border-top: 1px solid var(--border); }
  </style>
</head>
<body>
  <header>
    <h1>{阶段名}：{主题}</h1>
    <div class="meta">阶段 {N}/6 · verdict: pass · 生成于 {date}</div>
  </header>

  <nav class="toc">
    <ul>
      <li><a href="#section-1">1. {章节1}</a></li>
      <!-- 更多锚点 -->
    </ul>
  </nav>

  <main>
    <section class="hero">
      <div class="tldr">
        <h2>TL;DR</h2>
        <ul><li>{核心结论}</li></ul>
      </div>
      <div class="mermaid">
{主角图表 mermaid 代码}
      </div>
    </section>

    <section id="section-1">
      <h2>1. {章节标题}</h2>
      <!-- 按 .md 内容渲染 -->
    </section>
  </main>

  <footer>
    <p>本文档由 {skill-name} 生成。真相源：{deliverable}.md · 图表需联网加载 Mermaid</p>
  </footer>

  <script>
    mermaid.initialize({ startOnLoad: true, theme: 'neutral', securityLevel: 'loose' });
  </script>
</body>
</html>
```

> **Mermaid CDN 提示：** 上面骨架用了 CDN script tag。如果目标是完全离线自包含，
> 改为内联 minified mermaid.js（体积约 ~300KB）。优先尝试内联；只有当文件过大
> 导致 Write 失败时才退回 CDN 并在 footer 标注「图表需联网」。
