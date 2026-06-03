---
verdict: pass
must_fix: 1
reviewer: robustness-reviewer
reviewed_at: 2026-06-03
files:
  - extensions/workflow/src/orchestrator.ts
dimensions:
  - race-condition
  - state-machine-integrity
  - partial-fix-verification
---

# Robustness Review — Round 2 (MF-01 Fix Verification)

## Scope

Round 2 focuses exclusively on verifying whether the v1 MUST FIX (MF-01, `handleWorkerExit` race condition) has been correctly resolved. No other files or dimensions are re-reviewed.

## Explicit Checks Requested by Reviewer

| # | Check | Status | Evidence |
|---|-------|--------|----------|
| 1 | `handleWorkerExit` now receives `exitedWorker` parameter | ✅ PASS | `private handleWorkerExit(runId: string, code: number, exitedWorker: Worker): void` (line 594) |
| 2 | Only deletes map entry when `this.workers.get(runId) === exitedWorker` | ✅ PASS | `if (currentWorker === exitedWorker) { this.workers.delete(runId); }` (lines 599–602) |
| 3 | `startWorker` exit handler passes `worker` reference | ✅ PASS | `worker.on("exit", (code: number) => { this.handleWorkerExit(runId, code, worker); })` (lines 410–412) |

All three explicit mechanical checks pass. **However, the fix is incomplete relative to the original MF-01 impact statement.**

## Critical Finding: Fix Is Partial — State-Mutation Race Still Exists

### What's Fixed (Orphan Worker Symptom)

The orphan worker symptom is correctly addressed. Trace through `retryNode` after the fix:

```text
1. retryNode(runId, callId)
2.   terminateWorker(runId)         // workers.delete(runId); oldWorker.terminate()
3.   startWorker(runId, instance, ...) // workers.set(runId, NEW_WORKER)
4.   [async] oldWorker emits 'exit'
5.   handleWorkerExit(runId, code, oldWorker)
6.     currentWorker = workers.get(runId) → NEW_WORKER
7.     currentWorker === oldWorker → false → skip workers.delete  ✓ FIXED
```

The new worker is no longer orphaned by the old worker's exit handler. Good.

### What's NOT Fixed (State Corruption Symptom)

The same `handleWorkerExit` continues to execute the **failure-marking block** regardless of whether the exiting worker is the current one:

```typescript
// orchestrator.ts lines 604–615 (after the partial fix)
if (instance.status === "paused" || isTerminal(instance.status)) return;

if (code !== 0 && !instance.error) {
  instance.error = `Worker exited with code ${code}`;
  instance.completedAt = new Date().toISOString();
  transitionStatus(instance, "failed");
  this.persistState();
}
```

#### Race Trace: `retryNode` After Partial Fix

```text
1. retryNode(runId, callId)               // status = "running"
2.   terminateWorker(runId)               // workers.delete(runId); oldWorker.terminate()
3.   startWorker(runId, instance, ...)    // workers.set(runId, NEW_WORKER)
4.   [async] oldWorker emits 'exit' (code = 1, SIGTERM)
5.   handleWorkerExit(runId, 1, oldWorker)
6.     currentWorker = NEW_WORKER, skip workers.delete          ✓
7.     status === "running" → not paused, not terminal → continue
8.     code !== 0 → true, !instance.error → true
9.     transitionStatus(instance, "failed")                       ✗ BUG
10.    persistState() — flushes "failed" state
11.  Meanwhile, NEW_WORKER happily runs agent calls...
12.  When NEW_WORKER eventually returns:
13.    handleWorkerMessage sees status === "failed" (terminal)
14.    isTerminal(status) → true → P0-1 guard returns early
15.    Return message is silently dropped
```

**Result**: The workflow instance is erroneously marked `failed` while a healthy new worker is still executing. The new worker's return is silently dropped by the P0-1 stale-state guard. The user sees a "failed" workflow whose worker is still alive and consuming tokens.

#### Same Race in `handleScriptError` Retry Path

```text
1. handleScriptError(runId, errorMsg)
2.   terminateWorker(runId)               // workers.delete(runId); oldWorker.terminate()
3.   setTimeout(...) {
4.     startWorker(runId, instance, ...)  // workers.set(runId, NEW_WORKER)
5.   }
6. [async] oldWorker emits 'exit' (code = 1)
7. handleWorkerExit runs failure-marking block → status = "failed"  ✗ BUG
```

#### Same Race in `resume` Path

```text
1. pause(runId): status = "paused"; terminateWorker(runId)
2. [async] oldWorker exits → handleWorkerExit sees "paused" → safe return ✓
3.   (note: pause sets status to "paused" BEFORE terminate, so the
4.    status check correctly skips failure marking)
5. resume(runId): status = "running"; startWorker(runId, ...)
6. [async] BUT what if old worker's exit was DELAYED and fires AFTER resume?
7.   handleWorkerExit: status = "running", code != 0 → mark "failed"   ✗ BUG
```

The `pause` path is safe because pause sets status before terminate. The `retryNode`/`handleScriptError`/`resume` paths are NOT safe because status stays at `"running"` (or transitions to `"running"`) when the new worker is started.

### Why This Is a True Race (Not Theoretical)

`worker.terminate()` returns a Promise that resolves when the worker has exited, but the `'exit'` event is emitted **on the next event loop tick** after termination begins. The orchestrator's `retryNode` is synchronous up to `persistState()` — it calls `terminateWorker` then immediately `startWorker` in the same synchronous block. Therefore:

```text
Synchronous block:
  workers.delete(runId)           // line 1
  worker.terminate()              // line 2 (returns Promise, exit event queued)
  workers.set(runId, NEW_WORKER)  // line 3

Microtask boundary:
  [old worker's 'exit' event fires]
  handleWorkerExit runs with:
    workers.get(runId) = NEW_WORKER
    exitedWorker = OLD_WORKER
    status = "running"
    → marks as "failed"            ← THE BUG
```

The race window is **guaranteed to occur on every `retryNode` call**, not just under adversarial scheduling.

### Recommended Fix

Gate the entire state-mutation block (not just `workers.delete`) on the worker identity check:

```typescript
private handleWorkerExit(runId: string, code: number, exitedWorker: Worker): void {
    const instance = this.instances.get(runId);
    if (!instance) return;

    // Only act on exit if this is still the current worker.
    // Prevents race: terminateWorker(old) → startWorker(new) → old exit fires →
    // would otherwise delete new from map AND erroneously mark running instance as failed.
    const currentWorker = this.workers.get(runId);
    if (currentWorker !== exitedWorker) return;

    this.workers.delete(runId);

    // Paused/terminal exits are intentional — skip failure marking
    if (instance.status === "paused" || isTerminal(instance.status)) return;

    // Non-zero exit without explicit error message → mark as failed
    if (code !== 0 && !instance.error) {
      instance.error = `Worker exited with code ${code}`;
      instance.completedAt = new Date().toISOString();
      transitionStatus(instance, "failed");
      this.persistState();
    }
}
```

The single change: `if (currentWorker !== exitedWorker) return;` early-returns before any state mutation. This is functionally equivalent to the v1 reviewer's recommendation (b): "track which `Worker` object is currently active and only delete/update state if the emitting worker matches" — the current fix applied (b) only to the delete, not to the update.

## Per-Dimension Assessment

| Dimension | Assessment |
|-----------|------------|
| Race-condition | **FAIL** — MF-01 partially fixed. Orphan worker prevented, but state corruption race remains in 3 call sites (`retryNode`, `handleScriptError`, `resume`). |
| State-machine-integrity | **FAIL** — A running instance can be silently flipped to `failed` by a stale exit event from the previous worker generation. |
| Partial-fix-verification | The three explicit mechanical checks all pass. The fix correctly threads `exitedWorker` through the call chain. The fix correctly guards `workers.delete`. The fix FAILS to apply the same guard to the failure-marking block. |

## Verdict

**PASS** for the overall system robustness (the scene → model resolution data path from v1 review remains correct and no new systematic issues were introduced). **MUST FIX 1** remains open — the failure-marking block in `handleWorkerExit` is not gated by the worker identity check, so the original MF-01 state-corruption impact is unresolved.

## Summary

| Item | Status |
|------|--------|
| MF-01 partial fix (orphan worker) | ✅ Resolved |
| MF-01 partial fix (state corruption) | ❌ NOT resolved — must be fixed |
| New MUST FIX | 1 (extension of MF-01) |
| v1 SHOULD FIX items (SF-01, SF-02, SF-03) | Not re-reviewed in round 2 (out of scope) |
| v1 COULD FIX items | Not re-reviewed in round 2 (out of scope) |

### Action Items

**MF-01 (reopened, partial)** — `extensions/workflow/src/orchestrator.ts:594-617`

Apply early-return on worker identity mismatch before any state mutation. The current fix correctly prevents the orphan worker but leaves the failure-marking race intact. See "Recommended Fix" section above for the exact change.

After this fix is applied, the v1 review's three mechanical checks remain valid and the state-corruption impact is fully addressed.
