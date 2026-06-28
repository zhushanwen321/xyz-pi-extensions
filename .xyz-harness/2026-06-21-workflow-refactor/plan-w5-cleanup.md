# Wave 5: 清理 + 外部 caller — T29-T33

收尾：删旧码 + 重写测试 + 更新 coding-workflow 的 2 个 gate caller。依赖 W4 T28 完成（factory 切换后旧代码成死代码）。

**关键**：T29→T30/T31 必须紧挨（删源后 index.test/workflows-view.test 编译失败，T30/T31 紧跟修复）。T32/T33 全程可并行（独立于 workflow 内部）。

**Wave 完成检查（最终验收）：**
```bash
pnpm -r typecheck   # 全量零错误
pnpm -r lint
pnpm -r test

# AC-1/2/3/4 grep
grep -rnE "from ['\"]@mariozechner" extensions/workflow/src/engine/           # 无输出
grep -rn "OrchestratorCore" extensions/workflow/src/                          # 无输出
grep -rn "terminateDeps" extensions/workflow/src/                             # 无输出
grep -rn "errorHandlerContext\|agentCallContext\|budgetCallbacks" extensions/workflow/src/  # 无输出
grep -rn "cleanupWorker\|keepController\|cleanupTempFiles\|deletePool" extensions/workflow/src/  # 无输出
grep -rn "wfResult\.status\|status: string" extensions/coding-workflow/lib/gates/  # 无输出
```

---

### T29 — 删除旧代码 + 过时测试

- **依赖:** T28（factory 切换后旧代码成死代码）
- **动作:** delete 旧源文件 + 过时测试（机械，单 subagent）
- **删除清单（源）:**
  ```
  engine/core.ts                          # OrchestratorCore
  engine/lifecycle.legacy.ts              # T21 重命名的旧 lifecycle
  engine/worker-manager.ts                # 拆到 T9/T12
  engine/agent-call-handler.ts            # 拆到 T5/T18
  engine/error-handlers.ts                # → T19
  engine/orchestrator-budget.ts           # → T3
  engine/orchestrator-events.ts           # 删除
  engine/terminate-instance.ts            # → T15 release
  engine/trace-commit.ts                  # → T4
  engine/worker-script.ts                 # → T11
  orchestrator.ts                         # God Facade
  domain/state.ts + domain/run-resources.ts  # 整 domain/ 目录
  infra/agent-pool.ts                     # → T8
  infra/pi-runner.ts                      # → T10
  infra/config-loader.ts + workflow-files.ts  # → T14
  infra/state-store.ts                    # → T13
  infra/script-lint.ts                    # → T17
  infra/execution-trace.ts                # → T4
  interface/tool-workflow-run.ts          # → T25
  interface/tool-generate.ts + tool-workflow-lint.ts  # → T24
  ```
- **删除清单（过时测试，源已删且无替代）:**
  ```
  __tests__/agent-pool.test.ts            # → concurrency-gate.test (T8)
  __tests__/commands-generate.test.ts     # tool-generate 删
  __tests__/config-loader.test.ts         # → registry-impl.test (T14)
  __tests__/orchestrator.test.ts          # → lifecycle/node-ops (T21/T20)
  __tests__/orchestrator-events.test.ts   # orchestrator-events 删
  __tests__/orchestrator-stale.test.ts    # → execute-agent-call.test (T18)
  __tests__/state.test.ts                 # → types/run-state/workflow-run (T1/T7/T16)
  __tests__/state-budget.test.ts          # → budget.test (T3)
  __tests__/state-machine.test.ts         # → workflow-run.test (T16)
  __tests__/state-store.test.ts           # → jsonl-run-store.test (T13)
  __tests__/tool-generate.test.ts         # → tool-workflow-script.test (T24)
  engine/__tests__/error-handlers.test.ts # → error-recovery.test (T19)
  engine/__tests__/orchestrator-budget.test.ts  # → budget.test (T3)
  engine/__tests__/terminate-instance.test.ts   # → run-runtime.test (T15)
  infra/__tests__/workflow-files.test.ts        # → registry-impl.test (T14)
  ```
- **保留:** `__tests__/agent-discovery.test.ts` + `__tests__/jsonl-parser.test.ts`（源未删，T14 保留）
- **执行步骤:**
  1. 确认新代码不引用旧文件：`grep -rn "from ['\"].*\(/orchestrator\|/engine/core\|/engine/worker-manager\|/engine/agent-call-handler\|/engine/error-handlers\|/engine/orchestrator-budget\|/engine/orchestrator-events\|/engine/terminate-instance\|/engine/trace-commit\|/engine/worker-script\|/domain/state\|/domain/run-resources\|lifecycle\.legacy\)" extensions/workflow/src/ | grep -v "engine/models\|engine/lifecycle\|engine/error-recovery\|engine/node-ops\|engine/launcher\|engine/script-lint\|engine/execute-agent-call"` → 应无输出
  2. 逐个 `rm` 上述文件
  3. AC-1/2 grep 验证（OrchestratorCore/terminateDeps 等无残留）
- **验收:** grep 无残留 + typecheck（此时 index.test/workflows-view.test 会报错，**预期**，T30/T31 修复）
- **风险:** 中（漏删孤儿引用 → typecheck 报错；grep 步骤 1 兜底）

---

### T30 — 重写 index.test.ts

- **依赖:** T28, T29
- **动作:** rewrite `__tests__/index.test.ts`
- **参考源:** 旧 `__tests__/index.test.ts` + T28 新 factory
- **关键改动:**
  - 不再 mock WorkflowOrchestrator，改 mock Engine free functions + Infra 实现
  - 覆盖: session_start 重建 sessionApprovals + D-5 旧格式返回空 + D-4 kill-9 残留 running→failed + pi.__workflowRun 新签名(status:"done"+reason) + reentry-guard(2 tool 共享) + tmp workflow 不持久化
- **验收:** `test -- index` PASS + typecheck 0 errors（index.test 修复）
- **风险:** 中（mock 策略从 Orchestrator 改为 free functions）

---

### T31 — 重写 workflows-view.test.ts + 集成测试

- **依赖:** T26, T29
- **动作:** rewrite `__tests__/workflows-view.test.ts`；create `__tests__/pause-resume-integration.test.ts`
- **参考源:** 旧 `__tests__/workflows-view.test.ts` + T26 新 view + e2e-test-plan.md
- **关键改动:**
  - workflows-view.test 适配 WorkflowRun（不再 WorkflowInstance）+ 无 restart 快捷键
  - **集成测试**（domain-models.md §测试不变式清单 + e2e-test-plan）:
    - pause 后 callCache 保留（RunState.calls），resume 时 replay，不重复执行
    - abort 清理 worker + temp files（runtime=undefined）
- **补 domain-models §测试不变式清单**（确认 W1-W3 已覆盖，本 task 补漏）:
  - [x] 状态机转换（workflow-run.test T16）
  - [x] Budget 阈值（budget.test T3）
  - [ ] cleanup-before-mutate 顺序（A4 原子性，lifecycle.test T21 — 确认存在）
  - [x] 跨 session pause/resume（本 task）
  - [x] stale-context 不重试（execute-agent-call.test T18）
  - [x] Worker error 3 次重试（error-recovery.test T19）
  - [x] Worker exit 竞态防护（worker-handle.test T9）
  - [ ] per-call timeoutMs 与外部 signal 合并（concurrency-gate.test T8 — 确认存在）
  - [x] trace append-only + update 单源（trace.test T4）
  - [x] retryNode 前置 running（node-ops.test T20）
- **验收:** `pnpm --filter @zhushanwen/pi-workflow test` 全 PASS + typecheck 0 errors
- **风险:** 中（跨 session 集成测试需 mock store + worker）

---

### T32 — 更新 coding-workflow review-gate.ts（5 处 status→reason）

- **依赖:** 无（全程可并行，独立于 workflow 内部）
- **动作:** modify `extensions/coding-workflow/lib/gates/review-gate.ts`
- **参考源:** 现有 review-gate.ts（5 处 `wfResult.status`）+ spec.md AC-4/D-8
- **关键改动（5 处）:**
  - `WorkflowRunFn` 返回类型: `{ status: string; ... }` → `{ status: "done"; reason: DoneReason; scriptResult?; error?; runId }`
  - `if (wfResult.status !== "completed" || wfResult.error)` → `if (wfResult.reason !== "completed" || wfResult.error)`
  - `fixGuidance: ...failed (status=${wfResult.status}):...` → `...(reason=${wfResult.reason}):...`
  - `details: { status: wfResult.status, ... }` → `{ reason: wfResult.reason, ... }`（2 处）
  - 本地定义 `type DoneReason = "completed" | "failed" | "aborted" | "budget_limited" | "time_limited"`
- **验收:** `pnpm --filter @zhushanwen/pi-coding-workflow typecheck` 0 errors + `grep -rn "wfResult\.status\|status: string" extensions/coding-workflow/lib/gates/review-gate.ts` 无输出
- **风险:** 中（诊断消息/details 若不同步改 reason，会退化为 status=done 常量，丢失失败原因区分；typecheck 抓不到这种语义退化）

---

### T33 — 更新 coding-workflow test-fix-loop.ts（5 处 status→reason）

- **依赖:** 无（全程可并行，与 T32 同构）
- **动作:** modify `extensions/coding-workflow/lib/gates/test-fix-loop.ts`
- **参考源:** 现有 test-fix-loop.ts（与 review-gate.ts 同构，5 处 `wfResult.status`）
- **关键改动:** 同 T32 的 5 处改动（行号近似）
- **验收:** `pnpm --filter @zhushanwen/pi-coding-workflow typecheck` 0 errors + grep 无残留
- **风险:** 中（同 T32）

---

## 最终验收（全 Wave 完成）

- [ ] `pnpm -r typecheck && pnpm -r lint && pnpm -r test` 全绿
- [ ] AC-1~AC-6 grep 全部无输出（见 Wave 完成检查）
- [ ] 手动验证 5 项: 简单脚本跑通 / pause-resume 跨 session / abort 清理 / /workflows 面板无 restart / pi.__workflowRun 被 gate 正常调用（reason 消费正常）
- [ ] 提交收尾: `git commit -m "chore(workflow): complete three-layer architecture refactor"`

重构完成。
