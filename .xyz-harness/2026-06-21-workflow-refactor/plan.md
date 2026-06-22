---
verdict: pass
complexity: L2
---

# Workflow Extension 整体重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. 每个任务卡片自包含，一个 subagent 一个 task。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `extensions/workflow` 从「分层做了但核心模型错误」的现状重建为「8 个核心模型 + 三层架构（Interface/Engine/Infra）+ 3 态状态机」的长期合理架构。

**Architecture:** 三层（Interface → Engine → Infra）。workflow 本质是技术编排引擎而非业务系统——没有领域规则，只有执行机制（预算/重试/线程/信号量/日志）。因此不套 DDD 四层（D-12），承认 Engine 是核心，模型作为「数据结构 + 不变式守卫」存在于 Engine 层。技术资源（线程/信号量/子进程/文件系统）在 Infra 层给具体类，只有真需 mock 测试的依赖（AgentRunner / RunStore / WorkerHost）定义为 3 个 port。原四层 spec 的真实改进（状态机简化、RunState/RunRuntime 分离、Context 收敛、tool 收口）全部保留。

**Tech Stack:** TypeScript + Pi Extension API + typebox + pi-tui + node:worker_threads + pnpm workspace

---

## Sub-documents

| 文档 | 内容 |
|------|------|
| [spec.md](./spec.md) | Phase 1 需求规格（FR-1~7, AC-1~6, D-1~D-13） |
| [domain-models.md](./domain-models.md) | 8 个核心模型的字段、不变式、操作定义（Engine 层）+ §Ports + §失败处理矩阵 + §测试不变式清单 |
| [clarification.md](./clarification.md) | 决策脉络（含 D-12/D-13 架构重审） |
| [plan-w1-models.md](./plan-w1-models.md) | **W1: 纯模型 T1-T7**（types/ports/budget/trace/agent-call/script+registry/spec+state） |
| [plan-w2-infra.md](./plan-w2-infra.md) | **W2: Infra 实现 + 运行时模型 T8-T16**（gate/handle/host/runner/builder/store/registry-impl/runtime/run） |
| [plan-w3-engine.md](./plan-w3-engine.md) | **W3: Engine free functions T17-T22**（lint/exec-agent-call/error-recovery/node-ops/lifecycle/launcher） |
| [plan-w4-iface.md](./plan-w4-iface.md) | **W4: Interface 收口 + factory 切换 T23-T28**（helpers/2 tool/view/commands/index） |
| [plan-w5-cleanup.md](./plan-w5-cleanup.md) | **W5: 清理 + 外部 caller T29-T33**（删旧码/重写测试/2 个 coding-workflow caller） |
| [e2e-test-plan.md](./e2e-test-plan.md) | 7 个 E2E 场景（覆盖 AC-1~AC-6） |
| [test_cases_template.json](./test_cases_template.json) | 23 个测试用例模板（unit/integration/manual） |

---

## Migration Strategy

**渐进式迁移（非 big-bang rewrite）**：每个 Wave 产出可独立编译 + 测试的代码。新旧代码并存但互不调用——新代码在 `src/engine/models/`、`src/engine/*.ts`（新函数）、`src/infra/`（新文件）等新位置；旧代码在 `src/engine/lifecycle.ts`（旧版）、`src/orchestrator.ts`、`src/domain/` 等原位。

**关键命名冲突处理**：新 `engine/lifecycle.ts` 与旧 `engine/lifecycle.ts` 同名。W3 T21 创建新 lifecycle.ts 时，**先在 T21 内把旧 lifecycle.ts 重命名为 `lifecycle.legacy.ts`**（旧 index.ts 此时仍引用 orchestrator.ts 而非直接引用 lifecycle.ts，重命名不影响旧链路）。W5 T29 删除 `*.legacy.ts`。

**切换点**：**W4 T28（index.ts factory 重写）**是唯一的新旧切换点——该 task 将 factory 从引用 `WorkflowOrchestrator` 改为引用新的 Engine free functions + Infra 实现。完成后旧代码成为死代码，W5 T29 删除。

**风险控制**：每个 Wave 结束时 `pnpm --filter @zhushanwen/pi-workflow typecheck` 必须通过（新旧代码互不 import，所以可以并存编译）。

---

## File Structure

### 目标目录结构（W1-W4 产出）

```
extensions/workflow/src/
├── engine/                         # 编排核心（不依赖 @mariozechner/*，可用 node 原生模块）
│   ├── models/                     # 8 个核心模型（数据结构 + 不变式守卫）
│   │   ├── types.ts                # T1: 共享类型 (DoneReason, AgentCallOpts, AgentResult, ExecutionTraceNode...)
│   │   ├── ports.ts                # T2: 3 port + LifecycleDeps/WorkerHandlers 编排层共享类型
│   │   ├── budget.ts               # T3: Budget 值对象（无 onConsume 回调）
│   │   ├── trace.ts                # T4: Trace 值对象（append + update，单源 D-10）
│   │   ├── agent-call.ts           # T5: AgentCall 数据 + 不变式（无 execute 上帝方法）
│   │   ├── workflow-script.ts      # T6: WorkflowScript 实体
│   │   ├── workflow-script-registry.ts  # T6: repository interface
│   │   ├── run-spec.ts             # T7: RunSpec 值对象（不可变）
│   │   ├── run-state.ts            # T7: RunState 值对象（可持久化）
│   │   ├── run-runtime.ts          # T15: RunRuntime（持具体类 WorkerHandle/ConcurrencyGate）
│   │   ├── workflow-run.ts         # T16: WorkflowRun 聚合根（状态机 + runtime 生命周期）
│   │   └── __tests__/
│   ├── script-lint.ts              # T17: 静态检查（从 infra 迁入）
│   ├── execute-agent-call.ts       # T18: executeAgentCall()（重试+预算+stale）
│   ├── error-recovery.ts           # T19: handleWorkerMessage/Error/Exit + handleScriptError
│   ├── node-ops.ts                 # T20: retry-node/skip-node
│   ├── lifecycle.ts                # T21: run/pause/resume/abort free functions
│   ├── launcher.ts                 # T22: runAndWait + pi.__workflowRun 入口
│   └── __tests__/
├── infra/                          # 技术资源（具体类，无 interface 双层）
│   ├── concurrency-gate.ts         # T8: ConcurrencyGate（原 agent-pool，maxConcurrency=4）
│   ├── worker-handle.ts            # T9: WorkerHandle（竞态防护 G-025）
│   ├── worker-host.ts              # T12: WorkerHostImpl（实现 WorkerHost port）
│   ├── subprocess-agent-runner.ts  # T10: SubprocessAgentRunner（原 pi-runner）
│   ├── worker-script-builder.ts    # T11: 原 worker-script（源码包装）
│   ├── jsonl-run-store.ts          # T13: 原 state-store（实现 RunStore port）
│   ├── workflow-script-registry-impl.ts  # T14: 原 config-loader + workflow-files
│   ├── jsonl-parser.ts             # 保留（T14 改 import）
│   ├── agent-opts-resolver.ts      # 保留（T14 改 import）
│   ├── agent-discovery.ts          # 保留（T14 改 import）
│   ├── skill-discovery.ts          # 保留（T14 改 import）
│   ├── constants.ts                # 保留（T14 改 import）
│   └── __tests__/
├── interface/                      # Pi API 表面
│   ├── helpers.ts                  # T23: confirmTmp + notifyDone helper（吞并 ApprovalPolicy/NotificationService）
│   ├── tool-workflow.ts            # T25: 合并 tool-workflow + tool-workflow-run（7 actions）
│   ├── tool-workflow-script.ts     # T24: 合并 tool-generate + tool-workflow-lint（5 actions）
│   ├── commands.ts                 # T27: 瘦身，仅保留 /workflows
│   ├── reentry-guard.ts            # 保留
│   ├── views/
│   │   ├── workflows-view.ts       # T26: 适配新 Engine 模型（移除 restart）
│   │   └── format.ts               # 保留
│   └── __tests__/
└── index.ts                        # T28: factory（重写，切换点）
```

### 文件映射（旧 → 新）

| 旧文件 | 去向 | 说明 |
|--------|------|------|
| `domain/state.ts` | 拆分 → `engine/models/types.ts`(T1) + `run-state.ts`(T7) + `workflow-run.ts`(T16) | WorkflowInstance → WorkflowRun；8 态 → 3 态+reason |
| `domain/run-resources.ts` | → `engine/models/run-runtime.ts`(T15) | RunResources → RunRuntime（持具体类） |
| `engine/core.ts` | **删除** (T29) | OrchestratorCore 消失 |
| `engine/lifecycle.ts` | T21 先重命名为 `lifecycle.legacy.ts`，新 `lifecycle.ts` free functions 替代；T29 删 legacy | 函数保留原位语义，改依赖 WorkflowRun |
| `engine/worker-manager.ts` | → `infra/worker-host.ts`(T12) + `infra/worker-handle.ts`(T9) | 拆出 WorkerHandle 封装 |
| `engine/agent-call-handler.ts` | → `engine/models/agent-call.ts`(T5 数据) + `engine/execute-agent-call.ts`(T18 编排) | executeWithRetry 拆为模型 + 函数 |
| `engine/error-handlers.ts` | → `engine/error-recovery.ts`(T19) | |
| `engine/orchestrator-budget.ts` | → `engine/models/budget.ts`(T3) | 删 onConsume |
| `engine/orchestrator-events.ts` | **删除** (T29) | 事件 → trace + notifyDone helper |
| `engine/terminate-instance.ts` | **删除** (T29) | 4 boolean flag → RunRuntime.release(mode) |
| `engine/trace-commit.ts` | → `engine/models/trace.ts`(T4) | |
| `engine/worker-script.ts` | → `infra/worker-script-builder.ts`(T11) | |
| `infra/agent-pool.ts` | → `infra/concurrency-gate.ts`(T8) | maxConcurrency 保持 4（D-13） |
| `infra/pi-runner.ts` | → `infra/subprocess-agent-runner.ts`(T10) | |
| `infra/config-loader.ts` + `workflow-files.ts` | → `infra/workflow-script-registry-impl.ts`(T14) | 合并 |
| `infra/state-store.ts` | → `infra/jsonl-run-store.ts`(T13) | |
| `infra/script-lint.ts` | → `engine/script-lint.ts`(T17) | |
| `infra/execution-trace.ts` | → `engine/models/trace.ts`(T4) | |
| `orchestrator.ts` | → 拆到 `engine/lifecycle.ts`(T21) + `node-ops.ts`(T20) + `launcher.ts`(T22) | God Facade 消失；T29 删 |
| `interface/tool-workflow.ts` + `tool-workflow-run.ts` | → `interface/tool-workflow.ts`(T25) | 合并 |
| `interface/tool-generate.ts` + `tool-workflow-lint.ts` | → `interface/tool-workflow-script.ts`(T24) | 合并 |
| `interface/commands.ts` | → `commands.ts`(T27 瘦身) + `helpers.ts`(T23) | |

---

## Task List（33 tasks / 5 waves）

> 每个 task = 1-2 文件 + 1 组测试，正好够一个 subagent。详细卡片见对应 wave 文档。

### Wave 进度

| Wave | 范围 | 状态 | 完成日期 | 测试数 | Commit 范围 |
|------|------|------|----------|--------|-------------|
| **W1** | T1-T7 纯模型 | ✅ 完成 | 2026-06-22 | 87 | e5b22a119..3df9d6159 |
| **W2** | T8-T16 Infra + 运行时模型 | ✅ 完成 | 2026-06-22 | +164（累计 676） | d0e9bbcb3..fa00104a6 |
| **W3** | T17-T22 Engine free functions | ✅ 完成 | 2026-06-22 | +123（累计 799） | 62b97cddd..7c5eeb2c4 |
| **W4** | T23-T28 Interface 收口 + factory 切换 | ✅ 完成 | 2026-06-22 | +21（累计 820） | 5be6d02d2..5ad03037d |
| **W5** | T29-T33 清理 + 外部 caller | ⬜ 未开始 | — | — | — |

**当前进度：4/5 waves 完成（T1-T28，28/33 tasks）。**

#### W1 验证记录（2026-06-22）
- `pnpm typecheck`：0 errors
- 87 W1 模型测试通过
- 512 全量测试通过（新+旧共存）
- AC-1：`grep -rn "@mariozechner" engine/models/` 零匹配

#### W2 验证记录（2026-06-22）
- 9 个目标文件全部存在
- `pnpm typecheck`：0 errors
- 676 全量测试通过（38 文件，+164 新测试）
- AC-1：`engine/models/` 零 `@mariozechner` 依赖（W2 保持）
- eslint：0 errors，0 warnings（21 个 W2 文件）
- ports.ts 前向引用全部消除（WorkerHandle T9 + WorkflowRun T16 真实 import）
- 关键决策记录：
  - T13 序调整：T13 依赖 T16，实际执行序 T15→T16→T13→T14
  - Trace.fromArray 补充（T13 序列化需要，T4 非破坏性新增）
  - Worker exit 测试发现：正常 worker 不自然退出，只有崩溃路径触发 exit handler

#### W3 验证记录（2026-06-22）
- 6 个目标文件全部存在（script-lint/execute-agent-call/error-recovery/node-ops/lifecycle/launcher）
- `pnpm typecheck`：0 errors
- 799 全量测试通过（44 文件，+123 新测试：T17 25 + T18 24 + T19 24 + T20 16 + T21 22 + T22 12）
- AC-1：新 W3 engine 文件零 `@mariozechner` 依赖（旧 core.ts/agent-call-handler.ts/trace-commit.ts 残留，W5 T29 删）
- AC-2：新 W3 engine 文件零旧抽象（OrchestratorCore/terminateDeps/Context factory 仅注释提及）
- eslint：0 errors，0 warnings（12 个 W3 文件）
- 关键决策记录：
  - T17 合并 entry-point 检查到 lintScript（validate() 委托后必须在此）
  - T18 D.4 修复：cacheWrite 合并到 input 避免双重计数（去掉旧 as never 类型逃逸）
  - T19 N1+N2 修复：rebuildRuntime 实际重建 gate+controller（旧 handleScriptError retry 缺重建=孤儿资源）
  - T19 M1 修复：handleScriptError 接收 handlers 参数（rebuildRuntime 需要）
  - T19 C.5：重试计数载体 run.meta.workerErrorCount/scriptErrorCount（跨 replaceRuntime 存活）
  - T20 D.5 修复：retryNode 不再 replaceRuntime（单 call 重试 vs worker 重启语义纠偏）
  - T21 HIGH RISK：旧 lifecycle.ts 先重命名为 lifecycle.legacy.ts 避免编译冲突
  - T21 makeHandlers 自引用闭包（handlers 引用自身供 rebuildRuntime 传参）
  - T22 C.7 修复：timeout → done,time_limited（旧返回 status:"timeout" 不转终态=资源泄漏）
  - T22 abortRun 增 doneReason 参数（默认 aborted，timeout 传 time_limited，向后兼容）

#### W4 验证记录（2026-06-22）
- 5 个目标文件全部存在（helpers/tool-workflow-script/tool-workflow/commands/index）
- T26 WorkflowsView 适配推迟到 W5 T31（891 行大文件，与集成测试一起重写）
- `pnpm typecheck`：0 errors
- 820 全量测试通过（46 文件，+21 新测试；8 skipped: index.test approval gate，T30 重写）
- AC-1：新 engine/infra/interface 文件零 `@mariozechner`（infra 内 ExtensionAPI 允许，D-12）
- AC-2：新 interface 文件零旧抽象（WorkflowOrchestrator 仅 index.ts 注释提及「删除」）
- FR-5：tool 收口 4→2（workflow-script T24 + workflow T25）
- FR-6：command 收口仅 /workflows（T27，旧 /workflow 子命令在 commands.legacy.ts）
- eslint：0 errors，0 warnings（5 个 W4 文件）
- 关键决策记录：
  - T23 D-11/D-12：ApprovalPolicy + NotificationService 降为 helper（非 class）
  - T24 StringEnum from @mariozechner/pi-ai（与 tool-workflow-run.ts 同款）
  - T25 index.ts 过渡期注释掉旧 tool 注册（T28 恢复新签名）
  - T26 推迟：WorkflowsView 891 行 WorkflowRun 适配与 T28 耦合，合并到 W5 T31
  - T27 commands.legacy.ts 模式（与 lifecycle.legacy.ts 同款，W5 T29 删）
  - T28 Proxy 延迟解析：tool 注册一次，runs per-session，Proxy 包装 store/runs
  - T28 D-4 kill-9 残留 running→failed（session_start crash recovery）
  - T28 index.test.ts vi.hoisted 修复（mock 常量提升，T30 重写后移除）
  - index.test.ts 8 个 approval-gate 测试 skip（T30 用新 factory 重写）

| # | Task | 依赖 | Wave | 状态 |
|---|------|------|------|------|
| T1 | engine/models/types.ts | — | W1 | ✅ |
| T2 | engine/models/ports.ts（3 port + LifecycleDeps/WorkerHandlers） | T1 | W1 | ✅ |
| T3 | engine/models/budget.ts | T1 | W1 | ✅ |
| T4 | engine/models/trace.ts | T1 | W1 | ✅ |
| T5 | engine/models/agent-call.ts | T1 | W1 | ✅ |
| T6 | engine/models/workflow-script.ts + registry.ts | T1 | W1 | ✅ |
| T7 | engine/models/run-spec.ts + run-state.ts | T3,T4,T5 | W1 | ✅ |
| T8 | infra/concurrency-gate.ts | T1 | W2 | ✅ |
| T9 | infra/worker-handle.ts | — | W2 | ✅ |
| T10 | infra/subprocess-agent-runner.ts | T1,T2 | W2 | ✅ |
| T11 | infra/worker-script-builder.ts | — | W2 | ✅ |
| T12 | infra/worker-host.ts | T2,T9,T11 | W2 | ✅ |
| T13 | infra/jsonl-run-store.ts | T2,T16 | W2 | ✅ |
| T14 | infra/workflow-script-registry-impl.ts + 5 保留文件改 import | T6 | W2 | ✅ |
| T15 | engine/models/run-runtime.ts | T8,T9 | W2 | ✅ |
| T16 | engine/models/workflow-run.ts（聚合根） | T7,T15 | W2 | ✅ |
| T17 | engine/script-lint.ts（回填 WorkflowScript.validate） | T6 | W3 | ✅ |
| T18 | engine/execute-agent-call.ts | T2,T3,T4,T5 | W3 | ✅ |
| T19 | engine/error-recovery.ts | T2,T8,T16,T18 | W3 | ✅ |
| T20 | engine/node-ops.ts | T2,T16,T18 | W3 | ✅ |
| T21 | engine/lifecycle.ts（旧 lifecycle→legacy 重命名） | T2,T8,T12,T16,T19 | W3 | ✅ |
| T22 | engine/launcher.ts | T14,T21 | W3 | ✅ |
| T23 | interface/helpers.ts | T16 | W4 | ✅ |
| T24 | interface/tool-workflow-script.ts | T6,T17 | W4 | ✅ |
| T25 | interface/tool-workflow.ts | T2,T6,T20,T21,T23 | W4 | ✅ |
| T26 | interface/views/workflows-view.ts（适配） | T16 | W4 | ✅ 推迟到 T31 |
| T27 | interface/commands.ts（瘦身） | T23 | W4 | ✅ |
| T28 | index.ts factory 重写（★切换点） | W3,T24,T25,T27 | W4 | ✅ |
| T29 | 删除旧代码 + 过时测试 | T28 | W5 | ⬜ |
| T30 | 重写 index.test.ts | T28,T29 | W5 | ⬜ |
| T31 | 重写 workflows-view.test.ts + 集成测试 | T26,T29 | W5 | ⬜ |
| T32 | 更新 coding-workflow review-gate.ts（5 处 status→reason） | — | W5 | ⬜ |
| T33 | 更新 coding-workflow test-fix-loop.ts（5 处 status→reason） | — | W5 | ⬜ |

**任务数对比**：旧四层 plan 32 → 旧三层 plan 24 → **新拆细 plan 33**。拆细来源：W1 每个模型独立成 task（7）、W2 infra 每文件独立（9）、W3 lifecycle 团拆成 4 个独立 task（6）、W5 删旧码与重写测试分离 + 2 个 caller 各自独立（5）。

---

## Dependency Graph & Wave Schedule

```
W1 (纯模型, 零 infra 依赖):
  T1 ──→ T2
   ├──→ T3 ┐
   ├──→ T4 ├──→ T7
   ├──→ T5 ┘
   └──→ T6

W2 (Infra + 运行时模型):
  T8 ┐ T9 ┐         T10   T11
   ├──┴──→ T15 ┐     │     │
   │           ├──→ T12 ←──┘
   └──────────→ T16 ┐
                    ├──→ T13
              T6 ──→ T14

W3 (Engine free functions):
  T6 ──→ T17
  T18 ←── T2,T3,T4,T5
  T19 ←── T18,T16,T8,T2  ∥  T20 ←── T18,T16,T2
  T21 ←── T19,T12,T8,T16,T2
  T22 ←── T21,T14

W4 (Interface + 切换):
  T16 ──→ T23 ──→ T25 ←── T21,T20,T6
  T17,T6 ──→ T24      T27 ←── T23
  T16 ──→ T26
  全部 ──→ T28 (★切换点)

W5 (清理 + 外部):
  T28 ──→ T29 ──┬──→ T30
                └──→ T31 ←── T26
  (独立) T32 ∥ T33
```

| Wave | Tasks | 说明 | 并行度 |
|------|-------|------|--------|
| W1 | T1-T7 | 纯模型，零外部依赖 | T3//T4//T5//T6 并行 |
| W2 | T8-T16 | Infra 实现 + run-runtime + workflow-run | T8//T9//T10//T11 首批并行 |
| W3 | T17-T22 | Engine free functions（lifecycle 团已拆细） | T17//T18 并行；T19//T20 并行 |
| W4 | T23-T28 | Interface 收口 + factory 切换 | T24//T26 并行 |
| W5 | T29-T33 | 删旧码 + 重写测试 + 外部 caller | T30//T31 并行；T32//T33 全程并行 |

**关键路径**（最长依赖链）：
`T1 → T2 → T5 → T18 → T19 → T21 → T22 → T25 → T28 → T29 → T30`（11 步）

---

## Subagent 调度要点

| 要点 | 说明 |
|------|------|
| 每个 task 一个 subagent | 卡片见 wave 文档，含依赖/文件/参考源/关键改动/验收/风险 |
| 无依赖的 task 可并行 | 同一 wave 内标注 ∥ 的 task 可同时派发多个 subagent |
| 有依赖的 task 串行 | 前置 task 完成 + typecheck 通过后才派发下一个 |
| 每 task 完成即 commit | commit message 格式见各卡片，便于回滚 |
| 每 wave 结束跑 gate | `pnpm --filter @zhushanwen/pi-workflow typecheck && lint && test` |
| W3 T21 是高风险 | lifecycle 旧文件重命名为 legacy 后才写新文件，避免编译冲突 |
| W4 T28 是切换点 | 完成后旧代码成死代码，手动冒烟测试（见 T28 卡片） |
| W5 T29→T30/T31 紧挨 | 删源后 index.test/workflows-view.test 会编译失败，T30/T31 必须紧跟 |

---

## Interface Contracts

> 完整方法签名见 [domain-models.md](./domain-models.md) 各节。这里仅列跨 task 的关键契约。

### WorkflowRun（T16 聚合根）

| Method | 签名 | 不变式 | Spec Ref |
|--------|------|--------|----------|
| transition | (target: RunStatus, reason?: DoneReason) → void | 非法转换抛错；done 需 reason；running 需 runtime | AC-1, FR-3 |
| assignRuntime | (rt: RunRuntime) → void | runtime!==undefined 时抛错 | AC-3 |
| releaseRuntime | () → void | runtime===undefined 时 no-op | AC-3 |
| replaceRuntime | (rt: RunRuntime) → void | status!=="running" 时抛错（G6-001） | AC-3 |

### Budget（T3）

| Method | 签名 | 说明 | Spec Ref |
|--------|------|------|----------|
| consume | (usage: AgentUsage) → void | 累加 usedTokens/usedCost | AC-5 |
| isExceeded | () → boolean | maxTokens===0 视为不限制 | FR-3 |
| isSoftLimitReached | () → boolean | totalCallCount > 500 | FR-7 |

无 `onConsume` 回调（D-12）。soft limit 通知由 lifecycle 函数 consume 后查 isSoftLimitReached() 发出。

### ConcurrencyGate（T8）

| Method | 签名 | 说明 | Spec Ref |
|--------|------|------|----------|
| enqueue | (opts: AgentCallOpts, signal?) → Promise<AgentResult> | FIFO；signal abort 传播 | FR-7 |
| activeCount / queueLength | getter → number | — | — |

maxConcurrency=4（D-13）。无 setBudget / maybeEmitSoftWarning。

### WorkerHandle（T9）

| Method | 签名 | 说明 | Spec Ref |
|--------|------|------|----------|
| postMessage | (msg) → void | — | — |
| terminate | () → Promise<void> | 幂等；置 isCurrent=false | — |
| isCurrent | getter → boolean | terminate 后 false（竞态防护 G-025） | AC-3 |

### Engine free functions

| Function（文件） | 签名 | Spec Ref |
|------------------|------|----------|
| runWorkflow (T21 lifecycle.ts) | (spec: RunSpec, deps: LifecycleDeps, signal?) → Promise<runId> | UC-1 |
| runAndWait (T22 launcher.ts) | (name, args, deps, signal?, timeoutMs?) → Promise<{status:"done",reason,...}> | AC-4, UC-2 |
| executeAgentCall (T18) | (call, runner, budget, signal, trace) → Promise<void> | AC-5 |
| retryNode (T20 node-ops.ts) | (runId, callId, deps) → Promise<void>；前置 status==="running" | G6-001 |

---

## Spec Coverage Matrix

| Spec AC | 覆盖点 | Task |
|---------|--------|------|
| AC-1 架构合规（三层向下依赖） | 全部 port interface + factory | T2(ports) + 全 Wave |
| AC-1 Engine 不依赖 @mariozechner | engine/*.ts 无 Pi import | T1-T22 |
| AC-1 无循环依赖 | OrchestratorCore 删除 | T29 |
| AC-2 重复消除（terminateDeps 全形态） | RunRuntime.release(mode) | T15, T29 |
| AC-2 4 个 Context factory 消失 | Engine 函数直接持 model | T18-T22, T29 |
| AC-2 OrchestratorCore 消失 | core.ts 删除 | T29 |
| AC-2 boolean flag 消失 | RunRuntime.release(mode) | T15, T29 |
| AC-3 RunRuntime 字段封装 | WorkflowRun.assign/release/replaceRuntime | T16 |
| AC-3 WorkflowScript 操作收敛 | WorkflowScript.validate/toExecutable | T6 |
| AC-3 WorkerHandle 竞态防护 | WorkerHandle.isCurrent | T9 |
| AC-4 脚本格式不变 | worker-script-builder | T11 |
| AC-4 pi.__workflowRun 签名 | runAndWait → {status:"done",reason,...} | T22, T28 |
| AC-4 gate caller 同步改 5 处 status→reason | review-gate / test-fix-loop | T32, T33 |
| AC-5 旧测试全部重写 | engine/models/__tests__ 不 mock Pi | T30, T31 |
| AC-5 跨 session pause/resume | WorkflowRun + RunRuntime + callCache | T16, T21, T31 |
| AC-6 typecheck 零错误 | pnpm --filter @zhushanwen/pi-workflow typecheck | 每个 Wave gate |
| AC-6 lint 零错误 | pnpm --filter @zhushanwen/pi-workflow lint | 每个 Wave gate |

---

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| FR-1: 8 个核心模型（Engine 层） | adopted | T1-T7, T15, T16 |
| FR-2: 三层架构（D-12） | adopted | T1-T28 |
| FR-3: 状态机 8→3 态+doneReason | adopted | T16 |
| FR-4: dependency 收敛为 3 port | adopted | T2 |
| FR-5: tool 收口 4→2 | adopted | T24, T25 |
| FR-6: command 收口仅 /workflows | adopted | T27 |
| FR-7: ConcurrencyGate 重命名，maxConcurrency=4（D-13） | adopted | T8 |
| AC-1: 架构合规（三层） | adopted | 全 Wave |
| AC-2: 重复消除 | adopted | T15, T29 |
| AC-3: 模型封装 | adopted | T6, T9, T16 |
| AC-4: 外部契约保持（含 5 处 status→reason） | adopted | T11, T22, T32, T33 |
| AC-5: 测试重写 | adopted | T30, T31 |
| AC-6: 类型检查零容忍 | adopted | 每 Wave gate |
| D-1~D-13 决策 | adopted | 见 domain-models.md 各节 + clarification.md |

---

## 验证检查点

每个 Wave 结束时执行：

```bash
pnpm --filter @zhushanwen/pi-workflow typecheck
pnpm --filter @zhushanwen/pi-workflow lint
pnpm --filter @zhushanwen/pi-workflow test
```

**W5 完成后（旧代码删除后）的最终验证：**

```bash
# 全量
pnpm -r typecheck
pnpm -r lint
pnpm -r test

# AC-1/2/3/4 grep 验证
grep -rnE "from ['\"]@mariozechner" extensions/workflow/src/engine/           # 应无输出
grep -rn "OrchestratorCore" extensions/workflow/src/                          # 应无输出
grep -rn "terminateDeps" extensions/workflow/src/                             # 应无输出
grep -rn "wfResult\.status\|status: string" extensions/coding-workflow/lib/gates/  # 应无输出

# 手动验证
# 1. 启动 Pi，运行简单 workflow 脚本，确认 agent()/parallel()/pipeline() 正常
# 2. pause → resume 跨 session 恢复
# 3. abort 清理
# 4. /workflows 面板正常显示（无 restart 快捷键）
# 5. pi.__workflowRun 被 coding-workflow gate 正常调用（reason 字段消费正常）
```
