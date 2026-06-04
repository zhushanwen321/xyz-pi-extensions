---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 5
  issues_found: 6
  must_fix_count: 0
  low_count: 3
  info_count: 3
---

# Robustness Review — workflow Phase 3

**Scope**: `git diff 5208e76..HEAD` (18 files, ~1555 LOC)
**Reviewer**: robustness-review subagent
**Date**: 2026-06-04

---

## Dimension 1: Error Handling

### L-1: `executeWithRetry` uses fire-and-forget `.then()` — unhandled rejection risk

**File**: `orchestrator.ts:535`

```typescript
this.agentPool.enqueue(opts).then(async (poolResult) => {
  // ... await checkBudget, persistState ...
});
```

`.then()` without `.catch()` creates an unhandled rejection if the async callback throws (e.g., `persistState` fails on a full disk). The `enqueue()` promise itself never rejects (per contract), but the `.then(async ...)` callback contains `await this.persistState()` which can throw.

**Severity**: Low. In practice `persistState` writes to `~/.pi/agent/workflow-state/` and errors are unlikely, but the pattern violates the "no unhandled rejections" principle. A single `.catch(() => { /* log */ })` would eliminate the risk.

**Status**: Acceptable for current scope. Not a blocker.

### L-2: `index.ts:338` — orchestrator async methods called without `await`

**File**: `index.ts:338-340`

```typescript
if (action === "pause") orch.pause(runId);
else if (action === "resume") orch.resume(runId);
else orch.abort(runId);
```

`pause()`, `resume()`, and `abort()` are now `async` (return `Promise<void>`), but the call sites in the `try` block don't `await` them. This means:

1. The `return` statement immediately after executes before `persistState()` completes inside the orchestrator method.
2. If `persistState` throws, the error is silently swallowed (not caught by the outer `try/catch` because the promise is floating).

The fallback path at line 374 (`orch.persistState()`) has the same issue — not awaited.

**Severity**: Low. The state machine transition happens synchronously, so the returned status is correct. The persistence is best-effort. The fallback path after `catch` would mask the error anyway. But it's technically a floating promise.

### L-3: `session_shutdown` handler calls `orch.pause()` without `await`

**File**: `index.ts:260`

```typescript
for (const inst of running) {
  orch.pause(inst.runId);  // no await
}
```

`pause()` is async, called in a loop without `await` or `Promise.all`. If persistence fails, the error is silently lost. For a shutdown handler this is acceptable (fire-and-forget is the norm), but worth documenting.

**Severity**: Low.

---

## Dimension 2: Exception Management

### I-1: `handleWorkerMessage` — `handleAgentCall` not awaited

**File**: `orchestrator.ts:465`

```typescript
case "agent-call":
  this.handleAgentCall(runId, instance, msg.callId, msg.opts);
  break;
```

`handleAgentCall` is `async` but not awaited. This is intentional — agent calls are dispatched asynchronously to the pool and results arrive via `.then()`. The `handleAgentCall` body only does synchronous work (cache check, trace node creation) plus calls `executeWithRetry` which is also fire-and-forget by design.

**Severity**: Info. This is the correct pattern for worker message handling — awaiting would block the message loop.

### I-2: `handleWorkerMessage` — `handleScriptError` not awaited

**File**: `orchestrator.ts:482`

```typescript
this.handleScriptError(runId, msg.error);
```

Same pattern as I-1. `handleScriptError` is async (calls `persistState`). Not awaiting it means `handleWorkerMessage` resolves before persistence completes. The worker message handler is `async` but the `worker.on("message")` callback at line 403 calls it without awaiting either.

**Severity**: Info. Consequence: if persistence fails, the instance state is updated in-memory but not persisted. On crash, the state would be lost. This matches the existing design philosophy (best-effort persistence).

---

## Dimension 3: Logging

### I-3: `reconstructState` silently swallows errors

**File**: `index.ts:126-129`

```typescript
} catch {
  // If getEntries fails, return empty map
}
```

And at line 118-120:

```typescript
} catch {
  ctx.ui.notify(`WARN: missing or corrupt state for ${runId}`, "warning");
}
```

The inner catch (malformed JSONL lines) is silent — no logging at all. If deserialization fails on valid-looking JSON (e.g., schema mismatch), there's no way to diagnose it. Consider logging the line parse error at debug level.

The outer catch for file read failure correctly calls `ctx.ui.notify()`. Good.

**Severity**: Info. The outer catch provides user-visible feedback. The inner silent catch for individual lines is pragmatic (don't fail the entire reconstruction for one bad line).

---

## Dimension 4: Fail-Fast

No issues found. All public methods validate inputs:

- `run()`: checks `workflow.available` and throws on missing workflow
- `pause/resume/abort/retryNode/skipNode`: check `instance` existence and status, throw descriptive errors
- `WorkflowOrchestrator` constructor: `sessionDir` is deterministic, no validation needed
- `reconstructState`: validates `customType === "workflow-state-link"` and `data.runId && data.path` before processing

State machine transitions via `transitionStatus()` throw on invalid transitions. Error messages include the current state, target state, and allowed transitions.

---

## Dimension 5: Test Friendliness

No issues found. Key observations:

- `AgentPool` accepts `AgentPoolOptions` with injectable `onSoftLimitReached` callback — fully mockable
- `WorkflowOrchestrator` accepts `poolOptions` parameter for injecting pool options
- `reconstructState` reads from `ctx.sessionManager.getEntries()` — mockable via `ExtensionContext`
- Tests use `vi.mock()` for all external dependencies (fs, pi SDK, config-loader)
- Mock factories (`createMockPi`, `createMockCtx`, `makeMockPi`, `makeMockCtx`) are clean and reusable

The `bootstrap()` helper in `index.test.ts` properly simulates the full session lifecycle (factory → session_start → tool execution).

---

## Dimension 6: Debug Friendliness

Good overall. Notable positives:

- Error messages in state machine transitions include both states: `Invalid state transition: running → completed. Allowed: [paused, completed, ...]`
- `persistState` writes per-instance JSONL files with deterministic paths: `~/.pi/agent/workflow-state/<runId>.jsonl`
- Pointer entries include `updatedAt` timestamps
- `sessionApprovals` logs via `pi.appendEntry("workflow-approval-memory", ...)` with timestamp
- `sendUserMessage` in soft-limit callback includes runName and budget details

One minor gap: the `_callCache` in `AgentPool` uses randomly generated callIds (`agent-${randomUUID().slice(0, 8)}`), making it hard to correlate cache entries with specific workflow steps. But this cache is only for internal pool deduplication, not user-facing.

---

## Summary

| Dimension | Verdict | Notes |
|-----------|---------|-------|
| Error Handling | Acceptable | L-1/L-2/L-3 are floating promises, low risk |
| Exception Management | Acceptable | I-1/I-2 are intentional fire-and-forget patterns |
| Logging | Acceptable | I-3 inner catch is silent but pragmatic |
| Fail-Fast | Good | No issues |
| Test Friendliness | Good | No issues, well-structured mocks |
| Debug Friendliness | Good | Good context in error messages |

**Overall**: PASS. No must-fix issues. The 3 low-severity issues are all floating promise patterns that are consistent with the existing codebase style and pose minimal risk in practice. The codebase correctly handles the critical paths (persistence, state machine transitions, approval gates) with appropriate error handling and logging.
