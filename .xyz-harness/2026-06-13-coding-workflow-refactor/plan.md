---
verdict: pass
---

# coding-workflow 拆分重构 — 实施计划

## 目标文件结构

```
extensions/coding-workflow/
├── index.ts                         # 入口：注册 tools + commands + events（≤ 200 行）
├── lib/
│   ├── orchestrator/                # 编排层
│   │   ├── pipeline.ts              # Pipeline 执行器：按 config 顺序调用原子操作
│   │   ├── phase-config.ts          # Phase 配置定义（TypeScript 数组 + pipeline 声明）
│   │   ├── complexity.ts            # 复杂度评估逻辑
│   │   ├── decompose.ts             # 子问题分解 + manifest 生成
│   │   ├── order-resolver.ts        # 依赖拓扑 → 串行执行顺序（spec-clarify 用）
│   │   ├── wave-scheduler.ts        # 依赖拓扑 → 并行波次（dev/test phase 用）
│   │   └── manifest.ts              # manifest.yaml 解析 + 状态聚合
│   ├── operations/                  # 原子操作（每个 ≤ 300 行）
│   │   ├── init.ts                  # A1: workspace 初始化 + 复杂度评估入口
│   │   ├── skill-inject.ts          # A2: skill 内容注入
│   │   ├── gate-check.ts            # A3: gate 脚本执行
│   │   ├── review-dispatch.ts       # A4: anti-fraud review subagent
│   │   ├── review-loop.ts           # A5: 多轮 review-fix 循环
│   │   ├── test-fix-loop.ts         # A6: core/noncore 测试修复循环
│   │   ├── retrospect.ts            # A7: 回顾 steer 生成
│   │   ├── phase-transition.ts      # A8: compact + goal init + phase 切换
│   │   ├── complexity-assess.ts     # A9: 复杂度评估
│   │   ├── decompose.ts             # A10: 子问题分解 + manifest + children 目录
│   │   ├── contract-define.ts       # A11: api-contracts.md 生成
│   │   ├── contract-check.ts        # A12: 合约一致性验证
│   │   └── dependency-check.ts      # A13: 依赖约束验证
│   ├── infra/                       # 共享基础设施
│   │   ├── subagent-runner.ts       # Pi 进程 spawn + JSON 解析
│   │   ├── process-manager.ts       # 子进程生命周期管理
│   │   ├── skill-resolver.ts        # Skill 发现 + 缓存
│   │   ├── gate-runner.ts           # Gate 脚本执行
│   │   ├── yaml-parser.ts           # YAML frontmatter 解析
│   │   ├── state-store.ts           # 操作级状态读写
│   │   └── format.ts                # Token/usage 格式化
│   ├── state.ts                     # 全局 WorkflowState 精简版 + persist/reconstruct
│   └── render.ts                    # TUI 渲染
├── skills/                          # 不动
├── agents/                          # 不动
├── scripts/                         # 不动
├── commands/                        # 不动
└── package.json                     # 不动
```

## Execution Groups

### EG-1: 基础设施迁移（无行为变更）

将现有文件搬入 `lib/infra/`，只做 import path 更新，不改逻辑。

**涉及文件：**
- `lib/process-manager.ts` → `lib/infra/process-manager.ts`
- `lib/skill-resolver.ts` → `lib/infra/skill-resolver.ts`
- `lib/gate-runner.ts` → `lib/infra/gate-runner.ts`
- `lib/render-helpers.ts` → `lib/render.ts`
- `lib/helpers.ts` 中 YAML 解析函数 → `lib/infra/yaml-parser.ts`
- `lib/subagent.ts` 中 spawn 逻辑 → `lib/infra/subagent-runner.ts`
- `lib/subagent.ts` 中格式化函数 → `lib/infra/format.ts`

**验证：** 全量 typecheck 通过 + import 路径正确

### EG-2: 状态管理拆分

**2a. 全局状态精简（`lib/state.ts`）**

```typescript
interface WorkflowState {
  isActive: boolean;
  currentPhase: number;
  topicDir: string;
  topicName: string;
  phaseResults: Record<number, "passed">;
  pendingInit: boolean;
  pendingRequirement: string;
  complexity: "L0" | "L1" | "L2";     // 新增
  manifest: ManifestData | null;        // 新增：L1/L2 时有值
}
```

**2b. 操作级状态（`lib/infra/state-store.ts`）**

每个操作写自己的状态文件到 topicDir。

### EG-3: Phase 配置提取 + 自动化阶段 Pipeline 声明

将 `PHASES` 提取到 `lib/orchestrator/phase-config.ts`，每个 phase 的**自动化阶段**增加 `pipeline` 字段：

```typescript
const PHASE_CONFIGS: PhaseConfig[] = [
  {
    phase: 1, name: "Spec",
    skillName: "xyz-harness-brainstorming",
    pipeline: SPEC_AUTOMATED_PIPELINE,   // 仅自动化阶段
    // ...
  },
  // ...
];

// 注意：pipeline 只描述自动化阶段（gate + review + retrospect + transition）
// 交互阶段（brainstorming 10 步）不在 pipeline 中
const SPEC_AUTOMATED_PIPELINE: StepConfig[] = [
  { operation: "gate-check" },
  { operation: "review-loop", maxRetries: 3 },
  { operation: "review-dispatch" },
  { operation: "retrospect", on_fail: "warn_continue" },
];
```

### EG-4: 原子操作提取（核心）

逐个提取原子操作。spec-clarify-phase 子系统新增的操作优先：

#### Task 4.1: gate-check (A3) — 从 PhaseGate 提取

#### Task 4.2: review-dispatch (A4) — 从 dispatchReviewSubagent 提取

#### Task 4.3: review-loop (A5) — 从 runReviewGateLoop + ReviewGate 提取

#### Task 4.4: test-fix-loop (A6) — 从 TestFixLoopGate 提取

#### Task 4.5: skill-inject (A2) — 从 buildBeforeAgentStartMessage 提取

#### Task 4.6: retrospect (A7) — 从 buildRetrospectFollowUp 提取

#### Task 4.7: init (A1) — 从 executeInitTool 提取

#### Task 4.8: phase-transition (A8) — 从 executePhaseStartTool 提取

#### Task 4.9: complexity-assess (A9) — 新建

输入：用户需求 + 项目结构
输出：ComplexityAssessment（L0/L1/L2 + 各维度评分）
实现：AI 在 init 后通过 steer 评估，结果写入 manifest 或 state

#### Task 4.10: decompose (A10) — 新建

输入：需求 + 复杂度评估（L1/L2）
输出：manifest.yaml + children/ 目录 + api-contracts.md 骨架
实现：AI 通过 steer 指导分解，代码负责创建目录结构和 manifest 文件

#### Task 4.11: contract-define (A11) — 新建

输入：子系统边界 + 依赖关系
输出：api-contracts.md 各段的 TypeScript 接口
实现：AI 编写合约内容，代码验证格式

#### Task 4.12: contract-check (A12) — 新建

输入：manifest.yaml + api-contracts.md + 子系统 spec 列表
输出：合约一致性检查结果
实现：脚本化检查（锚点存在性、provider/consumer 引用完整性）

#### Task 4.13: dependency-check (A13) — 新建

输入：manifest.yaml + 当前子系统名 + 目标 phase
输出：依赖是否满足
实现：读取 manifest，检查 depends_on 中子系统的 status

### EG-5: Pipeline 执行器 + 调度器

新建 `lib/orchestrator/pipeline.ts` + `lib/orchestrator/order-resolver.ts` + `lib/orchestrator/wave-scheduler.ts`：

```typescript
// pipeline.ts — 执行自动化阶段的 pipeline
class Pipeline {
  async run(config: PhaseConfig, ctx: PipelineContext): PipelineResult {
    for (const step of config.pipeline) {
      const result = await this.operations[step.operation].execute(ctx);
      if (!result.passed) {
        if (step.on_fail === "return") return { passed: false, ...result };
        if (step.on_fail === "retry") { /* retry logic */ }
      }
    }
    return { passed: true };
  }
}

// order-resolver.ts — spec-clarify 阶段用，返回一维串行序列
class OrderResolver {
  deriveOrder(manifest: Manifest): string[] {
    // 拓扑排序 → 一维串行序列
    // spec-clarify 阶段严格串行，不并行
  }
}

// wave-scheduler.ts — dev/test phase 用，返回二维波次
class WaveScheduler {
  deriveWaves(manifest: Manifest): string[][] {
    // 拓扑排序 → 并行波次（仅用于纯代码执行阶段）
  }
}
```

**为什么需要两个调度器：**
- `OrderResolver`（串行）：spec-clarify 阶段需要人机交互，同一时间只能做一个子系统
- `WaveScheduler`（并行）：dev/test phase 纯代码执行，无依赖的子系统可并行

### EG-6: 入口重构

重写 `index.ts`，注册 4 个 tool（原有 3 个 + 新增 `coding-workflow-run-op` 1 个）。13 个原子操作通过 `run-op` 的 `action` 参数暴露，不独立注册。

### EG-7: 旧代码清理

删除被替代的旧文件。

## 风险点

| 风险 | 影响 | 缓解 |
|------|------|------|
| manifest.yaml 向后兼容 | 旧 topicDir 没有 manifest | 叶子节点不需要 manifest，L0 完全兼容 |
| 复杂度评估不准确 | L1 问题被误判为 L0 | 用户可 override，不强制 |
| 递归 gate-check 性能 | 深层嵌套时逐级检查 | 软限制 3 层 + 增量检查（缓存已通过状态） |
| skill 注入上下文膨胀 | L2 时注入系统 spec + 合约 + 子系统 spec | 叶子节点只看自己的 spec + 合约段 |
| 状态传播延迟 | ~~并行 wave 中状态更新竞态~~ 已移除并行 | spec-clarify 阶段严格串行，无竞态问题 |
| before_agent_start 拆分后 skill 注入时机改变 | Phase 1 无法注入 skill | A2 保留 before_agent_start 注册 |

## 依赖关系

```
EG-1 (infra 搬迁)
  → EG-2 (状态拆分)
  → EG-3 (phase 配置)
  → EG-4 (原子操作，4.1-4.8 先提取现有，4.9-4.13 新建)
  → EG-5 (pipeline + wave scheduler)
  → EG-6 (入口重构)
  → EG-7 (旧代码清理)
```

## 实施优先级

先做 EG-1 ~ EG-4 的 Task 4.1-4.8（L0 的原子操作拆分），确保向后兼容。
EG-4 的 Task 4.9-4.13（L1/L2 新增操作）作为第二批。
EG-5 的 `order-resolver`（串行）和 `wave-scheduler`（并行）分别服务于不同阶段——spec-clarify 用 order-resolver，dev/test 用 wave-scheduler。
