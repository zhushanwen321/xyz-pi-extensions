# 渲染 Cookbook

设计阶段 HTML 渲染的 CSS/JS 模式手册。**按需查对应段，勿整读。** SKILL.md 的四条踩坑铁律适用于本文件所有模式。

> 来源：从 visual-explainer v0.7.1 的 css-patterns.md / libraries.md / responsive-nav.md + 3 templates 提炼。

---

## 1. 主题基础：`:root` 变量 + 双主题

**选一套机制：`prefers-color-scheme`（推荐，自动跟随系统）或 `data-theme` 手动 toggle。勿混用。**

```css
:root {
  --font-body: 'Outfit', system-ui, sans-serif;
  --font-mono: 'Space Mono', 'SF Mono', Consolas, monospace;

  --bg: #f8f9fa;
  --surface: #ffffff;
  --surface-2: #f1f3f5;          /* 次级背景（表格头、内卡、callout） */
  --surface-elevated: #ffffff;
  --border: rgba(0, 0, 0, 0.08);
  --border-bright: rgba(0, 0, 0, 0.15);
  --text: #1a1a2e;
  --text-dim: #6b7280;
  --accent: #0891b2;
  --accent-dim: rgba(8, 145, 178, 0.1);

  /* 语义状态色（热力图/AC 清单/追溯表都靠这些）—— 必须定义，勿依赖 fallback */
  --green: #059669;       --green-dim: rgba(5, 150, 105, 0.1);
  --red: #ef4444;         --red-dim: rgba(239, 68, 68, 0.1);
  --orange: #d97706;      --orange-dim: rgba(217, 119, 6, 0.1);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface-2: #1c2333;
    --surface-elevated: #1c2333;
    --border: rgba(255, 255, 255, 0.06);
    --border-bright: rgba(255, 255, 255, 0.12);
    --text: #e6edf3;
    --text-dim: #8b949e;
    --accent: #22d3ee;
    --accent-dim: rgba(34, 211, 238, 0.12);

    --green: #4ade80;     --green-dim: rgba(74, 222, 128, 0.1);
    --red: #f87171;       --red-dim: rgba(248, 113, 113, 0.1);
    --orange: #fbbf24;    --orange-dim: rgba(251, 191, 36, 0.1);
  }
}
```

**换调色板规则**（每次渲染换一套，防 AI slop）：
- terracotta+sage：`--accent:#c2410c` / `--green:#4d7c0f` / `--orange:#b45309`
- rose+cranberry：`--accent:#be123c` / `--green:#16a34a` / `--orange:#d97706`
- amber+emerald：`--accent:#d97706` / `--green:#059669` / `--orange:#c2410c`
- 禁：indigo/violet（`#8b5cf6`/`#7c3aed`）、霓虹 cyan-magenta-pink

**页面氛围**（微妙的背景，二选一）：
```css
body { background: var(--bg);
  background-image: radial-gradient(ellipse at 50% 0%, var(--accent-dim) 0%, transparent 60%); }
/* 或点阵网格 */
body { background-color: var(--bg);
  background-image: radial-gradient(circle, var(--border) 1px, transparent 1px); background-size: 24px 24px; }
```

---

## 2. Mermaid zoom/pan 外壳（`[HISTORICAL]` 必须完整使用）

> **⚠️ 权威已转移（2026-06 改造）。** 本节的 CSS + JS 已抽到公共文件，**不要再从这里复制代码块**：
> - **CSS** → `templates/design.css`（`.mermaid-wrap` / `.zoom-controls` / `.diagram-shell` 等类）
> - **JS**（zoom/pan/fit/expand + scroll-spy）→ `templates/zoom.js`
> - 产物骨架 `templates/skeletons/{phase}.html` 已预埋完整的 `.diagram-shell` HTML 结构作为 AGENT-FILL: hero-diagram 槽位，render.sh 自动内联 CSS/JS。
>
> **本节保留下方代码仅作历史参考**（了解 shell 的结构契约）。正常渲染流程看 SKILL.md「渲染流程」段，不读本节。

裸 `<pre class="mermaid">` 无 zoom，图极小不可用。**每个 Mermaid 图用这个完整 shell。** 多图共存靠 `querySelectorAll('.diagram-shell').forEach(initDiagram)`。

### HTML 结构（每图一个）

```html
<section class="diagram-shell">
  <p class="diagram-shell__hint">Ctrl/Cmd + wheel to zoom. Scroll to pan. Drag to pan when zoomed. Double-click to fit.</p>
  <div class="mermaid-wrap">
    <div class="zoom-controls">
      <button type="button" data-action="zoom-in" title="Zoom in">+</button>
      <button type="button" data-action="zoom-out" title="Zoom out">&minus;</button>
      <button type="button" data-action="zoom-fit" title="Smart fit">&#8634;</button>
      <button type="button" data-action="zoom-one" title="1:1 zoom">1:1</button>
      <button type="button" data-action="zoom-expand" title="Open full size">&#x26F6;</button>
      <span class="zoom-label">Loading...</span>
    </div>
    <div class="mermaid-viewport">
      <div class="mermaid mermaid-canvas"></div>
    </div>
  </div>
  <script type="text/plain" class="diagram-source">
graph TD
  A[Push to main] --> B{Branch?}
  B -->|feature| C[Create PR]
  </script>
</section>
```

Mermaid 源放 `<script type="text/plain" class="diagram-source">`（不是 `<pre>`），JS 读 `textContent.trim()` 传给 `mermaid.render(id, code)`。

### CSS

```css
.mermaid-wrap {
  position: relative; background: var(--surface); border: 1px solid var(--border);
  border-radius: 12px; padding: 32px 24px; overflow: auto; margin-bottom: 24px;
  display: flex; justify-content: center; align-items: center; min-height: 400px;
  cursor: grab;
}
.mermaid-wrap.is-panning { cursor: grabbing; user-select: none; }
.zoom-controls {
  position: absolute; top: 8px; right: 8px; display: flex; gap: 2px; z-index: 10;
  background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 2px;
}
.zoom-controls button {
  width: 28px; height: 28px; border: none; background: transparent; color: var(--text-dim);
  font-family: var(--font-mono); font-size: 14px; cursor: pointer; border-radius: 4px;
  display: flex; align-items: center; justify-content: center; transition: background .15s, color .15s;
}
.zoom-controls button:hover { background: var(--border); color: var(--text); }
.diagram-shell { position: relative; }
.diagram-shell__hint { font-family: var(--font-mono); font-size: 11px; color: var(--text-dim); margin-bottom: 8px; opacity: .7; }
.mermaid-viewport { position: relative; overflow: hidden; width: 100%; height: 100%; min-height: 300px; }
.mermaid-canvas { position: absolute; top: 0; left: 0; }
.zoom-label { font-family: var(--font-mono); font-size: 10px; color: var(--text-dim); padding: 0 6px; white-space: nowrap; }
/* Mermaid SVG 字体覆盖 */
.mermaid .nodeLabel { font-family: var(--font-body) !important; font-size: 16px !important; }
.mermaid .edgeLabel { font-family: var(--font-mono) !important; font-size: 13px !important; }
.mermaid .node rect, .mermaid .node circle, .mermaid .node polygon { stroke-width: 1.5px !important; }
```

### JS（完整 zoom/pan/fit/expand 模块，~360 行）

```html
<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
import elkLayouts from 'https://cdn.jsdelivr.net/npm/@mermaid-js/layout-elk/dist/mermaid-layout-elk.esm.min.mjs';

const config = {
  fitPadding: 28, minHeight: 360, maxHeightPx: 960, maxHeightVh: 0.84,
  maxInitialZoom: 1.8, minZoom: 0.08, maxZoom: 6.5, zoomStep: 0.14, readabilityFloor: 0.58
};
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
let activeDrag = null;
addEventListener('mousemove', (e) => activeDrag?.onMove(e));
addEventListener('mouseup', () => { activeDrag?.onEnd(); activeDrag = null; });
const isDark = matchMedia('(prefers-color-scheme: dark)').matches;

mermaid.registerLayoutLoaders(elkLayouts);
mermaid.initialize({
  startOnLoad: false, theme: 'base', look: 'classic', layout: 'elk',
  themeVariables: {
    fontFamily: "'Bricolage Grotesque', system-ui, sans-serif", fontSize: '16px',
    primaryColor: isDark ? '#115e59' : '#ccfbf1',
    primaryBorderColor: isDark ? '#2dd4bf' : '#0d9488',
    primaryTextColor: isDark ? '#ccfbf1' : '#134e4a',
    secondaryColor: isDark ? '#0c4a6e' : '#e0f2fe',
    secondaryBorderColor: isDark ? '#38bdf8' : '#0369a1',
    secondaryTextColor: isDark ? '#ccfbf1' : '#134e4a',
    tertiaryColor: isDark ? '#2e2618' : '#fffbeb',
    tertiaryBorderColor: isDark ? '#fbbf24' : '#d97706',
    tertiaryTextColor: isDark ? '#ccfbf1' : '#134e4a',
    lineColor: isDark ? '#5eead4' : '#5f8a85',
    noteBkgColor: isDark ? '#115e59' : '#fefce8',
    noteTextColor: isDark ? '#ccfbf1' : '#134e4a',
    noteBorderColor: isDark ? '#fbbf24' : '#d97706',
  }
});

function initDiagram(shell) {
  const wrap = shell.querySelector('.mermaid-wrap');
  const viewport = shell.querySelector('.mermaid-viewport');
  const canvas = shell.querySelector('.mermaid-canvas');
  const source = shell.querySelector('.diagram-source');
  const label = shell.querySelector('.zoom-label');
  if (!wrap || !viewport || !canvas || !source || !label) { console.error('initDiagram: missing elements', shell); return; }

  let zoom = 1, fitMode = 'contain', panX = 0, panY = 0, svgW = 0, svgH = 0;
  let sx = 0, sy = 0, spx = 0, spy = 0, touchDist = 0, touchCx = 0, touchCy = 0;

  function constrainPan() {
    const vpW = viewport.clientWidth, vpH = viewport.clientHeight;
    const rW = svgW * zoom, rH = svgH * zoom, pad = config.fitPadding;
    panX = (rW + pad*2 <= vpW) ? (vpW - rW)/2 : clamp(panX, vpW - rW - pad, pad);
    panY = (rH + pad*2 <= vpH) ? (vpH - rH)/2 : clamp(panY, vpH - rH - pad, pad);
  }
  function applyTransform() {
    const svg = canvas.querySelector('svg');
    if (!svg || !svgW) return;
    constrainPan();
    svg.style.width = (svgW * zoom) + 'px'; svg.style.height = (svgH * zoom) + 'px';
    canvas.style.transform = `translate(${panX}px, ${panY}px)`;
    label.textContent = Math.round(zoom * 100) + '% \u2014 ' + fitMode;
  }
  function canPan() {
    return svgW*zoom + config.fitPadding*2 > viewport.clientWidth
        || svgH*zoom + config.fitPadding*2 > viewport.clientHeight;
  }
  function computeSmartFit() {
    const vpW = viewport.clientWidth, vpH = viewport.clientHeight;
    const aW = Math.max(80, vpW - config.fitPadding*2), aH = Math.max(80, vpH - config.fitPadding*2);
    const contain = Math.min(aW/svgW, aH/svgH);
    let z = contain, mode = 'contain';
    if (contain < config.readabilityFloor) {
      const chartR = svgH/svgW, vpR = vpH/Math.max(vpW, 1);
      if (chartR >= vpR) { z = aW/svgW; mode = 'width-priority'; }
      else { z = aH/svgH; mode = 'height-priority'; }
    }
    return { zoom: clamp(z, config.minZoom, config.maxInitialZoom), mode };
  }
  function fitDiagram() {
    if (!svgW) return;
    const fit = computeSmartFit();
    zoom = fit.zoom; fitMode = fit.mode;
    panX = (viewport.clientWidth - svgW*zoom)/2; panY = (viewport.clientHeight - svgH*zoom)/2;
    applyTransform();
  }
  function setOneToOne() {
    zoom = clamp(1, config.minZoom, config.maxZoom); fitMode = '1:1';
    panX = (viewport.clientWidth - svgW*zoom)/2; panY = (viewport.clientHeight - svgH*zoom)/2;
    applyTransform();
  }
  function zoomAround(factor, cx, cy) {
    const next = clamp(zoom * factor, config.minZoom, config.maxZoom);
    const ratio = next / zoom;
    panX = cx - ratio * (cx - panX); panY = cy - ratio * (cy - panY);
    zoom = next; fitMode = 'custom'; applyTransform();
  }
  function readSvgNaturalSize(svg) {
    let w = 0, h = 0;
    if (svg.viewBox?.baseVal?.width > 0) { w = svg.viewBox.baseVal.width; h = svg.viewBox.baseVal.height; }
    if (!w) { w = parseFloat(svg.getAttribute('width')) || 0; h = parseFloat(svg.getAttribute('height')) || 0; }
    if (!w) { const b = svg.getBBox(); w = b.width; h = b.height; }
    if (!w) { const r = svg.getBoundingClientRect(); w = r.width || 1000; h = r.height || 700; }
    if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    return { w, h };
  }
  function setAdaptiveHeight() {
    if (!svgW) return;
    const usableW = Math.max(280, wrap.getBoundingClientRect().width - 2);
    const idealH = (svgH/svgW) * usableW + config.fitPadding*2;
    const maxVp = Math.floor(innerHeight * config.maxHeightVh);
    const hardMax = Math.min(config.maxHeightPx, Math.max(config.minHeight + 40, maxVp));
    wrap.style.height = Math.round(clamp(idealH, config.minHeight, hardMax)) + 'px';
  }
  function openInNewTab() {
    const svg = canvas.querySelector('svg'); if (!svg) return;
    const clone = svg.cloneNode(true);
    clone.style.width = ''; clone.style.height = '';
    const bg = isDark ? '#042f2e' : '#f0fdfa';
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Diagram</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:${bg};padding:40px;box-sizing:border-box}svg{max-width:100%;max-height:90vh;height:auto}</style></head><body>${clone.outerHTML}</body></html>`;
    open(URL.createObjectURL(new Blob([html], { type: 'text/html' })), '_blank');
  }
  async function render() {
    try {
      const code = source.textContent.trim();
      if (!code) { label.textContent = 'Error: Empty source'; return; }
      const id = 'diagram-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const { svg } = await mermaid.render(id, code);
      canvas.innerHTML = svg;
      const svgNode = canvas.querySelector('svg');
      if (!svgNode) { label.textContent = 'Error: No SVG'; return; }
      const size = readSvgNaturalSize(svgNode);
      svgW = size.w; svgH = size.h;
      svgNode.removeAttribute('width'); svgNode.removeAttribute('height');
      svgNode.style.maxWidth = 'none'; svgNode.style.display = 'block';
      setAdaptiveHeight(); fitDiagram();
    } catch (err) { console.error('Mermaid render failed:', err); label.textContent = 'Error: ' + (err.message || 'Render failed'); }
  }
  const actions = {
    'zoom-in': () => zoomAround(1 + config.zoomStep, viewport.clientWidth/2, viewport.clientHeight/2),
    'zoom-out': () => zoomAround(1/(1+config.zoomStep), viewport.clientWidth/2, viewport.clientHeight/2),
    'zoom-fit': fitDiagram, 'zoom-one': setOneToOne, 'zoom-expand': openInNewTab
  };
  Object.entries(actions).forEach(([a, h]) => wrap.querySelector(`[data-action="${a}"]`)?.addEventListener('click', h));
  viewport.addEventListener('dblclick', fitDiagram);
  viewport.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault(); const rect = viewport.getBoundingClientRect();
      const f = e.deltaY < 0 ? 1+config.zoomStep : 1/(1+config.zoomStep);
      zoomAround(f, e.clientX - rect.left, e.clientY - rect.top); return;
    }
    if (canPan()) { e.preventDefault(); panX -= e.deltaX; panY -= e.deltaY; applyTransform(); }
  }, { passive: false });
  viewport.addEventListener('mousedown', (e) => {
    if (e.target.closest('.zoom-controls') || !canPan()) return;
    wrap.classList.add('is-panning'); sx = e.clientX; sy = e.clientY; spx = panX; spy = panY; e.preventDefault();
    activeDrag = {
      onMove: (ev) => { panX = spx + (ev.clientX - sx); panY = spy + (ev.clientY - sy); applyTransform(); },
      onEnd: () => wrap.classList.remove('is-panning')
    };
  });
  viewport.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; spx = panX; spy = panY; }
    else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX, dy = e.touches[0].clientY - e.touches[1].clientY;
      touchDist = Math.sqrt(dx*dx + dy*dy);
      const r = viewport.getBoundingClientRect();
      touchCx = (e.touches[0].clientX + e.touches[1].clientX)/2 - r.left;
      touchCy = (e.touches[0].clientY + e.touches[1].clientY)/2 - r.top;
    }
  }, { passive: true });
  viewport.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && canPan()) {
      if (touchDist > 0) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; spx = panX; spy = panY; touchDist = 0; }
      e.preventDefault(); panX = spx + (e.touches[0].clientX - sx); panY = spy + (e.touches[0].clientY - sy); applyTransform();
    } else if (e.touches.length === 2 && touchDist > 0) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX, dy = e.touches[0].clientY - e.touches[1].clientY;
      const d = Math.sqrt(dx*dx + dy*dy); zoomAround(d/touchDist, touchCx, touchCy); touchDist = d;
    }
  }, { passive: false });
  new ResizeObserver(() => { if (svgW) { setAdaptiveHeight(); fitDiagram(); } }).observe(wrap);
  render();
}
document.querySelectorAll('.diagram-shell').forEach(initDiagram);
</script>
```

---

## 3. 卡片组件（架构概览、决策记录）

`[HISTORICAL]` **卡片类用 `.ve-card` 或 `.section`，绝不用 `.node`**（Mermaid 内部占用，会破坏 SVG 定位）。

```css
.ve-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 20px; position: relative; }
.ve-card--accent-a { border-left: 3px solid var(--accent); }
.ve-card--elevated { background: var(--surface-elevated); box-shadow: 0 2px 8px rgba(0,0,0,.08), 0 1px 2px rgba(0,0,0,.04); }
.ve-card--hero { background: color-mix(in srgb, var(--surface) 92%, var(--accent) 8%); box-shadow: 0 4px 20px rgba(0,0,0,.08); border-color: color-mix(in srgb, var(--border) 50%, var(--accent) 50%); }
.ve-card--recessed { background: var(--surface-2); box-shadow: inset 0 1px 3px rgba(0,0,0,.06); }
.ve-card__label { font-family: var(--font-mono); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px; color: var(--accent); margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
.ve-card__label::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
```

卡片网格：
```css
.card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
.inner-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }   /* 卡片内 2 列 */
.three-col { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
```

卡片内列表（`[HISTORICAL]` 用 absolute 定位 marker，不用 `display:flex`——flex 的匿名子元素 `min-width:auto` 无法收缩，含多 `<code>` badge 的行会溢出）：
```css
.node-list { list-style: none; padding: 0; margin: 0; font-size: 12px; line-height: 1.8; }
.node-list li { padding-left: 14px; position: relative; }
.node-list li::before { content: '›'; color: var(--text-dim); font-weight: 600; position: absolute; left: 0; }
.node-list code { font-family: var(--font-mono); font-size: 11px; background: var(--accent-dim); color: var(--accent); padding: 1px 5px; border-radius: 3px; }
```

卡片间垂直箭头（独立 flex 元素，内联 SVG）：
```html
<div class="flow-arrow"><svg viewBox="0 0 20 20"><path d="M10 4 L10 16 M6 12 L10 16 L14 12"/></svg> 数据流</div>
```
```css
.flow-arrow { display: flex; justify-content: center; align-items: center; gap: 8px; color: var(--text-dim); font-family: var(--font-mono); font-size: 12px; padding: 4px 0; }
.flow-arrow svg { width: 20px; height: 20px; fill: none; stroke: var(--border-bright); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
```

---

## 4. 数据表格（功能清单、AC 清单、追溯表、签名表）

```css
.table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; margin-bottom: 24px; }
.table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.data-table { width: 100%; border-collapse: collapse; font-size: 13px; line-height: 1.55; }
.data-table thead { position: sticky; top: 0; z-index: 2; }
.data-table th { background: var(--surface-2); font-family: var(--font-mono); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 1.2px; color: var(--text-dim); text-align: left; padding: 14px 16px; border-bottom: 2px solid var(--border-bright); white-space: nowrap; }
.data-table td { padding: 14px 16px; border-bottom: 1px solid var(--border); vertical-align: top; }
.data-table .wide { min-width: 220px; max-width: 440px; }
.data-table td.num, .data-table th.num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--font-mono); }
.data-table tbody tr:nth-child(even) { background: var(--accent-dim); }
.data-table tbody tr { transition: background .15s; }
.data-table tbody tr:hover { background: var(--border); }
.data-table tbody tr:last-child td { border-bottom: none; }
.data-table code { font-family: var(--font-mono); font-size: 11px; background: var(--accent-dim); color: var(--accent); padding: 1px 5px; border-radius: 3px; }
.data-table small { display: block; color: var(--text-dim); font-size: 11px; margin-top: 3px; }
/* 超宽追溯表：冻结首列 */
.data-table th:first-child, .data-table td:first-child { position: sticky; left: 0; z-index: 1; background: var(--surface); }
```

```html
<div class="table-wrap"><div class="table-scroll">
  <table class="data-table">
    <thead><tr><th>ID</th><th>功能</th><th>关联 AC</th></tr></thead>
    <tbody><tr><td>F-1</td><td>用户注册</td><td>AC-1.1 [正常]</td></tr></tbody>
    <tfoot><tr><td>共 14 项</td><td></td><td>13 match · 1 gap</td></tr></tfoot>
  </table>
</div></div>
```

---

## 5. 热力图（风险矩阵：issue × 7 维度，④ 阶段主角图）

热力图本质是 `<table>` + 单元格着色，不用 Mermaid/drawio。用上面的 `.data-table`，每个单元格放 `.status` badge 或直接给 `<td>` 加 dim 背景色：

```css
.status { display: inline-flex; align-items: center; gap: 5px; font-family: var(--font-mono); font-size: 10px; font-weight: 600; padding: 3px 10px; border-radius: 6px; white-space: nowrap; }
.status::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.status--match { background: var(--green-dim); color: var(--green); }
.status--gap { background: var(--red-dim); color: var(--red); }
.status--warn { background: var(--orange-dim); color: var(--orange); }
/* 全单元格着色（heatmap 式）——给 td 加 modifier */
.heatmap-cell--good { background: var(--green-dim); }
.heatmap-cell--warn { background: var(--orange-dim); }
.heatmap-cell--bad { background: var(--red-dim); }
.heatmap-cell--na { background: transparent; color: var(--text-dim); }
```

配 KPI 行（总览数字）+ legend：
```css
.kpi-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 14px; margin-bottom: 20px; }
.kpi-card { background: var(--surface-elevated); border: 1px solid var(--border); border-radius: 10px; padding: 18px; }
.kpi-card__value { font-size: 32px; font-weight: 400; line-height: 1.1; font-variant-numeric: tabular-nums; }
.kpi-card__label { font-family: var(--font-mono); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 1.2px; color: var(--text-dim); margin-top: 6px; }
.legend { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
.legend-item { display: flex; align-items: center; gap: 6px; font-family: var(--font-mono); font-size: 11px; color: var(--text-dim); }
.legend-swatch { width: 10px; height: 10px; border-radius: 3px; }
```

---

## 6. 代码块、折叠区、callout

```css
.code-block { font-family: var(--font-mono); font-size: 13px; line-height: 1.5; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
.code-block--scroll { max-height: 400px; overflow-y: auto; }

details.collapsible { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; margin-bottom: 16px; }
details.collapsible summary { padding: 14px 20px; background: var(--surface); font-family: var(--font-mono); font-size: 12px; font-weight: 600; cursor: pointer; list-style: none; display: flex; align-items: center; gap: 8px; color: var(--text); transition: background .15s; }
details.collapsible summary:hover { background: var(--surface-2); }
details.collapsible summary::-webkit-details-marker { display: none; }
details.collapsible summary::before { content: '▸'; font-size: 11px; color: var(--text-dim); transition: transform .15s; }
details.collapsible[open] summary::before { transform: rotate(90deg); }
details.collapsible .collapsible__body { padding: 16px 20px; border-top: 1px solid var(--border); font-size: 13px; line-height: 1.6; }

.callout { background: var(--surface-2); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 0 8px 8px 0; padding: 14px 18px; font-size: 13px; line-height: 1.6; color: var(--text-dim); margin: 24px 0; }
.callout strong { color: var(--text); font-weight: 600; }
.callout code { font-family: var(--font-mono); font-size: 11px; background: var(--accent-dim); color: var(--accent); padding: 1px 5px; border-radius: 3px; }
```

目录树（⑤ 工程目录）：
```css
.dir-tree { font-family: var(--font-mono); font-size: 13px; line-height: 1.7; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px 20px; overflow-x: auto; white-space: pre; }
.dir-tree .ann { color: var(--text-dim); font-size: 11px; font-style: italic; }
.dir-tree .hl { color: var(--accent); font-weight: 600; }
```

---

## 7. 响应式导航（4+ section 页面：sticky 侧栏 TOC + 移动端横条）

architecture(12节)/code-arch(8节) 等大文档需要。`<nav class="toc">` 是 `.wrap` 的第一个子元素，内容在 `<div class="main">`。

```css
.wrap { max-width: 1400px; margin: 0 auto; display: grid; grid-template-columns: 170px 1fr; gap: 0 40px; }
.main { min-width: 0; }
.toc { position: sticky; top: 24px; align-self: start; padding: 14px 0; grid-row: 1/-1; max-height: calc(100dvh - 48px); overflow-y: auto; }
.toc-title { font-family: var(--font-mono); font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; color: var(--text-dim); padding: 0 0 10px; margin-bottom: 8px; border-bottom: 1px solid var(--border); }
.toc a { display: block; font-size: 11px; color: var(--text-dim); text-decoration: none; padding: 4px 8px; border-radius: 5px; border-left: 2px solid transparent; transition: all .15s; line-height: 1.4; margin-bottom: 1px; }
.toc a:hover { color: var(--text); background: var(--surface-2); }
.toc a.active { color: var(--text); border-left-color: var(--accent); }
@media (max-width: 1000px) {
  .wrap { grid-template-columns: 1fr; }
  .toc { position: sticky; top: 0; z-index: 200; max-height: none; display: flex; gap: 4px; align-items: center; overflow-x: auto; background: var(--bg); border-bottom: 1px solid var(--border); padding: 10px 0; grid-row: auto; }
  .toc-title { display: none; }
  .toc a { white-space: nowrap; flex-shrink: 0; border-left: none; border-bottom: 2px solid transparent; border-radius: 4px 4px 0 0; padding: 6px 10px; font-size: 10px; }
  .toc a.active { border-left: none; border-bottom-color: var(--accent); background: var(--surface); }
  .sec-head { scroll-margin-top: 52px; }
  body { padding: 16px; }
}
```

Scroll spy JS（`rootMargin: '-10% 0px -80% 0px'` 让 heading 进入顶部 10-20% 时高亮）：
```html
<script>
(function() {
  const toc = document.getElementById('toc'); if (!toc) return;
  const links = toc.querySelectorAll('a'); const sections = [];
  links.forEach(link => {
    const el = document.getElementById(link.getAttribute('href').slice(1));
    if (el) sections.push({ el, link });
  });
  new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        links.forEach(l => l.classList.remove('active'));
        sections.find(s => s.el === entry.target)?.link.classList.add('active');
      }
    });
  }, { rootMargin: '-10% 0px -80% 0px' }).observe?.(null);
  sections.forEach(s => new IntersectionObserver(entries => {
    entries.forEach(entry => { if (entry.isIntersecting) {
      links.forEach(l => l.classList.remove('active')); s.link.classList.add('active');
      if (innerWidth <= 1000) s.link.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }});
  }, { rootMargin: '-10% 0px -80% 0px' }).observe(s.el));
  links.forEach(link => link.addEventListener('click', e => {
    e.preventDefault(); const el = document.getElementById(link.getAttribute('href').slice(1));
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); history.replaceState(null, '', '#' + el.id); }
  }));
})();
</script>
```

---

## 8. 全局必加（overflow 防护 + 动画 + reset）

```css
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: var(--font-body); color: var(--text); line-height: 1.6; padding: 32px; overflow-wrap: break-word; }
/* grid/flex 子元素必须能收缩 —— 防 overflow 铁律 */
.grid > *, .flex > *, [style*="display:grid"] > *, [style*="display:flex"] > * { min-width: 0; }
h1 { font-size: 38px; font-weight: 700; letter-spacing: -1px; margin-bottom: 6px; text-wrap: balance; }
.subtitle { color: var(--text-dim); font-size: 14px; margin-bottom: 40px; font-family: var(--font-mono); }
code { font-family: var(--font-mono); }

/* 入场动画（用 --i 控制错峰） */
@keyframes fadeUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
.animate { animation: fadeUp .35s ease-out both; animation-delay: calc(var(--i, 0) * .04s); }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; animation-delay: 0ms !important; transition-duration: .01ms !important; }
}
@media (max-width: 768px) {
  body { padding: 16px; } h1 { font-size: 24px; }
  .inner-grid, .three-col { grid-template-columns: 1fr; }
}
```
