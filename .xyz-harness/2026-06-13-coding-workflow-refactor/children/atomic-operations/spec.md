---
verdict: pass
parent:
  topic_dir: ../..
  spec: ../../spec.md
  manifest: ../../manifest.yaml
priority: P0
subsystem: atomic-operations
---

# Atomic Operations — 子系统 Spec

## Background

当前 coding-workflow 的核心问题之一是所有操作耦合在一个 `executeGateTool` 函数中（6 种职责混合）。本 spec 定义从现有代码中提取出的 12 个原子操作，每个操作有独立接口、独立可调用、独立可调试。

原子操作是编排引擎的执行单元。编排引擎（`orchestrator` 子系统）通过统一的 `Operation` 接口调用它们。

### 提取来源映射

| 操作 ID | 现有代码位置 | 提取方式 |
|---------|-------------|---------|
| A1 init | `executeInitTool` (tool-handlers.ts) | 提取 |
| A2 skill-inject | `buildBeforeAgentStartMessage` + `buildSkillInjection` (tool-handlers.ts, helpers.ts) | 提取 |
| A3 gate-check | `PhaseGate` + `gate-runner.ts` + `gate-check.py` | 提取 |
| A4 review-dispatch | `dispatchReviewSubagent` (review-dispatcher.ts) | 已合并到 A5（作为 authenticity 维度） |
| A5 review-loop | `runReviewGateLoop` + `ReviewGate` + `dispatchReviewSubagent` (review-gate-impl.ts, gates/review-gate.ts, review-dispatcher.ts) | 重构（多维度审查） |
| A6 test-fix-loop | `runTestFixLoop` + `TestFixLoopGate` (review-gate-impl.ts, gates/test-fix-loop.ts) | 提取 |
| A7 retrospect | `buildRetrospectFollowUp` (review-dispatcher.ts) | 提取 |
| A8 phase-transition | `executePhaseStartTool` (tool-handlers.ts) | 提取 |
| A9 complexity-assess | 无（新建） | 新建 |
| A10 decompose | 无（新建） | 新建 |
| A11 contract-define | 无（新建） | 新建 |
| A12 contract-check | 无（新建） | 新建 |
| A13 dependency-check | 无（新建） | 新建 |

### 统一接口

所有原子操作实现相同的 `Operation` 接口（由系统 spec GC-7 定义）：

```typescript
interface Operation {
  readonly id: string;
  execute(ctx: OperationContext): Promise<OperationResult>;
}

interface OperationContext {
  /** 工作目录（.xyz-harness/{date}-{slug}/） */
  topicDir: string;
  /** 当前 phase 编号 */
  phase: number;
  /** Phase 配置（从 PHASE_CONFIGS 解析） */
  phaseConfig: PhaseConfig;
  /** Pi ExtensionAPI */
  pi: ExtensionAPI;
  /** 外部 abort signal */
  signal?: AbortSignal;
  /** 流式更新回调 */
  onUpdate?: OnUpdateCallback;
  /** 操作级状态存储 */
  stateStore: StateStore;
  /** 子进程注册表（用于 runSingleAgent 降级） */
  processRegistry?: ChildProcess[];
  /** Skill 解析器 */
  skillResolver: SkillResolver;
  /** 全局 workflow 状态（只读，phase-transition 可写） */
  workflowState: WorkflowState;
}

interface OperationResult {
  /** 操作是否成功 */
  passed: boolean;
  /** 结构化数据产出 */
  data?: Record<string, unknown>;
  /** 未通过时的修复指引 */
  fixGuidance?: string;
  /** 执行耗时（ms） */
  duration_ms: number;
  /** token 消耗（如果有 subagent 调用） */
  token_usage?: UsageStats;
  /** 重试信息 */
  retry_info?: {
    attempts: number;
    last_error?: string;
  };
}
```

### 操作分类

按系统 spec 的操作分类模型：

| 分类 | 含义 | 操作 |
|------|------|------|
| **自动化操作** | pipeline 自动触发，无 AI 参与 | gate-check, review-loop, test-fix-loop, retrospect, contract-check, dependency-check |
| **交互驱动操作** | 交互对话中由 AI/用户决策触发 | complexity-assess, decompose, contract-define |
| **管理操作** | 系统状态变更 | init, skill-inject, phase-transition |

## Functional Requirements

### A1: init — workspace 初始化

**invocation**: `management`

**来源**：`executeInitTool`（tool-handlers.ts L289-L368）n
**输入**：

```typescript
interface InitInput {
  slug: string;                     // 用户需求生成的短标识
  requirement?: string;             // 用户原始需求文本（可选，可能从上下文提取）
}
```

**输出**：

```typescript
interface InitOutput {
  topicDir: string;                 // 创建的工作目录路径
  topicName: string;                // 完整目录名（{date}-{slug}）
  skillInjected: boolean;           // Phase 1 skill 是否已注入
}
```

**行为**：
1. 规范化 slug（lowercase, `-` 分隔, max 60 chars）
2. 创建目录结构：`{topicDir}/changes/reviews/`, `{topicDir}/changes/evidence/`
3. 设置 workflow 状态为 active, currentPhase=1
4. 持久化状态

> **注意**：init 不调用 A2 skill-inject。编排引擎在 init 之后按 pipeline 单独调用 skill-inject。init 只负责目录创建和状态初始化。

**错误条件**：
- slug 为空或过短（< 2 chars）→ 返回错误
- 目录已存在 → 返回错误
- 目录创建失败 → 返回错误
- workflow 已 active → 返回错误

**状态副作用**：设置 `workflowState.isActive=true`, `currentPhase=1`

**向后兼容**：与现有 `coding-workflow-init` tool 行为一致。

---

### A2: skill-inject — Skill 内容注入

**invocation**: `management`

**来源**：`buildBeforeAgentStartMessage` + `buildSkillInjection`（tool-handlers.ts, helpers.ts）

**输入**：

```typescript
interface SkillInjectInput {
  skillName: string;                // 要注入的 skill 名称
  topicDir: string;                 // 工作目录
  phase: number;                    // 当前 phase
  extraContext?: string;            // L1/L2 时注入的额外上下文指令
  phaseSpecificRules?: string;      // phase 特殊规则（如 Phase 5 的"不合并 PR"）
}
```

**输出**：

```typescript
interface SkillInjectOutput {
  injected: boolean;
  skillName: string;
  /** 注入的消息内容（用于调试） */
  previewLength: number;
}
```

**行为**：
1. 通过 `SkillResolver.resolve()` 加载 skill 内容
2. 调用 `buildSkillInjection()` 构建注入消息
3. 如果有 extraContext，追加到 skill 内容之后
4. 如果有 phaseSpecificRules，追加到末尾
5. 通过 `pi.sendUserMessage(content, { deliverAs: "steer" })` 注入
6. Phase ≥ 3 时执行 `checkProjectProtection()` 检查并追加警告

**错误条件**：
- skill 文件不存在 → 返回错误（含查找路径列表）
- steer 注入失败 → 返回 passed=false 但不阻断 workflow

**状态副作用**：无（只影响 AI 上下文）

**触发时机**：
- init 后自动触发 Phase 1 skill 注入
- `before_agent_start` 事件中自动触发当前 phase skill 注入
- L1/L2 子系统 brainstorming 时通过 orchestrator 触发

**向后兼容**：与现有 `before_agent_start` 事件处理行为一致。

---

### A3: gate-check — Gate 脚本执行

**invocation**: `pipeline`

**来源**：`PhaseGate`（gates/phase-gate.ts）+ `gate-runner.ts` + `gate-check.py`

**输入**：

```typescript
interface GateCheckInput {
  topicDir: string;
  phase: number;
  /** 检查范围 */
  scope: "deliverables" | "reviews" | "all";
  /** 跳过哪些检查项（可选） */
  skipChecks?: string[];
}
```

**输出**：

```typescript
interface GateCheckOutput {
  passed: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    detail: string;
  }>;
  totalChecks: number;
  failedChecks: number;
}
```

**行为**：
1. spawn `python3 gate-check.py {topicDir} {phase} --json`
2. 根据 `scope` 参数过滤检查项：
   - `deliverables`：只检查 deliverable 文件存在性 + YAML 格式 + untracked files
   - `reviews`：只检查 review 文件存在性 + verdict/must_fix
   - `all`：检查全部（向后兼容现有行为）
3. 解析 JSON 输出为 `GateCheckOutput`
4. 30s 超时保护
5. 支持 AbortSignal 取消

**错误条件**：
- Python 脚本不存在 → 返回错误
- 脚本超时 → 返回 passed=false + 超时信息
- 脚本非零退出 → 解析 JSON 错误输出或返回原始 stderr
- JSON 解析失败 → 返回原始 stdout

**状态副作用**：无（只读文件系统）

**降级行为**：gate-check.py 不变，无需降级。

**向后兼容**：与现有 `PhaseGate.run()` 行为一致。

---

### A4: review-dispatch — 已合并

此操作已合并到 A5 review-loop 的「authenticity」维度中。反欺诈审查不再是独立操作，而是多维度审查的一个维度。

保留编号 A4 以维持后续操作编号的稳定性。

---

### A5: review-loop — 多维度审查 + 增量收敛

**invocation**: `pipeline`

**来源**：`runReviewGateLoop` + `dispatchReviewSubagent` + `ReviewGate`（review-gate-impl.ts, review-dispatcher.ts, gates/review-gate.ts）

#### 维度配置

每个 phase 的审查由多个独立维度组成。维度配置声明在 `PhaseConfig.dimensions` 中。

```typescript
interface ReviewDimension {
  /** 维度 ID */
  id: string;
  /** 显示名 */
  name: string;
  /** review 文件名前缀 */
  reviewPrefix: string;
  /** subagent 的 system prompt */
  systemPrompt: string;
  /** 审查聚焦点描述 */
  focusPrompt: string;
  /** 通过门槛 */
  threshold: { mustFix: number };
  /** 是否可能产出 NEEDS_USER 标签的问题 */
  mayNeedUser: boolean;
}
```

**输入**：

```typescript
interface ReviewLoopInput {
  topicDir: string;
  phase: number;
  /** 该 phase 的审查维度（从 PhaseConfig.dimensions 传入） */
  dimensions: ReviewDimension[];
  maxRounds?: number;                // 默认 3
  stagnationThreshold?: number;      // 默认 2
}
```

**输出**：

```typescript
interface ReviewLoopOutput {
  passed: boolean;
  rounds: number;
  /** 是否有需要用户决策的问题 */
  needsUserInput: boolean;
  /** 需要用户决策的问题列表 */
  needsUserIssues: Array<{
    dimension: string;
    issueId: string;
    description: string;
  }>;
  /** AI 可自行修复的问题列表 */
  fixableIssues: Array<{
    dimension: string;
    issueId: string;
    description: string;
    suggestion: string;
  }>;
  /** 各维度的执行结果 */
  dimensionResults: Array<{
    dimension: string;
    passed: boolean;
    rounds: number;
    lastMustFix: number;
    reviewPath: string;
  }>;
  /** 是否因停滞退出 */
  stagnation: boolean;
}
```

**行为（增量收敛循环）**：

1. 维度通过状态持久化到 `{topicDir}/.review-dims.json`（跨 gate 重试保持）
2. 每个 round：
   a. 过滤掉已通过的维度（只跑未通过的）
   b. 对每个未通过的维度，派遣独立 subagent 执行审查
   c. 解析每个维度的 review 文件（verdict + must_fix）
   d. must_fix ≤ threshold.mustFix → 标记该维度通过，写入 `.review-dims.json`
   e. 分析 issues，分类为 FIXABLE 和 NEEDS_USER
3. 如果任何维度产出了 NEEDS_USER 问题 → 立即停止，返回 `needsUserInput=true`
4. 如果所有维度通过 → 返回 `passed=true`
5. 停滞检测：某维度连续 `stagnationThreshold` 个 round 的 must_fix 未下降 → 标记该维度停滞
6. 自动 `git add` review 文件

**NEEDS_USER 退回机制**：
- 只有 `mayNeedUser=true` 的维度可以产出 NEEDS_USER 标签的问题
- subagent prompt 中要求将无法自行决策的问题标记为 `[NEEDS_USER]`
- 编排引擎收到 `needsUserInput=true` 后，将问题列表返回给 AI
- AI 向用户提问（局部澄清，不是重新走 brainstorming）
- 用户回答后 AI 更新 spec，重新调用 `coding-workflow-gate`
- 重新 gate 时，已通过的维度不重跑（从 `.review-dims.json` 恢复状态）

**Phase 路由**（通过维度配置驱动，而非代码分支）：
- Phase 1-3：走多维度审查（维度配置由 `PhaseConfig.dimensions` 决定）
- Phase 4+：不走 review-loop（走 test-fix-loop 或跳过）

**Phase 1 维度示例**：

| 维度 ID | 名称 | 审查重点 | mayNeedUser |
|---------|------|---------|-------------|
| authenticity | 反欺诈 | 引用的文件/函数是否存在、测试结果是否真实 | false |
| completeness | 完整性 | 六要素覆盖、AC 可量化、无 [AMBIGUOUS] | false |
| consistency | 一致性 | 内部引用一致、术语与 CONTEXT.md 对齐 | false |
| sufficiency | 充分性 | 用例覆盖关键场景、边界条件有明确策略 | true |

**Phase 3 维度示例**：

| 维度 ID | 名称 | 审查重点 | mayNeedUser |
|---------|------|---------|-------------|
| conformance | 规格符合性 | 代码实现覆盖 spec 所有需求 | false |
| code-quality | 代码质量 | standards + robustness + integration | false |
| taste | 代码品味 | ts/rust taste review | false |

**降级行为**：
- 优先通过 `pi.__workflowRun` 执行对应的 workflow 脚本
- workflow 不可用时降级到 `runSingleAgent` 串行执行

**错误条件**：
- subagent 非零退出 → 记录该维度失败，继续其他维度
- 所有维度的 review 文件解析失败 → 返回错误

**状态副作用**：持久化 `{topicDir}/.review-dims.json`（维度通过状态，跨 gate 重试保持）

---

### A6: test-fix-loop — Test-Fix 循环

**invocation**: `pipeline`

**来源**：`runTestFixLoop`（review-gate-impl.ts）+ `TestFixLoopGate`（gates/test-fix-loop.ts）

**输入**：

```typescript
interface TestFixLoopInput {
  topicDir: string;
  phase: number;
  maxRounds?: number;                // 默认 10
  stagnationThreshold?: number;      // 默认 3
  testScope?: "core" | "noncore" | "all";  // 默认 "all"
}
```

**输出**：

```typescript
interface TestFixLoopOutput {
  passed: boolean;
  core: {
    rounds: number;
    passed: number;
    failed: number;
    stagnation: boolean;
  };
  noncore: {
    rounds: number;
    passed: number;
    failed: number;
    stagnation: boolean;
  } | null;                          // testScope="core" 时为 null
  summary: string;                   // 人类可读的执行摘要
}
```

**行为**：
1. 串行执行 core → noncore 测试范围
2. 每个范围内循环 maxRounds 轮：
   - 读取 test_cases_template.json
   - 过滤当前范围的 case
   - 派遣 subagent 执行 + 修复
   - 解析 state JSON 获取 passed/failed
   - failed=0 → 该范围通过
   - 停滞检测：连续 stagnationThreshold 轮 failed 不降 → 强制退出
3. 两个范围都通过 → 整体通过

**降级行为**：
- 优先通过 `pi.__workflowRun` 执行 `phase4-test-fix-loop` workflow
- 不可用时降级到 `runSingleAgent`

**错误条件**：
- subagent 非零退出 → 记录失败，继续下一轮
- state JSON 解析失败 → 记录失败，继续下一轮

**状态副作用**：持久化 `.review-gate-p4.json` 状态文件

**向后兼容**：与现有 `TestFixLoopGate.run()` 行为一致。

---

### A7: retrospect — 回顾 steer 生成

**invocation**: `pipeline`（on_fail: warn_continue）

**来源**：`buildRetrospectFollowUp`（review-dispatcher.ts）

**输入**：

```typescript
interface RetrospectInput {
  topicDir: string;
  phase: number;
  phaseConfig: PhaseConfigForReview;
  /** 是否为系统级回顾（Phase 5 整体回顾） */
  isOverall?: boolean;
  /** 子系统名（L1/L2 子系统级回顾时） */
  subsystemName?: string;
}
```

**输出**：

```typescript
interface RetrospectOutput {
  injected: boolean;
  retrospectPath: string;            // 回顾文件应写入的路径
  steerSent: boolean;                // steer 消息是否已发送
  /** 注入的 deliverable 摘要（调试用） */
  contextSummaryLength: number;
}
```

**行为**：
1. 加载 `xyz-harness-retrospect` skill 路径
2. 构建回顾任务 prompt：
   - 包含回顾方法论指引
   - 包含当前 phase 的 deliverable 内容摘要（每个文件前 500 字符）
   - 整体回顾时列出所有前序 phase 的回顾文件路径
3. 通过 `pi.sendUserMessage(steer)` 注入回顾指令
4. 确定回顾文件写入路径

**错误条件**：
- skill 加载失败 → 返回 injected=false（不阻断 workflow）
- steer 注入失败 → 返回 steerSent=false（不阻断 workflow）

**状态副作用**：无（只影响 AI 上下文，回顾文件由 AI 写入）

**子系统级回顾**（L1/L2 时）：
- 轻量级——只覆盖该子系统的 brainstorming 执行质量
- 产出到 `children/{name}/changes/reviews/{name}_retrospect.md`
- 不重复系统级回顾的范围

**向后兼容**：与现有 `buildRetrospectFollowUp()` 行为一致。

---

### A8: phase-transition — Phase / 子系统切换

**invocation**: `management`

**来源**：`executePhaseStartTool`（tool-handlers.ts L370-L486）

**输入**：

```typescript
interface PhaseTransitionInput {
  /** 是否跳过 compact（调试用） */
  skipCompact?: boolean;
  /** compact 自定义指令 */
  compactInstructions?: string;
  /** 切换模式（由编排引擎决定，不由 AI 决定） */
  mode: "next-phase" | "next-subsystem" | "complete";
}
```

**输出**：

```typescript
interface PhaseTransitionOutput {
  /** 切换前的 phase 编号 */
  previousPhase: number;
  /** 切换后的 phase 编号（mode=next-subsystem 时不变） */
  newPhase: number;
  /** 切换前的子系统序号（-1 = 系统级） */
  previousSubsystemIndex: number;
  /** 切换后的子系统序号（-1 = 系统级） */
  newSubsystemIndex: number;
  compacted: boolean;
  committed: boolean;               // 是否执行了 git commit
  goalInitialized: boolean;
  goalTasks?: string[];              // 如果初始化了 goal，返回任务列表
  completed: boolean;                // 是否已完成所有 phase
  /** 实际执行的 mode */
  mode: "next-phase" | "next-subsystem" | "complete";
}
```

**行为**：
1. 验证当前 phase gate 已通过
2. 检查所有前序 phase 的 retrospect 文件完整性
3. 递增 currentPhase
4. Phase 2：初始化 goal（硬编码 L1 任务：plan.md, e2e-test-plan.md 等 5 项）
5. Phase 3：从 plan.md 解析 Execution Groups 初始化 goal 任务
6. 执行 `ctx.compact()` 压缩上下文：
   - onComplete: 重置 compactRetryCount，注入下一个 phase 的 skill
   - onError(stale context): abort workflow
   - onError(other): 回退 currentPhase，允许重试
7. Phase > FINAL_PHASE: 完成 workflow，重置状态

**三种模式的行为**：

**`next-phase`（Phase 间切换）**：
1. 验证当前 phase gate 已通过
2. 检查所有前序 phase 的 retrospect 文件完整性
3. `currentPhase + 1`
4. Phase 2：初始化 goal（硬编码 L1 任务：plan.md, e2e-test-plan.md 等 5 项）
5. Phase 3：从 plan.md 解析 Execution Groups 初始化 goal 任务
6. 执行 `ctx.compact()`
7. Phase > FINAL_PHASE: mode 自动变为 `complete`

**`next-subsystem`（子系统间切换，L1/L2 时）**：
1. 执行 `git add + commit`——将当前子系统的所有产出文件（spec.md、reviews/）提交到 git
2. 写入 `children/{name}/.state.json`——记录子系统状态（如 `{ status: "spec_approved", updatedAt: "..." }`）
3. `subsystemIndex + 1`
4. 执行 `ctx.compact()`——保留磁盘文件，清理对话历史
5. compact 完成后，编排引擎注入下一个子系统的 skill（通过 A2 skill-inject + extraContext）

**注意**：`next-subsystem` 不改变 `currentPhase`，只递增 `subsystemIndex`。

**`complete`（工作流完成）**：
1. 重置整个 workflowState
2. 标记 workflow 不再 active

**编排引擎如何选择 mode**：

```
phase-transition 被 pipeline 调用时:
  if L0:
    mode = "next-phase"（或最后一个 phase 时 "complete"）
  if L1/L2:
    if subsystemIndex == -1:         // 系统级刚完成
      mode = "next-subsystem"         // → 切到第一个子系统
    else:
      if 还有子系统未完成:
        mode = "next-subsystem"
      else:
        mode = "next-phase"           // 所有子系统完成，切到下一个 phase
```

**错误条件**：
- `next-phase`：当前 phase gate 未通过 → 返回错误
- `next-phase`：retrospect 文件缺失或格式错误 → 返回错误（列出缺失项）
- `next-subsystem`：当前子系统 gate 未通过 → 返回错误
- compact 重试次数耗尽（≥ 3）→ 返回错误，提供手动恢复选项
- stale context → abort workflow

**状态副作用**：
- `next-phase`：修改 `workflowState.currentPhase`，Phase > FINAL_PHASE 时重置整个 workflowState
- `next-subsystem`：修改 `workflowState.subsystemIndex`，写入 `children/{name}/.state.json`
- `complete`：重置整个 workflowState

**向后兼容**：与现有 `executePhaseStartTool()` 行为一致。

---

### A9: complexity-assess — 复杂度评估

**invocation**: `interactive`（在 brainstorming Step 1 Quick Overview 后由 AI 触发）

**来源**：新建

**输入**：

```typescript
interface ComplexityAssessInput {
  requirement: string;               // 用户原始需求文本
  projectRoot: string;               // 项目根目录（用于扫描结构）
  /** Quick Overview 产出的项目结构观察 */
  projectObservations?: string;
}
```

**输出**：

```typescript
interface ComplexityAssessOutput {
  assessment: ComplexityAssessment;
  /** 评估是否被用户 override */
  overridden: boolean;
}

interface ComplexityAssessment {
  level: "L0" | "L1" | "L2";
  dimensions: {
    modules: { score: "L0" | "L1" | "L2"; detail: string };
    interfaces: { score: "L0" | "L1" | "L2"; detail: string };
    dataModel: { score: "L0" | "L1" | "L2"; detail: string };
    nonFunctional: { score: "L0" | "L1" | "L2"; detail: string };
    constraints: { score: "L0" | "L1" | "L2"; detail: string };
  };
  reasoning: string;
}
```

**行为**：
1. `[AI-step]` AI 分析需求文本和项目结构，对 5 个维度分别评分
2. `[Code-step]` 合并各维度评分：任一 L2 → 整体 L2；任一 L1 → 整体 L1；否则 L0
3. 写入 `workflowState.complexity`
4. 支持用户 override（通过交互对话修改 state.complexity）

**评估维度细节**（由 spec-clarify-phase spec FR-SC1 定义）：
- modules：涉及模块数（≤1 / 2-5 / >5）
- interfaces：接口变更范围（无/模块间/子系统间）
- dataModel：数据模型变更（不变/局部/新实体+迁移）
- nonFunctional：非功能需求数量（0 / 1 / 2+）
- constraints：已有约束复杂度（无/兼容现有/跨团队）

**错误条件**：
- AI 未返回有效评分 → 默认 L0 + 警告
- 项目目录不存在 → 默认 L0 + 警告

**状态副作用**：设置 `workflowState.complexity`

**触发时机**：init → skill-inject → Quick Overview 后、Step 2 提问前

---

### A10: decompose — 子问题分解

**invocation**: `interactive`（在 brainstorming 系统级讨论后由 AI 触发）

**来源**：新建

**输入**：

```typescript
interface DecomposeInput {
  requirement: string;
  assessment: ComplexityAssessment;  // 必须是 L1 或 L2
  topicDir: string;                  // 父 topicDir
}
```

**输出**：

```typescript
interface DecomposeOutput {
  manifestPath: string;              // manifest.yaml 路径
  apiContractsPath: string;          // api-contracts.md 路径
  children: Array<{
    name: string;
    path: string;
    priority: "P0" | "P1" | "P2";
  }>;
  /** 拓扑排序后的执行顺序 */
  order: string[];
  /** 是否检测到循环依赖并已修正 */
  cyclesFixed: boolean;
}
```

**行为**：
1. `[AI-step]` 分析需求，识别领域边界，划分子系统，定义职责、依赖、优先级
2. `[Code-step]` 创建 `children/{name}/` 目录结构（含 `changes/reviews/`, `changes/evidence/`）
3. `[Code-step]` 写入 `manifest.yaml`（子系统列表 + 依赖关系 + 合约索引）
4. `[Code-step]` 写入 `api-contracts.md` 空模板（每个合约段用 `##` 锚点占位）
5. `[Code-step]` 执行拓扑排序检测循环依赖
6. `[Code-step]` 如果有循环依赖 → 返回错误让 AI 重新分解

**约束**：
- 同层子系统 ≤ 8 个
- 叶子节点 spec ≤ 500 行
- 嵌套深度建议 ≤ 3 层

**错误条件**：
- 复杂度为 L0 → 返回错误（L0 不需要分解）
- 循环依赖 → 返回错误 + 依赖环详情
- AI 产出格式无法解析 → 返回错误 + 原始输出
- 目录创建失败 → 返回错误

**状态副作用**：设置 `workflowState.manifest`

---

### A11: contract-define — 接口合约定义

**invocation**: `interactive`（在子系统边界确定后由 AI 触发）

**来源**：新建

**输入**：

```typescript
interface ContractDefineInput {
  topicDir: string;
  manifest: ManifestData;
  /** AI 产出的合约内容（结构化） */
  contracts: Array<{
    id: string;
    provider: string;
    consumers: string[];
    content: string;                 // Markdown 格式的合约段
  }>;
}
```

**输出**：

```typescript
interface ContractDefineOutput {
  contractsPath: string;             // api-contracts.md 路径
  definedContracts: number;          // 已定义的合约数
  validationErrors: string[];        // 验证错误（如有）
}
```

**行为**：
1. `[AI-step]` 为每个子系统间接口编写合约（TypeScript 接口 + 行为契约 + 约束）
2. `[Code-step]` 将合约段写入 `api-contracts.md` 对应的 `##` 锚点位置
3. `[Code-step]` 验证每个合约段的 provider/consumer 在 manifest.children 中存在
4. `[Code-step]` 更新 manifest.yaml 的 contracts 索引

**错误条件**：
- provider/consumer 不在 manifest 中 → 返回验证错误
- 锚点格式错误 → 返回验证错误
- AI 未产出合约内容 → 返回错误

**状态副作用**：无

---

### A12: contract-check — 合约一致性验证

**invocation**: `pipeline`（L1/L2 系统级自动化阶段）

**来源**：新建

**输入**：

```typescript
interface ContractCheckInput {
  topicDir: string;
  manifest: ManifestData;
}
```

**输出**：

```typescript
interface ContractCheckOutput {
  passed: boolean;
  checks: Array<{
    id: string;
    passed: boolean;
    detail: string;
  }>;
}
```

**行为**（全部 Code-step，无 AI 参与）：
1. 读取 `api-contracts.md`，提取所有 `##` 标题作为合约 ID
2. 对每个合约 ID：
   - 验证在 `manifest.contracts` 中有对应条目
   - 验证 provider 在 `manifest.children` 中存在
   - 验证 consumers 在 `manifest.children` 中存在
3. 验证子系统 spec 的 `contract_sections` 指向存在的锚点

**错误条件**：
- api-contracts.md 不存在 → 返回 passed=false
- manifest.yaml 格式错误 → 返回 passed=false
- 某些合约段缺失 → 返回 passed=false + 缺失列表

**状态副作用**：无（只读文件系统）

---

### A13: dependency-check — 依赖约束验证

**invocation**: `pipeline`（L1/L2 子系统级自动化阶段）

**来源**：新建

**输入**：

```typescript
interface DependencyCheckInput {
  topicDir: string;
  manifest: ManifestData;
  targetSubsystem: string;           // 要检查的子系统名
  targetPhase: "spec" | "dev";       // 检查哪个阶段的依赖
}
```

**输出**：

```typescript
interface DependencyCheckOutput {
  satisfied: boolean;
  blockedBy: Array<{
    subsystem: string;
    currentStatus: string;
    requiredStatus: string;
  }>;
}
```

**行为**（全部 Code-step，无 AI 参与）：
1. 从 manifest 读取 targetSubsystem 的 `depends_on`（spec 阶段）或 `dev_depends_on`（dev 阶段）
2. 检查每个依赖子系统的 status 是否满足要求：
   - spec 阶段：依赖子系统需 `spec_approved`
   - dev 阶段：依赖子系统需 `dev_complete`
3. 列出所有不满足的依赖

**错误条件**：
- manifest 不存在 → 返回错误
- targetSubsystem 不在 manifest 中 → 返回错误

**状态副作用**：无（只读 manifest）

---

## 操作在 Phase Pipeline 中的使用矩阵

| 操作 \ Phase | 1(Spec) | 2(Plan) | 3(Dev) | 4(Test) | 5(PR) |
|-------------|---------|---------|--------|---------|-------|
| A1 init | ★ 启动 | | | | |
| A2 skill-inject | ★ 每阶段 | ★ 每阶段 | ★ 每阶段 | ★ 每阶段 | ★ 每阶段 |
| A3 gate-check | ★ pipeline×2 | ★ pipeline×2 | ★ pipeline×2 | ★ pipeline×2 | ★ pipeline |
| A4 review-dispatch | （已合并到 A5） | | | | |
| A5 review-loop | ★ pipeline | ★ pipeline | ★ pipeline | | |
| A6 test-fix-loop | | | | ★ pipeline | |
| A7 retrospect | ★ pipeline | ★ pipeline | ★ pipeline | ★ pipeline | ★ pipeline |
| A8 phase-transition | ★ 结尾 | ★ 结尾 | ★ 结尾 | ★ 结尾 | ★ 结尾 |
| A9 complexity-assess | ★ 交互阶段 | | | | |
| A10 decompose | ★ 交互阶段(L1/L2) | | | | |
| A11 contract-define | ★ 交互阶段(L1/L2) | | | | |
| A12 contract-check | ★ pipeline(L1/L2) | | | | |
| A13 dependency-check | ★ pipeline(L1/L2) | | | | |

> ★ pipeline = 在自动化阶段的 pipeline 中执行
> ★ 交互阶段 = 在交互阶段中由 AI/用户触发（不是 pipeline 自动执行）
> ★ 每阶段 = 在 `before_agent_start` 中自动注入
> ★ 结尾 = pipeline 最后一步
> ★ 启动 = workflow 启动时执行一次

## 各 Phase 自动化 Pipeline 配置

> ★ pipeline×2 = 在 pipeline 中出现两次（Stage 1: scope=deliverables, Stage 3: scope=reviews）

### Phase 1 (Spec) — L0

```typescript
const SPEC_L0_PIPELINE: StepConfig[] = [
  { operation: "gate-check", args: { scope: "deliverables" } },
  { operation: "review-loop" },    // 多维度：authenticity + completeness + consistency + sufficiency
  { operation: "gate-check", args: { scope: "reviews" } },
  { operation: "retrospect", on_fail: "warn_continue" },
];
```

### Phase 1 (Spec) — L1/L2

```typescript
const SPEC_L12_SYSTEM_PIPELINE: StepConfig[] = [
  { operation: "gate-check", args: { scope: "deliverables" } },
  { operation: "contract-check" },
  { operation: "review-loop" },
  { operation: "gate-check", args: { scope: "reviews" } },
];

const SPEC_L12_SUBSYSTEM_PIPELINE: StepConfig[] = [
  { operation: "dependency-check" },
  { operation: "gate-check", args: { scope: "deliverables" } },
  { operation: "review-loop" },
  { operation: "gate-check", args: { scope: "reviews" } },
  { operation: "retrospect", on_fail: "warn_continue" },
];
```

### Phase 2 (Plan)

```typescript
const PLAN_PIPELINE: StepConfig[] = [
  { operation: "gate-check", args: { scope: "deliverables" } },
  { operation: "review-loop" },    // 多维度：feasibility + spec-conformance + test-plan-quality
  { operation: "gate-check", args: { scope: "reviews" } },
  { operation: "retrospect", on_fail: "warn_continue" },
];
```

### Phase 3 (Dev)

```typescript
const DEV_PIPELINE: StepConfig[] = [
  { operation: "gate-check", args: { scope: "deliverables" } },
  { operation: "review-loop" },    // 多维度：conformance + code-quality + taste
  { operation: "gate-check", args: { scope: "reviews" } },
  { operation: "retrospect", on_fail: "warn_continue" },
];
```

### Phase 4 (Test)

```typescript
const TEST_PIPELINE: StepConfig[] = [
  { operation: "gate-check", args: { scope: "deliverables" } },
  { operation: "test-fix-loop", args: { maxRounds: 10 } },
  { operation: "gate-check", args: { scope: "reviews" } },
  { operation: "retrospect", on_fail: "warn_continue" },
];
```

### Phase 5 (PR)

```typescript
const PR_PIPELINE: StepConfig[] = [
  { operation: "gate-check", args: { scope: "all" } },
  { operation: "retrospect", on_fail: "warn_continue" },
];
```

## 共享基础设施

原子操作依赖以下共享模块（位于 `lib/infra/`）：

| 模块 | 用途 | 使用者 |
|------|------|--------|
| `subagent-runner.ts` | Pi 进程 spawn + JSON 解析 | A5, A6 |
| `process-manager.ts` | 子进程生命周期管理 | subagent-runner |
| `skill-resolver.ts` | Skill 发现 + 缓存 | A2, A7 |
| `gate-runner.ts` | gate-check.py 执行 | A3 |
| `yaml-parser.ts` | YAML frontmatter 解析 | A5, A7 |
| `state-store.ts` | 操作级状态读写 | 所有操作 |
| `format.ts` | Token/usage 格式化 | A5, A6（用于输出） |

## Acceptance Criteria

### AC-AO1: 统一接口

- [ ] 所有 12 个操作实现 `Operation` 接口（A4 为占位，不实现 `Operation`）
- [ ] 所有操作返回结构化的 `OperationResult`
- [ ] 操作通过 `OperationRegistry` 注册，支持按 ID 查找

### AC-AO2: 独立可调用

- [ ] 每个操作可通过 `coding-workflow-run-op` tool 单独调用
- [ ] 单独调用时不需要 workflow 处于 active 状态（A1 init 除外）
- [ ] 单独调用的结果与 pipeline 中调用的结果一致

### AC-AO3: 向后兼容

- [ ] A1-A8 提取后，现有 3 个 tool（init/gate/phase-start）行为不变
- [ ] 所有 19 个 skills 和 18 个 agents 内容零改动
- [ ] gate-check.py 不修改

### AC-AO4: 状态隔离

- [ ] A3-A7 不修改 `workflowState`（只读或写操作级状态文件）
- [ ] A1 修改 `workflowState`（isActive, currentPhase, topicDir, topicName）
- [ ] A8 根据 mode 修改 `workflowState`（next-phase 修改 currentPhase，next-subsystem 修改 subsystemIndex，complete 重置全部）
- [ ] A9 修改 `workflowState.complexity`
- [ ] A10 修改 `workflowState.manifest`
- [ ] A8 next-subsystem 模式写入 `children/{name}/.state.json`（独立状态文件，不修改 manifest.yaml）

### AC-AO5: 多维度增量收敛

- [ ] A5 review-loop 按 `PhaseConfig.dimensions` 配置的维度独立执行审查
- [ ] 已通过的维度不重跑（从 `.review-dims.json` 恢复状态）
- [ ] 每个维度独立 subagent、独立 review 文件、独立通过门槛
- [ ] stagnation 检测：某维度连续 N 个 round must_fix 未下降 → 标记停滞
- [ ] Phase 4+ 跳过 review-loop（走 test-fix-loop 或跳过）

### AC-AO6: 降级行为

- [ ] A5 review-loop 和 A6 test-fix-loop 支持 workflow → runSingleAgent 降级
- [ ] 降级时结果结构一致（passed/rounds/dimensionResults）
- [ ] 降级路径有日志标记

### AC-AO7: NEEDS_USER 退回机制

- [ ] `mayNeedUser=true` 的维度可以产出 `[NEEDS_USER]` 标签的问题
- [ ] 发现 NEEDS_USER 问题后，A5 立即停止并返回 `needsUserInput=true`
- [ ] 编排引擎将问题列表返回给 AI，AI 向用户提问做局部澄清
- [ ] 用户回答后更新 spec，重新 gate 时已通过的维度不重跑
- [ ] `mayNeedUser=false` 的维度（真实性、形式合规）不会触发用户中断

### AC-AO8: gate-check scope 参数

- [ ] `scope="deliverables"` 只检查 deliverable 文件存在性 + YAML 格式 + untracked files
- [ ] `scope="reviews"` 只检查 review 文件存在性 + verdict/must_fix
- [ ] `scope="all"` 检查全部（向后兼容）

## Constraints

- 每个操作文件 ≤ 300 行
- 操作间无直接调用（A1 调 A2 是已知例外，通过 OperationRegistry 间接调用）
- 操作不依赖 `index.ts` 的闭包变量——所有依赖通过 `OperationContext` 注入
- 操作级状态存储在 `{topicDir}/.ops/{operation-id}.json`，不影响全局状态
- 提取操作时保持与现有代码的行为一致，不优化、不重构逻辑

## Decisions

### D-AO1: OperationRegistry 模式

操作通过注册表管理，不直接 import。编排引擎通过 `registry.get(id)` 查找操作。好处：解耦编排层和操作层，支持运行时动态注册（未来可用于插件化）。

### D-AO2: A1 init 不调用其他操作

init 只负责目录创建和状态初始化。Phase 1 skill 注入由编排引擎在 init 完成后通过 pipeline 调用 A2 skill-inject 完成。这保持了操作间的零耦合——操作之间不存在直接调用关系。

### D-AO3: Phase 路由通过维度配置驱动

A5 (review-loop) 不再内部根据 phase 编号做 if-else 路由。每个 phase 的审查维度通过 `PhaseConfig.dimensions` 声明式配置。编排引擎传入 dimensions，review-loop 只负责执行。Phase 3 的「三阶段嵌套」变为 3 个维度（conformance, code-quality, taste），不再需要特殊的嵌套逻辑。

### D-AO4: 状态文件隔离

每个操作的状态写到独立的 JSON 文件（`.ops/{id}.json`），不混在全局状态中。全局 `workflowState` 只保留跨操作的状态（currentPhase, isActive, complexity, manifest）。

### D-AO5: A9-A13 是新建操作

A9-A13 没有现有代码可提取。它们的接口设计参照现有操作的提取模式（输入/输出 schema + 行为描述 + 错误条件 + 状态副作用），保持风格一致。

### D-AO6: review-dispatch 合并到 review-loop

反欺诈审查不再作为独立操作（A4），而是作为 review-loop 的 `authenticity` 维度。原因：反欺诈和内容质量审查属于同一个「质量关卡」，拆成两个独立操作增加了编排复杂度但未带来调试收益。合并后，多维度审查在同一个循环中增量收敛，已通过的维度（包括 authenticity）不重跑。

### D-AO7: NEEDS_USER 退回是「局部澄清中断」，不是「退回交互阶段」

当审查发现需要用户决策的问题时（如「支付失败后应该退款还是重试？」），不是退回 brainstorming 的 10 步 checklist，而是针对具体问题做局部澄清。用户体验是一个简短的 Q&A，不是重新开始。只有 `mayNeedUser=true` 的维度（如 sufficiency）可以触发此机制，其他维度（真实性、形式合规）不会中断用户。

### D-AO8: 增量收敛通过 .review-dims.json 跨 gate 重试保持状态

维度通过状态持久化到 `{topicDir}/.review-dims.json`，而不是全局 `workflowState`。这样在 NEEDS_USER 退回后重新 gate 时，已通过的维度不需要重跑——直接从文件恢复状态。这也使得 `coding-workflow-run-op` 单独调 review-loop 时可以接续上次进度。

## 业务用例

### UC-AO1: 单独跑 gate-check

开发者：`coding-workflow-run-op(action="gate-check", topicDir="/path/to/.xyz-harness/xxx", phase=1)` → 返回结构化检查结果，不启动 workflow。

### UC-AO2: 重跑 review-loop（增量）

review-loop 因停滞退出后，开发者修复问题，重跑：`coding-workflow-run-op(action="review-loop", topicDir="...", phase=1)` → 从 `.review-dims.json` 恢复已通过的维度，只重跑未通过的维度。

### UC-AO3: NEEDS_USER 退回后继续

review-loop 发现「支付失败场景未澄清」返回 `needsUserInput=true`。AI 向用户提问，用户回答后 AI 更新 spec.md。重新调用 `coding-workflow-gate(phase=1)` → authenticity/completeness/consistency 维度已通过（从 `.review-dims.json` 恢复），只重跑 sufficiency 维度。

### UC-AO4: 单独跑 gate-check 指定 scope

开发者只想检查文件是否存在：`coding-workflow-run-op(action="gate-check", topicDir="...", phase=1, scope="deliverables")` → 只检查 deliverable 文件，不检查 review 文件。

### UC-AO5: L1 复杂度评估

init 后 AI 判断需求复杂度：返回 L1 → 触发 decompose → 创建 children/ → 后续子系统串行 spec。

## Complexity Assessment

- **领域复杂度**: L1 — 12 个操作的接口定义 + 提取映射，多维度审查模型
- **存储复杂度**: L1 — 操作级状态 JSON 文件
- **数据流复杂度**: L1 — OperationContext 统一注入，OperationResult 统一返回
- **API 复杂度**: L1 — 统一接口 + 4 个 Tool 暴露
- **非功能性复杂度**: L1 — 向后兼容 + 降级策略 + 状态隔离

整体：**L1**
