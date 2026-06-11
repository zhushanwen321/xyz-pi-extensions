# Claude Code Workflow 对标分析

数据来源：`docs/research/claude-code-prompts/` 下所有提取的提示词
对比对象：本项目 `extensions/workflow/` 实现

---

## 一、格式兼容性差距

### 1.1 meta.phases 类型不兼容

**Claude Code 格式**（对象数组）：
```javascript
export const meta = {
  name: 'review-fix-loop',
  phases: [
    { title: 'Review', detail: 'Run code-review and produce report' },
    { title: 'Fix', detail: 'Fix all must-fix issues' },
  ],
}
```

**Pi 当前格式**（字符串数组）：
```javascript
const meta = {
  name: 'review-fix-loop',
  phases: ['review-fix-loop'],  // 只接受 string[]
}
```

**代码位置**：`config-loader.ts` 第 164-165 行：
```typescript
phases: Array.isArray(metaObj.phases)
  ? metaObj.phases.filter((p: unknown) => typeof p === "string") as string[]
  : [],
```

**问题**：Claude Code 的 `{title, detail}` 对象被 `filter(p => typeof p === "string")` 全部过滤掉，导致 phases 为空数组。TUI 无法按 phase 分组显示 agent。

**修复方案**：扩展 `WorkflowMeta.phases` 类型为联合类型：
```typescript
type PhaseDef = string | { title: string; detail?: string };
interface WorkflowMeta {
  phases: PhaseDef[];
}
```

### 1.2 ESM export 支持

**当前**：`orchestrator.ts` 第 205 行用正则 `replace(/\bexport\s+const\s+meta\b/, "const meta")` 去掉 `export`。

**问题**：只处理 `meta` 的 export，不处理 `export const` 其他声明或 `export default`。Claude Code 脚本只有 `export const meta`，当前正则已覆盖。**此项暂无问题。**

### 1.3 `args` 全局变量名差异

| 平台 | 全局变量名 | 多态处理 |
|------|-----------|---------|
| Claude Code | `args` | `typeof args === 'number' ? args : args?.maxIterations` |
| Pi | `$ARGS` | `$ARGS?.max_rounds` |

**现状**：worker-script.ts 已注入 `$ARGS`。Claude Code 用 `args`。

**修复方案**：在 worker-script 中同时注入 `args` 作为 `$ARGS` 的别名：
```javascript
const $ARGS = ...;
const args = $ARGS; // CC-compat alias
```

### 1.4 `budget` 全局变量差异

| 平台 | API |
|------|-----|
| Claude Code | `budget: { total, spent(), remaining() }` |
| Pi | `$BUDGET: { usedTokens, usedCost, maxTokens?, maxTimeMs? }` |

Claude Code 的 `budget.spent()` / `budget.remaining()` 是动态函数，支持 loop-until-budget 模式。Pi 是静态快照。

---

## 二、Structured Output 失败根因分析

### 2.1 当前实现链路

```
worker-script agent(opts)
  → postMessage({type:"agent-call", opts})
  → orchestrator.handleAgentCall()
  → agentPool.enqueue(opts)
  → agentPool.buildArgs(opts)      ← 在这里拼 prompt
  → spawn("pi", ["--mode","json","-p", prompt])
  → pi 子进程执行，输出 JSONL
  → processJsonlEvent()            ← 在这里检测 structured-output 工具调用
```

### 2.2 buildArgs 的 prompt 注入（agent-pool.ts 第 313-321 行）

```typescript
if (opts.schema) {
  const schemaJson = JSON.stringify(opts.schema);
  prompt = [
    `You MUST call the structured-output tool to return your result.`,
    `Parameters: schema = ${schemaJson}, data = <your result>`,
    `Do NOT output JSON in your text response — use the structured-output tool instead.`,
    `---`,
    prompt,
  ].join("\n");
}
```

**问题清单**：

| # | 问题 | 影响 | 严重度 |
|---|------|------|--------|
| 1 | prompt 注入而非 system prompt 注入 | 模型可能忽略，尤其弱模型 | **P0** |
| 2 | schema JSON 直接拼接到 prompt，无转义 | 特殊字符可能破坏 prompt 结构 | **P0** |
| 3 | `structured-output` 工具在子进程是否可用未验证 | 子进程可能不加载此扩展 | **P0** |
| 4 | 无重试机制 | 首次失败即返回错误 | **P1** |
| 5 | `hasToolCall` 检查有盲区 | agent 调了其他工具但没调 structured-output 时不报错 | **P2** |

### 2.3 Claude Code 的做法

从日志提取的 Workflow 工具描述（完整原文）：

> "With schema (a JSON Schema), the subagent is forced to call a StructuredOutput tool and agent() returns the validated object — no parsing needed."

> "opts.agentType uses a custom subagent type — resolved from the same registry as the Agent tool; composes with schema (the custom agent's system prompt gets a StructuredOutput instruction appended)."

关键差异：

1. **system prompt 注入**：Claude Code 在子 agent 的 system prompt 中**追加** StructuredOutput 指令，而非拼接到 user prompt
2. **工具层强制**：schema 存在时，StructuredOutput 工具被自动注入到子 agent 的工具列表
3. **重试**："validation happens at the tool-call layer so the model retries on mismatch"

### 2.4 Pi 可行的修复路径

**路径 A：Hook 注入（用户建议）**

用户提到"前几个 PR 中删除了这一点"。检查 hook 可行性：

Pi 扩展可注册的事件：
- `tool_execution_start` — 工具调用前拦截
- `tool_execution_end` — 工具调用后处理
- `session_start` — 会话开始

但这些 hook 只能在**主进程**中使用。workflow 的子 agent 是独立 `pi --mode json` 子进程，**主进程的 hook 不会传播到子进程**。

所以 hook 方案不可行（除非 Pi 核心支持 hook 传播）。

**路径 B：buildArgs 改进（最小改动，立即可行）**

在 `agent-pool.ts` 的 `buildArgs` 中：

1. **改 prompt 注入为 `--append-system-prompt` 注入**：
   ```typescript
   if (opts.schema) {
     const schemaJson = JSON.stringify(opts.schema);
     const systemPrompt = [
       '## Structured Output Requirement (MANDATORY)',
       `You MUST call the structured-output tool to return your result.`,
       `schema = ${schemaJson}`,
       `data = <your result conforming to the schema>`,
       'Do NOT output JSON in text — call the tool.',
       'If you cannot produce valid data, call the tool with your best attempt.',
     ].join('\n');
     // 写临时文件，注入为 system prompt
     const tmpFile = path.join(os.tmpdir(), `so-${callId}.txt`);
     fs.writeFileSync(tmpFile, systemPrompt);
     args.push("--append-system-prompt", tmpFile);
   }
   ```

2. **增加环境变量标记**，让 structured-output 扩展知道当前是 workflow 场景：
   ```typescript
   // 设置环境变量传递 schema 信息
   env['STRUCTURED_OUTPUT_SCHEMA'] = schemaJson;
   ```

3. **增加重试逻辑**：在 `spawnAndParse` 中，当 schema 存在但 parsedOutput 为空时，重试一次。

**路径 C：structured-output 扩展增强**

在 `structured-output/src/index.ts` 中：

1. 移除或放宽对环境变量的检查（如果有 gate 限制只允许 workflow 场景调用）
2. 增加 `promptGuidelines` 的权重，确保模型优先调用此工具
3. 增加更详细的 description，包含具体调用示例

---

## 三、TUI 展示差距

### 3.1 Claude Code 的 Workflow TUI 架构

从用户提供的截图描述，Claude Code 有三层 TUI：

```
Layer 1: Footer 状态栏（最小化，仅展示存在 workflow）
  ┌─────────────────────────────────────────┐
  │ ★ 1 workflow running · /workflows       │
  └─────────────────────────────────────────┘

Layer 2: /workflows 命令 → 全屏表格（两栏布局）
  ╭ Phases ────────┬ Agents ──────────────────╮
  │ ❯ ✔ Review 4/4 │  ✔ review-1  · glm-5.1  │
  │   ✔ Fix    3/3 │  ✔ review-2  · glm-5.1  │
  │                │  ✔ review-3  · glm-5.1  │
  │                │  ✔ review-4  · glm-5.1  │
  ╰────────────────┴──────────────────────────╯
  ↑↓ select · esc back · s save

Layer 3: Enter agent → agent 详情页
  ╭ review-1 ──────────────────────────────╮
  │ ✔ Completed · glm-5.1                  │
  │ 66k tok · 23 tool calls · 3m 15s       │
  │                                         │
  │ Prompt · 20 lines · ⏎ expand           │
  │   Iteration 1 of a review-fix loop...  │
  │   ... 18 more lines                    │
  │                                         │
  │ Activity · last 3 of 23 tool calls     │
  │   Write(/tmp/review-fix-loop/report…)  │
  │   Bash(mkdir -p /tmp/review-fix-loop…) │
  │   StructuredOutput(...)                │
  │                                         │
  │ Outcome                                 │
  │   The review is complete...            │
  ╰─────────────────────────────────────────╯
  ↑↓ agent · ⏎ prompt · esc back · s save
```

### 3.2 Pi 当前 TUI

Pi 使用 `ctx.ui.setWidget()` 在 chat input 上方显示 widget，只有一层：

```
  [completed] review-fix-loop 16s 4/4 agents
    ✓ #0 review-round-1 3.2s
    ✓ #1 fix-round-1 5.1s
    ✓ #2 review-round-2 4.8s
    ✓ #3 fix-round-2 3.0s
```

### 3.3 差距分析

| 维度 | Claude Code | Pi 当前 | 需要补充 |
|------|-------------|---------|---------|
| 执行时展示 | Footer 最小化，完成后消失 | chat input 上方 widget | **改 Footer** |
| 全屏列表 | /workflows 命令进入全屏 | 无全屏页面 | **新增** |
| 两栏布局 | 左栏 Phases 分组 + 右栏 Agent 列表 | 单列平铺 | **新增** |
| Phase 分组 | 按 phase() 调用分组 | 无 phase 概念 | **依赖 1.1 修复** |
| Agent 详情 | Enter 查看 prompt/tool calls/outcome | 无详情页 | **新增** |
| 交互导航 | ↑↓ 选择 · Enter 进入 · Esc 返回 | 无交互 | **新增** |
| 持久化 | `s save` 保存报告 | 无 | **P2** |

### 3.4 Pi TUI 能力评估

Pi TUI 提供：
- `ctx.ui.setWidget(key, content)` — widget 显示（当前用法）
- `ctx.ui.setFooter(factory)` — **Footer 区域**（当前未使用！）
- `ctx.ui.custom(factory)` — **全屏 overlay**（当前用于 detail，但不是交互式的）
- `ctx.ui.registerShortcut()` — 快捷键（已注册 ctrl+shift+p/x/r）

**可行方案**：

1. **Layer 1（Footer）**：执行时用 `setFooter` 显示最小化状态，完成后清除
2. **Layer 2（全屏列表）**：用 `ctx.ui.custom()` 构建交互式两栏布局，注册 `↑↓` `Enter` `Esc` 快捷键处理导航
3. **Layer 3（详情页）**：用 `ctx.ui.custom()` 构建详情 overlay，展示 prompt/tool calls/outcome

**技术限制**：Pi 的 `ctx.ui.custom()` 是否支持交互式选择（高亮当前行、键盘导航）需要验证。如果不支持，可能需要用 `ctx.ui.select()` 代替两栏布局。

---

## 四、agent() API 差距

### 4.1 缺失的 opts 字段

| 字段 | Claude Code | Pi 当前 | 用途 |
|------|-------------|---------|------|
| `label` | ✅ 进度树显示名 | 用 `description` 替代 | 显示名 vs 日志描述，语义不同 |
| `phase` | ✅ agent 分组到 phase | **缺失** | TUI 按 phase 分组 |
| `agentType` | ✅ 自定义 agent 类型 | 用 `agent` 替代 | 功能等价 |
| `isolation: 'worktree'` | ✅ per-agent worktree | 不支持 | 并行写文件隔离 |

**最关键**：`phase` 字段。没有它，TUI 无法按 phase 分组。

### 4.2 worker-script 中 phase 的处理

当前 worker-script.ts 中有 `phase()` 全局函数：
```javascript
let _currentPhase = "";
function phase(name) { _currentPhase = String(name); }
```

但 `_currentPhase` 只用于 `log()` 的 phase 标记。`agent()` 调用时不传递 phase 信息到 orchestrator。

**修复**：在 agent() 调用时，将 `_currentPhase` 注入到 opts 中：
```javascript
async function agent(firstArg, secondArg) {
  // ... 现有参数解析 ...
  opts._phase = _currentPhase; // 注入当前 phase
  parentPort.postMessage({ type: "agent-call", callId, opts });
}
```

orchestrator 将 `_phase` 传递到 `ExecutionTraceNode`，TUI 就能按 phase 分组。

### 4.3 parallel() API 不兼容

**Claude Code**：
```javascript
const results = await parallel([
  () => agent("task 1", {schema: S}),
  () => agent("task 2", {schema: S}),
]);
```
接受 `() => Promise` thunk 数组。

**Pi 当前**：
```javascript
parallel(calls) {
  if (typeof calls === "function") { return calls(); }
  return Promise.all(calls.map((c) => agent(c)));
}
```
接受 `agent()` 的参数数组，但**不支持 thunk**。

Claude Code 的 thunk 模式允许内联构造 schema/label 等 opts。Pi 的 `Promise.all(calls.map(c => agent(c)))` 在处理对象参数时会丢失 schema 等 fields。

**修复**：支持 thunk + 对象两种模式：
```javascript
async function parallel(calls) {
  if (typeof calls === "function") return calls();
  return Promise.all(calls.map(c => {
    if (typeof c === 'function') return c();
    return agent(c);
  }));
}
```

### 4.4 pipeline() 实现差异

**Claude Code**：
```javascript
pipeline(items, stage1, stage2, ...)
// 每个 item 独立通过所有 stage，无 barrier
// stage 回调: (prevResult, originalItem, index)
```

**Pi 当前**：
```javascript
pipeline(stages) {
  let result;
  for (let i = 0; i < stages.length; i++) {
    result = await stages[i](result);
  }
  return result;
}
```

Pi 的 pipeline 只接受 stage 函数数组，不接受 items。Claude Code 的 pipeline 是 items × stages 的笛卡尔积。**功能不对等。**

---

## 五、修复优先级排序

### P0 — Structured Output 可靠性（阻塞 workflow 执行）

| # | 改动 | 文件 | 改动量 |
|---|------|------|--------|
| 1 | schema prompt 改为 `--append-system-prompt` 注入 | `agent-pool.ts` buildArgs() | ~20 行 |
| 2 | schema JSON 安全转义 | `agent-pool.ts` buildArgs() | ~5 行 |
| 3 | 验证子进程是否加载 structured-output 扩展 | `agent-pool.ts` spawnAndParse() | 测试 |
| 4 | 失败自动重试一次 | `agent-pool.ts` spawnAndParse() | ~15 行 |

### P1 — CC 格式兼容

| # | 改动 | 文件 | 改动量 |
|---|------|------|--------|
| 5 | phases 支持 `{title, detail}[]` | `config-loader.ts` | ~10 行 |
| 6 | 注入 `args` 作为 `$ARGS` 别名 | `worker-script.ts` | 1 行 |
| 7 | agent() 传递 `_currentPhase` 到 orchestrator | `worker-script.ts` + `orchestrator.ts` | ~15 行 |
| 8 | ExecutionTraceNode 增加 `phase` 字段 | `state.ts` | ~3 行 |
| 9 | parallel() 支持 thunk 数组 | `worker-script.ts` | ~5 行 |

### P2 — TUI 重构

| # | 改动 | 文件 | 改动量 |
|---|------|------|--------|
| 10 | 执行时改用 Footer 最小化展示 | `index.ts` + `widget.ts` | ~30 行 |
| 11 | /workflows 命令全屏两栏布局 | `widget.ts` | ~150 行 |
| 12 | agent 详情页（prompt/tool calls/outcome） | `widget.ts` | ~100 行 |
| 13 | 交互式导航（↑↓ Enter Esc） | `widget.ts` | ~50 行 |
| 14 | 完成后 widget 自动消失 | `index.ts` | ~10 行 |

### P3 — 增强

| # | 改动 | 文件 | 改动量 |
|---|------|------|--------|
| 15 | budget 动态函数（spent()/remaining()） | `worker-script.ts` | ~10 行 |
| 16 | pipeline(items, stage1, stage2) 笛卡尔积 | `worker-script.ts` | ~20 行 |
| 17 | /workflows s save 保存报告 | 新文件 | ~30 行 |

---

## 六、与 Pi 平台的兼容性风险

1. **`--append-system-prompt` 是否可用**：需确认 Pi CLI 是否支持此参数。如果不支持，退回 prompt 注入但改进格式。

2. **`ctx.ui.custom()` 交互能力**：需确认是否支持键盘事件和动态更新。如果不支持，用 `ctx.ui.select()` 降级。

3. **`ctx.ui.setFooter()` 可用性**：type stub 中有声明但 workflow 扩展未使用。需确认是否已实现。

4. **子进程扩展加载**：`pi --mode json -p` 启动的子进程是否加载所有已安装扩展（包括 structured-output）？这是 P0 #3 的前提。
