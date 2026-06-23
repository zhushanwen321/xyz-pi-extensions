# Workflow Extension 重构计划

- **状态**: done
- **日期**: 2026-06-21
- **完成日期**: 2026-06-21（6 个 Wave 全部合并，typecheck/eslint/test 三绿，425 tests）
- **范围**: `extensions/workflow/` — 消除重复代码、修复架构异味、拆分超限文件

## 背景

对 `extensions/workflow/` 做了一次代码审查，发现重复代码与架构异味。按影响范围分级：

- **P0** — 影响整体架构（orchestrator 原子性契约被破坏）
- **P1** — 影响局部模块架构（散弹枪手术、并行数据结构、超限文件）
- **P2** — 确定性问题但只影响小规模局部（重复函数、死代码）
- **P3** — 不确定性（已排除：与 pi-subagents 平行实现，不在本次范围）

## 问题清单

### P0

- **A4** — orchestrator 原子性破坏。`pause/resume/abort` 副作用顺序错误（先 `transitionStatus` 再 `terminateWorker`），terminate 抛错时状态已变但 worker 仍存活。index.ts 在 execute 层用三层 fallback 打补丁（orchestrator 调用 → idempotent 检查 → 直调 `transitionStatus`），掩盖了 orchestrator 的原子性 bug。

### P1

- **#5** — 终止 workflow 的 6 行模式（`completedAt` + `transitionStatus` + `emit` + `terminateWorker` + `cleanupTempFiles` + `deletePool` + `persistState` + `onCompletion`）散落 8 处（error-handlers×3 / orchestrator-budget×2 / orchestrator×3），各处三件套不一致。
- **#6** — orchestrator 维护 7 个并行 Map（instances / workers / runMetaMap / retryCounts / runPools / runAbortControllers / activeTempFiles），每个生命周期方法都要同步维护 4–6 个。
- **A3** — `index.ts`（790 行）+ `orchestrator.ts`（870 行）逼近 1000 行上限。index.ts 注册 3 个 tool 未拆分（已有 TODO 注释）。

### P2

- **A1** — `resolveModel` 是退化死代码（`opts.model || undefined`），调用点把它读出又赋回。
- **#2** — `isTerminal`（domain/state.ts）与 `isTerminalStatus`（format.ts）实现等价，后者用内联数组字面量。
- **A5** — `isTerminal(x) || x === "budget_limited"` 冗余条件（budget_limited 已在 TERMINAL_STATUSES），暗示状态机定义未被完整理解。
- **#7** — runId 生成代码在 orchestrator.ts 重复 2 处。
- **#4** — `renderResult` fallback 模式（`content[0].text`）重复 5 处（index.ts×4 + tool-generate×1）。
- **#3** — `formatAgentOneLiner`（format.ts）提取了但未被调用，`renderLevel0/1`（WorkflowsView.ts）各自内联了相同拼接逻辑。
- **#8** — RUNID 常量（RUNID_SHORT_LENGTH / RUNID_SLICE_LENGTH）在 3 个文件定义且值不同。
- **#1** — `saveWorkflow` 两套实现：commands.ts 用 renameSync + 仅 project scope；WorkflowsView.ts 用 copyFileSync + project/user scope。
- **A2** — 测试目录约定违反：`tests/`（根级 12 文件）+ `src/__tests__/` + `src/engine/__tests__/` 并存。CLAUDE.md 规定统一放 `src/__tests__/`。

### 已排除

- **A6** — 与 `@zhushanwen/pi-subagents` 包的平行实现（agent-pool / pi-runner / agent-discovery vs session-factory / discovery-config）。CHANGELOG 已注明是已知技术债，合并方向未定，本次不做。

## 已确认的决策

### 决策 1：agent 行格式（影响 #3）

统一为 `formatAgentOneLiner`（format.ts）的格式——**elapsed（耗时）独立成一段，用 4 空格与前一组分隔**：

```
● agent-name    model-name    12k tok · 3 tools    45s
```

理由：token（用量）和 tools（操作数）是同类信息（「agent 消耗了什么」），elapsed 是时间维度，语义不同。用不同分隔符（空格 vs `·`）让用户一眼分清「用量组」和「耗时」。

影响：TUI 显示会从「全 ` · ` 连」变成「elapsed 独立一段」，用户可感知。

### 决策 2：saveWorkflow 语义（影响 #1）

统一为**方案 B**：`renameSync` + 仅 project scope。

- 两处都改为 rename（tmp 文件保存后自动消失）
- 砍掉 TUI 的 user scope（Tab 切换）功能和 `saveScope` 状态字段
- 保存位置统一 `.pi/workflows/`

代价：TUI 失去 user scope 选项（功能倒退）；Windows/跨设备 rename 可能失败（已知风险，接受）。

## 分 Wave 执行计划

每个 Wave 聚焦单一目标、独立 commit、可独立验证（`pnpm typecheck && pnpm --filter @zhushanwen/pi-workflow test` 双绿）。

### Wave 1 — P2 局部清理（1 个 subagent，内部串行 3 步）

范围：A1 + #2 + A5 + #7 + #4 + #8 + #3（用决策 1 格式）

| 步骤 | 文件 | 修改 |
|------|------|------|
| 1 | 新建 `src/infra/constants.ts`；改 `src/interface/views/format.ts` | constants 定义 RUNID_GEN_* / RUNID_DISPLAY_* / MS_PER_SEC；format.ts 删 `isTerminalStatus`（#2）、新增 `renderTextFallback(result)`（#4） |
| 2 | 删 `src/engine/model-resolver.ts` + `src/__tests__/model-resolver.test.ts`；改 `src/orchestrator.ts`；改 `src/__tests__/state-machine.test.ts` | A1 删 resolveModel 调用；A5 删 `\|\| instance.status === "budget_limited"`（2 处）+ 加状态机测试；#7 提取 `generateRunId()`；#8 RUNID 引用 constants |
| 3 | 改 `src/index.ts` / `src/interface/tool-generate.ts` / `src/interface/commands.ts` / `src/interface/views/WorkflowsView.ts` | #4 五处 renderResult 改用 renderTextFallback；#3 `renderLevel0/1` 改调 `formatAgentOneLiner`（决策 1 格式）；#8 RUNID 引用 constants；#2 WorkflowsView import isTerminal from domain |

验收：`pnpm typecheck && pnpm --filter @zhushanwen/pi-workflow test`

### Wave 2 — #1 saveWorkflow 统一（1 个 subagent，独立）

范围：按决策 2（方案 B）统一

| 任务 | 文件 | 修改 |
|------|------|------|
| 提取 workflow-files 模块 | 新建 `src/infra/workflow-files.ts` + `src/infra/__tests__/workflow-files.test.ts`；改 `src/interface/commands.ts`、`src/interface/views/WorkflowsView.ts` | 统一 `saveWorkflow(name, newName?)` rename 语义 + 仅 project scope；`deleteWorkflow` 从 commands.ts 搬入；commands.ts 和 WorkflowsView 改为调用新模块；WorkflowsView 砍掉 saveScope/saveInputValue 的 Tab 切换 |

验收：新增 workflow-files 单测 + 手测 `/workflow save` 与 TUI `s` 键行为一致（rename + tmp 消失）。

依赖：Wave 1 完成后启动（避免 commands.ts 的 RUNID 常量冲突）。

### Wave 3 — A2 测试迁移（1 个 subagent，独立）

| 任务 | 文件 | 修改 |
|------|------|------|
| tests/ → src/__tests__/ | mv `tests/*.test.ts`（12 文件）按模块就近放；改 `vitest.config.ts` include + `tsconfig.json` exclude；删空 `tests/` | 机械迁移 + 修正 import 路径 |

验收：`pnpm --filter @zhushanwen/pi-workflow test` 全绿，测试文件数量不变。

### Wave 4 — #6 Map 合并（3 个 subagent，严格串行）

核心数据结构重构。

**4-A 类型定义**

新建 `src/domain/run-resources.ts`，定义：

```typescript
interface RunResources {
  instance: WorkflowInstance;
  meta: RunMeta;
  pool: AgentPool;
  worker?: Worker;              // undefined = 已 terminate
  abortController?: AbortController;  // undefined = 已 abort
  retryCount: number;           // 默认 0，替代 retryCounts Map
}
```

**4-B orchestrator 内部合并**

改 `src/orchestrator.ts`（大改）：
- 6 个 Map → `runs: Map<string, RunResources>`（`activeTempFiles` 保持全局 Set，生命周期不是 per-run）
- 所有 lifecycle 方法（run/pause/resume/abort/retryNode/skipNode/restart/terminateWorker/startWorker/postMessage）改用 `run.xxx`
- context 构造方法内部从 runs 取，对外接口暂保持兼容
- `terminateWorker` 置 `run.worker = undefined`、`run.abortController = undefined`（不删 Map 条目——实例还在）
- `abort/restart` 删除整个 Map 条目

**4-C 外部 context 接口迁移**

改 `src/engine/error-handlers.ts`、`src/engine/agent-call-handler.ts`：
- ErrorHandlerContext / AgentCallContext 改用 `getRun(runId): RunResources | undefined` 或传 `runs` Map
- BudgetCallbacks 不变（已无状态）

验收：全量 `pnpm typecheck`（兜底捕获遗漏访问点）+ orchestrator/error-handlers/agent-call-handler/orchestrator-budget 全套测试绿。

### Wave 5 — A4 + #5 控制流重构（4 个 subagent）

**5-A 提取 terminateInstance**

新建 `src/engine/terminate-instance.ts`：

```typescript
terminateInstance(ctx, runId, instance, {
  status: WorkflowStatus,
  error?: string,
  scriptResult?: unknown,
  cleanupWorker?: boolean,    // 默认 true
  cleanupTempFiles?: boolean, // 默认 true
  deletePool?: boolean,       // 默认 true
})
```

内部顺序遵循 A4 原则：**先 cleanup（worker/tempFiles/pool）→ 再 transitionStatus + emit → 再 persistState → 再 onCompletion**。

**5-B orchestrator 副作用重排**

改 `src/orchestrator.ts` + 加测试：
- A4：`pause/resume/abort/handleWorkerMessage` 的 return/error 分支，把 terminateWorker+cleanup 移到 transitionStatus 之前
- 新增测试「mock terminateWorker 抛错 → instance.status 未变」

**5-C 替换 8 处终止模式**

改 `src/engine/error-handlers.ts`（3 处）、`src/engine/orchestrator-budget.ts`（2 处）、`src/orchestrator.ts`（3 处）：
- 各处 6 行模式替换为 `terminateInstance(...)` 调用

**5-D index.ts execute 简化**

改 `src/index.ts`：pause/resume/abort case 删掉 idempotent 检查 + transitionStatus 直调两层 fallback，简化为单层 try/catch。

调度：5-A → 5-B → **5-C 与 5-D 并行**（5-C 改 engine 层，5-D 改 index.ts，文件不交叉）。

验收：5-B 新增的原子性测试绿 + 全套回归。

### Wave 6 — A3 拆分（1 个 subagent，内部串行）

拆 `src/index.ts`：
- 新建 `src/interface/tool-workflow.ts`（pause/resume/abort/status）
- 新建 `src/interface/tool-workflow-run.ts`（workflow-run）
- 新建 `src/interface/tool-workflow-lint.ts`（workflow-lint）
- 参照 `tool-generate.ts` 范例
- index.ts 只留 factory + events 注册 + tool_call hook

评估 `src/orchestrator.ts`：Wave 5 后重新评估行数，>700 行则拆 `src/engine/worker-manager.ts`（startWorker/terminateWorker/postMessage）或 `src/engine/lifecycle.ts`（pause/resume/abort/retry/restart）。

验收：`pnpm typecheck && pnpm --filter @zhushanwen/pi-workflow test`。

## 依赖图与执行顺序

```
Wave 1 (P2 清理) ──┐
                   ├─→ Wave 4 (A→B→C) ──→ Wave 5 (A→B→C‖D) ──→ Wave 6 (拆分)
Wave 2 (#1 统一) ──┤
Wave 3 (A2 迁移) ───┘
```

- Wave 1 / 2 / 3 互不依赖，但 Wave 2 改 commands.ts 与 Wave 1 的 #8 冲突，故 Wave 2 在 Wave 1 之后启动
- Wave 4 必须先于 Wave 5（#6 给 A4/#5 提供干净的操作对象）
- Wave 6 必须最后（等 Wave 5 简化后再拆，避免返工）

执行批次：

| 批次 | Wave | subagent 数 | 模式 |
|------|------|------------|------|
| 1 | Wave 1 | 1 | 内部串行 3 步 |
| 2 | Wave 2 + Wave 3 | 2 | 并行 |
| 3 | Wave 4-A | 1 | 串行 |
| 4 | Wave 4-B | 1 | 串行 |
| 5 | Wave 4-C | 1 | 串行 |
| 6 | Wave 5-A | 1 | 串行 |
| 7 | Wave 5-B | 1 | 串行 |
| 8 | Wave 5-C + Wave 5-D | 2 | 并行 |
| 9 | Wave 6 | 1 | 内部串行 |

## subagent 委托规范

- 每个任务标注：文件路径、函数名/唯一代码片段定位（不用行号，行号会漂）、具体修改、验收命令
- 单 subagent 改动上限：5 文件 / 1000 行
- 无依赖任务可并行（最多 5 个并发，一般 3 个）
- 有依赖任务串行
- 禁止空泛委托：必须包含文件路径、定位锚点、具体修改内容

## 风险与回滚

- 每个 Wave 独立 commit，失败时 `git reset --hard <wave-start>` 回滚单个 Wave
- Wave 4/5 风险最高（核心数据结构 + 控制流），动手前再次 review 技术方案
- typecheck + test 双绿是每个 Wave 的硬性门槛
