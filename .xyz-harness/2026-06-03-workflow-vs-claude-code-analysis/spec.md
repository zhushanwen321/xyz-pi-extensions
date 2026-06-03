---
verdict: pass
---

# Workflow Extension — 集成 model-switch 智能模型推荐

## Background

### 问题

workflow extension 的 `agent()` 调用链路中，模型选择完全依赖脚本的静态声明（`agent({ model: "router-openai/glm-5.1" })`）。脚本作者需要手动了解各模型的：
- 可用性（是否已配置、是否有 quota）
- 适用性（图片处理、代码生成等不同场景的最优选择）
- 时段限制（如 zhipu 14:00-18:00 peak 时段 3x 计费）

同时，`@zhushanwen/pi-model-switch` 已实现完整的模型推荐逻辑（quota 快照 + peak 时段判断 + scene 映射），但它通过 `before_agent_start` 上下文注入给 AI 自主决策，不被 workflow 的脚本执行链路使用。

### 目标

让 workflow 脚本可以通过声明 `scene` 参数，由 runtime 调用 model-switch 的 advisor 逻辑自动选择最优模型。不声明时保持现有行为（由 AI/脚本自行决定）。

## Functional Requirements

### FR-1: agent() 新增 `scene` 参数

`worker-script.ts` 注入到 Worker 的 `agent()` 全局函数接受新的可选参数 `scene`：

```javascript
// 新增签名
agent({
  prompt: "审查 src/ 下所有 .ts 文件",
  scene: "coding",    // 新增
  schema: { ... },
  // model: "xxx"     // 显式 model > scene > 默认
})
```

**`AgentCallOpts` 类型扩展**（`agent-pool.ts`）：
- 新增 `scene?: string` 字段

**Worker→Main 消息传递**（`worker-script.ts`）：
- `agent-call` 消息中的 `opts` 增加 `scene` 字段

### FR-2: Orchestrator 模型解析

`orchestrator.ts` 在 `handleAgentCall()` 中，`executeWithRetry()` 之前，调用新增的 `resolveModel(opts)` 函数：

**决策优先级**（从高到低）：

| 优先级 | 来源 | 行为 |
|--------|------|------|
| 1 | `opts.model` 显式指定 | 原样传递到 AgentPool |
| 2 | `opts.scene` 声明 | 调用 model-switch `resolveModelForScene(scene)`，返回推荐模型 |
| 3 | 都不指定 | `undefined`，Pi 子进程使用默认模型 |

**推荐失败降级**：`resolveModelForScene()` 抛出异常时，log warning 但不阻断调用，回退到优先级 3（不指定模型）。

### FR-3: model-switch 新增 barrel export `resolveModelForScene()`

`@zhushanwen/pi-model-switch` 在 `src/index.ts` 中新增导出函数：

```typescript
/**
 * 根据场景名解析推荐模型。
 * 内部流程：
 *   1. loadConfig() 加载 model-policy.json
 *   2. 查 config.scenes[scene] 获取候选模型别名列表
 *   3. computeQuotaSnapshot() 获取各 plan 用量
 *   4. computePeakRecommend() 判断 peak 时段
 *   5. 按别名排序：非 peak plan 优先 → priority 高的优先
 *   6. 返回首个可用模型的 provider/modelId
 *   7. 全部不可用返回 undefined
 */
export function resolveModelForScene(scene: string): string | undefined;
```

**内部逻辑**：
1. `loadConfig()` → `config.scenes[scene]` → 如 `["glm-5.1", "ds-flash", "minimax-m3"]`
2. 对每个候选 alias，查 `config.models[provider].models[alias]` 获取 `{ modelId, plan }`
3. 对每个 plan 查 `computePeakRecommend()` → result 为 `"avoid"` 则跳过
4. 返回第一个 `result === "ok"` 的 `plan/modelId`

### FR-4: workflow 依赖声明

workflow 的 `package.json` 中新增依赖：

```json
{
  "dependencies": {
    "@zhushanwen/pi-model-switch": "workspace:*"
  }
}
```

**单调用方**：workflow 只 import `resolveModelForScene`，不 import 其他 model-switch 内部模块。

### FR-5: 错误处理

| 错误场景 | 行为 |
|---------|------|
| `loadConfig()` 返回 null（无配置） | `resolveModelForScene()` 返回 `undefined`，日志 warn |
| scene 在 config.scenes 中不存在 | `resolveModelForScene()` 返回 `undefined`，日志 warn |
| scene 对应的所有模型都是 peak "avoid" | `resolveModelForScene()` 返回 `undefined`，日志 info |
| `resolveModelForScene()` 抛出异常 | catch 异常，log warn，回退到不指定模型 |

**关键约束**：model-switch 配置缺失或异常**不阻断** workflow 执行。workflow 在最坏情况下回退到默认模型。

## Acceptance Criteria

### AC-1: scene 声明 → 正确模型选择

**Given**: `model-policy.json` 中配置了 `scenes.coding: ["glm-5.1", "ds-flash"]`，当前非 peak 时段
**When**: 脚本中调用 `agent({ prompt: "...", scene: "coding" })`
**Then**: Pi 子进程以 `--model zhipu/glm-5.1` 参数启动

### AC-2: peak 时段自动避让

**Given**: 同上配置，但当前是 zhipu peak 时段（14:00-18:00）且 quota 用量 > 50%
**When**: 脚本中调用 `agent({ prompt: "...", scene: "coding" })`
**Then**: Pi 子进程以 `--model opencode-go/ds-flash` 参数启动（跳过 glm）

### AC-3: 显式 model 覆盖 scene

**Given**: `model-policy.json` 存在
**When**: 脚本中调用 `agent({ prompt: "...", scene: "coding", model: "minimax/minimax-m3" })`
**Then**: Pi 子进程以 `--model minimax/minimax-m3` 参数启动（忽略 scene）

### AC-4: 无 scene 时行为不变

**Given**: `model-policy.json` 存在
**When**: 脚本中调用 `agent({ prompt: "..." })`（无 scene 无 model）
**Then**: Pi 子进程不携带 `--model` 参数（使用默认模型）

### AC-5: 配置缺失时降级

**Given**: `model-policy.json` 不存在
**When**: 脚本中调用 `agent({ prompt: "...", scene: "coding" })`
**Then**: warn 日志输出，Pi 子进程不携带 `--model` 参数，workflow 正常完成

### AC-6: 向后兼容

**Given**: 现有的所有 workflow 脚本（不使用 `scene` 参数）
**When**: 在集成后的 workflow extension 中运行
**Then**: 行为与集成前完全一致

## Constraints

- **不引入 pi-subagents 依赖**：保持现有 spawn("pi", ...) 机制
- **model-switch 作为 optional peer**：配置缺失不阻断 workflow
- **不改变 Worker 线程模型**：scene 解析在 Orchestrator（主线程）完成
- **不改变 callCache 逻辑**：resolved model 不写入 callCache key（cache 按 callId 工作，与 model 无关）
- **不改变 budget 计算**：model 切换不影响 token/cost/time budget 机制

## 业务用例

### UC-1: 批量代码审查自适应模型

- **Actor**: 用户（运行 workflow 脚本）
- **场景**: 用户在非 peak 时段运行批量代码审查脚本，脚本声明 `scene: "coding"`
- **预期结果**: workflow 自动选择 zhipu 模型（cost 最优），审查正常完成。而在 peak 时段运行时自动切换到 opencode-go，避免 3x 计费

### UC-2: 显式模型覆盖

- **Actor**: 脚本作者
- **场景**: 脚本作者明确知道某任务需要 vision 能力，在 `agent()` 中指定 `model: "minimax/mimo-v2.5-pro"`
- **预期结果**: workflow 使用指定模型，忽略 scene 和 advisor 推荐

## Complexity Assessment

- **改动范围**: 4 个文件（workflow `worker-script.ts`, `agent-pool.ts`, `orchestrator.ts`, model-switch `src/index.ts`）+ workflow `package.json`
- **新增代码**: ~80 行（`resolveModelForScene()` ~50 行 + orchestrator 集成 ~20 行 + 类型扩展 ~10 行）
- **破坏性变更**: 无（向后兼容，scene 为可选参数）
- **测试需求**: 覆盖 6 个 AC，建议 vitest 单测 `resolveModelForScene()` + 集成测试 AC-1/2/3/5
