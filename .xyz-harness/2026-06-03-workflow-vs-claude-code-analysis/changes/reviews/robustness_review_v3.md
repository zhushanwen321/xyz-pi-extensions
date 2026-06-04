---
verdict: pass
must_fix: 0
reviewer: robustness-reviewer
reviewed_at: 2026-06-03
files:
  - extensions/workflow/src/orchestrator.ts
dimensions:
  - race-condition
  - state-machine-integrity
  - partial-fix-verification
---

# Robustness Review — Round 3 (MF-01 Full Fix Verification)

## Scope

Round 3 verifies whether the v2 MUST FIX (MF-01 state-corruption race — failure-marking block not gated by worker identity check) has been correctly resolved. The v2 review specifically required:

> Apply early-return on worker identity mismatch before any state mutation. The current fix correctly prevents the orphan worker but leaves the failure-marking race intact.

No other files or dimensions are re-reviewed. v1 SHOULD FIX items (SF-01, SF-02, SF-03) and COULD FIX items remain out of scope per the v2 boundary.

## Verification: Current `handleWorkerExit` Implementation

Located at `extensions/workflow/src/orchestrator.ts:593-614`:

```typescript
private handleWorkerExit(runId: string, code: number, exitedWorker: Worker): void {
    const instance = this.instances.get(runId);
    if (!instance) return;

    // Guard: only process exit if the exited worker is still the current one.
    // Prevents race: terminateWorker(old) → startWorker(new) → old exit fires →
    // would delete new worker and incorrectly mark instance as failed.
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

## Explicit Checks

| # | Check (v2 requirement) | Status | Evidence |
|---|-------|--------|----------|
| 1 | `handleWorkerExit` receives `exitedWorker` parameter | ✅ PASS | `private handleWorkerExit(runId: string, code: number, exitedWorker: Worker): void` (line 593) |
| 2 | Early-return `if (currentWorker !== exitedWorker) return;` BEFORE any state mutation | ✅ PASS | Line 603 — early return positioned after identity check, before `this.workers.delete(runId)` (line 604) and the failure-marking block (lines 610-615) |
| 3 | `this.workers.delete(runId)` is inside the protected section (runs only if identity matches) | ✅ PASS | Line 604 — only reached if `currentWorker === exitedWorker` |
| 4 | Failure-marking block is inside the protected section (runs only if identity matches) | ✅ PASS | Lines 610-615 — only reached if `currentWorker === exitedWorker` |
| 5 | `startWorker` exit handler passes `worker` reference | ✅ PASS | `worker.on("exit", (code: number) => { this.handleWorkerExit(runId, code, worker); })` (line 411) |
| 6 | Code comment documents the protected-region rationale | ✅ PASS | Comment at lines 599-601 explicitly mentions "would delete new worker and incorrectly mark instance as failed" |

All six checks pass. The fix matches the v2 reviewer's "Recommended Fix" code snippet exactly.

## Race Trace Re-verification

### Race Path 1: `retryNode`

```text
1. retryNode(runId, callId)             // status = "running"
2.   terminateWorker(runId)             // workers.delete(runId); oldWorker.terminate() (exit queued)
3.   startWorker(runId, instance, ...)  // workers.set(runId, NEW_WORKER)
4.   [microtask] oldWorker emits 'exit' (code = 1, SIGTERM)
5.   handleWorkerExit(runId, 1, oldWorker)
6.     currentWorker = workers.get(runId) → NEW_WORKER
7.     NEW_WORKER !== oldWorker → early return                          ✓ FIXED
8.   NEW_WORKER runs agent calls normally
9.   handleWorkerMessage sees status === "running" → proceeds normally  ✓
```

**Result**: New worker is no longer orphaned, and the running instance is no longer flipped to `failed`. The new worker's `return` message is correctly processed (P0-1 stale-state guard is not triggered). Both orphan-worker and state-corruption symptoms resolved.

### Race Path 2: `handleScriptError` (Retry With Backoff)

```text
1. handleScriptError(runId, errorMsg)
2.   terminateWorker(runId)             // workers.delete(runId); oldWorker.terminate() (exit queued)
3.   setTimeout(...) {
4.     startWorker(runId, instance, ...) // workers.set(runId, NEW_WORKER)
5.   }
6. [microtask] oldWorker emits 'exit' (code = 1)
7. handleWorkerExit(runId, 1, oldWorker)
8.   currentWorker = NEW_WORKER
9.   NEW_WORKER !== oldWorker → early return                          ✓ FIXED
```

**Result**: State corruption in retry-with-backoff path resolved.

### Race Path 3: `resume` (with delayed exit)

```text
1. pause(runId): status = "paused"; terminateWorker(runId)
   └─ workers.delete(runId); oldWorker.terminate() (exit queued)
2. [microtask] oldWorker emits 'exit'
3. handleWorkerExit(runId, code, oldWorker)
   ├─ currentWorker = workers.get(runId) → undefined
   ├─ undefined !== oldWorker → early return                          ✓ FIXED
4. resume(runId): status = "running"; startWorker(runId, ...)
   └─ workers.set(runId, NEW_WORKER)
5. NEW_WORKER runs agent calls normally
```

**Result**: The pause path is naturally safe (status check skipped failure marking) AND the resume path is now also safe (delayed old-worker exit is correctly ignored). Both terminateWorker-before-startWorker and delayed-exit-after-resume scenarios are covered.

### Non-Race Path: Genuine Worker Crash

```text
1. Worker crashes (uncaught exception, no replacement started)
2. 'exit' event fires with code !== 0
3. handleWorkerExit(runId, code, crashedWorker)
4.   currentWorker = crashedWorker (no replacement)
5.   crashedWorker === exitedWorker → proceed
6.   this.workers.delete(runId)                                       ✓
7.   status !== "paused", !isTerminal → proceed
8.   code !== 0, !instance.error → mark "failed", persistState       ✓
```

**Result**: Genuine worker failures are still correctly marked. The early-return guard does not regress the failure-detection behavior — it only suppresses stale exit events from previous worker generations.

## Per-Dimension Assessment

| Dimension | Assessment |
|-----------|------------|
| Race-condition | **PASS** — MF-01 fully resolved. All three race paths (`retryNode`, `handleScriptError`, `resume`) trace clean. The early-return guard short-circuits the entire state-mutation region. |
| State-machine-integrity | **PASS** — A running instance is no longer silently flipped to `failed` by a stale exit event. Genuine worker failures still surface as `failed` because the guard only suppresses when `currentWorker !== exitedWorker`. |
| Partial-fix-verification | The fix is now complete (not partial). The early-return pattern matches the v2 reviewer's recommended code. The protected region encompasses both `workers.delete` and the failure-marking block. |

## Verdict

**PASS** with **0 MUST FIX**.

The v2 MUST FIX (MF-01 extension — state-corruption race) is fully resolved. The early-return guard at `orchestrator.ts:603` (`if (currentWorker !== exitedWorker) return;`) sits before all state-mutation code, eliminating the race window that previously caused running instances to be erroneously marked `failed` by stale exit events from previous worker generations.

## Summary

| Item | Status |
|------|--------|
| MF-01 (orphan worker symptom) | ✅ Resolved (v1 → v2) |
| MF-01 (state corruption symptom) | ✅ Resolved (v2 → v3, this round) |
| v1 SHOULD FIX items (SF-01, SF-02, SF-03) | Not re-reviewed (out of scope) |
| v1 COULD FIX items | Not re-reviewed (out of scope) |
| New MUST FIX | 0 |
| New SHOULD FIX | 0 |
| Regressions introduced | None observed |

### No Action Items

No further fixes required for MF-01. The orchestrator's `handleWorkerExit` is now robust against stale exit events from previous worker generations while still correctly detecting and surfacing genuine worker failures.
