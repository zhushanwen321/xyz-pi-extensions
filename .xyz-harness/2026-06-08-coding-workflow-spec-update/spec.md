---
verdict: pass
---

# Coding-Workflow 按最新 Spec 实现的完整差距分析与实施计划

## Background

Coding-workflow 扩展当前实现了一套硬编码的 5-phase 状态机（Spec → Plan → Dev → Test → PR），通过 `coding-workflow-gate`/`coding-workflow-init`/`coding-workflow-phase-start` 三个 tool 由主 agent 手动调度。

最新 spec（`docs/phase-specs/phase-{1-4}.md`、`docs/adr/018-review-gate-auto-loop.md`）重新定义了各 phase 的 gate 机制，核心变化：
- 引入 Review-Gate 自动循环审查机制（Phase 1/2/3/4）
- Review-Gate 内部循环使用 Workflow Extension 脚本执行（`agent()`/`parallel()`/`pipeline()`）
- Phase-Gate 保留为脚本检查 + AI 防伪造，不走 Workflow
- Phase 4 改为 Test-Fix Loop Workflow（无 Review-Gate）
- Goal 自动注入（`initializeGoalFromExternal`）在 Phase 2/3 自动初始化任务列表
- Retrospect 改为 fork session 执行

当前代码与最新 spec 存在系统性差距，需要逐项修复。

## Functional Requirements

### FR-1: Workflow Extension 接入 Review-Gate（Phase 1/2/3）

Phase 1/2/3 的 Review-Gate 必须使用 Workflow Extension 的 `workflow-run` tool 启动，利用 `agent()`/`parallel()`/`pipeline()` API 实现循环审查。

**当前状态**：全部用 `runSingleAgent` 手动 spawn `pi --mode json` 子进程模拟，没有使用 Workflow Extension。

| Phase | 当前实现 | Spec 要求 | 差距 |
|-------|---------|----------|------|
| Phase 1 | `runSingleAgent` 单次 dispatch | **Workflow 循环**：`spec-requirements-reviewer` agent 审查 + 直接修复 → must_fix=0 退出，最多 3 轮 | ❌ 未使用 Workflow |
| Phase 2 | 同 Phase 1 共用一套循环 | **Workflow 循环**：L1 单 `plan-requirements-reviewer` / L2 串行 `plan-requirements-reviewer` + `plan-bl-requirements-reviewer`，最多 3 轮 | ❌ 未使用 Workflow，且 L2 分支未实现 |
| Phase 3 | `runSingleAgent` 模拟外层 3 次 × 内层 3 轮 | **Workflow 三阶段**：阶段一（`spec-plan-conformance-reviewer`）→ 阶段一.五（`simulated-data-generator`）→ 阶段二（并行 5 reviewer → `review-sync-fix-worker` 汇总 → 按文件 dispatch `file-fix-subagent` 修复 → 循环最多 3 轮） | ⚠️ 骨架有但缺核心环节 |

### FR-2: Test-Fix Loop Workflow（Phase 4）

Phase 4 的核心机制是 Test-Fix Loop Workflow，两个串行 workflow（核心 case → 非核心 case），各最多 10 轮。

**当前状态**：`runTestFixLoop` 有 core/noncore 两个循环骨架，但：
- 不是 Workflow Extension，仍是 `runSingleAgent` 单 agent 包办
- 没有 Wave 并行测试（每 Wave 最多 3 个 subagent）
- 没有 `test-execute-coordinator` 节点
- 没有增量测试策略（只重跑 failed + 依赖下游）
- 没有 Fix Worker 按文件分组修复
- 没有 `test-case-subagent` / `test-fix-worker` agent

### FR-3: Gate Pipeline 抽象

将 gate 机制抽象为可配置的 gate 链，各 phase 声明自己的 gate 配置。

**当前状态**：`executeGateTool` 中硬编码了 review-gate → phase-gate 顺序，无抽象层。

需要实现：
```typescript
interface Gate {
  name: string;
  run(ctx: GateContext): Promise<GateResult>;
}

interface GateContext {
  phase: number;
  topicDir: string;
  state: WorkflowState;
  skillResolver: SkillResolver;
  signal?: AbortSignal;
}

interface GateResult {
  passed: boolean;
  fixGuidance?: string;
  details?: Record<string, unknown>;
}
```

Phase 配置：
```typescript
{ phase: 1, gates: ["review-gate", "phase-gate"] }
{ phase: 2, gates: ["review-gate", "phase-gate"] }
{ phase: 3, gates: ["review-gate", "phase-gate"] }
{ phase: 4, gates: ["test-fix-loop", "phase-gate"] }
{ phase: 5, gates: ["phase-gate"] }
```

### FR-4: Review-Gate 状态隔离

每个 phase 的 Review-Gate 状态独立持久化，互不干扰。

**当前状态**：代码中没有任何状态文件读写。

需要实现：
- 状态文件：`{topic_dir}/.review-gate-p{N}.json`（N = phase 编号）
- 交付物隔离：`{topic_dir}/changes/reviews/phase-{N}/` 子目录

### FR-5: Goal 自动注入（Phase 2/3）

Phase 2/3 在 `coding-workflow-phase-start` tool handler 中自动调用 `initializeGoalFromExternal()` 初始化任务列表。

**当前状态**：
- `pi.__goalInit` 已暴露（goal extension 侧完成）
- Phase 2 有硬编码 L1 任务列表注入
- Phase 3 未实现动态任务列表（从 plan.md 读取 Execution Groups 构建）
- Phase 2 缺少"评估 L2 后追加额外任务"的交互逻辑

### FR-6: Retrospect fork session

Retrospect subagent 必须 fork 主 session 的对话历史后执行，而不是由主 agent 按 steer 指令执行。

**当前状态**：`buildRetrospectFollowUp` 只是构造 steer 指令让主 agent 执行，没有 fork。

### FR-7: Agent 文件创建

Spec 要求创建 11 个新的 agent.md 文件，当前全部缺失：

| # | Agent 文件 | 职责 | 所属 Phase |
|---|-----------|------|-----------|
| 1 | `spec-requirements-reviewer.md` | Phase 1 Review-Gate 审查 + 直接修复 spec.md | Phase 1 |
| 2 | `plan-requirements-reviewer.md` | Phase 2 L1/L2 共用 Review-Gate 审查 | Phase 2 |
| 3 | `plan-bl-requirements-reviewer.md` | Phase 2 L2 专用业务逻辑审查 | Phase 2 |
| 4 | `spec-plan-conformance-reviewer.md` | Phase 3 阶段一：规格符合性 + 业务逻辑 | Phase 3 |
| 5 | `fallow-reviewer.md` | Phase 3 阶段二：Code Quality 审查（包装 fallow CLI） | Phase 3 |
| 6 | `review-sync-fix-worker.md` | Phase 3 阶段二：汇总 5 reviewer + 判断退出 + 按文件分组 dispatch 修复 | Phase 3 |
| 7 | `simulated-data-generator.md` | Phase 3 阶段一.五：生成 JSON fixture 模拟数据 | Phase 3 |
| 8 | `file-fix-subagent.md` | Phase 3 阶段二：每个文件独占一个实例，串行处理 must_fix | Phase 3 |
| 9 | `test-execute-coordinator.md` | Phase 4 Workflow 节点：构造/读取 JSON、分派 Wave、汇总判断 | Phase 4 |
| 10 | `test-fix-worker.md` | Phase 4 Fix Worker：分析失败 + 修复 + 更新状态 | Phase 4 |
| 11 | `test-case-subagent.md` | Phase 4 测试执行：每个 Wave 最多 3 个并行执行一组 case | Phase 4 |

### FR-8: SKILL.md 清理

各 phase 的 SKILL.md 需要按 spec 删除旧章节、新增指导。

| SKILL.md | 应删除 | 应新增 |
|----------|--------|--------|
| `xyz-harness-brainstorming` | Spec Review 章节、Gate Handoff 章节、Phase Transition 中"单独 session 跑 gate" | "完成后调用 coding-workflow-gate(phase=1)"、Goal 追踪建议（brainstorming 完成后提示用户 /goal） |
| `xyz-harness-writing-plans` | Self-Review 章节、Plan Review 章节、Gate Handoff 章节 | "完成后调用 coding-workflow-gate(phase=2)"、复杂度评估后调用 `goal_manager.add_tasks()` |
| `xyz-harness-phase-dev` | Step 4（Five-Step Specialized Review）、Step 4a（Retrospect 触发）、Step 6 review 文件检查项、Step 7（Gate Handoff）、Step 8"单独 session 跑 gate" | Goal 自动追踪指导、"完成后调用 coding-workflow-gate(phase=3)" |
| `xyz-harness-phase-test` | Review-Gate 章节、Gate Handoff 章节 | Test-Fix Loop Workflow 机制、test-execute JSON 版本化、手动验证清单输出、Phase-Gate 严格防伪造 |

### FR-9: Workflow Extension 集成点（已确认）

Coding-workflow 与 Workflow Extension 的集成需要明确以下接口：

- **启动方式**：`coding-workflow-gate` tool handler 内部通过 `WorkflowOrchestrator.run()` 启动 review-gate workflow
- **参数传递**：topicDir、phase、round、reviewer 配置等通过 `args` 参数传递（`$ARGS` 在 workflow 脚本中可用）
- **结果回调**：workflow 脚本通过 `return` 传递结构化结果，gate handler 读取 `instance.scriptResult`
- **状态持久化**：workflow 内部不直接写 `.review-gate-p{N}.json`，结果由 gate handler 统一写入

**已确认结论**：

| 问题 | 结论 | 影响 |
|------|------|------|
| `agent()` 是否支持注入 SKILL.md？ | **支持**。`agent({ prompt: "...", agent: "name" })` 通过 `AgentRegistry` 自动解析 `.md` 文件并注入 system prompt | Phase 3 的 5 个 reviewer 可直接通过 agent 字段引用 |
| `agent()` 返回值 | `Promise<string>`（`parsedOutput ?? content`） | 获取文本输出，文件需 reviewer 自己写入 |
| `parallel()` 能力 | `Promise.all(calls.map(c => agent(c)))`，返回 `Promise<string[]>` | 5 个 reviewer 可并行，但**不支持动态分组 dispatch** |
| 连续调用 `agent()` | **支持**。`await agent()` 后可继续调用下一个 `agent()` | workflow 脚本内可实现 `while` 循环 |
| workflow 脚本位置 | `.pi/workflows/*.js`（项目级，优先级高于用户级） | 脚本放在项目根目录 `.pi/workflows/` |
| workflow 结果获取 | 脚本 `return` → `instance.scriptResult` | gate handler 读取 scriptResult 获取 review 结果 |
| gate handler 调用方式 | coding-workflow **必须 import WorkflowOrchestrator** | 需要先在 `extension-dependencies.json` 添加 package 依赖 |
| Phase 4 串行 workflow | **一个脚本内两个阶段**（core → noncore） | 用 JavaScript 变量传递状态，不需要两次 `workflow-run` 调用 |

### FR-10: Phase 3 阶段一.五（模拟数据生成）

阶段一通过后，读取 `spec-plan-conformance-reviewer` 报告中的 `simulated_data_paths` 字段，dispatch `simulated-data-generator` subagent 生成 JSON fixture。

**当前状态**：`runPhase3ReviewGate` 中完全没有这个阶段。

### FR-11: Phase 3 阶段二 Fix Worker 按文件分组修复

Fix Worker 汇总 5 个 reviewer 的 must_fix 后，按涉及文件分组，同一文件的所有 must_fix 由同一个 subagent 串行处理。

**当前状态**：`runPhase3ReviewGate` 中阶段二是 reviewer 串行执行，没有 Fix Worker，也没有按文件分组修复。

### FR-12: Phase 4 增量测试策略

Turn 2+ 不重跑所有 case，只重跑上一轮 failed 且已 fixed 的 case，以及依赖这些 case 的下游 case（通过 `depends_on` 判断）。

**当前状态**：`runTestFixLoop` 中没有增量策略，每轮都是全量重跑。

### FR-13: Review-Gate 连续不降处理

所有 phase 的 Review-Gate（除 Phase 4）统一阈值：连续 2 轮 must_fix 不降 → 人工介入，最大 3 轮 → 强制通过。

Phase 4 Test-Fix Loop 阈值不同：连续 3 轮 failed 不降 → 强制退出，最大 10 轮。

**当前状态**：Phase 1/2/3 有 stagnation 检查（2 轮不降），Phase 4 有（3 轮不降），逻辑正确。但 Phase 3 的"人工介入"路径未实现（当前直接返回 FAIL）。

## Acceptance Criteria

1. Phase 1/2/3 的 Review-Gate 必须通过 Workflow Extension 的 `workflow-run` tool 启动
2. Phase 4 的 Test-Fix Loop 必须通过 Workflow Extension 启动两个串行 workflow
3. 所有 11 个 agent.md 文件已创建并放置在正确目录
4. Gate Pipeline 抽象已实现，`executeGateTool` 按 phase 配置执行 gate 链
5. `.review-gate-p{N}.json` 状态文件在 Review-Gate 完成后正确写入
6. review 报告写入 `changes/reviews/phase-{N}/` 子目录
7. Phase 2/3 的 `coding-workflow-phase-start` 自动注入 Goal 任务列表
8. Phase 3 的 Goal 任务列表从 plan.md 的 Execution Groups 动态构建
9. Retrospect 使用 fork session 执行（`context: 'fork'`）
10. 所有 SKILL.md 已按 FR-8 清理完毕
11. Phase 3 的阶段一.五（模拟数据生成）已实现
12. Phase 3 的阶段二 Fix Worker 按文件分组修复已实现
13. Phase 4 的增量测试策略已实现
14. 全量类型检查通过（`pnpm -r typecheck`）

## Constraints

- `agent()` 支持通过 `agent` 字段注入 `.md` 文件的 system prompt，`parallel()` 只支持简单并发，**不支持动态分组 dispatch**。Fix Worker 的按文件修复在 workflow 脚本内用 `for` 循环串行实现
- `initializeGoalFromExternal()` 是 goal extension 内部 API，coding-workflow 通过 `pi.__goalInit` 调用，类型安全需通过 stub 保障
- **coding-workflow 必须先添加对 workflow extension 的 package 依赖**，才能 import `WorkflowOrchestrator`
- pi-subagents 支持 `context: "fork"`，但 coding-workflow 的 `runSingleAgent` 直接 spawn `pi --mode json` 无法调用 pi-subagents 的 fork 机制。Retrospect 改用**上下文注入**近似实现（在 task prompt 中内联 Phase 1~N 的关键交付物摘要）
- 不能破坏现有的 coding-workflow 基本流程（`/coding-workflow` 命令、`coding-workflow-gate` tool 的对外接口不变）
- 单文件 ≤ 1000 行，函数 ≤ 80 行

## 业务用例

### UC-1: 用户启动 Phase 1 Spec

1. 用户输入 `/coding-workflow 实现一个用户认证系统`
2. AI 生成 slug，`coding-workflow-init` 创建目录
3. 主 agent 按 brainstorming SKILL.md 执行
4. 用户 brainstorming 完成后，主 agent 提示用户使用 `/goal`
5. 用户手动触发 `/goal`，Goal 初始化任务列表（spec.md）
6. 主 agent 编写 spec.md
7. 主 agent 调用 `coding-workflow-gate(phase=1)`
8. Gate handler 启动 **Review-Gate Workflow**，循环审查 + 修复 spec.md
9. Review-Gate 通过后自动触发 Phase-Gate（脚本检查）
10. Phase-Gate 通过后，gate handler fork session dispatch Retrospect subagent
11. 主 agent 收到 steer 指令后调用 `coding-workflow-phase-start()`
12. Phase-start handler compact + 注入 Phase 2 skill

### UC-2: Phase 3 Dev 进入 Review-Gate

1. 主 agent 完成 TDD + Wave 编码
2. 主 agent 调用 `coding-workflow-gate(phase=3)`
3. Gate handler 启动 **Review-Gate Workflow（三阶段）**
4. 阶段一：`spec-plan-conformance-reviewer` 检查规格符合性
   - FAIL → 打回主 agent，重置 Goal 状态为 pending，重新编码
   - PASS → 进入阶段一.五
5. 阶段一.五：`simulated-data-generator` 生成模拟数据
6. 阶段二：并行 5 reviewer（Standards + Taste + Robustness + Fallow + Integration）
7. `review-sync-fix-worker` 汇总 must_fix
   - must_fix = 0 → 通过，触发 Phase-Gate
   - must_fix > 0 → 按文件分组 dispatch `file-fix-subagent` 修复
   - 循环最多 3 轮
8. Phase-Gate 通过后 fork session dispatch Retrospect

### UC-3: Phase 4 Test-Fix Loop

1. 主 agent 启动基础设施（dev server / DB）
2. 主 agent 调用 `coding-workflow-gate(phase=4)`
3. Gate handler 启动 **Test-Fix Loop Workflow（核心 case）**
4. 每轮：coordinator 构造 test-execute JSON → Wave 并行测试 → 汇总
5. 有 failed case → Fix Worker 分析 + 修复 → git commit
6. 核心 case 全部 passed/skipped → 启动 Workflow 2（非核心 case）
7. 两个 workflow 都完成后触发 Phase-Gate（严格防伪造）

## 实施计划

### 阶段 1：基础设施（P0，阻塞后续所有工作）

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 1.1 | 确认 Workflow Extension API | `extensions/workflow/src/` | 确认 `workflow-run` tool 的 `args` 传递方式、`agent()` 是否支持 skill 注入、`parallel()` 的能力边界 |
| 1.2 | 创建 Gate Pipeline 抽象 | `extensions/coding-workflow/lib/gates/` | 新建 `gate.ts`（接口定义）、`review-gate.ts`、`phase-gate.ts`、`test-fix-loop.ts` |
| 1.3 | 更新 Phase 配置 | `extensions/coding-workflow/index.ts` | `PHASES` 数组增加 `gates` 字段 |
| 1.4 | 重构 `executeGateTool` | `extensions/coding-workflow/lib/tool-handlers.ts` | 按 Gate Pipeline 抽象重写 gate 执行逻辑 |

### 阶段 2：Phase 1/2 Review-Gate Workflow（P1）

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 2.1 | 创建 Phase 1 Review-Gate Workflow 脚本 | `.pi/workflows/phase1-review-gate.js` | `agent()` 循环：审查 → 修复 → 判断 must_fix |
| 2.2 | 创建 `spec-requirements-reviewer.md` | `extensions/coding-workflow/agents/` | Phase 1 Review-Gate agent |
| 2.3 | 创建 Phase 2 Review-Gate Workflow 脚本 | `.pi/workflows/phase2-review-gate.js` | L1 单 agent / L2 串行双 agent |
| 2.4 | 创建 `plan-requirements-reviewer.md` | `extensions/coding-workflow/agents/` | Phase 2 L1/L2 共用 agent |
| 2.5 | 创建 `plan-bl-requirements-reviewer.md` | `extensions/coding-workflow/agents/` | Phase 2 L2 专用 agent |
| 2.6 | 实现 review-gate 状态隔离 | `extensions/coding-workflow/lib/gates/review-gate.ts` | 读写 `.review-gate-p{N}.json`，写入 `changes/reviews/phase-{N}/` |

### 阶段 3：Phase 3 Review-Gate Workflow（P1）

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 3.1 | 创建阶段一 agent | `agents/spec-plan-conformance-reviewer.md` | 规格符合性 + 业务逻辑审查 |
| 3.2 | 创建阶段一.五 agent | `agents/simulated-data-generator.md` | 生成 JSON fixture 模拟数据 |
| 3.3 | 创建 `fallow-reviewer.md` | `agents/fallow-reviewer.md` | 包装 fallow CLI，格式化 JSON 为 review 报告 |
| 3.4 | 创建 `review-sync-fix-worker.md` | `agents/review-sync-fix-worker.md` | 汇总 5 reviewer + 判断退出 + 按文件分组 dispatch |
| 3.5 | 创建 `file-fix-subagent.md` | `agents/file-fix-subagent.md` | 每个文件独占实例，串行处理 must_fix |
| 3.6 | 创建 Phase 3 Review-Gate Workflow 脚本 | `.pi/workflows/phase3-review-gate.js` | 三阶段：阶段一 → 阶段一.五 → 阶段二循环（并行 5 reviewer → Fix Worker → 按文件修复） |
| 3.7 | 更新 Phase 3 SKILL.md | `skills/xyz-harness-phase-dev/SKILL.md` | 删除旧章节，新增指导 |

### 阶段 4：Phase 4 Test-Fix Loop Workflow（P1）

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 4.1 | 创建 `test-execute-coordinator.md` | `agents/test-execute-coordinator.md` | Workflow 节点：构造/读取 JSON、分派 Wave、汇总判断 |
| 4.2 | 创建 `test-fix-worker.md` | `agents/test-fix-worker.md` | Fix Worker：分析失败 + 修复 + 更新状态 |
| 4.3 | 创建 `test-case-subagent.md` | `agents/test-case-subagent.md` | 测试执行：每 Wave 最多 3 个并行 |
| 4.4 | 创建 Phase 4 Test-Fix Loop Workflow 脚本 | `.pi/workflows/phase4-test-fix-loop.js` | 两个串行 workflow，含增量测试策略 |
| 4.5 | 更新 Phase 4 SKILL.md | `skills/xyz-harness-phase-test/SKILL.md` | 删除旧章节，新增指导 |

### 阶段 5：Goal 自动注入与 Retrospect fork（P2）

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 5.1 | 实现 Phase 3 Goal 动态任务列表 | `lib/tool-handlers.ts` | 从 plan.md 读取 Execution Groups 构建任务列表 |
| 5.2 | 实现 Phase 2 L2 任务追加 | `lib/tool-handlers.ts` | 评估 L2 后通过 `goal_manager.add_tasks()` 追加 |
| 5.3 | 实现 Retrospect fork session | `lib/review-dispatcher.ts` | `runSingleAgent` 使用 `context: 'fork'`（需确认 Pi subagent API） |
| 5.4 | 更新 Phase 1/2 SKILL.md | `skills/xyz-harness-brainstorming/`、`skills/xyz-harness-writing-plans/` | 删除旧章节，新增指导 |

### 阶段 6：验证与清理（P2）

| # | 任务 | 说明 |
|---|------|------|
| 6.1 | 全量类型检查 | `pnpm -r typecheck` |
| 6.2 | 全量 lint | `pnpm -r lint` |
| 6.3 | 更新 CHANGELOG | 记录所有变更 |
| 6.4 | 更新 README | 反映新的 gate 机制和 agent 文件 |

## 依赖关系

```
阶段 1（基础设施）
    ↓
阶段 2（Phase 1/2 Review-Gate）
    ↓
阶段 3（Phase 3 Review-Gate） ← 依赖 Workflow Extension API 确认
    ↓
阶段 4（Phase 4 Test-Fix Loop） ← 依赖阶段 3 的 Workflow 经验
    ↓
阶段 5（Goal + Retrospect）
    ↓
阶段 6（验证）
```

阶段 2/3/4 可并行开发各自的 Workflow 脚本和 agent 文件，但都需要阶段 1 的 Gate Pipeline 抽象。

## 技术确认

### Workflow Extension API 确认（问题 1-6）

| # | 问题 | 状态 | 最终结论 |
|---|------|------|---------|
| 1 | `agent()` 是否支持 SKILL.md 注入 | ✅ | `agent({ prompt, agent: "name" })` 通过 `AgentRegistry` 自动解析 `.md` 并注入 system prompt |
| 2 | workflow 脚本存放位置 | ✅ | 项目级 `.pi/workflows/*.js`，`loadWorkflows()` 扫描路径已确认 |
| 3 | Fix Worker 实现路径 | ✅ | workflow 脚本内 `for` 循环串行 dispatch `file-fix-subagent`（`parallel()` 不支持动态分组） |
| 4 | gate handler 调用方式 | ⚠️ | **必须先在 `extension-dependencies.json` 添加 coding-workflow → workflow 依赖**，然后 import `WorkflowOrchestrator` |
| 5 | Review-Gate 状态传递 | ✅ | workflow `return` → `instance.scriptResult` → gate handler 写 `.review-gate-p{N}.json` |
| 6 | Phase 4 串行 workflow | ✅ | 一个 workflow 脚本内两个阶段（core → noncore），JavaScript 变量传递状态 |

### pi-subagents fork 上下文确认（问题 7）

| # | 问题 | 状态 | 最终结论 |
|---|------|------|---------|
| 7 | Retrospect `context: "fork"` | ⚠️ | pi-subagents **支持** `context: "fork"`（`SubagentParamsLike.context` 类型定义 + `createForkContextResolver` + `wrapForkTask`），但 coding-workflow 的 `runSingleAgent` 直接 spawn `pi --mode json` **无法调用** pi-subagents 的 fork 机制。CLI 参数无 `--context fork`。Retrospect 降级为**上下文注入**（task prompt 内联 Phase 1~N 交付物摘要） |

### 阻塞项总结（最终版）

| 优先级 | 阻塞项 | 说明 |
|--------|--------|------|
| **P0** | `extension-dependencies.json` 添加依赖 | coding-workflow → workflow（type: package），否则无法 import `WorkflowOrchestrator` |
| P1 | Retrospect fork 降级 | 用上下文注入近似实现，不影响核心功能 |
| P1 | agent.md 存放位置 | `cwd/extensions/*/agents/` 扫描路径已验证覆盖 coding-workflow 的 `agents/` |

## 风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| `extension-dependencies.json` 添加依赖后循环依赖 | coding-workflow → workflow，workflow 是否依赖 coding-workflow？ | 检查 `extension-dependencies.json`，workflow 当前不依赖 coding-workflow，无循环风险 |
| 实施工作量过大 | 11 个 agent + 4 个 workflow 脚本 + 大量重构 | 按阶段分批实施，每阶段独立验证 |
| 现有用户 workflow 中断 | 接口变更导致已有 topic 无法继续 | `reconstructState` 向后兼容，旧 topic 按旧逻辑处理 |
| workflow 脚本 lint 失败 | `workflow-lint` 预检拦截 API 误用 | 每次创建 workflow 脚本后先运行 lint |
