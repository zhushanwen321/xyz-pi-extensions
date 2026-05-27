---
review:
  type: code_review
  round: 2
  timestamp: "2026-05-25T16:00:00"
  target: "workflow/src/ 下 3 个文件：worker-script.ts, index.ts, orchestrator.ts"
  verdict: pass
  summary: "增量审查完成，6 条 MUST_FIX 全部已验证修复，无新增 MUST_FIX"

statistics:
  total_issues: 6
  must_fix: 0
  must_fix_resolved: 6
  low: 0
  info: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "workflow/src/worker-script.ts:41-93"
    title: "$ARGS/$WORKSPACE/$BUDGET 未注入为 Worker 全局变量，FR1.3 违规"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    verification: "buildWorkerScript 生成的 script source 顶部声明了 const $ARGS、const $WORKSPACE、const $BUDGET，分别从 workerData.args/workspace/budget 读取，带 null-safety 兜底。已验证 worker-script.ts:85-87"
  - id: 2
    severity: MUST_FIX
    location: "workflow/src/index.ts:78-99"
    title: "跨会话恢复 (FR4.5) 数据路径错位 — reconstructState 读了错误的数据源"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    verification: "reconstructState 当前遍历 getBranch() entries，过滤 entry.type === 'custom' 且 customType === ENTRY_TYPE ('workflow-state')，从 custom 数据源读取并 deserializeState。write path 是 pi.appendEntry(ENTRY_TYPE, ...)，读写路径一致。已验证 index.ts:80-98"
  - id: 3
    severity: MUST_FIX
    location: "workflow/src/index.ts:141-147"
    title: "session_shutdown 未自动暂停运行中的 workflow (FR6.4)"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    verification: "session_shutdown handler 在清理 sessionStates/orchestrators 之前遍历 orch.list() 过滤 status === 'running' 的实例，对每个执行 orch.pause(inst.runId)。已验证 index.ts:155-163"
  - id: 4
    severity: MUST_FIX
    location: "workflow/src/worker-script.ts:73-82"
    title: "agent() 返回 StateAgentResult 对象而非 spec 约定的 extracted content"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    verification: "Worker 消息 handler resolve 时提取 msg.result.parsedOutput ?? msg.result.content（worker-script.ts:111），失败时 reject(new Error(msg.result.error))（worker-script.ts:110）。callCache 重放路径同样返回 cached.parsedOutput ?? cached.content（worker-script.ts:135），且 cached.error 时 throw new Error(cached.error)（worker-script.ts:133）。两条路径一致"
  - id: 5
    severity: MUST_FIX
    location: "workflow/src/orchestrator.ts:410-460"
    title: "Agent 调用自动重试 (FR7.1) 未实现 — 失败后直接传递给 Worker，无退避重试"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    verification: "executeWithRetry 方法已实现（orchestrator.ts:440-478），MAX_AGENT_RETRIES=3，RETRY_BACKOFF_MS=1000，指数退避 1s→2s→4s（pow(2, attempt-1)）。仅在 poolResult.success === false 且 attempt < MAX_AGENT_RETRIES 时重试。handleAgentCall 委托 executeWithRetry 而非直接 enqueue"
  - id: 6
    severity: MUST_FIX
    location: "workflow/src/orchestrator.ts:540-570"
    title: "90% 预算警告未实现 (FR8.2) — checkBudget 只在超限时处理，缺少独立 90% 阈值检查"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    verification: "checkBudget 在 exceeded 判断之后增加独立 90% 阈值检查（orchestrator.ts:501-508）：!exceeded && !b._budgetWarningSent && b.maxTokens !== undefined && b.usedTokens >= b.maxTokens * 0.9。命中时设置 b._budgetWarningSent = true（仅一次），发送 type:'budget-warning' 消息但不 terminate Worker。_budgetWarningSent? 字段已在 state.ts:48 的 WorkflowBudget interface 中定义"
---

# 增量审查 v2

## 验证方法

逐条审查 code_review_v1.md 指出的 6 条 MUST_FIX，阅读当前源代码确认修复是否到位。

## 逐条验证结果

### Issue 1 — $ARGS/$WORKSPACE/$BUDGET 注入

**文件**：`worker-script.ts:85-87`

```typescript
"const $ARGS = (workerData.args && typeof workerData.args === 'object') ? workerData.args : {};",
"const $WORKSPACE = typeof workerData.workspace === 'string' ? workerData.workspace : '';",
"const $BUDGET = (workerData.budget && typeof workerData.budget === 'object') ? workerData.budget : {};",
```

三条全局变量均已注入，带类型守卫和空对象兜底。`$ARGS` 必须是 object，`$WORKSPACE` 必须是 string，`$BUDGET` 必须是 object。Worker 脚本可直接使用这些变量。

**状态**：✅ 已修复

---

### Issue 2 — 跨会话恢复数据路径错位

**文件**：`index.ts:80-98`

`reconstructState` 当前逻辑：
1. 遍历 `ctx.sessionManager.getBranch()` 所有 entries
2. 过滤 `entry.type === "custom"` 且 `(entry as any).customType === ENTRY_TYPE`（`ENTRY_TYPE` = `"workflow-state"`）
3. 从 `entry.data` 调用 `deserializeState()` 重建 instances map

Write path：`persistState()` → `pi.appendEntry(ENTRY_TYPE, serializeState(instances))`

**路径一致**：写 `workflow-state` custom entry → 读 `workflow-state` custom entry。不再依赖 tool result messages。

**状态**：✅ 已修复

---

### Issue 3 — session_shutdown 暂停运行中 workflow

**文件**：`index.ts:155-163`

```typescript
pi.on("session_shutdown", async () => {
    const sessionId = lastSessionId;
    const orch = orchestrators.get(sessionId);
    if (orch) {
      const running = orch.list().filter((s) => s.status === "running");
      for (const inst of running) {
        orch.pause(inst.runId);
      }
    }
    sessionStates.delete(sessionId);
    orchestrators.delete(sessionId);
  });
```

逐行执行：
1. 获取 session 对应的 orchestrator
2. `orch.list()` 获取所有 instances，过滤 `status === "running"`
3. 对每个 running instance 调用 `orch.pause()` → 设置 `pausedAt` + `transitionStatus("paused")` + terminate Worker + `persistState()`
4. 然后再清理 `sessionStates` 和 `orchestrators`

**状态**：✅ 已修复

---

### Issue 4 — agent() 返回值修复

**文件**：`worker-script.ts`

**主消息处理路径**（`worker-script.ts:109-113`）：
```typescript
if (msg.result && msg.result.error) {
    pending.reject(new Error(msg.result.error));
} else if (msg.result && typeof msg.result === "object") {
    pending.resolve(msg.result.parsedOutput ?? msg.result.content);
} else {
    pending.resolve(msg.result);
}
```
- 成功时 resolve `parsedOutput ?? content`
- 失败时 reject `Error(msg.result.error)`
- 兜底 resolve 原始值

**callCache 重放路径**（`worker-script.ts:131-136`）：
```typescript
if (_callCache.has(callId)) {
    const cached = _callCache.get(callId);
    if (cached && cached.error) {
      throw new Error(cached.error);
    }
    return cached.parsedOutput ?? cached.content;
  }
```
- 有 error 时 throw
- 成功时 return `parsedOutput ?? content`
- 两条路径行为一致

**状态**：✅ 已修复

---

### Issue 5 — Agent 调用自动重试

**文件**：`orchestrator.ts`

**新方法**：`executeWithRetry`（`orchestrator.ts:440-478`）

```typescript
private executeWithRetry(
    runId: string, callId: number, opts: AgentCallOpts,
    instance: WorkflowInstance, node: ExecutionTraceNode,
    attempt = 1,
  ): void {
    this.agentPool.enqueue(opts).then((poolResult) => {
      const result: StateAgentResult = { ... };
      if (!poolResult.success && attempt < MAX_AGENT_RETRIES) {
        const delay = RETRY_BACKOFF_MS * Math.pow(2, attempt - 1);
        setTimeout(() => {
          this.executeWithRetry(runId, callId, opts, instance, node, attempt + 1);
        }, delay);
        return;
      }
      // 最后一次尝试（不论成功/失败）后缓存结果 + 发送回 Worker
    });
  }
```

- `MAX_AGENT_RETRIES = 3`
- `RETRY_BACKOFF_MS = 1000`
- 指数退避：attempt 1→1s, attempt 2→2s, attempt 3→4s（`pow(2, attempt-1)`）
- `handleAgentCall` 不再直接 `enqueue`，而是委托 `executeWithRetry`

*注意：实际退避序列为 1s→2s→4s，与 v1 建议的 1s→3s→9s 不同，但指数退避语义一致且更符合标准实现。不影响功能。*

**状态**：✅ 已修复

---

### Issue 6 — 90% 预算警告

**文件**：`orchestrator.ts:497-508`（`checkBudget` 方法内）

```typescript
// Send warning at 90% threshold (only once)
if (!exceeded && !b._budgetWarningSent && b.maxTokens !== undefined && b.usedTokens >= b.maxTokens * 0.9) {
    b._budgetWarningSent = true;
    this.postMessage(runId, {
        type: "budget-warning",
        budget: b,
        reason: `Token budget warning: ${b.usedTokens} >= ${Math.floor(b.maxTokens * 0.9)} (90%)`,
    });
}
```

- **`_budgetWarningSent` 标志**：有，在 `state.ts:48` 的 `WorkflowBudget` interface 中定义为 `_budgetWarningSent?: boolean`
- **90% 阈值检查**：有，`b.usedTokens >= b.maxTokens * 0.9`
- **仅发送一次**：`!_budgetWarningSent` 检查 + 发送后 `_budgetWarningSent = true`
- **不 terminate Worker**：仅在 `!exceeded` 条件下触发，与 100% 超限的 terminate 分支独立

**状态**：✅ 已修复

---

## 结论

**verdict: pass** — 6 条 MUST_FIX 全部已修复，无新增 MUST_FIX 问题。

| # | 优先级 | 文件 | 问题 | 状态 |
|---|--------|------|------|------|
| 1 | MUST_FIX | worker-script.ts | $ARGS/$WORKSPACE/$BUDGET 未注入 | ✅ 已修复 |
| 2 | MUST_FIX | index.ts | 跨会话恢复数据路径错位 | ✅ 已修复 |
| 3 | MUST_FIX | index.ts | session_shutdown 未暂停 workflow | ✅ 已修复 |
| 4 | MUST_FIX | worker-script.ts | agent() 返回值/错误处理 | ✅ 已修复 |
| 5 | MUST_FIX | orchestrator.ts | Agent 重试未实现 | ✅ 已修复 |
| 6 | MUST_FIX | orchestrator.ts | 90% 预算警告未实现 | ✅ 已修复 |
