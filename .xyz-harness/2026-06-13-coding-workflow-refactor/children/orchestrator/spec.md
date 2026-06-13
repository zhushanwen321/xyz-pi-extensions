---
verdict: pass
parent:
  topic_dir: ../..
  spec: ../../spec.md
  manifest: ../../manifest.yaml
priority: P0
subsystem: orchestrator
---

# Orchestrator — 子系统 Spec

## Background

当前 coding-workflow 的编排逻辑散布在 `index.ts`（入口）、`tool-handlers.ts`（tool 处理函数）和 `helpers.ts`（PHASES 配置）中。编排、执行、状态管理纠缠在一起。

本 spec 定义编排引擎的职责：**读取 phase 配置 → 调用原子操作 → 管理状态流转**。编排引擎不实现任何业务逻辑，只负责调度。

### 核心原则

1. **编排引擎是胶水，不是逻辑** — 所有业务逻辑在原子操作中，编排引擎只负责"按顺序调用"
2. **声明式配置驱动** — phase 的 pipeline 配置是数据，不是代码
3. **状态只进不退** — phase 只能向前推进（除非 abort 或 error），不支持回退到前序 phase
4. **事件驱动注入** — skill 注入通过 Pi 事件系统触发，不是编排引擎主动轮询

## Functional Requirements

### FR-OR1: PhaseConfig 声明

将现有 `PHASES` 数组提取为独立的配置模块。

**数据结构**：

```typescript
interface PhaseConfig {
  phase: number;                     // Phase 编号（1-5）
  name: string;                      // 显示名（"Spec", "Plan", "Dev", "Test", "PR"）
  skillName: string;                 // 注入的 skill 名称
  reviewPrefix: string | string[];   // review 文件名前缀
  retrospectPrefix: string;          // retrospect 文件名前缀
  deliverables: string[];            // 该 phase 的交付物路径（相对于 topicDir）
  reviewMode: string;                // review 模式描述
  /** 自动化阶段 pipeline 步骤 */
  pipeline: StepConfig[];
}
```

**配置内容**（从 plan.md EG-3 和 atomic-operations spec 的 pipeline 配置提取）：

```typescript
const PHASE_CONFIGS: PhaseConfig[] = [
  {
    phase: 1, name: "Spec",
    skillName: "xyz-harness-brainstorming",
    reviewPrefix: "spec_review",
    retrospectPrefix: "spec_retrospect",
    deliverables: ["spec.md"],
    reviewMode: "Mode 1: Plan review (verify spec completeness)",
    pipeline: [
      { operation: "gate-check" },
      { operation: "review-loop", args: { maxRounds: 3 } },
      { operation: "review-dispatch" },
      { operation: "retrospect", on_fail: "warn_continue" },
    ],
  },
  {
    phase: 2, name: "Plan",
    skillName: "xyz-harness-writing-plans",
    reviewPrefix: ["business_logic_review", "standards_review", "robustness_review",
                    "integration_review", "ts_taste_review", "rust_taste_review", "taste_review"],
    retrospectPrefix: "plan_retrospect",
    deliverables: ["plan.md", "e2e-test-plan.md", "test_cases_template.json",
                    "use-cases.md", "non-functional-design.md"],
    reviewMode: "Mode 1: Plan review (verify plan feasibility)",
    pipeline: [
      { operation: "gate-check" },
      { operation: "review-loop", args: { maxRounds: 3 } },
      { operation: "retrospect", on_fail: "warn_continue" },
    ],
  },
  {
    phase: 3, name: "Dev",
    skillName: "xyz-harness-phase-dev",
    reviewPrefix: "dev_review",
    retrospectPrefix: "dev_retrospect",
    deliverables: ["changes/evidence/test_results.md"],
    reviewMode: "Mode 2: Code review (verify implementation against spec)",
    pipeline: [
      { operation: "gate-check" },
      { operation: "review-loop", args: { maxRounds: 3 } },
      { operation: "retrospect", on_fail: "warn_continue" },
    ],
  },
  {
    phase: 4, name: "Test",
    skillName: "xyz-harness-phase-test",
    reviewPrefix: "",
    retrospectPrefix: "test_retrospect",
    deliverables: ["changes/evidence/test_execution.json"],
    reviewMode: "Mode 3: Test review (verify test coverage and quality)",
    pipeline: [
      { operation: "gate-check" },
      { operation: "test-fix-loop", args: { maxRounds: 10 } },
      { operation: "retrospect", on_fail: "warn_continue" },
    ],
  },
  {
    phase: 5, name: "PR",
    skillName: "xyz-harness-phase-pr",
    reviewPrefix: "pr_review",
    retrospectPrefix: "overall_retrospect",
    deliverables: ["changes/evidence/pr_evidence.md", "changes/evidence/ci_results.md"],
    reviewMode: "Code review (verify PR completeness and CI results)",
    pipeline: [
      { operation: "gate-check" },
      { operation: "retrospect", on_fail: "warn_continue" },
    ],
  },
];
```

**L1/L2 扩展配置**（Phase 1 的复杂度分支）：

```typescript
// L1/L2 系统级 pipeline（替代 Phase 1 的标准 pipeline）
const SPEC_L12_SYSTEM_PIPELINE: StepConfig[] = [
  { operation: "gate-check" },
  { operation: "contract-check" },
  { operation: "review-dispatch" },
];

// L1/L2 子系统级 pipeline
const SPEC_L12_SUBSYSTEM_PIPELINE: StepConfig[] = [
  { operation: "dependency-check", args: { targetPhase: "spec" } },
  { operation: "gate-check" },
  { operation: "review-dispatch" },
  { operation: "retrospect", on_fail: "warn_continue" },
];
```

**复杂度路由**：Pipeline 执行器根据 `workflowState.complexity` 选择对应的 pipeline 配置。L0 用标准 pipeline，L1/L2 用系统级或子系统级 pipeline。

---

### FR-OR2: Pipeline 执行器

按 StepConfig 顺序调用原子操作，处理失败策略。

**接口**：

```typescript
interface StepConfig {
  operation: string;                 // 操作 ID（对应 Operation.id）
  args?: Record<string, unknown>;    // 传递给操作的参数
  on_fail?: "return" | "retry" | "warn_continue";  // 失败策略
  max_retries?: number;              // on_fail="retry" 时的最大重试次数
}

interface PipelineResult {
  passed: boolean;
  stepsExecuted: number;
  failedStep?: string;               // 失败的操作 ID
  stepResults: Array<{
    operation: string;
    passed: boolean;
    duration_ms: number;
    token_usage?: UsageStats;
  }>;
  totalDuration_ms: number;
  totalTokenUsage?: UsageStats;
}
```

**执行流程**：

```
Pipeline.run(config, ctx):
  for step in config.pipeline:
    operation = registry.get(step.operation)
    result = operation.execute(ctx)

    if not result.passed:
      switch step.on_fail:
        case "return":
          return PipelineResult(passed=false, failedStep=step.operation)
        case "retry":
          for i in range(step.max_retries ?? 1):
            result = operation.execute(ctx)
            if result.passed: break
          if not result.passed:
            return PipelineResult(passed=false, failedStep=step.operation)
        case "warn_continue":
          log warning
          continue  // 继续下一步
    end if

    record result
  end for

  return PipelineResult(passed=true)
```

**失败策略说明**：

| 策略 | 行为 | 适用操作 |
|------|------|---------|
| `"return"` | 失败立即返回，不继续 | gate-check, review-loop, test-fix-loop, review-dispatch |
| `"retry"` | 失败后重试 N 次 | （当前未使用，预留） |
| `"warn_continue"` | 失败记录警告，继续下一步 | retrospect |

**关键约束**：
- Pipeline 是**同步串行**的——一个操作完成后才执行下一个
- Pipeline **不处理交互阶段**——只执行自动化阶段的操作
- Pipeline 结果汇总 token usage 和耗时，用于展示和调试

---

### FR-OR3: OrderResolver（串行调度）

spec-clarify 阶段的子系统调度器。将依赖图转为严格的一维串行序列。

**接口**：

```typescript
interface OrderResolver {
  /**
   * 从 manifest 的依赖关系推导子系统执行顺序。
   * 返回一维数组：被依赖的排前面，依赖者排后面。
   * 循环依赖时抛出错误。
   */
  deriveOrder(manifest: ManifestData): string[];
}
```

**算法**：Kahn's 拓扑排序

```
deriveOrder(manifest):
  // 构建邻接表和入度表
  graph = buildGraph(manifest.children)
  inDegree = computeInDegree(graph)

  queue = [nodes with inDegree == 0]
  // 同入度 0 时按 priority 排序：P0 > P1 > P2
  sort queue by priority ascending

  result = []
  while queue is not empty:
    node = queue.dequeue()
    result.push(node)

    for neighbor in graph[node].dependents:
      inDegree[neighbor] -= 1
      if inDegree[neighbor] == 0:
        queue.enqueue(neighbor)

  if result.length != manifest.children.length:
    throw Error("Circular dependency detected")

  return result
```

**输出示例**：
```
manifest.children = [
  { name: "A", depends_on: [] },
  { name: "B", depends_on: ["A"] },
  { name: "C", depends_on: ["A"] },
  { name: "D", depends_on: ["B", "C"] },
]
→ deriveOrder = ["A", "B", "C", "D"]  或  ["A", "C", "B", "D"]
```

**约束**：
- 返回值是一维数组，不是二维波次
- 同级无依赖的子系统之间按 priority 排序
- 检测到循环依赖时抛出错误（含环路径描述）

**为什么 spec-clarify 不用 WaveScheduler**：
见 spec-clarify-phase spec D-SC8 — 人机交互的 brainstorming 无法并行，共享交互线程（用户），信息隐性依赖，compact 时机要求。

---

### FR-OR4: WaveScheduler（并行波次调度）

dev/test 阶段的子系统调度器。将依赖图转为二维并行波次。

**接口**：

```typescript
interface WaveScheduler {
  /**
   * 从 manifest 的依赖关系推导子系统执行波次。
   * 返回二维数组：同一波次内的子系统可以并行执行。
   * 循环依赖时抛出错误。
   */
  deriveWaves(manifest: ManifestData): string[][];
}
```

**算法**：拓扑排序 + 同层分组

```
deriveWaves(manifest):
  graph = buildGraph(manifest.children)
  inDegree = computeInDegree(graph)

  currentWave = [nodes with inDegree == 0]
  result = []

  while currentWave is not empty:
    result.push(currentWave)

    nextWave = []
    for node in currentWave:
      for neighbor in graph[node].dependents:
        inDegree[neighbor] -= 1
        if inDegree[neighbor] == 0:
          nextWave.push(neighbor)

    currentWave = nextWave

  if total_nodes_in_result != manifest.children.length:
    throw Error("Circular dependency detected")

  return result
```

**输出示例**：
```
manifest.children = [
  { name: "A", depends_on: [] },
  { name: "B", depends_on: ["A"] },
  { name: "C", depends_on: ["A"] },
  { name: "D", depends_on: ["B", "C"] },
]
→ deriveWaves = [["A"], ["B", "C"], ["D"]]
// Wave 1: A（独立）
// Wave 2: B 和 C（可以并行，都只依赖 A）
// Wave 3: D（依赖 B 和 C）
```

**约束**：
- 返回值是二维数组
- 同一波次内的子系统互不依赖（理论上可并行）
- 实际并行度取决于执行引擎的能力（当前 Pi subagent 并发上限约 5 个）
- 检测到循环依赖时抛出错误

**适用阶段**：仅用于 dev 和 test phase。spec-clarify 阶段使用 OrderResolver。

---

### FR-OR5: Manifest 解析 + 状态聚合

解析 `manifest.yaml` 并提供状态查询接口。

**接口**：

```typescript
interface ManifestData {
  name: string;
  slug: string;
  created: string;
  status: string;
  children: Array<ManifestChild>;
  contracts?: Array<ManifestContract>;
}

interface ManifestChild {
  name: string;
  path: string;
  depends_on: string[];
  dev_depends_on?: string[];
  priority: "P0" | "P1" | "P2";
  description: string;
  contract_sections?: Array<{
    provides: string;
    consumes: string[];
  }>;
}

interface ManifestContract {
  id: string;
  file: string;
  provider: string;
  consumers: string[];
}

interface ManifestStore {
  /** 加载 manifest（从磁盘或缓存） */
  load(topicDir: string): ManifestData | null;

  /** 更新子系统状态（写入 children/{name}/.state.json） */
  updateChildStatus(topicDir: string, childName: string, status: string): void;

  /** 读取子系统状态（从 children/{name}/.state.json） */
  getChildStatus(topicDir: string, childName: string): string | null;

  /** 聚合所有子系统状态 → 父级状态 */
  aggregateStatus(topicDir: string): string;

  /** 检查指定子系统的依赖是否满足 */
  checkDependencies(
    topicDir: string,
    childName: string,
    requiredStatus: string,
  ): DependencyCheckResult;
}
```

**状态聚合规则**（从 `children/{name}/.state.json` 读取）：

```
aggregateStatus(topicDir):
  statuses = []
  for child in manifest.children:
    stateFile = path.join(topicDir, child.path, ".state.json")
    if exists(stateFile):
      statuses.push(JSON.parse(read(stateFile)).status)
    else:
      statuses.push("pending")

  if all are "pending":               return "pending"
  if any is "spec_in_progress":       return "spec_in_progress"
  if all are "spec_approved":         return "spec_approved"
  if any is "plan_in_progress":       return "plan_in_progress"
  if all are "plan_approved":         return "plan_approved"
  if any is "dev_in_progress":        return "dev_in_progress"
  if all are "dev_complete":          return "dev_complete"
  if any is "test_in_progress":       return "test_in_progress"
  if all are "test_complete":         return "test_complete"
  if all are "pr_complete":           return "pr_complete"

  return "in_progress"  // 混合状态
```

**向后兼容**：
- L0 扁平 topicDir 没有 manifest.yaml → `load()` 返回 null
- 所有依赖 manifest 的操作在 L0 时跳过 manifest 相关逻辑
- `updateChildStatus` 写入 `children/{name}/.state.json`，不修改 manifest.yaml 本身

---

### FR-OR6: OperationRegistry

原子操作的注册和查找。

**接口**：

```typescript
interface OperationRegistry {
  /** 注册一个操作 */
  register(operation: Operation): void;

  /** 按 ID 查找操作 */
  get(id: string): Operation | undefined;

  /** 列出所有已注册的操作 ID */
  listIds(): string[];
}
```

**注册时机**：extension 入口（index.ts）初始化时注册所有 13 个操作。

**使用方式**：
- Pipeline 执行器通过 `registry.get(step.operation)` 查找
- `run-op` tool 通过 `registry.get(action)` 查找
- A1 init 内部调用 A2 skill-inject 通过 `registry.get("skill-inject")` 查找

---

### FR-OR7: 全局 WorkflowState

精简后的全局状态。去除分散在各个操作中的计数器。

**接口**：

```typescript
interface WorkflowState {
  isActive: boolean;
  currentPhase: number;
  topicDir: string;
  topicName: string;
  phaseResults: Record<number, "passed">;
  pendingInit: boolean;
  pendingRequirement: string;
  /** 复杂度评估结果（L0 默认） */
  complexity: "L0" | "L1" | "L2";
  /** L1/L2 的 manifest 数据（L0 时为 null） */
  manifest: ManifestData | null;
  /** 当前处理的子系统序号（-1 = 系统级，0+ = 第 N 个子系统） */
  subsystemIndex: number;
  /** 子系统名 → passed 的映射 */
  subsystemResults: Record<string, "passed">;
}
```

**与现有状态的区别**：

| 字段 | 现有 | 重构后 | 说明 |
|------|------|--------|------|
| `gateInProgress` | ✓ | ✗ | 移到 gate-check 操作的局部状态 |
| `gateRetryCount` | ✓ | ✗ | 移到 Pipeline 执行器的执行上下文 |
| `compactRetryCount` | ✓ | ✗ | 移到 phase-transition 操作的局部状态 |
| `complexity` | ✗ | ✓ | 新增：复杂度评估结果 |
| `manifest` | ✗ | ✓ | 新增：L1/L2 manifest 数据 |
| `subsystemIndex` | ✗ | ✓ | 新增：当前子系统序号（-1 = 系统级） |
| `subsystemResults` | ✗ | ✓ | 新增：子系统通过记录 |

**状态持久化**：

与现有机制一致——通过 `pi.appendEntry("coding-workflow", state)` 写入，`ctx.sessionManager.getEntries()` 读取。`reconstructState` 从最近的 entry 恢复状态。

**状态变更权限**：

| 操作 | 可修改字段 |
|------|-----------|
| A1 init | isActive, currentPhase, topicDir, topicName, pendingInit, pendingRequirement |
| A8 phase-transition | currentPhase (next-phase), subsystemIndex (next-subsystem), phaseResults, subsystemResults |
| A9 complexity-assess | complexity |
| A10 decompose | manifest |
| 其他操作 | 无（只读 workflowState） |

---

### FR-OR8: Tool 注册

注册 4 个 Tool（3 个现有 + 1 个新增）。

**现有 Tool 适配**：

| Tool | 现有行为 | 重构后行为 |
|------|---------|-----------|
| `coding-workflow-init` | 直接执行 init 逻辑 | 委托给 A1 init 操作 |
| `coding-workflow-gate` | 混合执行 gate-check + review + retrospect | 执行当前 phase 的 pipeline（通过 Pipeline 执行器） |
| `coding-workflow-phase-start` | 直接执行 phase 切换 | 委托给 A8 phase-transition 操作 |

**`coding-workflow-gate` 重构细节**：

现有 `executeGateTool` 的 6 种职责分配：

| 现有职责 | 分配给 |
|---------|--------|
| 验证状态（isActive, pendingInit, phase token） | gate tool handler（前置检查） |
| 检查前序 phase 通过 | gate tool handler（前置检查） |
| 检查前序 review 文件 | gate tool handler（前置检查） |
| 执行 gate pipeline（gate-check → review-loop → ...） | Pipeline 执行器 |
| 派遣 review subagent | A4 review-dispatch 操作 |
| 生成回顾 steer | A7 retrospect 操作 |

重构后的 gate tool handler 流程：

```
executeGateTool(params):
  // 1. 前置检查（状态验证）
  validateState(state, params.phase)
  validatePriorPhases(state)
  validatePriorReviews(state)

  // 2. 执行 pipeline
  phaseConfig = PHASE_CONFIGS[state.currentPhase - 1]
  pipeline = resolvePipeline(phaseConfig, state.complexity)
  result = pipeline.run(phaseConfig.pipeline, ctx)

  // 3. 处理结果
  if result.passed:
    state.phaseResults[params.phase] = "passed"
    dispatchRetrospectSteer(state, phaseConfig)
  return result
```

**新增 Tool**：

```typescript
// coding-workflow-run-op — 独立调用原子操作
const RunOpParams = Type.Object({
  action: StringEnum([
    "complexity-assess", "decompose", "contract-define", "contract-check",
    "dependency-check", "review-loop", "gate-check", "review-dispatch",
    "retrospect", "phase-transition", "skill-inject", "test-fix-loop",
    // 不暴露: init（需要 workflow 未激活状态）
    // 不暴露: aggregate-status（改为 ManifestStore.aggregateStatus() 内部调用）
  ]),
  topicDir: Type.String({ description: "工作目录路径" }),
  phase: Type.Optional(Type.Number()),
  maxRounds: Type.Optional(Type.Number()),
  // 其他操作特定参数...
});

// execute 实现
executeRunOp(params):
  operation = registry.get(params.action)
  if !operation:
    return error("Unknown operation: {params.action}")

  ctx = buildOperationContext(params)
  result = operation.execute(ctx)
  return { content: [{ type: "text", text: formatResult(result) }] }
```

---

### FR-OR9: 事件处理

保持现有的事件注册，适配重构后的模块。

| 事件 | 现有行为 | 重构后行为 |
|------|---------|-----------|
| `before_agent_start` | 注入 skill 内容 + 等待状态提示 | 委托给 A2 skill-inject 操作 |
| `session_start` | reconstructState + updateWidget | 不变 |
| `session_tree` | kill subprocesses + reset state | 不变 |
| `turn_end` | updateWidget | 不变 |

**`before_agent_start` 适配**：

```
before_agent_start(event):
  if !state.isActive or state.pendingInit:
    return undefined

  // 检查当前 phase 是否已 passed → 显示等待提示
  if state.phaseResults[state.currentPhase] === "passed":
    return waitingMessage(state.currentPhase)

  // 检查前序 phase retrospect
  missingRetrospects = checkMissingRetrospects(state)
  if missingRetrospects.length > 0:
    return blockedMessage(missingRetrospects)

  // 注入 skill
  return skillInjectOperation.execute(buildSkillInjectContext(event))
```

---

### FR-OR10: 命令注册

保持现有 3 个命令不变。

| 命令 | 行为 |
|------|------|
| `/coding-workflow` | 启动 workflow（设置 pendingInit=true, 提取 requirement） |
| `/coding-workflow-status` | 显示当前状态 |
| `/coding-workflow-abort` | 中止 workflow（kill subprocesses + reset state） |

---

## 模块结构

```
lib/orchestrator/
├── pipeline.ts              # Pipeline 执行器
├── phase-config.ts          # PhaseConfig 定义 + 配置数据
├── order-resolver.ts        # 串行调度（spec-clarify 用）
├── wave-scheduler.ts        # 并行波次调度（dev/test 用）
├── manifest.ts              # Manifest 解析 + 状态聚合
└── operation-registry.ts    # 操作注册表
```

**入口（index.ts）结构**：

```
index.ts（≤ 200 行）
├── 注册 4 个 Tool（init, gate, phase-start, run-op）
│   └── 每个 tool 的 execute 委托给对应的操作/pipeline
├── 注册 3 个 Command（workflow, status, abort）
├── 注册 4 个 Event（before_agent_start, session_start, session_tree, turn_end）
├── 注册 MessageRenderer（coding-workflow-context）
├── 初始化 OperationRegistry（注册 13 个操作）
├── 状态持久化/恢复（persistState, reconstructState）
└── Widget 更新（updateWidget）
```

## 入口代码结构约束

index.ts 作为入口，只做注册胶水。所有逻辑委托出去：

| 职责 | 委托给 | index.ts 中的代码 |
|------|--------|------------------|
| Tool execute | 操作 / Pipeline | `return pipeline.run(...)` 或 `return operation.execute(...)` |
| Command handler | 直接逻辑 | 保持内联（逻辑简单） |
| Event handler | 操作 / 辅助函数 | `return skillInject.execute(...)` |
| 状态持久化 | StateStore / helpers | 调用 `persistState()` / `reconstructState()` |
| Widget 更新 | render.ts | 调用 `updateWidget()` |

## Acceptance Criteria

### AC-OR1: Pipeline 执行

- [ ] Pipeline 按 StepConfig 顺序执行操作
- [ ] `on_fail: "return"` 的操作失败时立即停止
- [ ] `on_fail: "warn_continue"` 的操作失败时记录警告继续
- [ ] Pipeline 汇总所有步骤的耗时和 token usage

### AC-OR2: 复杂度路由

- [ ] L0 时使用标准 Phase 1 pipeline（gate-check → review-loop → review-dispatch → retrospect）
- [ ] L1/L2 系统级使用 SPEC_L12_SYSTEM_PIPELINE
- [ ] L1/L2 子系统级使用 SPEC_L12_SUBSYSTEM_PIPELINE
- [ ] 复杂度为 L0 时 `deriveOrder` / `deriveWaves` 不被调用

### AC-OR3: OrderResolver

- [ ] 输入无依赖的 3 个子系统 → 返回 3 元素数组（顺序不确定但合理）
- [ ] 输入有依赖的子系统 → 被依赖者排在前面
- [ ] 输入循环依赖 → 抛出错误
- [ ] 输入空 manifest → 返回空数组

### AC-OR4: WaveScheduler

- [ ] 输入无依赖的 3 个子系统 → 返回 `[["A", "B", "C"]]`（一波次）
- [ ] 输入有依赖的子系统 → 返回多波次，同一波次内互不依赖
- [ ] 输入循环依赖 → 抛出错误

### AC-OR5: Manifest 解析

- [ ] L0 扁平 topicDir 无 manifest → `load()` 返回 null
- [ ] L1/L2 topicDir 有 manifest → `load()` 返回 ManifestData
- [ ] `updateChildStatus()` 修改 manifest 文件并持久化
- [ ] `aggregateStatus()` 正确聚合子系统状态

### AC-OR6: OperationRegistry

- [ ] 注册 13 个操作后 `listIds()` 返回 13 个 ID
- [ ] `get("gate-check")` 返回 gate-check 操作实例
- [ ] `get("nonexistent")` 返回 undefined

### AC-OR7: Tool 向后兼容

- [ ] `coding-workflow-init` 行为与重构前一致
- [ ] `coding-workflow-gate` 行为与重构前一致（对 L0 问题）
- [ ] `coding-workflow-phase-start` 行为与重构前一致
- [ ] `coding-workflow-run-op` 可独立调用任意原子操作

### AC-OR8: 入口代码行数

- [ ] index.ts ≤ 200 行
- [ ] 所有业务逻辑从 index.ts 中移除，只保留注册胶水

## Constraints

- Pipeline 执行器不处理交互阶段——只执行自动化 pipeline
- OrderResolver 和 WaveScheduler 是纯函数（无副作用，不修改 manifest）
- ManifestStore 的写操作（updateChildStatus）直接修改磁盘文件
- Tool handler 中的前置检查逻辑（状态验证）不提取为操作——这是编排层的职责
- 入口 index.ts 不直接 import 任何操作——通过 OperationRegistry 间接访问

## Decisions

### D-OR1: Pipeline 不支持嵌套

Pipeline 是一维的 step 数组。Phase 3 review-loop 的三阶段嵌套在 review-loop 操作内部处理，不在 pipeline 层体现。pipeline 只看到 `review-loop` 一个 step。

### D-OR2: 复杂度路由在 Pipeline 执行时决定

复杂度评估在 init 后、pipeline 执行前完成。Pipeline 执行器在运行时根据 `workflowState.complexity` 选择对应的 pipeline 配置。不在配置时预绑定。

### D-OR3: 两个调度器，不是一个

OrderResolver（串行）和 WaveScheduler（并行）是两个独立的类，不是同一个类加参数控制。原因：
- 接口不同（一维 vs 二维返回值）
- 算法细节不同（串行有 priority 排序，并行有波次分组）
- 语义不同（人机交互 vs 纯代码执行）
- 未来可能独立演化（串行可能加 pause/resume，并行可能加资源约束）

### D-OR4: run-op tool 不走 pipeline

`coding-workflow-run-op` 直接调用 `operation.execute()`，不走 Pipeline 执行器。Pipeline 执行器有失败策略、步骤追踪等额外逻辑，run-op 是简单的透传调用。

### D-OR5: 前置检查留在 Tool handler

gate tool handler 中的状态验证（isActive、phase token、前序 phase 通过、前序 review 文件）不属于任何原子操作，它是编排层的职责。提取为独立函数，但不提取为操作。

### D-OR6: 全局状态只减不增

重构后的 `WorkflowState` 比现有版本少 3 个字段（gateInProgress, gateRetryCount, compactRetryCount），多 2 个字段（complexity, manifest）。净减少 1 个字段。目标是减少全局状态，将操作局部状态移到操作内部。

## 业务用例

### UC-OR1: L0 完整 5-phase 流程

用户 `/coding-workflow "修复按钮样式"` → init(L0) → skill-inject → brainstorming → gate → pipeline(Spec) 通过 → phase-transition → ... → Phase 5 通过 → 完成。

### UC-OR2: L1 带 decompose 的流程

用户 `/coding-workflow "添加插件热加载"` → init → skill-inject → Quick Overview → complexity-assess = L1 → decompose → 3 个子系统 → 按 derive_order 逐个 brainstorming + pipeline → 全部通过 → 系统级回顾 → phase-transition。

### UC-OR3: 调试 gate-check

开发者 `coding-workflow-run-op(action="gate-check", topicDir="...", phase=3)` → 返回结构化检查结果，不触发 review 和 retrospect。

### UC-OR4: 修改 pipeline 配置

开发者编辑 `phase-config.ts`，移除 Phase 1 的 review-loop：pipeline 变为 `[gate-check, review-dispatch, retrospect]`。不影响其他 phase。

### UC-OR5: 查看 L1/L2 子系统状态

开发者读取 manifest.yaml，或由编排引擎在系统级回顾前自动调用 `manifestStore.aggregateStatus(topicDir)` 汇总子系统状态。此功能不是独立 Tool，而是 ManifestStore 的内部方法。

## Complexity Assessment

- **领域复杂度**: L1 — Pipeline 执行器 + 2 个调度器 + Manifest 解析，概念清晰
- **存储复杂度**: L0 — manifest.yaml 已有 schema，无新存储
- **数据流复杂度**: L1 — OperationContext 注入 + OperationResult 返回，单向数据流
- **API 复杂度**: L1 — 4 个 Tool + 事件处理适配
- **非功能性复杂度**: L1 — 入口 ≤ 200 行约束 + 向后兼容

整体：**L1**
