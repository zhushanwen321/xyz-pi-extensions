---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 5
  boundaries_checked: 8
  issues_found: 2
  must_fix_count: 0
  low_count: 1
  info_count: 1
  duration_estimate: "6"
---

# Integration Review v1

## 审查记录
- 审查时间：2026-06-03
- 上游 BLR：business_logic_review_v1.md
- 模块边界点数：8
- 审查链路：workflow → model-switch 跨包集成

## 模块边界图

```
worker-script.ts ── agent-call message ──→ orchestrator.ts
                    (WorkerInMsg.opts)
                           │
                           ▼
                    model-resolver.ts ── import ──→ @zhushanwen/pi-model-switch
                           │              resolveModelForScene(scene)
                           │                   │
                           │            ┌───────┴────────┐
                           │            │  advisor.ts     │
                           │            │  (config/peak/  │
                           │            │   candidate)    │
                           │            └────────────────┘
                           │
                    string | undefined
                           │
                           ▼
                    orchestrator.ts
                    enrichedOpts = { ...opts, model: resolvedModel }
                           │
                           ▼
                    agent-pool.ts
                    buildArgs() → --model flag → pi 子进程
```

## 边界检查矩阵

| # | 边界点 | D1 格式转换 | D2 错误传播 | D3 契约一致 | 问题 |
|---|--------|------------|------------|------------|------|
| B1 | worker-script→orchestrator (scene 字段) | ✅ | ✅ | ⚠️ | LOW-1 |
| B2 | orchestrator→model-resolver (AgentCallOpts) | ✅ | ✅ | ✅ | — |
| B3 | model-resolver→@zhushanwen/pi-model-switch (import) | ✅ | — | ✅ | — |
| B4 | model-resolver→orchestrator (return) | ✅ | ✅ | ✅ | — |
| B5 | orchestrator→agent-pool (enrichedOpts.model) | ✅ | ✅ | ✅ | — |
| B6 | agent-pool→pi subprocess (--model flag) | ✅ | ✅ | ✅ | — |
| B7 | workflow/package.json→model-switch (workspace:* 依赖) | ✅ | — | ✅ | — |
| B8 | model-switch/index.ts→advisor.ts (re-export chain) | ✅ | — | ✅ | — |

### 模拟数据验证路径

| # | 场景 | 源数据 | 验证结果 |
|---|------|--------|---------|
| P1 | scene="coding"，正常解析 → "openrouter/glm-5.1" | LC 模拟数据 | ✅ |
| P2 | scene="coding"，peak 全部 avoid → undefined | AP-2 数据 | ✅ |
| P3 | scene="coding"，配置缺失 → undefined | AP-3 数据 | ✅ |
| P4 | explicit model 指定，scene 忽略 | UC-2 数据 | ✅ |
| P5 | scene 传递：worker → orchestrator → resolver | 跨进程 message | ✅ |
| P6 | undefined model → 不加 --model flag → Pi 默认 | fallback | ✅ |

---

## 模拟数据验证详情

### P1：scene="coding"，正常解析

**边界 B1：worker-script 中 agent() 收集 scene 字段**

`worker-script.ts` 的 `agent()` 处理三种签名：
- `agent("prompt", { scene: "coding" })` → `extract scene from secondArg`
- `agent({ prompt: "...", scene: "coding" })` → `extract from firstArg`
- `agent({ task: "...", scene: "coding" })` → `extract from firstArg`

```
postMessage({ type: "agent-call", callId, opts: { prompt, scene, model, ... } })
```
✅ scene 字段在三种签名中均正确提取。

**边界 B2：orchestrator → model-resolver（opts 传递）**

```typescript
// orchestrator.ts:240
const resolvedModel = resolveModel(opts);
// model-resolver.ts:10
export function resolveModel(opts: AgentCallOpts): string | undefined {
  if (opts.model) return opts.model;    // 跳过
  if (opts.scene) {                      // "coding" → truthy
    const resolved = resolveModelForScene(opts.scene);  // → "openrouter/glm-5.1"
    return resolved ?? undefined;
  }
  return undefined;
}
```

✅ `opts.scene = "coding"` 传递给 `resolveModelForScene`，返回 `"openrouter/glm-5.1"`。

**边界 B3：model-resolver → @zhushanwen/pi-model-switch（import 链）**

```
model-resolver.ts:
  import { resolveModelForScene } from "@zhushanwen/pi-model-switch";

model-switch/package.json:
  "name": "@zhushanwen/pi-model-switch"
  "main": "index.ts"

model-switch/index.ts:
  export { resolveModelForScene } from "./advisor";

advisor.ts:
  export function resolveModelForScene(scene: string, now?: Date): string | undefined {...}
```

✅ 导入路径四段对齐：package name → index.ts [named re-export] → advisor.ts [actual definition]
✅ 函数签名匹配：参数 `scene: string`，返回值 `string | undefined`

**边界 B4：model-resolver → orchestrator（返回值）**

```typescript
// orchestrator.ts:240-245
const resolvedModel = resolveModel(opts);                         // "openrouter/glm-5.1"
const enrichedOpts = resolvedModel ? { ...opts, model: resolvedModel } : opts;  // { ..., model: "openrouter/glm-5.1" }
// trace node
model: enrichedOpts.model ?? "default",                          // "openrouter/glm-5.1"
```

✅ `resolvedModel` truthy → `enrichedOpts.model = "openrouter/glm-5.1"` ✅
✅ `resolvedModel` undefined → `enrichedOpts = opts`（不加 model 字段） ✅

**边界 B5：orchestrator → agent-pool（enrichedOpts）**

```typescript
// orchestrator.ts:256
this.agentPool.enqueue(enrichedOpts);
// agent-pool.ts enqueue() 的参数类型：AgentCallOpts
```

✅ `enrichedOpts` 结构对齐 `AgentCallOpts` — 多出的 `model` 字段被类型定义接受。

**边界 B6：agent-pool → pi subprocess（--model flag）**

```typescript
// agent-pool.ts:107-108
if (opts.model) {
  args.push("--model", opts.model);
}
```

`opts.model = "openrouter/glm-5.1"` → `args: ["--mode", "json", "-p", "--no-session", "--model", "openrouter/glm-5.1", prompt]`
✅ --model flag 格式正确（Pi 接受 `provider/modelId` 格式）。

---

### P2：scene="coding"，peak 全部 avoid → undefined

**边界 B2/B3/B4：undefined 传播**

```
resolveModelForScene("coding") → 所有候选 isPeakAvoid=true → return undefined  [advisor.ts:180]
model-resolver.ts → resolved = undefined → console.warn → return undefined    [model-resolver.ts:18-19]
orchestrator.ts → resolvedModel = undefined → enrichedOpts = opts (无 model)  [orchestrator.ts:240]
trace node → model = "default"                                                [orchestrator.ts:245]
buildArgs → opts.model = undefined → 不加 --model flag → Pi 默认模型           [agent-pool.ts:107]
```

✅ undefined 三跳传播正确，每跳均有 warn 日志。

---

### P3：scene="coding"，配置缺失

**边界 B3：loadConfig() → return null**

```
resolveModelForScene("coding") → loadConfig() → return null
→ console.warn("no config loaded") → return undefined
```

✅ 与 P2 汇合到同一降级路径。

---

### P4：explicit model，scene 忽略

```typescript
// model-resolver.ts:10
if (opts.model) return opts.model;
// 不检查 opts.scene，不调用 resolveModelForScene
// → scene 参数被静默忽略
```

✅ 见 model-resolver.ts 注释 "Priority: explicit model > scene advisor > Pi default"。

---

### P5：scene 跨进程传递（worker → orchestrator）

**数据类型对齐检查：**

`WorkerInMsg` 中的 `opts` 定义（worker-script.ts）：
```typescript
opts: {
  prompt: string;
  schema?: unknown;
  model?: string;
  scene?: string;
  description?: string;
}
```

`AgentCallOpts` 定义（agent-pool.ts）：
```typescript
interface AgentCallOpts {
  prompt: string;
  schema?: Record<string, unknown>;
  model?: string;
  scene?: string;
  description?: string;
}
```

⚠️ **B1 上的类型差异**：`schema` 字段类型为 `unknown`（`WorkerInMsg`）vs `Record<string, unknown>`（`AgentCallOpts`）。由于 `orchestrator.ts:222` 使用 `raw as WorkerInMsg` 断言，实际不会触发 TS 类型错误，但类型契约不完全对齐。（LOW-1）

---

### P6：undefined model → 不加 --model → Pi 默认

```
buildArgs: opts.model = undefined → if (opts.model) 未进入 → args 无 --model → spawn pi --mode json -p --no-session ...
```

✅ 正确降级到 Pi 默认模型。

---

## 问题清单

| # | 严重度 | 边界 | D# | 描述 | 文件 | 修改建议 |
|---|--------|------|----|------|------|---------|
| 1 | LOW | B1 | D3 | `WorkerInMsg.opts.schema` 类型为 `unknown`，但 `AgentCallOpts.schema` 为 `Record<string, unknown>`。运行时因 `as WorkerInMsg` 断言安全，但类型契约不完全对齐 | worker-script.ts:28, agent-pool.ts:14 | 将 `WorkerInMsg.opts.schema` 改为 `Record<string, unknown>`，与 `AgentCallOpts` 对齐；或在 `handleAgentCall` 中做一次类型归一 |
| 2 | INFO | B3/B8 | D1/D3 | `resolveModelForScene` 的 `now?: Date` 参数在 `model-resolver.ts` 中未传递，依赖函数内默认值 `new Date()`。这意味着 workflow 场景无法注入测试用的固定时间。当前无实际影响，但降低了可测试性 | model-resolver.ts:14, advisor.ts:124 | 若未来需要对 workflow 的 model resolution 做 time-aware 单元测试，需要在 `resolveModel` 上增加 `now` 参数透传 |

---

## 补充边界检查

### 依赖声明一致性（B7）

```
workflow/package.json:
  "dependencies": {
    "@zhushanwen/pi-model-switch": "workspace:*"
  }

model-switch/package.json:
  "name": "@zhushanwen/pi-model-switch"
```

✅ `workspace:*` 在 monorepo pnpm workspace 中正确解析到本地包。发布时自动转换为具体 semver 版本。

### 导出链完整性（B8）

```
model-switch/index.ts (main)
  → export default function modelSwitchExtension(pi)   // 扩展工厂
  → export { resolveModelForScene } from "./advisor"  // 编程式 API
```

✅ 同一个 `index.ts` 同时作为扩展入口和编程式 API 出口，设计清晰。
✅ `resolveModelForScene` 不是 default export，避免与扩展工厂冲突。

### 运行时兼容性

- `--model` flag 传递的 `"providerKey/modelId"` 格式被 Pi CLI 接受（Pi 的 model registry 使用 `{ provider, id }` 标识模型）
- 无 `--model` flag 时 Pi 使用 session 默认模型（在交互式会话中回退到当前活动模型）

---

## 结论

所有 8 个模块边界检查通过，6 条模拟数据验证路径全部对齐。

| UC | 边界通过数 | 问题 | 影响 |
|----|----------|------|------|
| UC-1（scene → model 解析） | 8/8 | LOW-1: schema 类型宽泛 | 无运行时影响 |
| UC-2（explicit model） | 5/5 | — | — |

**两个问题均为 LOW/INFO，无 MUST_FIX。**

1. **LOW-1**：`WorkerInMsg.opts.schema` 使用 `unknown` 类型。因 `as WorkerInMsg` 断言绕过类型检查，运行时无影响。但为保持类型契约精确，建议与 `AgentCallOpts.schema` 对齐为 `Record<string, unknown>`。
2. **INFO-1**：`resolveModelForScene` 的 `now` 参数在 workflow 中未透传。当前无实际影响（依赖 `new Date()` 默认值），未来引入 time-aware 单元测试时需加。

**verdict: pass** — 跨包导入/导出链完整、数据格式一致、错误传播路径明确、降级行为防御到位。
