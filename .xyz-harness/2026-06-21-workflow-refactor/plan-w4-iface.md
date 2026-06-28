# Wave 4: Interface 收口 + factory 切换 — T23-T28

2 个收口 tool + helpers + view 适配 + command 瘦身 + factory 重写。**T28 是新旧切换点**。

**关键差异（vs 旧四层 plan，D-11/D-12）**：
- 无 ApprovalPolicy class → 降为 T23 `confirmTmp/requiresConfirmation` helper
- 无 NotificationService class → 降为 T23 `notifyDone` helper

**Wave 完成检查：**
```bash
ls extensions/workflow/src/interface/{helpers,tool-workflow,tool-workflow-script}.ts
pnpm --filter @zhushanwen/pi-workflow typecheck   # 新 index.ts 不引用旧 orchestrator
pnpm --filter @zhushanwen/pi-workflow test
# 冒烟测试: 启动 Pi，运行简单 workflow 脚本，确认 agent()/parallel()/pipeline() + /workflows 面板正常
```

---

### T23 — interface/helpers.ts

- **依赖:** T16（WorkflowRun）
- **动作:** create `interface/helpers.ts`
- **参考源:** 旧 `interface/commands.ts` 的 sendCompletionNotification（_render descriptor + sendUserMessage）+ domain-models.md（ApprovalPolicy 降级）
- **关键改动（D-11/D-12 简化）:**
  - `requiresConfirmation(script, approved: Set<string>): boolean` — tmp 或未批准返回 true（**D-11: ApprovalPolicy 降为 2 行 helper**）
  - `recordApproval(name, pi): Promise<void>` — appendEntry("workflow-approval-memory", ...)
  - `notifyDone(pi, runId, run, notifiedRunIds: Set<string>): void` — 去重 + sendUserMessage（**D-12: NotificationService 降为 helper**）
  - import `ExtensionAPI` 用顶部 import（非 inline）
- **验收:** typecheck PASS（无独立测试，被 T25/T27 覆盖）
- **风险:** 低

---

### T24 — interface/tool-workflow-script.ts（合并 tool-generate + tool-workflow-lint）

- **依赖:** T6（registry）, T17（lintScript）
- **动作:** create `interface/tool-workflow-script.ts` + `interface/__tests__/tool-workflow-script.test.ts`
- **参考源:** 旧 `interface/tool-generate.ts`（182 行）+ 旧 `interface/tool-workflow-lint.ts`（91 行）
- **关键改动:**
  - 1 个 tool，**5 actions**: generate/lint/save/delete/list
  - typebox `Type.Object` + `StringEnum` schema
  - generate: 隐式契约（tool_call 自动注入 workflow-script-format SKILL.md），AI 生成脚本源码
  - lint: 调 `lintScript(args.source)`
  - save/delete/list: 调 registry
  - delete 前查 isRunning（防止删运行中脚本）
  - import registry/lintScript 用顶部 import（D.7）
- **验收:** `test -- tool-workflow-script` PASS（5 actions 路由）
- **风险:** 中（合并 2 个旧 tool 的参数 schema）

---

### T25 — interface/tool-workflow.ts（合并 tool-workflow + tool-workflow-run）

- **依赖:** T2（LifecycleDeps）, T6（registry）, T20（node-ops）, T21（lifecycle 函数）, T23（helpers）
- **动作:** create `interface/tool-workflow.ts` + `interface/__tests__/tool-workflow.test.ts`
- **参考源:** 旧 `interface/tool-workflow.ts`（323 行）+ 旧 `interface/tool-workflow-run.ts`（182 行）
- **关键改动:**
  - 1 个 tool，**7 actions**: run/status/pause/resume/abort/retry-node/skip-node
  - **restart 不包含**（D-9 废弃）
  - run: registry.get → requiresConfirmation(T23) → RPC 降级 sendUserMessage 确认 → recordApproval → runWorkflow
  - pause/resume/abort: 调 T21 lifecycle 函数
  - retry-node/skip-node: 调 T20 node-ops
  - status: 列出 runs
  - reentry-guard 共享对象（与 T24 tool 共用 `guard.isProcessing`）
  - import 用顶部 import（D.7: registry/LifecycleDeps 等）
- **验收:** `test -- tool-workflow` PASS（7 actions + reentry-guard + 确认流程）
- **风险:** 中（合并 2 个旧 tool + 确认流程 RPC 降级）

---

### T26 — interface/views/workflows-view.ts（适配）

- **依赖:** T16（WorkflowRun）
- **动作:** modify `interface/views/WorkflowsView.ts`（适配新 Engine 模型）；rename 为 `workflows-view.ts`（统一命名）
- **参考源:** 现有 `interface/views/WorkflowsView.ts`（891 行）
- **关键改动:**
  - `WorkflowInstance` → `WorkflowRun`（读 `run.state.status` / `run.state.trace.toArray()` 等）
  - **移除 restart 快捷键**（D-9，'r' 键绑定删除）
  - 保留三级导航 + 现有快捷键集（除 'r'）
  - 保留 _render descriptor 产出
- **验收:** `test -- workflows-view`（旧测试此 wave 暂不重写，W5 T31 重写；此 task 先确保 typecheck 过）
- **风险:** 中（891 行大文件适配，逐处改 WorkflowInstance→WorkflowRun）

---

### T27 — interface/commands.ts（瘦身）

- **依赖:** T23（notifyDone helper）
- **动作:** modify `interface/commands.ts`
- **参考源:** 现有 `interface/commands.ts`（491 行）
- **关键改动:**
  - **移除** `/workflow run|list|abort|save|delete`（FR-6）
  - 仅保留 `/workflows` 打开 WorkflowsView
  - `sendCompletionNotification` 逻辑移到 T23 helpers，commands.ts 不再持有
- **验收:** typecheck PASS + grep `/workflow run` 等子命令无残留
- **风险:** 低

---

### T28 — index.ts factory 重写（★切换点）

- **依赖:** W3 全部（T17-T22）, T24, T25, T27
- **动作:** modify `index.ts`（重写，193 行）
- **参考源:** 现有 `index.ts` + 各 wave 产出
- **关键改动:**
  - **删除** `new WorkflowOrchestrator(pi, ctx)` + `orchestrators Map`
  - 用 Infra 实例 + `runs Map<string, WorkflowRun>` + Engine free functions
  - Infra 注入: `JsonlRunStore`(T13) / `WorkerHostImpl`(T12) / `SubprocessAgentRunner`(T10) / `WorkflowScriptRegistryImpl`(T14)
  - `deps: LifecycleDeps = { store, workerHost, runner, runs }`
  - `session_start`: 重建 sessionApprovals（读 entries）+ D-5 store.loadAll 重建 runs + D-4 kill-9 残留 running→failed
  - **`pi.__workflowRun`**（D-8 新签名）: 调 `runAndWait(name, args, {...deps, registry}, signal, timeoutMs)`
  - `declare module` 扩展 `__workflowRun` 类型为新签名
  - 注册 2 个 tool（T24/T25）+ /workflows command（T27）
  - `session_tree`: 切分支前强制 pause 所有 running run（隐式契约保留）
  - `session_shutdown`: pause 所有 running + 清理 temp files（从旧 orchestrator.cleanupAllTempFiles 迁移）
- **验收:**
  - `typecheck` PASS（新 index.ts 不引用旧 orchestrator.ts，旧代码成死代码）
  - **手动冒烟**: 启动 Pi → 运行简单 workflow 脚本 → 确认 agent() 正常 + /workflows 面板 + pause/resume/abort
- **风险:** **高**（切换点，全链路首次连通；冒烟测试必须过）
- **注意:** 完成后旧代码（orchestrator.ts / engine/core.ts / *.legacy.ts / domain/ 等）成死代码，W5 T29 删除
