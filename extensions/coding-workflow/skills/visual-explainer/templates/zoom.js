/*
 * zoom.js — design-visual-explainer 公共脚本
 * 从 issues.html (feat-system-prompt-loader) 抽出，含 Mermaid zoom/pan/fit/expand + TOC scroll-spy。
 * render.sh 通过占位符注释 INLINE:zoom.js 将本文件内联进产物 HTML 的 script[type=module]。
 *
 * 依赖：mermaid@11 + @mermaid-js/layout-elk（CDN ESM import）。
 * CSS 契约：.diagram-shell 及内部 .mermaid-wrap/.mermaid-viewport/.mermaid-canvas/.diagram-source/.zoom-label
 *          + [data-action] 按钮（zoom-in/out/fit/one/expand）— 类名与 design.css 绑定，勿改名。
 */
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
import elkLayouts from 'https://cdn.jsdelivr.net/npm/@mermaid-js/layout-elk/dist/mermaid-layout-elk.esm.min.mjs';

const config = { fitPadding: 28, minHeight: 360, maxHeightPx: 960, maxHeightVh: 0.84, maxInitialZoom: 1.8, minZoom: 0.08, maxZoom: 6.5, zoomStep: 0.14, readabilityFloor: 0.58 };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
let activeDrag = null;
addEventListener('mousemove', (e) => activeDrag?.onMove(e));
addEventListener('mouseup', () => { activeDrag?.onEnd(); activeDrag = null; });
const isDark = matchMedia('(prefers-color-scheme: dark)').matches;

mermaid.registerLayoutLoaders(elkLayouts);
mermaid.initialize({
  startOnLoad: false, theme: 'base', look: 'classic', layout: 'elk',
  themeVariables: {
    fontFamily: "'Bricolage Grotesque', 'PingFang SC', system-ui, sans-serif", fontSize: '14px',
    // Dark mode: dark filled nodes + bright semantic borders/text (keeps page bg #0a1414 and lineColor #5eead4 intact)
    primaryColor: isDark ? '#0d2424' : '#ccfbf1', primaryBorderColor: isDark ? '#5eead4' : '#0d9488', primaryTextColor: isDark ? '#e3efee' : '#134e3a',
    secondaryColor: isDark ? '#111d1d' : '#fffbeb', secondaryBorderColor: isDark ? '#115e59' : '#d97706', secondaryTextColor: isDark ? '#5eead4' : '#92400e',
    tertiaryColor: isDark ? '#1a1a1a' : '#f8fafc', tertiaryBorderColor: isDark ? '#64748b' : '#64748b', tertiaryTextColor: isDark ? '#e2e8f0' : '#334155',
    lineColor: isDark ? '#5eead4' : '#5f8a85',
    noteBkgColor: isDark ? '#0d2424' : '#f0fdfa', noteTextColor: isDark ? '#e3efee' : '#134e3a', noteBorderColor: isDark ? '#2dd4bf' : '#0d9488',
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
  function constrainPan() { const vpW = viewport.clientWidth, vpH = viewport.clientHeight; const rW = svgW*zoom, rH = svgH*zoom, pad = config.fitPadding; panX = (rW+pad*2<=vpW)?(vpW-rW)/2:clamp(panX,vpW-rW-pad,pad); panY = (rH+pad*2<=vpH)?(vpH-rH)/2:clamp(panY,vpH-rH-pad,pad); }
  function applyTransform() { const svg = canvas.querySelector('svg'); if (!svg||!svgW) return; constrainPan(); svg.style.width=(svgW*zoom)+'px'; svg.style.height=(svgH*zoom)+'px'; canvas.style.transform=`translate(${panX}px,${panY}px)`; label.textContent=Math.round(zoom*100)+'% \u2014 '+fitMode; }
  function canPan() { return svgW*zoom+config.fitPadding*2>viewport.clientWidth || svgH*zoom+config.fitPadding*2>viewport.clientHeight; }
  function computeSmartFit() { const vpW=viewport.clientWidth,vpH=viewport.clientHeight; const aW=Math.max(80,vpW-config.fitPadding*2),aH=Math.max(80,vpH-config.fitPadding*2); const contain=Math.min(aW/svgW,aH/svgH); let z=contain,mode='contain'; if(contain<config.readabilityFloor){const chartR=svgH/svgW,vpR=vpH/Math.max(vpW,1); if(chartR>=vpR){z=aW/svgW;mode='width-priority';}else{z=aH/svgH;mode='height-priority';}} return {zoom:clamp(z,config.minZoom,config.maxInitialZoom),mode}; }
  function fitDiagram() { if(!svgW)return; const fit=computeSmartFit(); zoom=fit.zoom; fitMode=fit.mode; panX=(viewport.clientWidth-svgW*zoom)/2; panY=(viewport.clientHeight-svgH*zoom)/2; applyTransform(); }
  function setOneToOne() { zoom=clamp(1,config.minZoom,config.maxZoom); fitMode='1:1'; panX=(viewport.clientWidth-svgW*zoom)/2; panY=(viewport.clientHeight-svgH*zoom)/2; applyTransform(); }
  function zoomAround(factor,cx,cy) { const next=clamp(zoom*factor,config.minZoom,config.maxZoom); const ratio=next/zoom; panX=cx-ratio*(cx-panX); panY=cy-ratio*(cy-panY); zoom=next; fitMode='custom'; applyTransform(); }
  function readSvgNaturalSize(svg) { let w=0,h=0; if(svg.viewBox?.baseVal?.width>0){w=svg.viewBox.baseVal.width;h=svg.viewBox.baseVal.height;} if(!w){w=parseFloat(svg.getAttribute('width'))||0;h=parseFloat(svg.getAttribute('height'))||0;} if(!w){const b=svg.getBBox();w=b.width;h=b.height;} if(!w){const r=svg.getBoundingClientRect();w=r.width||1000;h=r.height||700;} if(!svg.getAttribute('viewBox'))svg.setAttribute('viewBox',`0 0 ${w} ${h}`); return {w,h}; }
  function setAdaptiveHeight() { if(!svgW)return; const usableW=Math.max(280,wrap.getBoundingClientRect().width-2); const idealH=(svgH/svgW)*usableW+config.fitPadding*2; const maxVp=Math.floor(innerHeight*config.maxHeightVh); const hardMax=Math.min(config.maxHeightPx,Math.max(config.minHeight+40,maxVp)); wrap.style.height=Math.round(clamp(idealH,config.minHeight,hardMax))+'px'; }
  function openInNewTab() { const svg=canvas.querySelector('svg'); if(!svg)return; const clone=svg.cloneNode(true); clone.style.width=''; clone.style.height=''; const bg=isDark?'#0a1414':'#f6f8f8'; const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Diagram</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:${bg};padding:40px;box-sizing:border-box}svg{max-width:100%;max-height:90vh;height:auto}</style></head><body>${clone.outerHTML}</body></html>`; open(URL.createObjectURL(new Blob([html],{type:'text/html'})),'_blank'); }
  async function render() { try { const code=source.textContent.trim(); if(!code){label.textContent='Error: Empty source';return;} const id='diagram-'+Date.now()+'-'+Math.random().toString(36).slice(2,8); const {svg}=await mermaid.render(id,code); canvas.innerHTML=svg; const svgNode=canvas.querySelector('svg'); if(!svgNode){label.textContent='Error: No SVG';return;} const size=readSvgNaturalSize(svgNode); svgW=size.w; svgH=size.h; svgNode.removeAttribute('width'); svgNode.removeAttribute('height'); svgNode.style.maxWidth='none'; svgNode.style.display='block'; setAdaptiveHeight(); fitDiagram(); } catch(err){ console.error('Mermaid render failed:',err); label.textContent='Error: '+(err.message||'Render failed'); } }
  const actions = { 'zoom-in':()=>zoomAround(1+config.zoomStep,viewport.clientWidth/2,viewport.clientHeight/2), 'zoom-out':()=>zoomAround(1/(1+config.zoomStep),viewport.clientWidth/2,viewport.clientHeight/2), 'zoom-fit':fitDiagram, 'zoom-one':setOneToOne, 'zoom-expand':openInNewTab };
  Object.entries(actions).forEach(([a,h])=>wrap.querySelector(`[data-action="${a}"]`)?.addEventListener('click',h));
  viewport.addEventListener('dblclick',fitDiagram);
  viewport.addEventListener('wheel',(e)=>{ if(e.ctrlKey||e.metaKey){e.preventDefault();const rect=viewport.getBoundingClientRect();const f=e.deltaY<0?1+config.zoomStep:1/(1+config.zoomStep);zoomAround(f,e.clientX-rect.left,e.clientY-rect.top);return;} if(canPan()){e.preventDefault();panX-=e.deltaX;panY-=e.deltaY;applyTransform();} },{passive:false});
  viewport.addEventListener('mousedown',(e)=>{ if(e.target.closest('.zoom-controls')||!canPan())return; wrap.classList.add('is-panning'); sx=e.clientX;sy=e.clientY;spx=panX;spy=panY;e.preventDefault(); activeDrag={onMove:(ev)=>{panX=spx+(ev.clientX-sx);panY=spy+(ev.clientY-sy);applyTransform();},onEnd:()=>wrap.classList.remove('is-panning')}; });
  viewport.addEventListener('touchstart',(e)=>{ if(e.touches.length===1){sx=e.touches[0].clientX;sy=e.touches[0].clientY;spx=panX;spy=panY;} else if(e.touches.length===2){const dx=e.touches[0].clientX-e.touches[1].clientX,dy=e.touches[0].clientY-e.touches[1].clientY;touchDist=Math.sqrt(dx*dx+dy*dy);const r=viewport.getBoundingClientRect();touchCx=(e.touches[0].clientX+e.touches[1].clientX)/2-r.left;touchCy=(e.touches[0].clientY+e.touches[1].clientY)/2-r.top;} },{passive:true});
  viewport.addEventListener('touchmove',(e)=>{ if(e.touches.length===1&&canPan()){if(touchDist>0){sx=e.touches[0].clientX;sy=e.touches[0].clientY;spx=panX;spy=panY;touchDist=0;}e.preventDefault();panX=spx+(e.touches[0].clientX-sx);panY=spy+(e.touches[0].clientY-sy);applyTransform();}else if(e.touches.length===2&&touchDist>0){e.preventDefault();const dx=e.touches[0].clientX-e.touches[1].clientX,dy=e.touches[0].clientY-e.touches[1].clientY;const d=Math.sqrt(dx*dx+dy*dy);zoomAround(d/touchDist,touchCx,touchCy);touchDist=d;} },{passive:false});
  new ResizeObserver(()=>{if(svgW){setAdaptiveHeight();fitDiagram();}}).observe(wrap);
  render();
}
document.querySelectorAll('.diagram-shell').forEach(initDiagram);

/* TOC scroll-spy：高亮当前 section 对应的 TOC 链接 */
(function() {
  const toc = document.getElementById('toc'); if (!toc) return;
  const links = toc.querySelectorAll('a'); const sections = [];
  links.forEach(link => { const el = document.getElementById(link.getAttribute('href').slice(1)); if (el) sections.push({ el, link }); });
  sections.forEach(s => new IntersectionObserver(entries => { entries.forEach(entry => { if (entry.isIntersecting) { links.forEach(l => l.classList.remove('active')); s.link.classList.add('active'); if (innerWidth <= 1000) s.link.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }); } }); }, { rootMargin: '-10% 0px -80% 0px' }).observe(s.el));
  links.forEach(link => link.addEventListener('click', e => { e.preventDefault(); const el = document.getElementById(link.getAttribute('href').slice(1)); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); history.replaceState(null, '', '#' + el.id); } }));
})();
