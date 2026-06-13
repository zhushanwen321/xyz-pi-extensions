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
│   │   └── phase-config.ts          # Phase 配置定义（TypeScript 数组，替代硬编码 PHASES）
│   ├── operations/                  # 8 个原子操作（每个 ≤ 300 行）
│   │   ├── init.ts                  # A1: workspace 初始化
│   │   ├── skill-inject.ts          # A2: skill 内容注入
│   │   ├── gate-check.ts            # A3: gate 脚本执行
│   │   ├── review-dispatch.ts       # A4: anti-fraud review subagent
│   │   ├── review-loop.ts           # A5: 多轮 review-fix 循环
│   │   ├── test-fix-loop.ts         # A6: core/noncore 测试修复循环
│   │   ├── retrospect.ts            # A7: 回顾 steer 生成
│   │   └── phase-transition.ts      # A8: compact + goal init + phase 切换
│   ├── infra/                       # 共享基础设施
│   │   ├── subagent-runner.ts       # Pi 进程 spawn + JSON 解析（from subagent.ts）
│   │   ├── process-manager.ts       # 子进程生命周期管理（现有，搬入）
│   │   ├── skill-resolver.ts        # Skill 发现 + 缓存（现有，搬入）
│   │   ├── gate-runner.ts           # Gate 脚本执行（现有，搬入）
│   │   ├── yaml-parser.ts           # YAML frontmatter 解析（from helpers.ts）
│   │   └── state-store.ts           # 操作级状态读写（新）
│   ├── state.ts                     # 全局 WorkflowState 精简版 + persist/reconstruct
│   └── render.ts                    # TUI 渲染（现有 render-helpers.ts，搬入）
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

从现有 `helpers.ts` 的 `WorkflowState` 中提取，移除操作级字段：

```typescript
// 精简后的全局状态
interface WorkflowState {
  isActive: boolean;
  currentPhase: number;
  topicDir: string;
  topicName: string;
  phaseResults: Record<number, "passed">;
  pendingInit: boolean;
  pendingRequirement: string;
}
// 移除: gateInProgress, gateRetryCount, compactRetryCount → 操作内部管理
```

**2b. 操作级状态（`lib/infra/state-store.ts`）**

```typescript
// 每个操作写自己的状态文件
interface OperationStateStore {
  write(topicDir: string, operation: string, phase: number, data: Record<string, unknown>): void;
  read(topicDir: string, operation: string, phase: number): Record<string, unknown> | null;
}
```

**涉及文件：**
- 新建 `lib/state.ts`
- 新建 `lib/infra/state-store.ts`
- 修改 `index.ts` 的 persistState/reconstructState 引用

**验证：** typecheck + 手动测试 `/coding-workflow` 初始化后状态正确

### EG-3: Phase 配置提取

将 `index.ts` 中的 `PHASES` 数组提取到 `lib/orchestrator/phase-config.ts`，增加 pipeline 定义：

```typescript
interface PhaseConfig {
  phase: number;
  name: string;
  skillName: string;
  reviewPrefix: string | string[];
  retrospectPrefix: string;
  deliverables: string[];
  reviewMode: string;
  // 新增：声明式 pipeline
  pipeline: OperationType[];
}

type OperationType =
  | "skill-inject"
  | "gate-check"
  | "review-dispatch"
  | "review-loop"
  | "test-fix-loop"
  | "retrospect"
  | "phase-transition";
```

**涉及文件：**
- 新建 `lib/orchestrator/phase-config.ts`
- 修改 `index.ts` 的 PHASES 引用

**验证：** typecheck + phase 配置与现有行为一致

### EG-4: 原子操作提取（核心）

逐个提取原子操作。每个操作是独立文件，导出一个 execute 函数。

**提取顺序（按依赖从少到多）：**

#### Task 4.1: gate-check (A3)

来源：`lib/gates/phase-gate.ts` → `lib/operations/gate-check.ts`
- 输入：`{ topicDir, phase, gateScriptPath }`
- 输出：`{ passed: boolean, checks: GateCheckItem[], fixGuidance?: string }`
- 无需修改调用方（现有 gate tool 仍然通过 pipeline 调用它）

#### Task 4.2: review-dispatch (A4)

来源：`lib/review-dispatcher.ts` → `lib/operations/review-dispatch.ts`
- 输入：`{ topicDir, phase, phaseConfig }`
- 输出：`{ success: boolean, reviewPath: string, usage?: UsageStats }`

#### Task 4.3: review-loop (A5)

来源：`lib/review-gate-impl.ts` + `lib/gates/review-gate.ts` → `lib/operations/review-loop.ts`
- 输入：`{ topicDir, phase, phaseConfig }`
- 输出：`{ passed: boolean, rounds: number, lastMustFix: number, summary: string }`
- 合并 Phase 1/2 标准循环 + Phase 3 三阶段逻辑

#### Task 4.4: test-fix-loop (A6)

来源：`lib/gates/test-fix-loop.ts` → `lib/operations/test-fix-loop.ts`
- 输入：`{ topicDir }`
- 输出：`{ passed: boolean, rounds: number, summary: string }`

#### Task 4.5: skill-inject (A2)

来源：`tool-handlers.ts` 的 `buildBeforeAgentStartMessage` → `lib/operations/skill-inject.ts`
- 输入：`{ topicDir, phase, phaseConfig }`
- 输出：`{ message: string | null }`（steer 内容）

#### Task 4.6: retrospect (A7)

来源：`review-dispatcher.ts` 的 `buildRetrospectFollowUp` → `lib/operations/retrospect.ts`
- 输入：`{ topicDir, phase, phaseConfig }`
- 输出：`{ steerMessage: string }`

#### Task 4.7: init (A1)

来源：`tool-handlers.ts` 的 `executeInitTool` → `lib/operations/init.ts`
- 输入：`{ slug, requirement }`
- 输出：`{ topicDir, topicName, skillInjected: boolean }`

#### Task 4.8: phase-transition (A8)

来源：`tool-handlers.ts` 的 `executePhaseStartTool` → `lib/operations/phase-transition.ts`
- 输入：`{ topicDir, currentPhase }`
- 输出：`{ nextPhase: number, compacted: boolean }`

**每个 Task 的验证：**
- typecheck 通过
- 单元可调用（tool 参数传入，返回结构化结果）

### EG-5: Pipeline 执行器

新建 `lib/orchestrator/pipeline.ts`，替代 `executeGateTool` 中的硬编码流程：

```typescript
class Pipeline {
  async run(config: PhaseConfig, ctx: PipelineContext): PipelineResult {
    for (const step of config.pipeline) {
      const result = await this.operations[step].execute(ctx);
      if (!result.passed) return { passed: false, failedStep: step, ...result };
    }
    return { passed: true };
  }
}
```

**涉及文件：**
- 新建 `lib/orchestrator/pipeline.ts`
- 修改 `index.ts` 的 gate tool handler 调用 pipeline

**验证：** 全流程测试 `/coding-workflow test-topic`

### EG-6: 入口重构

重写 `index.ts`，只做注册胶水：

1. 注册 3 个原有 tool（gate/init/phase-start），内部调用 pipeline
2. 注册 8 个新原子操作 tool（独立入口）
3. 注册 3 个 command（不变）
4. 注册 5 个 event handler（精简，委托给操作）

**验证：** 全流程 + 单独调用原子操作

### EG-7: 旧代码清理

- 删除 `lib/gates/` 目录（已被 operations/ 替代）
- 删除 `lib/tool-handlers.ts`（已被 operations/ + orchestrator/ 替代）
- 删除 `lib/helpers.ts`（已被拆分到 state.ts + infra/ 中）
- 删除 `lib/review-dispatcher.ts`（已被 operations/review-dispatch.ts 替代）
- 删除 `lib/review-gate-impl.ts`（已被 operations/review-loop.ts 替代）
- 删除 `lib/subagent.ts`（已被 infra/subagent-runner.ts 替代）

**验证：** 全量 typecheck + lint + 全流程测试

## 风险点

| 风险 | 影响 | 缓解 |
|------|------|------|
| 状态管理拆分导致 reconstructState 向后不兼容 | 旧 session 恢复失败 | reconstructState 保持读取旧格式，向后兼容 |
| before_agent_start 事件处理拆分后 skill 注入时机改变 | Phase 1 无法注入 skill | A2 保留 before_agent_start 注册，确保首次注入 |
| review-loop 内部 Phase 3 三阶段逻辑复杂度高 | 提取时引入 bug | 先保持原有逻辑不变，只做文件搬迁 + 接口统一 |
| compact 在 phase-transition 中是异步回调 | 状态管理复杂 | 保持 compact 回调机制不变，只提取到独立函数 |

## 依赖关系

```
EG-1 (infra 搬迁)
  → EG-2 (状态拆分)
  → EG-3 (phase 配置)
  → EG-4 (原子操作提取，4.1→4.2→4.3→4.4→4.5→4.6→4.7→4.8)
  → EG-5 (pipeline 执行器)
  → EG-6 (入口重构)
  → EG-7 (旧代码清理)
```

EG-1/2/3 可以并行。EG-4 是串行的（每个 task 依赖前一个的接口定义稳定下来）。EG-5/6/7 必须在 EG-4 完成后。
