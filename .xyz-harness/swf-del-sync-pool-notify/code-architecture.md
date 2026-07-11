---
verdict: pass
upstream: system-architecture.md, issues.md, requirements.md
downstream: execution-plan.md
backfed_from: []
---

# T2 代码级设计：删sync + 并发池分层 + 通知合并

> 聚焦 T2 改造的代码级设计。上游：issues.md + system-architecture.md + requirements.md。
> 产出：code-architecture.md，供 execution-plan.md 拆 wave。

## 1. 工程目录

T2 改造涉及的模块（全部在 `extensions/subagents/src/` 下）：

| 模块（相对路径） | T2 改造 | 归属层 |
|-----------------|---------|--------|
| `runtime/subagent-service.ts` | 删 sync 分支、删 notifier 引用、改并发池调用为 depth | Execution |
| `core/concurrency-pool.ts` | 接口 acquire(depth) + 实现分层配额 max(1, maxConcurrent-depth) | Core |
| `runtime/execution/notifier.ts` | **整个文件删除** | Execution |
| `types.ts` | 删 SyncResponse、简化 ExecutionMode、简化 ExecutionHandle | Core |
| `tools/subagent-tool.ts` | 删 wait 参数 schema、删 description 中 sync 引用 | Interface |
| `tools/subagent-actions.ts` | 删 liftSync()、删 sync 返回分支、简化 startHandler | Interface |
| `tui/tool-render.ts` | 删 sync 渲染分支（syncResponse 消费点） | TUI |

## 2. API 契约

### 2.1 ConcurrencyPool 接口改造

**当前**（`core/concurrency-pool.ts` L25-30）：

```typescript
interface ConcurrencyPool {
  acquire(priority: number): Promise<void>;
  release(): void;
  readonly active: number;
}
```

**T2 改造后**（接口不变，SubagentService 内部计算有效配额，默认 maxConcurrent=6）：

```typescript
interface ConcurrencyPool {
  acquire(priority: number, effectiveMaxConcurrent?: number): Promise<void>;
  release(): void;
  readonly active: number;
  readonly maxConcurrent: number;  // 总配额（分层计算基准）
}
```

**SubagentService.runAndFinalize 改造**：

```typescript
// 当前
const pooled = record.mode === "background";
if (pooled) await this.pool.acquire(priority);

// T2 改造后（SubagentService 内部计算有效配额）
const pooled = record.mode === "background";
if (pooled) {
  const effectiveMaxConcurrent = Math.max(1, this.pool.maxConcurrent - record.depth);
  await this.pool.acquire(PRIORITY_BACKGROUND, effectiveMaxConcurrent);
}
```

**DefaultConcurrencyPool.acquire 改造**：

- 增加可选 `effectiveMaxConcurrent` 参数，覆盖实例级默认值
- 内部逻辑：`effective = effectiveMaxConcurrent ?? this._maxConcurrent`，然后 `if (this._active < effective)` 放行
- 保留 `QueueEntry.priority` 字段和优先级排序（PRIORITY_BACKGROUND=1000 仍在用）
- 默认 maxConcurrent=6（比原来 4 更大，支持更多并行 step）

### 2.2 SubagentService.runAndFinalize 改造

**当前**（`runtime/subagent-service.ts` L489-493）：

```typescript
const pooled = record.mode === "background";
if (pooled) await this.pool.acquire(priority);
```

**T2 改造后**：

```typescript
const pooled = record.mode === "background";
if (pooled) {
  const effectiveMaxConcurrent = Math.max(1, this.pool.maxConcurrent - record.depth);
  await this.pool.acquire(PRIORITY_BACKGROUND, effectiveMaxConcurrent);
}
```

同时删除 L484-488 的 D-032 注释块（sync 不进池的理由已随 sync 删除而消失）。

### 2.3 pending:unregister 事件契约扩展

**当前**（`runtime/subagent-service.ts` L68-70 的 `emitPendingUnregister`）：

```typescript
emit("pending:unregister", { id, reason })
```

**T2 改造后**：

```typescript
emit("pending:unregister", {
  id,
  reason,
  result?: string,     // 新增：subagent 完成结果
  error?: string,      // 新增：错误信息
  patchFile?: string,  // 新增：worktree patch 路径
})
```

**改动点**：
- `emitPendingUnregister` 签名扩展，接收可选的 `result`/`error`/`patchFile`
- `finalizeRecord` 调用时透传 record.result / record.error / record.patchFile
- `cancelBackground` 调用时透传 cancelledResult 的 error

```typescript
// 改造后 emitPendingUnregister
function emitPendingUnregister(
  pi: PiLike | null,
  id: string,
  reason: string,
  opts?: { result?: string; error?: string; patchFile?: string },
): void {
  pi?.events.emit("pending:unregister", {
    id,
    reason,
    ...(opts?.result !== undefined && { result: opts.result }),
    ...(opts?.error !== undefined && { error: opts.error }),
    ...(opts?.patchFile !== undefined && { patchFile: opts.patchFile }),
  });
}
```

### 2.4 pending-notifications 扩展消费契约

pending-notifications 扩展监听 `pending:unregister` 事件，当 payload 携带 `result`/`error`/`patchFile` 时，触发 sendMessage 到 LLM（替代 BgNotifier 的职责）。

## 3. 功能时序图

### 3.1 background 完成通知（T2 改造后）

```
SubagentService.runAndFinalize
  → result = await runSpawn(...)
  → status = result.success ? "done" : "failed"
  → tryTransition(record, status)
  → finalizeRecord(record, result, status)
    → completeRecord(record, result, status)
    → store.archive(record)
    → writeFinalized + cleanup + removeAliveMarker
    → emitPendingUnregister(pi, record.id, status, {
        result: record.result,
        error: record.error,
        patchFile: record.patchFile,
      })
  → pending-notifications 扩展消费事件
    → sendMessage({ customType, content, display:true })
    → pi.sendMessage({ triggerTurn:true, deliverAs:"followUp" })
```

### 3.2 并发池分层配额（T2 改造后）

```
SubagentService.execute (depth=1, fork 子 agent)
  → createRecordForMode → record.depth = parentDepth + 1 = 1
  → kickOffBackground → runAndFinalize
    → pool.acquire(1)  // depth=1
      → effective = Math.max(1, 6 - 1) = 5
      → _active(2) < 3 → 放行
    → runSpawn(...)
    → pool.release()
```

## 4. 删除清单

### 4.1 subagent-service.ts

| 行号 | 删除内容 | 理由 |
|------|---------|------|
| L97 | `const PRIORITY_SYNC = 0` | sync 删除后不需要 |
| L335 | `const priority = mode === "background" ? PRIORITY_BACKGROUND : PRIORITY_SYNC` | 简化为 PRIORITY_BACKGROUND 常量 |
| L338-355 | `if (mode === "sync") { ... }` 整个 sync 分支 | 只保留 background |
| L405-413 | `resolveMode()` 函数 | 只保留 background，mode 固定为 "background" |
| L182 | `this.notifier = new BgNotifier(this.piAdapter())` | 删除 notifier.ts |
| L205 | `this.notifier.revive()` | 删除 notifier.ts |
| L233 | `this.notifier.flushPendingNotifications()` | 改用 emitPendingUnregister |
| L235 | `this.notifier.dispose()` | 删除 notifier.ts |
| L741-743 | `notifyComplete()` 方法 + `toNotifyRecord()` 方法 | 改用 pending:unregister |
| L576 | `this.notifyComplete(record)` in kickOffBackground | 改用 pending:unregister（finalizeRecord 已 emit） |
| L636 | `this.notifyComplete(record)` in cancelBackground | 改用 pending:unregister |
| L484-488 | D-032「sync 不进池」注释块 | sync 删除后不需要 |

**新增 import**：删除 `BgNotifier`、`BgNotifyRecord`、`NotifierHost` 的 import。

**改造 execute()**：
- 删除 mode 判定逻辑（`this.resolveMode(opts)`），mode 固定 `"background"`
- 删除 `const mode = this.resolveMode(opts)`，改为 `const mode: ExecutionMode = "background"`
- 删除 signal/priority 分叉（L331-335），signal 固定 `record.controller!.signal`
- 删除 buildEarlyFailedHandle 的 sync 变体（L477-479），只保留 background 变体

### 4.2 types.ts

| 行号 | 删除内容 | 理由 |
|------|---------|------|
| L37 | `ExecutionMode = "sync" \| "background"` | 改为 `type ExecutionMode = "background"` |
| L460-462 | `SyncResponse extends SubagentToolDetails` 接口 | sync 模式删除 |
| L500 | `SubagentToolResult` union 的 syncResponse 成员 | sync 模式删除 |

**改造 ExecutionHandle**（L446-448）：
```typescript
// 当前
export type ExecutionHandle =
  | { mode: "sync"; record: RecordSnapshot; details: SubagentToolDetails }
  | { mode: "background"; subagentId: string; sessionFile: string | undefined; details: SubagentToolDetails };

// T2 改造后
export type ExecutionHandle = {
  mode: "background";
  subagentId: string;
  sessionFile: string | undefined;
  details: SubagentToolDetails;
};
```

**改造 SubagentToolResult**（L499-502）：
```typescript
// 当前
export type SubagentToolResult =
  | { action: "start"; subagentId: string | null; sessionFile: string | null; syncResponse: SyncResponse }
  | { action: "start"; subagentId: string | null; sessionFile: string | null; bgResponse: BgResponse }
  | { action: "list"; subagentId: null; sessionFile: null; listResponse: ListResponse }
  | { action: "cancel"; subagentId: string; sessionFile: null; cancelResponse: CancelResponse };

// T2 改造后（删除 syncResponse 成员）
export type SubagentToolResult =
  | { action: "start"; subagentId: string; sessionFile: string | null; bgResponse: BgResponse }
  | { action: "list"; subagentId: null; sessionFile: null; listResponse: ListResponse }
  | { action: "cancel"; subagentId: string; sessionFile: null; cancelResponse: CancelResponse };
```

### 4.3 subagent-tool.ts

| 行号 | 删除内容 | 理由 |
|------|---------|------|
| startParam 中 | `wait` 参数 schema（`Type.Optional(Type.Boolean({...}))`) | handoff 用户决策：wait 参数彻底删除 |
| description 中 | sync 相关描述（`sync (wait:true, default)`、`sync subagents are cancelled via Esc`） | 只保留 background |

**StartParam interface**（L119-132）：删除 `wait?: boolean` 字段。

### 4.4 subagent-actions.ts

| 行号 | 删除内容 | 理由 |
|------|---------|------|
| L121-133 | `liftSync()` 函数 | sync 模式删除 |
| L65 | `StartHandlerResult` 的 `kind: "sync"` 变体 | sync 模式删除 |
| L166-176 | `startHandler` 中 `onUpdate` 的 `liftSync` 包装 | sync 模式删除 |
| L191-199 | `startHandler` 中 sync 完成分支 | 只保留 background |

**简化 startHandler**：
```typescript
// T2 改造后 startHandler 返回类型
export type StartHandlerResult = {
  kind: "bg";
  subagentId: string;
  sessionFile: string | undefined;
  response: BgResponse;
};

// startHandler 内部：删除 onUpdate 包装、删除 sync 返回分支
// handle.mode 固定为 "background"，直接返回 bg 变体
```

### 4.5 tool-render.ts

| 行号 | 删除内容 | 理由 |
|------|---------|------|
| L28 | `SyncResponse` import | sync 渲染分支删除 |
| L220-246 | compact 模式 syncResponse 分支 | sync 模式删除 |
| L278-290 | expanded 模式 syncResponse 分支 | sync 模式删除 |
| L303 | `syncResponse` in d 判断 | sync 模式删除 |
| L352-396 | `buildStatusLineFromSync` 函数 | sync 模式删除 |
| L398-433 | `buildDeliveryLineFromSync` 函数 | sync 模式删除 |

### 4.6 notifier.ts

**整个文件删除**（`runtime/execution/notifier.ts`，~200 行）。

## 5. 改造关联图

```
┌─────────────────────────────────────────────────────────┐
│                    Interface 层                          │
│  subagent-tool.ts ──删 wait schema──→ 只有 action 参数   │
│  subagent-actions.ts ──删 liftSync──→ 只有 bg 路径       │
│  tool-render.ts ──删 sync 渲染──→ 只有 bgResponse 渲染   │
└──────────────────────┬──────────────────────────────────┘
                       │ execute
                       ▼
┌─────────────────────────────────────────────────────────┐
│                    Execution 层                          │
│  subagent-service.ts                                    │
│    ├─ 删 resolveMode() → mode 固定 "background"         │
│    ├─ 删 execute() sync 分支                            │
│    ├─ 删 notifier 引用 + notifyComplete + toNotifyRecord │
│    ├─ 分层配额: pool.acquire(PRIORITY, effectiveMax)    │
│    └─ emitPendingUnregister 扩展 payload                │
│                                                         │
│  notifier.ts ────────── 整个文件删除                      │
└──────────────────────┬──────────────────────────────────┘
                       │ pool.acquire(priority, effectiveMaxConcurrent)
                       ▼
┌─────────────────────────────────────────────────────────┐
│                      Core 层                             │
│  concurrency-pool.ts                                    │
│    ├─ acquire(priority, effectiveMaxConcurrent?)         │
│    ├─ 有效配额 = max(1, maxConcurrent - depth)           │
│    ├─ 默认 maxConcurrent=6                               │
│    └─ 保留 priority 排序（PRIORITY_BACKGROUND=1000）      │
│                                                         │
│  types.ts                                               │
│    ├─ ExecutionMode = "background"                       │
│    ├─ 删除 SyncResponse                                  │
│    └─ ExecutionHandle 只保留 background 变体              │
└─────────────────────────────────────────────────────────┘
```

## 6. 测试矩阵（Test Matrix）

### 6.1 回归测试

- 删除 sync 后，现有 background 测试全绿
- 删除 notifier.ts 后，现有通知测试被移除或改为 EventBus

### 6.2 新增测试

**来源 A（功能用例）：**

| 用例 ID | 测试 | 覆盖点 | 测试层 | 文件 |
|---------|------|---------|--------|------|
| T-A1 | 分层配额 - 顶层 | depth=0 时可用配额 = maxConcurrent | unit | `core/__tests__/concurrency-pool.test.ts` |
| T-A2 | 分层配额 - 嵌套 | depth=N 时可用配额 = max(1, maxConcurrent-N) | unit | `core/__tests__/concurrency-pool.test.ts` |
| T-A3 | 分层配额 - 保底 | depth >= maxConcurrent 时保底 1 槽位 | unit | `core/__tests__/concurrency-pool.test.ts` |
| T-A4 | 分层配额 - FIFO | 删除 priority 后纯 FIFO 出队 | unit | `core/__tests__/concurrency-pool.test.ts` |
| T-A5 | bg 完成 - done | result.success=true → status=done → emitPendingUnregister(reason, result, patchFile) | integration | `runtime/__tests__/subagent-service.test.ts` |
| T-A6 | bg 完成 - failed | result.success=false → status=failed → emitPendingUnregister(reason, error) | integration | `runtime/__tests__/subagent-service.test.ts` |
| T-A7 | bg 完成 - cancelled | signal.aborted=true → status=cancelled（runAndFinalize 内） | integration | `runtime/__tests__/subagent-service.test.ts` |
| T-A8 | CAS 抢锁 - cancel 抢先 | cancel 先设 cancelled → runAndFinalize 的 tryTransition 返回 false → 跳过 finalize | integration | `runtime/__tests__/subagent-service.test.ts` |
| T-A9 | 通知合并 - pending:unregister | background 完成后触发事件 + payload 含 result/error/patchFile | integration | `runtime/__tests__/subagent-service.test.ts` |
| T-A10 | sync 删除 - wait 参数删除 | tool schema 不含 wait 字段 | unit | `tools/__tests__/subagent-tool.test.ts` |
| T-A11 | sync 删除 - mode 固定 | execute 返回 mode="background" | unit | `runtime/__tests__/subagent-service.test.ts` |

**来源 B（NFR 风险→用例映射）：**

| 用例ID | 来源NFR | 测试 | 覆盖点 | 测试层 | 文件 |
|--------|---------|------|---------|--------|------|
| T-NFR-1 | M-4 | 分层配额 debug 日志 | acquire 入口记录 depth/effectiveMaxConcurrent/queueLength | unit | `core/__tests__/concurrency-pool.test.ts` |
| T-NFR-2 | M-5 | 保底 1 槽位单测 | depth >= maxConcurrent 场景不饿死 | unit | `core/__tests__/concurrency-pool.test.ts` |
| T-NFR-3 | M-6 | 排队超时 warn 日志 | 队列等待 > 5s 时输出 warn | unit | `core/__tests__/concurrency-pool.test.ts` |
| T-NFR-4 | M-7 | emitPendingUnregister payload 扩展 | payload 含 result/error/patchFile 字段 | integration | `runtime/__tests__/subagent-service.test.ts` |
| T-NFR-5 | M-9 | pending-notifications 容忍额外字段 | 旧消费方忽略新字段不报错 | integration | `runtime/__tests__/subagent-service.test.ts` |
| T-NFR-6 | M-10 | 终态路径 emit 事件与 completeRecord 同步 | 状态转换同步更新两侧 | integration | `runtime/__tests__/subagent-service.test.ts` |
| T-NFR-7 | M-11 | 事件 emit 不走异步回调 | 避免竞态窗口 | integration | `runtime/__tests__/subagent-service.test.ts` |
| T-NFR-8 | M-12 | dispose() 路径终态化时 emit 事件 | 进程退出时两侧一致 | integration | `runtime/__tests__/subagent-service.test.ts` |
| T-NFR-9 | M-13 | finalizeRecord 入口 debug 日志 | recordId/status 输出正确 | unit | `runtime/__tests__/subagent-service.test.ts` |
