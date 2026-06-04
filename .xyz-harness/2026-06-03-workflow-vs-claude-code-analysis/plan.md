---
verdict: pass
complexity: L1
---

# Workflow model-switch 集成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 workflow 脚本通过 `agent({ scene: "coding" })` 声明场景，由 model-switch advisor 自动推荐最优模型。

**Architecture:** workflow 的 Orchestrator 在处理 Worker 的 agent-call 消息时，调用 model-switch 新增的 `resolveModelForScene()` 函数解析模型。模型解析在主线程完成，结果通过现有 `--model` flag 传递给 Pi 子进程。

**Tech Stack:** TypeScript, Pi Extension API, vitest

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `extensions/model-switch/src/advisor.ts` | modify | BG1 | 新增 `resolveModelForScene()` 函数 |
| `extensions/model-switch/src/index.ts` | modify | BG1 | re-export `resolveModelForScene` |
| `extensions/workflow/src/agent-pool.ts` | modify | BG2 | `AgentCallOpts` 新增 `scene` 字段 |
| `extensions/workflow/src/worker-script.ts` | modify | BG2 | `agent()` 注入代码传递 `scene` 字段 |
| `extensions/workflow/src/orchestrator.ts` | modify | BG2 | 集成 `resolveModel()` 到 `handleAgentCall()` |
| `extensions/workflow/src/model-resolver.ts` | create | BG2 | 从 orchestrator 提取的模型解析纯函数 |
| `extensions/workflow/package.json` | modify | BG2 | 添加 `@zhushanwen/pi-model-switch` 依赖 |
| `extensions/model-switch/tests/resolveModelForScene.test.ts` | create | BG1 | `resolveModelForScene()` 单元测试 |
| `extensions/workflow/tests/resolveModel.test.ts` | create | BG2 | orchestrator 模型解析集成测试 |

## Interface Contracts

### Module: model-switch/advisor

#### Function: resolveModelForScene

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| resolveModelForScene | (scene: string) => string \| undefined | `"provider/modelId"` 或 `undefined` | config 为 null → undefined; scene 不存在 → undefined; 所有候选 avoid → undefined | AC-1, AC-2, AC-5 |

#### Data: ModelPolicy.scenes

| Field | Type | Description |
|-------|------|-------------|
| scenes | `Record<string, string[]>` | scene 名 → 模型 alias 列表 |

### Module: workflow/orchestrator

#### Function: resolveModel

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| resolveModel | (opts: AgentCallOpts) => string \| undefined | 模型字符串或 undefined | opts.model 存在 → 直接返回; opts.scene → 调 advisor; 都无 → undefined | AC-3, AC-4 |

#### Data: AgentCallOpts (扩展)

| Field | Type | Description |
|-------|------|-------------|
| scene | `string \| undefined` | 场景名，用于 model-switch advisor 推荐模型 |

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1 scene→正确模型 | resolveModelForScene("coding") → "zhipu/glm-5.1" | advisor:loadConfig→scenes→quota→peak→pick | Task 1 |
| AC-2 peak 避让 | resolveModelForScene("coding") peak 时 → "opencode-go/ds-flash" | advisor:loadConfig→scenes→quota→peak→skip avoid→pick | Task 1 |
| AC-3 显式 model 覆盖 | resolveModel({model:"minimax/m3"}) → "minimax/m3" | orchestrator: short-circuit | Task 3 |
| AC-4 无 scene 默认 | resolveModel({}) → undefined | orchestrator: no model, no scene | Task 3 |
| AC-5 配置缺失降级 | resolveModelForScene("coding") null config → undefined | advisor:loadConfig→null→warn→undefined | Task 1 |
| AC-6 向后兼容 | 无 scene 的 agent() 调用 → 行为不变 | worker-script: scene optional | Task 2 |

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 scene→正确模型 | adopted | Task 1 |
| AC-2 peak 时段避让 | adopted | Task 1 |
| AC-3 显式 model 覆盖 | adopted | Task 3 |
| AC-4 无 scene 默认 | adopted | Task 3 |
| AC-5 配置缺失降级 | adopted | Task 1 |
| AC-6 向后兼容 | adopted | Task 2 |
| FR-1 agent() 新增 scene | adopted | Task 2 |
| FR-2 Orchestrator 模型解析 | adopted | Task 3 |
| FR-3 model-switch barrel export | adopted | Task 1 |
| FR-4 workflow 依赖声明 | adopted | Task 3 |
| FR-5 错误处理 | adopted | Task 1, Task 3 |

## Task List

### Task 1: model-switch 新增 `resolveModelForScene()` + 单元测试

**Type:** backend

**Files:**
- Modify: `extensions/model-switch/src/advisor.ts`
- Modify: `extensions/model-switch/src/index.ts`
- Create: `extensions/model-switch/tests/resolveModelForScene.test.ts`

- [ ] **Step 1: 在 `advisor.ts` 中新增 `resolveModelForScene()` 函数**

函数签名：
```typescript
export function resolveModelForScene(scene: string): string | undefined
```

内部逻辑：
1. 调用 `loadConfig()` — 返回 null 则 warn 并返回 undefined
2. 查 `config.scenes[scene]` — 不存在则 warn 并返回 undefined
3. 获取 `readCache()` 中的 quota 数据
4. **调一次** `computeQuotaSnapshot(cache, config)` 得到全局快照
5. **调一次** `computePeakRecommend(now, config, snapshot)` 得到系统级 peak 状态（该函数是系统级的：内部通过 `findPeakPlan()` 找到唯一 peak plan，不区分候选）
6. 收集所有候选到 `Candidate[]` 数组，每个元素包含 `{ alias, providerKey, modelId, plan, priority, isPeakAvoid }`
7. 遍历 `config.models` 找每个候选 alias 的 provider：
   - 对 `config.models` 的每个 `[providerKey, pcfg]`，检查 `pcfg.models[alias]` 是否存在
   - 找到后记录 `providerKey`、`modelId`、`pcfg.plan`、`config.plans[pcfg.plan].priority`
   - 判断 `isPeakAvoid`：仅当候选的 `pcfg.plan` 等于 `findPeakPlan(config)` 返回的 planName 且 `peakRecommend.result === "avoid"` 时为 true
8. 按 spec FR-3 排序：`isPeakAvoid === false` 优先 → `priority` 数值小的优先（priority 1 > priority 2）
9. 返回排序后首个候选的 `providerKey/modelId`（这是 Pi `--model` flag 的正确格式）
10. 全部 avoid 或无候选 → info 日志并返回 undefined

关键设计决策：
- `computePeakRecommend` **只调用一次**（在循环外），避免 per-candidate 重复调用
- `isPeakAvoid` 通过比对候选的 plan 与 peak plan 名称来判断，而非对每个候选调 `computePeakRecommend`
- 返回 `providerKey/modelId`（如 `"zhipu/glm-5.1"`），不是 `plan/modelId`。`providerKey` 是 `config.models` 的 key（遍历时的外层 key）

需要在 advisor.ts 顶部新增 import：
```typescript
import { loadConfig } from "./config";
import { readCache } from "@zhushanwen/pi-quota-providers";
```

注意：`loadConfig` 和 `readCache` 当前已在 `src/index.ts` 中 import 但未在 advisor.ts 中。需要新增。

- [ ] **Step 2: 在 `src/index.ts` 末尾添加 re-export**

在文件末尾（`registerSwitchTool` 之后或 `export default` 之前）添加：
```typescript
// Re-export for programmatic usage (e.g., workflow extension)
export { resolveModelForScene } from "./advisor";
```

- [ ] **Step 3: 编写单元测试 `tests/resolveModelForScene.test.ts`**

测试框架使用 vitest（从 vitest 导入 describe/it/expect/vi），运行命令 `npx vitest run`，禁止 node:test 和 tsx --test。

测试用例覆盖：
- TC-1-01: config 存在 + scene 存在 + 非 peak → 返回 `"zhipu/glm-5.1"`（第一个候选，priority 1）
- TC-1-02: config 存在 + scene 存在 + zhipu peak avoid → 返回 `"opencode-go/ds-flash"`（跳过 peak plan 的 zhipu，选择非 peak 的 opencode-go）
- TC-1-03: config 存在 + scene 不存在 → 返回 undefined + warn 日志
- TC-1-04: config 不存在（loadConfig 返回 null） → 返回 undefined + warn 日志
- TC-1-05: 所有候选都是 peak avoid → 返回 undefined + info 日志
- TC-1-06: scenes 列表顺序与 priority 不一致（如 `["ds-flash", "glm-5.1"]`）+ 非 peak → 仍返回 `"zhipu/glm-5.1"`（priority 排序后取首个）

mock 策略：mock `./config` 的 `loadConfig` 和 `@zhushanwen/pi-quota-providers` 的 `readCache`。`computeQuotaSnapshot` 和 `computePeakRecommend` 不需要 mock（纯计算函数）。

构造 test config：
```typescript
const mockConfig: ModelPolicy = {
  version: 2,
  models: {
    "zhipu": { plan: "zhipu", models: { "glm-5.1": { modelId: "glm-5.1", capabilities: ["text"] } } },
    "opencode-go": { plan: "opencode-go", models: { "ds-flash": { modelId: "ds-flash", capabilities: ["text"] } } },
  },
  scenes: { coding: ["glm-5.1", "ds-flash"] },
  plans: {
    zhipu: { priority: 1, peak: { start: 14, end: 18, multiplier: 3 } },
    "opencode-go": { priority: 2 },
  },
  stickiness: { minTurns: 3, minInputTokens: 1000 },
};
```

测试中 mock `computePeakRecommend`：
- peak 时段：返回 `{ result: "avoid", reason: "Peak hours" }`（只影响 plan 匹配 peakPlan 的候选）
- 非 peak：返回 `{ result: "ok", reason: "Off-peak" }`

也 mock `findPeakPlan`（或通过 mock config 间接控制）：返回 `["zhipu", config.plans.zhipu]`。

- [ ] **Step 4: 运行测试确认全部通过**

```bash
npx vitest run extensions/model-switch/tests/resolveModelForScene.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add extensions/model-switch/src/advisor.ts extensions/model-switch/src/index.ts extensions/model-switch/tests/resolveModelForScene.test.ts
git commit -m "feat(model-switch): add resolveModelForScene() for workflow integration"
```

---

### Task 2: workflow 类型扩展 + Worker 脚本 scene 传递

**Type:** backend

**Files:**
- Modify: `extensions/workflow/src/agent-pool.ts` (新增 `scene` 字段到 `AgentCallOpts`)
- Modify: `extensions/workflow/src/worker-script.ts` (agent() 注入代码传递 scene)

- [ ] **Step 1: 扩展 `AgentCallOpts` 接口**

在 `extensions/workflow/src/agent-pool.ts` 的 `AgentCallOpts` 接口中新增：
```typescript
/** Scene name for model-switch advisor recommendation. */
scene?: string;
```

位置：在 `model?: string` 字段之后。

- [ ] **Step 2: 扩展 Worker 消息类型**

在 `extensions/workflow/src/worker-script.ts` 的 `WorkerOutMsg` 类型中，`agent-call` 消息的 `opts` 添加 `scene`：
```typescript
| { type: "agent-call"; callId: number; opts: { prompt: string; schema?: unknown; model?: string; scene?: string; description?: string } }
```

- [ ] **Step 3: 扩展 `agent()` 注入代码**

在 `worker-script.ts` 的 `buildWorkerScript()` 中，`agent()` 函数的两种参数形式都要传递 `scene`：

字符串参数形式（~行 142-148）添加：
```javascript
'        scene: (secondArg && typeof secondArg === "object" && secondArg.scene) || undefined,',
```

对象参数形式（~行 149-160）添加：
```javascript
'          scene: firstArg.scene,',
```

兼容性分支（`firstArg.task || firstArg.agent`）也添加：
```javascript
'          scene: firstArg.scene,',
```

- [ ] **Step 4: 确认类型检查通过**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add extensions/workflow/src/agent-pool.ts extensions/workflow/src/worker-script.ts
git commit -m "feat(workflow): add scene parameter to AgentCallOpts and agent() global"
```

---

### Task 3: Orchestrator 模型解析集成 + 依赖声明

**Type:** backend

**Depends on:** Task 1, Task 2

**Files:**
- Modify: `extensions/workflow/src/orchestrator.ts`
- Modify: `extensions/workflow/package.json`
- Create: `extensions/workflow/tests/resolveModel.test.ts`

- [ ] **Step 1: 在 `orchestrator.ts` 顶部添加 import**

```typescript
import { resolveModelForScene } from "@zhushanwen/pi-model-switch";
```

- [ ] **Step 2: 新增 `resolveModel()` 函数**

在 `Orchestrator` 类中新增私有方法：

```typescript
/**
 * 根据调用选项解析目标模型。
 * 优先级：显式 model > scene advisor > undefined（Pi 默认）
 */
private resolveModel(opts: AgentCallOpts): string | undefined {
  if (opts.model) return opts.model;
  if (opts.scene) {
    try {
      const resolved = resolveModelForScene(opts.scene);
      if (resolved) {
        console.log(`[workflow] scene "${opts.scene}" resolved to model: ${resolved}`);
      } else {
        console.warn(`[workflow] scene "${opts.scene}" could not resolve to a model, using default`);
      }
      return resolved ?? undefined;
    } catch (err) {
      console.warn(`[workflow] resolveModelForScene failed for scene "${opts.scene}":`, err);
      return undefined;
    }
  }
  return undefined;
}
```

- [ ] **Step 3: 在 `handleAgentCall()` 中集成**

在 `handleAgentCall()` 方法中，`this.executeWithRetry(runId, callId, opts, instance, node)` 调用之前，插入模型解析：

```typescript
// Resolve model from scene if needed
const resolvedModel = this.resolveModel(opts);
const enrichedOpts = resolvedModel ? { ...opts, model: resolvedModel } : opts;
```

然后将后续的 `opts` 引用替换为 `enrichedOpts`（仅在传给 `executeWithRetry` 时）。trace node 的 model 字段也应更新：

```typescript
node.model = enrichedOpts.model ?? "default";
```

- [ ] **Step 4: 更新 `package.json` 添加依赖**

在 `extensions/workflow/package.json` 的 `dependencies` 中添加：
```json
"@zhushanwen/pi-model-switch": "workspace:*"
```

- [ ] **Step 5: 编写集成测试 `tests/resolveModel.test.ts`**

测试框架使用 vitest。

测试用例：
- TC-3-01: opts.model 存在 → 直接返回 opts.model
- TC-3-02: opts.model 不存在 + opts.scene 存在 + resolveModelForScene 返回值 → 返回该值
- TC-3-03: opts.model 不存在 + opts.scene 存在 + resolveModelForScene 返回 undefined → 返回 undefined
- TC-3-04: opts 都不传 → 返回 undefined
- TC-3-05: resolveModelForScene 抛异常 → catch + warn + 返回 undefined

mock `@zhushanwen/pi-model-switch` 的 `resolveModelForScene`。

注意：`resolveModel` 是 Orchestrator 的私有方法。测试策略有两种：
- A) 将其提取为独立模块函数（如 `src/model-resolver.ts`），直接测试
- B) 测试 `handleAgentCall` 的端到端行为

推荐方案 A（提取为 `src/model-resolver.ts`），保持函数纯净可测。

- [ ] **Step 6: 运行测试确认通过**

```bash
npx vitest run extensions/workflow/tests/resolveModel.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add extensions/workflow/src/orchestrator.ts extensions/workflow/src/model-resolver.ts extensions/workflow/package.json extensions/workflow/tests/resolveModel.test.ts
git commit -m "feat(workflow): integrate model-switch scene-based model resolution"
```

---

## Execution Groups

#### BG1: model-switch advisor

**Description:** model-switch 新增 `resolveModelForScene()` 函数及其单元测试。独立于 workflow，可先行完成。

**Tasks:** Task 1

**Files (预估):** 3 个文件（2 modify + 1 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: high、tdd-coder: medium、reviewer: medium） |
| 注入上下文 | Task 1 描述 + spec FR-3/FR-5 + advisor.ts/config.ts/types.ts 现有代码 |
| 读取文件 | `extensions/model-switch/src/advisor.ts`, `extensions/model-switch/src/config.ts`, `extensions/model-switch/src/types.ts`, `extensions/model-switch/src/index.ts` |
| 修改/创建文件 | `extensions/model-switch/src/advisor.ts`, `extensions/model-switch/src/index.ts`, `extensions/model-switch/tests/resolveModelForScene.test.ts` |

**Execution Flow (BG1 内部):** 单 Task，走完整 TDD 链。

  Task 1:
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** 无

**设计细节:** 函数实现直接在 advisor.ts 中，复用已有的 `computeQuotaSnapshot` + `computePeakRecommend` 计算管线。

---

#### BG2: workflow 集成

**Description:** workflow 的类型扩展、Worker 脚本 scene 传递、Orchestrator 模型解析集成及测试。

**Tasks:** Task 2, Task 3

**Files (预估):** 6 个文件（4 modify + 2 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择 |
| 注入上下文 | Task 2/3 描述 + spec FR-1/FR-2/FR-4 + workflow 源码 |
| 读取文件 | `extensions/workflow/src/agent-pool.ts`, `extensions/workflow/src/worker-script.ts`, `extensions/workflow/src/orchestrator.ts`, `extensions/workflow/package.json` |
| 修改/创建文件 | `extensions/workflow/src/agent-pool.ts`, `extensions/workflow/src/worker-script.ts`, `extensions/workflow/src/model-resolver.ts`, `extensions/workflow/src/orchestrator.ts`, `extensions/workflow/package.json`, `extensions/workflow/tests/resolveModel.test.ts` |

**Execution Flow (BG2 内部):** 串行派遣。

  Task 2 (类型扩展，无测试):
    1. general-purpose → 修改 agent-pool.ts + worker-script.ts
    2. general-purpose → tsc --noEmit 验证

  Task 3 (depends on Task 1 + Task 2):
    1. general-purpose (read xyz-harness-test-driven-development) → 写失败测试
    2. general-purpose → 写实现代码（model-resolver.ts + orchestrator.ts 集成 + package.json）
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** BG1（需要 `resolveModelForScene` 已实现）

---

## Dependency Graph & Wave Schedule

```
BG1 (model-switch advisor) ──→ BG2 (workflow 集成)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | model-switch 新增函数，无外部依赖 |
| Wave 2 | BG2 | 依赖 BG1 的 `resolveModelForScene` 导出 |
