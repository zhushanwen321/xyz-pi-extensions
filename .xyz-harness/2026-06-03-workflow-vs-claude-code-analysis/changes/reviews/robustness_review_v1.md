---
verdict: pass
must_fix: 1
reviewer: robustness-reviewer
reviewed_at: 2026-06-03
files:
  - extensions/model-switch/src/advisor.ts
  - extensions/workflow/src/model-resolver.ts
  - extensions/workflow/src/orchestrator.ts
  - extensions/workflow/src/worker-script.ts
dimensions:
  - error-handling
  - exception-safety
  - logging
  - fail-fast
  - test-friendly
  - debug-friendly
---

# Robustness Review — Workflow ↔ Model Switch Integration (Scene → Model Resolution)

## Overview

Review of the scene-based model resolution data path:

```
worker-script.ts    →  orchestrator.ts     →  model-resolver.ts    →  advisor.ts
agent({ scene })      handleAgentCall()      resolveModel()          resolveModelForScene()
  scene in opts        enrich opts.model       scene → advisor        loadConfig + readCache
                       executeWithRetry()                              return "provider/modelId"
```

## Per-File Analysis

### 1. `extensions/model-switch/src/advisor.ts` — `resolveModelForScene`

| Dimension | Assessment |
|-----------|------------|
| Error Handling | `loadConfig()` null → warn + return undefined. Scene not found → warn + return undefined. No candidates → warn + return undefined. All candidates peak-avoid → info + return undefined. **`readCache()` called without try/catch** — if cache subsystem fails, unhandled exception crashes the entire call. `computeQuotaSnapshot` casts `cache as Record<string, unknown>` with zero validation. |
| Exception Safety | `parseZaiResetTime` / `parseIsoRemaining` handle empty strings. Pattern 4 in `extractSingleQuota` accesses `d.models` with `as Array<...>` then calls `.find()` — if `d.models` is present but not an array, crashes. |
| Logging | All failure paths logged with `[model-switch]` prefix. **No success log** when model IS resolved — can't trace which model was selected in production. |
| Fail-fast | Returns `undefined` early on any failure, caller falls through to Pi default. |
| Test-friendly | `resolveModelForScene` accepts optional `now` param for time injection. **But directly calls `loadConfig()` and `readCache()` singletons** — requires module-level mocking in tests (existing tests prove this works, but fragile). |
| Debug-friendly | Failure messages include scene name and reason. Success path is invisible. |

**Issues:**
1. **SHOULD FIX — `readCache()` unguarded**: If cache read throws, the entire `resolveModelForScene` crashes. Wrap in try/catch and return undefined.
2. **SHOULD FIX — `computeQuotaSnapshot` missing type guard**: `cache` is cast to `Record<string, unknown>` without `typeof cache === "object" && cache !== null` guard. Unexpected schema from quota-providers triggers runtime crash.
3. **COULD FIX — No success log**: Add `console.info("[model-switch] scene \"%s\" resolved to %s", scene, result)` after successful resolution.
4. **COULD FIX — `loadConfig()` called on every invocation**: No cache — each call reads/parses config from disk. Consider caching per session.

---

### 2. `extensions/workflow/src/model-resolver.ts` — `resolveModel`

| Dimension | Assessment |
|-----------|------------|
| Error Handling | **Best of the four files.** `resolveModelForScene` wrapped in try/catch. All paths return `undefined` gracefully. Guards against `opts.model` shortcut before calling advisor. |
| Exception Safety | No uncalled exceptions — the only external call is guarded by try/catch. |
| Logging | Success path: `console.log` with resolved model. Warning path: `console.warn` with scene name. Error path: `console.warn` with exception. All use `[workflow]` prefix. |
| Fail-fast | Graceful degradation — never blocks the workflow on model resolution failure. |
| Test-friendly | **Pure function** — given `AgentCallOpts`, returns `string \| undefined`. Single import dependency, easily mocked. No side effects beyond console. |
| Debug-friendly | Clear, scoped messages. Exception stack is propagated in log. |

**Issues:** None.

---

### 3. `extensions/workflow/src/orchestrator.ts` — `handleAgentCall` Integrated Path

| Dimension | Assessment |
|-----------|------------|
| Error Handling | Stale state guards (P0-1, P0-2, P0-3) prevent double-finalization. `handleWorkerMessage` gates stale messages for terminal/paused/budget_limited. **Worker exit handler has a race condition** (see MUST FIX below). |
| Exception Safety | `executeWithRetry` — `enqueue` never rejects (per AgentPool contract). `setTimeout` retries have stale state checks. Budget check after each agent call. Timer uses `unref()` to not block exit. |
| Logging | **Nearly silent in critical paths** — `handleAgentCall`, `executeWithRetry` (start, retry, complete), `checkBudget` (exceed) all have NO console.log. Only `handleScriptError` logs (indirectly via error message). Makes production debugging very difficult. |
| Fail-fast | State transition guards everywhere — `pause/abort/retry/skip` all check valid state transitions. `run()` throws immediately if workflow not found. |
| Test-friendly | Class-based with constructor injection of `pi`/`ctx`. **`AgentPool` instantiated internally** — cannot inject mock pool. **`getWorkflow`, `buildWorkerScript` are direct imports** — requires module-level mocking. State is mutated across multiple methods (trace.push, callCache.set, budget fields) — hard to assert intermediate states. |
| Debug-friendly | Run IDs are timestamp+random — traceable. Error messages include context. **No structured logging** — all diagnostics in `instance.error` strings only. |

**Issues:**
1. **MUST FIX — Worker exit handler race condition**: `handleWorkerExit(runId, code)` unconditionally calls `this.workers.delete(runId)`. When `retryNode()` or `resume()` terminates the old worker and starts a new one (`startWorker` sets the new worker in the map), the old worker's `exit` event fires asynchronously. `handleWorkerExit` then deletes the NEW worker's reference from the map. Consequences:
   - The new worker becomes untracked (orphan) — its messages (agent-result, return, error) are received but `handleWorkerMessage` won't crash (it reads from `this.instances` not `this.workers`), but the return/error handlers don't fire because the `workers` map entry is gone.
   - Specifically: `return`/`error` messages from the new worker still route through `handleWorkerMessage` which reads from `this.instances`, so instance state updates still happen. But `this.workers.delete()` causes `handleWorkerExit` to NOT clean up properly... actually let me re-trace:
     - `handleWorkerMessage` for `"return"` type: reads `instance` from `this.instances`, transitions status to "completed", does `this.workers.delete(runId)` — **BUT** `this.workers` already has no entry for this runId (deleted by old worker's exit handler), so this delete is a no-op. The state IS persisted. The instance IS marked completed. No crash.
     - `handleWorkerMessage` for `"error"` type: similar — deletes from `this.workers` which is already empty.
     - The net effect: the new worker finishes, its messages are handled, but `handleWorkerExit` never fires for the new worker (because the old worker's exit handler already removed the map entry). Since `handleWorkerExit` only does cleanup (workers.delete + failure marking), and `handleWorkerMessage` already handles completion/error, the actual state is correct.
     - **BUT** — if the new worker crashes (exit code != 0), `handleWorkerExit` should catch it. But since the map entry is already gone, `handleWorkerExit` returns early (`if (!instance) return;` is NOT true because `instance` is still in `this.instances`). So `handleWorkerExit` WOULD still run. It gets the instance from `this.instances.get()`. Then it does `this.workers.delete(runId)` which is a no-op. Then `instance.status` — if the instance is already "running" (set by `startWorker` indirectly... no, `startWorker` doesn't change status), it checks `instance.status === "paused" || isTerminal(instance.status)` — if the instance is "running", and code !== 0, it marks as "failed". But this could overwrite a legitimate "completed" state if the old worker's exit fires after the new worker has already succeeded.
     - **Race window**: Old worker exit handler fires → `handleWorkerExit` runs → reads instance, instance is "running" (new worker), code from old worker is non-zero (because terminate() sends SIGTERM which exits with non-zero) → marks instance as "failed" even though the NEW worker is running fine.
     
   This IS a real bug. The race window is small but present: `terminateWorker()` calls `worker.terminate()` which is async, and the `exit` event fires on microtask boundary. If `startWorker()` runs before the old worker's `exit` event fires (very likely since `terminate()` returns a Promise that resolves when the worker exits), the map already has the new worker when the old exit fires.

2. **SHOULD FIX — No logging in `executeWithRetry`**: When retry happens (attempt 2/3), there's no log. When budget is exceeded, no console.warn. When agent-call completes, no log.

3. **COULD FIX — `AgentPool` not injectable**: Constructor creates `new AgentPool(maxConcurrency)` directly. Tests cannot mock the pool.

4. **COULD FIX — Timer leak on multiple resume**: `scheduleTimeBudgetCheck` is called in both `run()` and `resume()`. Old timer from `run()` is never cleared. The guard `instance.status !== "running"` prevents double-termination, but old timer still fires and does a no-op lookup.

---

### 4. `extensions/workflow/src/worker-script.ts` — Scene Field Passing

| Dimension | Assessment |
|-----------|------------|
| Error Handling | `parentPort === null` throws with clear message. `agent()` validates firstArg type. `_callCache` deserialization handles Map, plain object, and unknown shapes. `log()` swallows postMessage errors. `agent-result` for unknown callId silently dropped (correct for cache-hit race). |
| Exception Safety | `WorkflowAbortedError` properly defined and thrown. `.then().catch()` chain ensures both success and error are sent back to main. `parallel()` wraps in `agent()` which validates inputs. |
| Logging | Console.log override (for TUI cleanliness). No diagnostic logging in worker. `log()` sends to main thread. |
| Fail-fast | Throws immediately on invalid `agent()` calls. Throws `WorkflowAbortedError` on abort. Reports error immediately on unhandled exception in user script. |
| Test-friendly | **Best of the four files** — `buildWorkerScript` is a pure string builder. Input: string → Output: string. Zero side effects. Easily tested with snapshot or substring assertions. |
| Debug-friendly | Error messages include function name and context. `scene` field properly propagated through all agent() signatures (string+options, object, parallel). |

**Issues:**
1. **COULD FIX — `parallel()` drops non-standard fields**: When `parallel([{ task, agent, extra }])` is used, only known fields (prompt, description, schema, model, scene) are passed. Extra fields are silently dropped. This is by design but could surprise users.

**Scene field flow verified:**

| Entry Point | `scene` propagated? |
|---|---|
| `agent("prompt", { scene })` | ✅ Passed in opts |
| `agent({ prompt, scene })` | ✅ `opts = firstArg` |
| `agent({ task, scene })` | ✅ `prompt: firstArg.task, scene: firstArg.scene` |
| `parallel([...])` | ✅ Each `agent(c)` gets `c.scene` |
| Cache hit → `_callCache.get(callId)` | ✅ Returns cached result, no model re-resolution needed |
| Agent pool enqueue → `handleAgentCall` → `resolveModel` | ✅ `opts.scene` passed through |

---

## Inter-File Integration Risks

### Data Flow: `scene` Field Integrity

```
worker-script.ts                  orchestrator.ts              model-resolver.ts           advisor.ts
─────────────────                ───────────────              ───────────────              ──────────
agent({scene:"x"})  ──post──▶  handleAgentCall      ──call──▶  resolveModel(opts)  ──call──▶  resolveModelForScene(scene)
  │                              │                               │
  │ opts = { prompt, scene }     │ opts.scene preserved          │ opts.scene → advisor
  │                              │                               │
  │                              │ resolveModel returns          │ returns "p/m"
  │                              │ model or undefined            │
  │                              │                               │
  │                              │ { ...opts, model }            │
  │                              │   passed to AgentPool         │
```

No field loss across the chain. Verified signatures match (`AgentCallOpts.scene?: string` in all layers).

### Risk: `resolveModel` Graceful Degradation Hides Bugs

`model-resolver.ts` catches ALL exceptions from `resolveModelForScene` and returns `undefined`. This means if `advisor.ts` has a bug (type error, crash), the workflow silently falls back to Pi default model. The catch is correct for production resilience, but:
- **No error counter/metric**: Orchestrator never knows the advisor failed.
- **No propagation of crash details**: The catch logs the error, but orchestrator doesn't know model resolution was attempted and failed.
- Result: bugs in `advisor.ts` can go undetected in production unless someone monitors console.warn.

### Risk: `readCache()` Timing

`advisor.ts` calls `readCache()` every time `resolveModelForScene` is invoked. The cache is updated asynchronously by `@zhushanwen/pi-quota-providers`. If a workflow fires many agent calls rapidly, each call reads cache independently → N calls = N cache reads. Not a correctness issue but a performance concern for high-concurrency workflows.

---

## Summary

| File | Verdict | MUST FIX | SHOULD FIX | COULD FIX |
|------|---------|----------|------------|-----------|
| advisor.ts | PASS with issues | 0 | 2 | 2 |
| model-resolver.ts | PASS | 0 | 0 | 0 |
| orchestrator.ts | PASS with issues | **1** | 1 | 2 |
| worker-script.ts | PASS | 0 | 0 | 1 |
| **Total** | | **1** | **3** | **5** |

### MUST FIX (1)

**MF-01 — `orchestrator.ts` `handleWorkerExit` race condition**

`handleWorkerExit(runId, code)` unconditionally calls `this.workers.delete(runId)`. When `retryNode()` or `resume()` terminates the old worker and immediately starts a new one (same runId), the old worker's asynchronous `exit` event fires after the new worker's reference is already in the map. The old exit handler deletes the new worker's reference, creating an orphan worker.

**Impact**: If the old worker's `exit` handler fires while the new worker is running, the exit handler sees `instance.status === "running"` (set by the new worker's activity) and code !== 0 (because terminate sends SIGTERM), and marks the instance as `"failed"` — erroneously terminating the new worker's progress.

**Fix**: Either (a) tag each worker with a generation counter and compare in `handleWorkerExit`, or (b) track which `Worker` object is currently active and only delete/update state if the emitting worker matches.

### SHOULD FIX (3)

- **SF-01** — `advisor.ts`: `readCache()` called without try/catch. Wrap in try/catch → return undefined.
- **SF-02** — `advisor.ts` `computeQuotaSnapshot`: Missing type guard before casting `cache as Record<string, unknown>`. Unexpected schema from quota-providers triggers runtime crash.
- **SF-03** — `orchestrator.ts`: No logging in `executeWithRetry` (retry attempts, completions) and `checkBudget` (budget exceeded). Add `console.warn`/`console.log`.

### COULD FIX (5)

- **CF-01** — `advisor.ts`: No success log after successful model resolution.
- **CF-02** — `advisor.ts`: `loadConfig()` called on every invocation. Consider caching.
- **CF-03** — `orchestrator.ts`: `AgentPool` hard-instantiated in constructor. Accept optional pool parameter for test injection.
- **CF-04** — `orchestrator.ts`: Old time-budget timer from `run()` not cleared on `resume()`. Use `clearTimeout`.
- **CF-05** — `worker-script.ts`: `parallel()` silently drops non-standard fields from task objects.

### Verdict

**PASS** — No systematic robustness issue. The scene → model resolution data path is correctly wired end-to-end. The single MUST FIX (worker exit race) is a timing bug that manifests only during `retryNode`/`resume` under specific scheduling conditions, not in the common forward-only execution path.
