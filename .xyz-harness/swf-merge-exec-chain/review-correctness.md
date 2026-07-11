# Review: 业务逻辑正确性 + 类型安全 + 边界条件

**审查范围**: `76c0bf775...HEAD`（11 commits, 148 files, 30K+ lines）
**审查方式**: 3 个 subagent 并行审查（修改已有文件 / 业务逻辑+边界条件 / 类型安全+接口契约）
**日期**: 2026-07-10

## 汇总

| Category | Count |
|----------|-------|
| Must Fix | 3 |
| Should Fix | 10 |
| Nit | 3 |

---

## Must Fix（必修）

### MF-1: [subagent-service.ts:755] finalizeRecord 对 cancelled 状态也写 `.finalized`，重建时丢失 cancelled 状态

**文件**: `extensions/subagents-workflow/src/execution/subagent-service.ts` (finalizeRecord, L709-L771)

`finalizeRecord` 的 Step 3（L755）无条件调用 `writeFinalized(record.sessionFile)`，`writeFinalized` 内部先 `rmSync('.cancelled')` 再写 `.finalized`。当 `runAndFinalize` CAS 抢到锁、result 是 cancelled 时，session 会拿到 `.finalized` sidecar 但丢失 `.cancelled` tombstone。

`reconstructFromFile`（session-reconstructor.ts）读到 `readFinalized → true`、`readCancelledTombstone → undefined`，会从 `stopReason` 推断为 `"done"` 或 `"failed"`，**永远不会恢复 `"cancelled"`**。

**对比**: `cancelBackground` 路径（CAS 先抢到锁）正确写 `writeCancelledTombstone`，从不调 `finalizeRecord`。bug 是 `finalizeRecord` 不分 status 一律写 `.finalized`。

**修复方向**（L755 附近）:

```typescript
if (record.sessionFile && status !== "cancelled") {
  writeFinalized(record.sessionFile);
}
if (record.sessionFile && status === "cancelled") {
  writeCancelledTombstone(record.sessionFile, {
    id: record.id, status: "cancelled", agent: record.agent,
    startedAt: record.startedAt, endedAt: record.endedAt ?? Date.now(),
  });
}
```

---

### MF-2: [session-runner.ts:647] 非 fork session 的 identity 条目 forkDepth 被无条件+1

**文件**: `extensions/subagents-workflow/src/execution/session-runner.ts` (L647)

```typescript
forkDepth: (opts.parentForkDepth ?? 0) + 1,
```

此行在 `opts.fork` 为 `false`/`undefined` 时（非 fork 子 agent）也执行，导致顶层非 fork 子 agent 的 `forkDepth` 显示为 `1`，`/subagents list` 误将其展示为 fork session depth 1。

对比同文件 `buildEnvBlock`（L470）正确处理了此情况:

```typescript
const ownForkDepth = opts.fork ? (opts.parentForkDepth ?? 0) + 1 : undefined;
```

**修复方向**:

```typescript
forkDepth: opts.fork ? (opts.parentForkDepth ?? 0) + 1 : undefined,
```

---

### MF-3: [execution-record.ts:748-757] `accumulateMessageEndForRecord` 中 `as AgentUsage` 不安全类型断言

**文件**: `extensions/subagents-workflow/src/execution/execution-record.ts` (L748-L757)

```typescript
const usageRaw = msg?.usage as Record<string, unknown> | undefined;
if (usageRaw) {
  const { cost: _costField, ...usageBase } = usageRaw;
  const usage: AgentUsage = {
    ...usageBase,        // unknown 字段直接展开到 number 类型接口
    cost: ...,
  } as AgentUsage;       // 不安全断言
}
```

**问题**:
1. `usageRaw` 可能是 truthy 非对象（`"usage": "hello"`），`if (usageRaw)` 通过，解构字符串产生 String wrapper 展开到 `AgentUsage`
2. `usageBase` 的 `input/output/cacheRead/cacheWrite` 是 `unknown`，但 `AgentUsage` 声明为 `number`。损坏的 JSONL 中非数字值会静默绕过类型契约
3. 这是 `addUsage()` 和 `updateFromEvent()` 中四处散落的 `?? 0` 防御性代码的根因

**修复方向**: 在解构前加 `typeof usageRaw === "object" && usageRaw !== null` guard，显式提取并强制转换每个数字字段（如 `input: typeof usageRaw.input === "number" ? usageRaw.input : 0`）

---

## Should Fix（建议）

### SF-1: [coding-workflow: review-gate.test.ts:213,229] gate.run() 双次调用，测试脆弱

`gate.run(ctx)` 在一个测试中调用两次（每个 `.rejects.toThrow()` 各调一次）。虽然 `resolveWorkflowRunFn` 是纯 throw 无副作用，但如果 `gate.run()` 未来加入计数或 session 写入，测试会静默偏离意图。只保留第一个 assertion（`/Install @zhushanwen\/pi-subagents-workflow/`）已能唯一标识错误。

---

### SF-2: [workflow: execute-agent-call.test.ts:174] `.toBe(200.2)` 浮点精确相等

`.toBe()` 在加权 token 计算结果上使用精确比较。权重可能未来调整产生舍入误差。改用 `.toBeCloseTo(200.2, 5)`。

---

### SF-3: [workflow: budget.test.ts:27] `.toBe(50.1)` 同上

---

### SF-4: [workflow: jsonl-run-store.test.ts:197] 缩进不一致

`expect(loaded!.state.budget.usedTokens).toBe(200)` 缩进了 4 空格，兄弟断言用 6 空格。补 2 空格对齐。

---

### SF-5: [session-runner.ts:330附近] spawnedChildren.add(child) 过早，后续 setup 失败导致孤儿进程泄漏

`spawnedChildren.add(child)` 在 `child.on("close")` / `child.on("error")` listener 注册前调用。中间有 `setEncoding`、signal listener、watchdog setTimeout 等同步操作。如果其中任一 throw，child 在 `spawnedChildren` 中但没有 close/error listener 来移除它，外层 `runAndFinalize` 的 catch 调 `finalizeFailed` 但不会 kill child。概率极低（`setEncoding` 在新鲜 pipe 上几乎不会 throw），属于防御性关注。修复: 把 `spawnedChildren.add(child)` 移到所有 setup 完成后，或 wrap setup 在 try-catch 中 kill child 并移除。

---

### SF-6: [subagent-service.ts:cancelBackground] sync subagent 无法被显式 cancel 杀死进程

`cancelBackground` 靠 `record.controller?.abort()` 杀子进程。sync subagent 的 `record.controller` 是 `undefined`（见 `createRecordForMode`），所以 cancel 只标记 record 为 `"cancelled"`（CAS），但从不发 SIGTERM。子进程继续运行，而 record 已归档、worktree 已清理、alive marker 已移除。修复: 在 tool 层阻止对 sync subagent 的 cancel（返回错误说明 sync subagent 通过父 tool abort 取消），或在 record 上存 `opts.signal` 供 `cancelBackground` 使用。

---

### SF-7: [subagent-service.ts:executeAndAwait ~L340] emitPendingRegister 成功后异常缺少 emitPendingUnregister

`executeAndAwait` 中 `emitPendingRegister` 成功后，到 `runAndFinalize` 之间的任何步骤（`buildSessionRunnerContext` 等）失败都不会调 `emitPendingUnregister`，留下僵尸 pending notification。概率极低（中间都是同步对象构造），但与 `execute` 方法的不对称（`execute` 有 `finalizeFailed → emitPendingUnregister`）是潜在 bug。修复: 在 `emitPendingRegister` 后的代码包 try/catch 调 `emitPendingUnregister`。

---

### SF-8: [execution-record.ts: updateFromEvent tool_end] `turn.toolCalls[i]!` 非空断言

索引来自同一数组同一次迭代，当前上下文中无中间修改，实际正确但脆弱。如果有人在此函数中插入对 `turn.toolCalls` 的修改代码，`!` 断言就变成真正的空指针解引用。改为让 `findRunningToolCall` 直接返回 `InternalToolCall` 引用而非索引。

---

### SF-9: [execution-record.ts: addUsage + updateFromEvent] required `number` 字段上的 `?? 0`

`AgentUsage.input/output/cacheRead/cacheWrite` 类型声明为 `number`（非可选），但 `addUsage` 和 `totalTokens` 累加器都在用 `(next.input ?? 0)`。这是对 MF-3 不安全断言的防御性补偿。修复 MF-3 后，要么把 `AgentUsage` 字段改为 `number | undefined`（反映 JSONL 实际），要么移除 `?? 0` guard。

---

### SF-10: [spawn-event-adapter.ts: parseSpawnLine] `obj as SdkEvent` duck-type 断言，验证不足

只验证了 `obj.type` 是 string，没有验证嵌套的 `message` 形状。如果 pi 产生的 JSONL 中 `message` 畸形为字符串，下游访问 `event.message.usage` 会抛异常。实际风险低（pi 自有 JSONL 输出），但类型断言缺乏结构校验是缺口。补充类型收窄 predicate 或验证 `message` 形状。

---

## Nit（细节）

### N-1: workflow 测试中混用中文注释（`加权`...），与周围英文注释风格不一致

---

### N-2: [session-file-gc.ts] catch 块中 `void _e` 完全静默错误

与 `best-effort.ts` 的 `console.debug` 不同，GC 的错误真正不可见。如果清理静默失败数月，孤儿文件积累无感知。考虑用 `bestEffort(err, "session-file-gc")` 代替 `void _e`。

---

### N-3: [record-store.ts] `STATUS_PRIORITY` 中 `failed` 和 `crashed` 同 priority=1

两个都是 terminal-with-error 状态，但 tiebreak 走 `startedAt desc`，意味着 30 秒前的 crashed record 排在 2 秒前的 failed record 前面。补充注释说明此设计选择。

---

## 未发现问题

- **`any` 使用**: 9 个核心执行文件零 `any` 使用，所有 `unknown` 使用恰当且已 guard
- **SDK handler 签名**: 执行层文件不是 extension entry point，不涉及 `pi.on`/`registerTool` 签名
- **schema/description 一致性**: 执行层不含 typebox schema 或 description 字符串
- **边界条件**: CAS 状态转换、pool acquire/release finally 块、pid 存活检测、best-effort I/O 模式均遵循既定约定
