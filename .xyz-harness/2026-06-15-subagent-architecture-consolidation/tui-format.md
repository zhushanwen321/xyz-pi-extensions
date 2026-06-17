# 展示层 — 格式化约定

> 所有格式化纯函数的单一真相源。展示层所有组件共用。
> 源：subagent-tui FR-1 + impeccable 设计审查

---

## 1. 分隔符语义体系

| 字符 | 语义 | 何时用 | dim? |
|------|------|--------|------|
| `·` | 同级并列字段 / thinking 图标 | `model · thinking`、`2 turns · 8.2k · 12s`；thinking eventLog 行首图标 | 是 |
| `()` | 元数据分组 | `(anthropic/claude-sonnet-4.5 · thinking medium)` | 是 |
| `›` | 工具调用图标 | eventLog tool_start/tool_end 行首 | 否 |
| `>` | 输出文本图标 | eventLog text_output 行首 | 否 |
| `│` | 大区块分隔 | orchestration header 仅此一处 `orchestrate │ parallel` | 否 |
| `→` | 时序/因果链 | chain DAG `scout → planner → worker` | 是 |
| `▶`/`▼` | 折叠标记 | orchestration expanded step 标题 | 否 |
| `──` | 分节线 | expanded view turn 分隔 | 是 |

### 禁止

- `│` 做 stats 字段分隔（历史 bug：`2 turns │ 8.2k │ 12s` → 改 `·`）
- `├─`/`└─` 做 eventLog 行前缀（已废弃，2026-06-17 改用类型图标 `›`/`>`/`·`）
- 多种分隔符混用无语义区分

### 设计变更说明（2026-06-17）

原方案所有 eventLog 行统一用 `├─ ` 前缀（dim 连接符），理由是"单父单子关系 + 避免 redraw 抖动"。
实测压缩视图（对话流 block 最近 4 条 + `/subagents list` 详情）发现：thinking / tool / output
全部长一个样，杂乱难辨。**改为按类型加图标**（`›` 工具 / `>` 输出 / `·` thinking），
牺牲一点"层级感"换"类型一眼可辨"。redraw 抖动问题不适用（图标固定不变，不存在切换）。

---

## 2. Tokens 格式化

```typescript
function formatTokens(n: number, withSuffix = false): string {
  const suffix = withSuffix ? " token" : "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M${suffix}`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k${suffix}`;
  return `${n}${suffix}`;
}
```

| 输入 | 输出 |
|------|------|
| 820 | `820` |
| 8200 | `8.2k` |
| 82000 | `82k` |
| 1_200_000 | `1.2M` |

**统一入口**：所有展示 token 的地方都调 `formatTokens`。禁止内联模板 `${tokens} tokens`（历史 background 路径的格式不一致 bug）。

---

## 3. Duration 格式化

```typescript
function formatDuration(ms: number): string {
  if (ms < 1000)   return `${ms}ms`;
  if (ms < 60000)  return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}
```

| 输入 | 输出 |
|------|------|
| 450ms | `450ms` |
| 12000ms | `12.0s` |
| 135000ms | `2m15s` |

### elapsedSeconds（对话流 block）

对话流 block 用**整数秒**（简洁）：`Math.floor((now - startedAt) / 1000)` → `12s`。

全屏 overlay 用 `formatDuration`（精确，含 ms/m）。

**唯一计算点**：`executionStateToDetails()` 里算（见 architecture.md §2），不在各路径重复。

---

## 4. eventLog 行格式化

```typescript
function formatEventLogLine(entry: AgentEventLogEntry, theme: ThemeLike, turnNumber?: number): string
```

| 类型 | 格式 | 颜色 |
|------|------|------|
| tool_start | `› {toolName} {args摘要}` | normal |
| tool_end (done) | `› {toolName} {args摘要} ✓` | ✓=success |
| tool_end (failed) | `› {toolName} {args摘要} ✗` | ✗=error |
| text_output | `> {文本片段}` | normal |
| thinking | `· {reasoning 片段}` | dim（含 `·` 图标整行 dim） |
| turn_end | `── turn {N} ──` | dim（expanded only） |

**类型图标语义**（2026-06-17 变更，替代原 `├─ ` 统一前缀）：

| 图标 | 类型 | 说明 |
|------|------|------|
| `›` | tool_start / tool_end | 工具调用。tool_end 尾部追加 `✓`（success）/`✗`（error） |
| `>` | text_output | agent 输出文本片段 |
| `·` | thinking | 推理片段。图标 + 文本**整行 dim** |
| `──` | turn_end | turn 分隔线（仅 expanded view） |

图标后接 1 个空格再接内容。图标本身**不上色**（thinking 的 `·` 随整行 dim 一起着色，属例外）。

### args 摘取（extractLabelFromArgs）

| 工具 | 摘取 | 截断 |
|------|------|------|
| read/write/edit | `{toolName} {basename(path)}` | — |
| bash | `{toolName} {command}` | ≤60 char |
| web_search | `{toolName} {query}` | — |
| web_fetch | `{toolName} {url}` | — |
| 其他 | `{toolName}` | — |

---

## 5. ANSI 安全截断（truncLine）

```typescript
function truncLine(text: string, maxWidth: number): string
```

**问题**：pi-tui 的 `truncateToWidth` 在省略号前插 `\x1b[0m`（全局 reset），导致 Box 背景色在省略号处断裂。

**解决**：追踪 active SGR styles（`\x1b[...m`），在写 `…` 前重应用所有 active styles。

```typescript
// 核心逻辑
let activeStyles: string[] = [];
// 遇到 \x1b[0m → 清空 activeStyles
// 遇到其他 \x1b[..m → push 到 activeStyles
// 截断时：return result + activeStyles.join("") + "…";
```

用 `Intl.Segmenter({ granularity: "grapheme" })` 处理 Unicode/emoji。

**所有输出行都经 truncLine**。禁止直接用 `truncateToWidth`。

---

## 6. 颜色 token 体系

| 用途 | theme token | 说明 |
|------|------------|------|
| spinner (running) | `fg("accent", ...)` | 强调色 |
| done glyph | `fg("success", "✓")` | 绿 |
| failed glyph | `fg("error", "✗")` | 红 |
| cancelled glyph | `fg("muted", "■")` | 灰 |
| agent name | `bold(...)` | 加粗（视觉焦点） |
| model/thinking/stats/连接符 | `fg("dim", ...)` | 降级 |
| Ctrl+O 提示 | `fg("accent", ...)` | 强调 |
| running 背景块 | `bg("toolPendingBg", ...)` | 黄 |
| done 背景块 | `bg("toolSuccessBg", ...)` | 绿 |
| failed/cancelled 背景块 | `bg("toolErrorBg", ...)` | 红 |

**禁止硬编码 ANSI**——只用 theme token。

---

## 7. 零值隐藏规则

stats 各字段（turns/totalTokens/elapsedSeconds）**仅在 > 0 时显示**。

```typescript
// buildStatusLine 里的 stats 拼接
const statParts: string[] = [];
if (d.turns > 0)         statParts.push(`${d.turns} turns`);
if (d.totalTokens > 0)   statParts.push(formatTokens(d.totalTokens));
if (d.elapsedSeconds > 0) statParts.push(`${d.elapsedSeconds}s`);
// 全零 → statParts 为空 → 整段省略（不显示 · 0 turns · 0 · 0s）
```

---

## 8. spinner seed-frame（不用 setInterval）

```typescript
const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function runningSeed(...values: Array<number | undefined>): number | undefined {
  let seed: number | undefined;
  for (const v of values) {
    if (v === undefined || !Number.isFinite(v)) continue;
    seed = (seed ?? 0) + Math.trunc(v);
  }
  return seed;
}

// single: seed = turns + totalTokens + elapsedSeconds + eventLog.length
// orchestration: seed = 所有 step state 汇总 + currentStepIndex
// frame = RUNNING_FRAMES[abs(seed) % 10]
```

- 每次 onUpdate（真实事件）→ seed 变化 → spinner 换帧
- 静默期（无事件）→ seed 不变 → spinner 冻结（换取滚动体验）
- 无 seed → 静态 `●`

---

## 9. sanitizeLine

```typescript
function sanitizeLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/\t/g, "  ");
}
```

所有进入 buildRenderLines 的文本都先 sanitize——防止 LLM 输出的换行/制表符把单行展开成多行，破坏固定行布局。
