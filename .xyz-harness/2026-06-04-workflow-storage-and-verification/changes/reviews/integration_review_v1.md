---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 8
  issues_found: 7
  must_fix_count: 0
  low_count: 4
  info_count: 3
---

# Integration Review — Workflow Storage Externalization + Approval Gate + Verification Gate

**Reviewer:** Integration Boundary Specialist
**Date:** 2026-06-04
**Scope:** `git diff 5208e76..HEAD` (18 files, +1555 / -155 lines)
**Source BLR:** `business_logic_review_v1.md` (PASS, 5 LOW/INFO)

---

## Executive Summary

**Verdict: PASS** — All module boundaries are structurally correct. Data flows through the persist/reconstruct/approval/soft-warning pipelines without schema mismatches. The async signature migration of orchestrator methods has a gap in caller `await` discipline, but the in-memory state transitions remain synchronous and correct; only the persisted-write path is affected on edge-case failures. No blocking issues found.

---

## 1. Module Boundary Correctness

### 1.1 AgentPool ↔ Orchestrator (AgentPoolOptions callback)

| Aspect | Status | Evidence |
|--------|--------|----------|
| Constructor signature compatibility | ✅ | `AgentPool` accepts `AgentPoolOptions \| number`. Orchestrator passes `AgentPoolOptions` object: `{ maxConcurrency, ...poolOptions, onSoftLimitReached }`. Backward-compatible with the old `number` overload. |
| Callback wiring | ✅ | Orchestrator constructor creates `defaultOnSoftLimit` → passes to pool via `onSoftLimitReached`. Pool stores it, invokes via `maybeEmitSoftWarning` only on real spawns. |
| Callback error isolation | ✅ | `maybeEmitSoftWarning` wraps callback in `try/catch` (agent-pool.ts:216-219). Errors do not propagate to `run()`/`dispatch()`. |
| `poolOptions` passthrough | ✅ | `index.ts` constructs `WorkflowOrchestrator(pi, ctx)` with no poolOptions → `poolOptions` is `undefined` → `defaultOnSoftLimit` is used. No external callers override it today. |

**Finding (LOW-1):** The `defaultOnSoftLimit` callback destructures `budget` as `{ used: number; total: number }`, but `maybeEmitSoftWarning` passes a hardcoded `{ total: 0, used: 0, remaining: 0, isExhausted: false }`. The resulting message shows "Budget: 0/0 tokens" instead of real budget data. The `?? "unlimited"` fallback on `budget.total` doesn't help because `0` is not `null`/`undefined`. Already noted as BLR LOW-1. Impact: misleading user-facing warning; the warning itself fires correctly at the right threshold.

### 1.2 Orchestrator ↔ index.ts (persistState/reconstructState)

| Aspect | Status | Evidence |
|--------|--------|----------|
| persistState async contract | ✅ | `persistState(): Promise<void>` writes to external files via `fs.promises.appendFile`. Returns a Promise. |
| reconstructState async contract | ✅ | `reconstructState(ctx): Promise<Map<string, WorkflowInstance>>` reads files via `fs.promises.readFile`. Both call sites in index.ts correctly `await` it (lines 197, 230). |
| Entry type migration | ✅ | Old `workflow-state` entries are silently ignored (not matched by `workflow-state-link` filter). New `workflow-state-link` pointers are the only entries read. |
| Pointer dedup | ✅ | `pointers.set(data.runId, { path: data.path })` with Map dedup — last pointer per runId wins. |

**Finding (LOW-2): Missing `await` on async orchestrator methods in index.ts.** The orchestrator methods `pause()`, `resume()`, `abort()`, and `persistState()` are now async. Three call sites in `index.ts` invoke them without `await`:

1. **session_shutdown handler (line 260):** `orch.pause(inst.runId)` — not awaited. The `async` handler returns before `persistState()` completes. If Pi exits quickly, the last state snapshot may not be written to disk.
2. **workflow tool execute (lines 338-340):** `orch.pause(runId)` / `orch.resume(runId)` / `orch.abort(runId)` — not awaited inside a `try/catch` block. The sync validation errors (not found, invalid transition) are still caught because they throw before the first `await`. But `persistState()` failures become unhandled Promise rejections.
3. **Fallback persistState (line 374):** `orch.persistState()` — not awaited in the direct-state-machine fallback path.

**Impact analysis:** The in-memory state transitions (`transitionStatus`, `terminateWorker`) all happen synchronously before the first `await` inside these methods. So `orch.list()` called immediately after shows correct status. The risk is limited to: (a) `persistState()` disk failures become silent, (b) unhandled rejection may log a warning or crash depending on Pi's `--unhandled-rejections` config. Not a data-corruption risk; the in-memory state is always correct within the session's lifetime.

### 1.3 index.ts ↔ state.ts (serializeInstance/deserializeInstance)

| Aspect | Status | Evidence |
|--------|--------|----------|
| Import alignment | ✅ | index.ts imports `deserializeInstance` (new) from state.ts. Old imports `ENTRY_TYPE`, `deserializeState` removed from the diff. |
| serializeInstance usage | ✅ | Only consumed by orchestrator.ts (line 749). Returns `SerializedWorkflowInstance` with `trace: SerializedExecutionTraceNode[]`. |
| deserializeInstance usage | ✅ | index.ts reconstructState uses `Parameters<typeof deserializeInstance>[0]` for type-safe JSON parsing. |
| Round-trip fidelity | ✅ | `serializeInstance` → JSON.stringify → JSON.parse → `deserializeInstance` preserves all fields. `created` → `running` backward-compat mapping retained. |

**Finding (INFO-1): `verifyStrategy` type-level inconsistency.** `SerializedExecutionTraceNode = Omit<ExecutionTraceNode, "verifyStrategy">` declares the field stripped, but `serializeInstance` assigns `trace: instance.trace` directly (no runtime stripping). TypeScript's structural typing allows this because `ExecutionTraceNode` is assignable to `Omit<ExecutionTraceNode, "verifyStrategy">`. At runtime, `verifyStrategy` IS present in the serialized JSON. The deserialization round-trip preserves it correctly. No functional impact — the `Omit` is a documentation intent, not an enforcement mechanism.

### 1.4 state.ts new types ↔ existing consumers

| Aspect | Status | Evidence |
|--------|--------|----------|
| `state_lost` status | ✅ | Added to `WorkflowStatus` union, `ALL_STATUSES`, `TERMINAL_STATUSES`, `VALID_TRANSITIONS` (empty = terminal). All consumers iterate via `ALL_STATUSES` or `TERMINAL_STATUSES` constants, so the new status is automatically included. |
| `verifyStrategy` field | ✅ | Optional field on `ExecutionTraceNode`. No code reads it at runtime (only SKILL.md + tool-generate.ts guide AI to set it). Addition is non-breaking. |
| `confirmSkipped` on WorkflowRunDetails | ✅ | Optional field in index.ts local interface. Only written in force mode, never read by other modules. |

---

## 2. Data Flow Path Completeness

### 2.1 persistState → external file → pointer entry → reconstructState

```
persistState (orchestrator.ts:740-757)
  → fs.promises.mkdir (recursive)
  → fs.promises.appendFile → ~/.pi/agent/workflow-state/{runId}.jsonl
  → pi.appendEntry("workflow-state-link", { runId, path, updatedAt })

reconstructState (index.ts:89-131)
  → ctx.sessionManager.getEntries()
  → filter customType === "workflow-state-link"
  → dedup by runId (Map, last wins)
  → fs.promises.readFile(path)
  → JSON.parse each line
  → deserializeInstance(parsed)
  → instances.set(runId, instance)

restoreInstances (orchestrator.ts)
  → for each [runId, instance]: this.instances.set(runId, instance)
```

**Verdict: ✅ Closed loop.** Each persist writes one JSONL line + one pointer entry. Reconstruct deduplicates pointers, loads the file, and takes the last line per runId (the most recent snapshot). Old `workflow-state` entries are naturally filtered out.

**Finding (INFO-2): `sessionDir` is global, not per-session.** `path.join(homedir(), ".pi", "agent")` is shared across all sessions. RunId is UUID so collision is negligible, but state files don't follow session lifecycle. Auto-GC is out of scope per spec. Same as BLR INFO-1.

### 2.2 session_start → approval memory → workflow-run confirm

```
session_start handler (index.ts:185-190)
  → getEntries() → filter customType === "workflow-approval-memory"
  → sessionApprovals.add(workflowName)

workflow-run execute (index.ts:596-619)
  → isTmp = exactMatch.source === "tmp"
  → shouldConfirm = isTmp || !sessionApprovals.has(name)
  → if shouldConfirm && hasUI → ctx.ui.confirm()
    → !ok → return declined
    → ok && !isTmp → sessionApprovals.add(name) + pi.appendEntry(...)
  → if !hasUI → pi.sendUserMessage(RPC fallback) — still proceeds to run
  → orch.run()
```

**Verdict: ✅ Closed loop.** Approval memory is persisted via `appendEntry("workflow-approval-memory")`, rehydrated on `session_start`, and checked before confirmation. Tmp workflows bypass memory (`!isTmp` guard). hasUI=false falls back to `sendUserMessage` and proceeds without interactive gate.

**Edge case verified:** If a session has both `workflow-state-link` and `workflow-approval-memory` entries, both reconstruction loops iterate the same `getEntries()` result independently. No cross-contamination.

### 2.3 AgentPool dispatch → maybeEmitSoftWarning → callback → sendUserMessage

```
AgentPool.run() (agent-pool.ts:179-206)
  → cache check (pool._callCache.get) — miss in normal flow
  → totalCallCount++
  → maybeEmitSoftWarning(description, zeroBudget)
    → if totalCallCount > 500 && !softWarningSent → fire callback
    → softWarningSent = true
  → spawnAndParse()
  → _callCache.set(callId, result)

Orchestrator defaultOnSoftLimit (orchestrator.ts:123-131)
  → (this.pi as unknown as { sendUserMessage }).sendUserMessage(message)
```

**Verdict: ✅ Functionally correct, data quality issue.** The warning fires exactly once per pool instance at the correct threshold. The callback is wired through to `pi.sendUserMessage`. The `as unknown as` cast is necessary because `sendUserMessage` is not declared on the local `ExtensionAPI` type stub (it's `any`).

**Finding (LOW-3): AgentPool._callCache is dead code.** The pool caches results by string callId (`"agent-abc12345"`). The orchestrator caches by numeric callId (`Map<number, AgentResult>`). The orchestrator checks its own cache first (`instance.callCache.get(callId)`) and only calls `pool.enqueue()` on miss. Each `enqueue()` call generates a new unique string callId, so the pool's cache key is never repeated. The cache is unreachable in normal flow. Minimal memory overhead (one entry per completed call, GC'd with the pool).

---

## 3. Interface Contract Consistency

### 3.1 AgentPoolOptions ↔ constructor call

| Contract field | Orchestrator provides | Pool expects | Match? |
|---------------|----------------------|--------------|--------|
| `maxConcurrency` | `number \| undefined` | `number \| undefined` (defaults to 4) | ✅ |
| `onSoftLimitReached` | `poolOptions?.onSoftLimitReached ?? defaultOnSoftLimit` | `(info: {...}) => void \| undefined` | ✅ |

The `...poolOptions` spread means any extra fields from a hypothetical external caller are passed through. No extra fields exist today.

### 3.2 persistState async signature ↔ callers

| Caller | `await`? | Impact if missing |
|--------|----------|-------------------|
| orchestrator.run() (line 174) | ✅ `await this.persistState()` | Correct |
| orchestrator.pause() (line 204) | ✅ `await this.persistState()` | Correct |
| orchestrator.resume() (line 243) | ✅ `await this.persistState()` | Correct |
| orchestrator.abort() (line 260) | ✅ `await this.persistState()` | Correct |
| orchestrator.retryNode() (line 309) | ✅ `await this.persistState()` | Correct |
| orchestrator.skipNode() (line 342) | ✅ `await this.persistState()` | Correct |
| orchestrator.handleWorkerMessage/return (line 471) | ✅ `await this.persistState()` | Correct |
| orchestrator.executeWithRetry (line 581) | ✅ `await this.persistState()` | Correct |
| orchestrator handleWorkerError (line 601) | ✅ `await this.persistState()` | Correct |
| orchestrator handleWorkerExit (line 629) | ✅ `await this.persistState()` | Correct |
| orchestrator handleScriptError (line 660) | ✅ `await this.persistState()` | Correct |
| orchestrator checkBudget (line 706) | ✅ `await this.persistState()` | Correct |
| orchestrator scheduleTimeBudgetCheck (line 733) | ✅ `await this.persistState()` | Correct |
| **index.ts session_shutdown (line 260)** | ❌ `orch.pause(inst.runId)` | State may not persist |
| **index.ts workflow tool (lines 338-340)** | ❌ `orch.pause/resume/abort()` | persistState errors lost |
| **index.ts fallback (line 374)** | ❌ `orch.persistState()` | persistState errors lost |

All **internal** orchestrator callers correctly `await`. Three **external** callers in `index.ts` are missing `await` — detailed in LOW-2 above.

### 3.3 reconstructState async signature ↔ callers

| Caller | `await`? |
|--------|----------|
| index.ts session_start (line 197) | ✅ `const instances = await reconstructState(ctx)` |
| index.ts session_tree (line 230) | ✅ `const instances = await reconstructState(ctx)` |

### 3.4 Dual `WorkflowBudget` types

**Finding (INFO-3):** Two unrelated interfaces share the name `WorkflowBudget`:
- `agent-pool.ts:99` — `{ total, used, remaining, isExhausted }` — callback parameter shape
- `state.ts:41` — `{ maxTokens?, maxCost?, maxTimeMs?, usedTokens, usedCost, _budgetWarningSent? }` — instance state shape

The orchestrator imports `WorkflowBudget` from `state.ts` (line 33) and uses it for `WorkflowInstanceSummary.budget`. The pool's `WorkflowBudget` is only used within the pool module and the callback signature. No code confuses the two because they're in separate modules with separate import paths. The naming collision is a maintenance hazard but not a current bug.

---

## 4. Additional Cross-Module Observations

### 4.1 Entry access pattern inconsistency in index.ts

- `reconstructState` (line 101): checks `entry.type !== "custom"` before casting and checking `custom.customType`. Defensive.
- Approval rehydration (line 187): checks `entry.customType === "workflow-approval-memory"` directly without guarding `entry.type`. Works because `CustomEntry` has `customType` defined and non-custom entries would have `customType` as `undefined`, making the comparison `false`.

Not a bug, but inconsistent defensive coding. Low risk.

### 4.2 Dead exports in state.ts

`ENTRY_TYPE`, `serializeState`, `deserializeState`, and `WorkflowStateEntry` are exported but no longer imported by any production code. `index.ts` removed these imports in the diff. Only `tests/state-budget.test.ts` still uses them. These can be cleaned up in a follow-up pass. Noted in BLR as INFO-1.

### 4.3 session_shutdown pause without await

The `session_shutdown` handler pauses all running workflows without awaiting. Since shutdown is a graceful cleanup event and the handler is `async`, adding `await Promise.all(running.map(inst => orch.pause(inst.runId)))` would be more correct. But Pi's shutdown timing constraints may not allow waiting for disk I/O. This is a judgment call.

---

## Issues Summary

### LOW Issues (4)

| ID | Severity | Boundary | Description | Impact |
|----|----------|----------|-------------|--------|
| LOW-1 | LOW | Pool→Orchestrator | `maybeEmitSoftWarning` passes hardcoded zero budget. Warning shows "Budget: 0/0 tokens" instead of real data. `?? "unlimited"` doesn't fire because `0` is not nullish. | Misleading user-facing warning. Threshold and single-fire behavior are correct. |
| LOW-2 | LOW | Orchestrator→index.ts | Three call sites invoke async orchestrator methods (`pause/resume/abort/persistState`) without `await`. Sync validation errors are caught; only `persistState()` disk failures become unhandled rejections. | Silent state persistence failure on disk errors. In-memory state always correct. Unhandled rejection may trigger process warning. |
| LOW-3 | LOW | AgentPool internal | `_callCache` (string-keyed) is effectively dead code. Orchestrator-level cache (numeric-keyed) prevents pool cache from ever being hit. Each enqueue generates a unique string callId. | Negligible memory overhead per pool instance. Architectural confusion for future maintainers. |
| LOW-4 | LOW | state.ts types | `Omit<ExecutionTraceNode, "verifyStrategy">` is a compile-time declaration, not a runtime strip. `serializeInstance` assigns `trace: instance.trace` directly, preserving `verifyStrategy` in JSON output. | No functional impact. Type says "stripped" but data retains it. Round-trip works correctly. |

### INFO Observations (3)

| ID | Description |
|----|-------------|
| INFO-1 | `ENTRY_TYPE`, `serializeState`, `deserializeState` in state.ts are dead production exports. Only tests reference them. |
| INFO-2 | `sessionDir` resolves to global `~/.pi/agent/` rather than per-session directory. State files don't follow session lifecycle. Collision risk is negligible (UUID runIds). |
| INFO-3 | Two distinct `WorkflowBudget` interfaces exist (agent-pool.ts and state.ts) with completely different shapes. Naming collision is a maintenance hazard. |

---

## BLR Cross-Reference

| BLR Issue | Integration View | Status |
|-----------|-----------------|--------|
| BLR LOW-1 (zero budget) | Confirmed as LOW-1 | No new evidence |
| BLR LOW-2 (dead pool cache) | Confirmed as LOW-3 | Root cause: orchestrator-level cache prevents pool-level hits |
| BLR LOW-3 (global sessionDir) | Confirmed as INFO-2 | Architectural decision, not a defect |
| BLR INFO-1 (dead exports) | Confirmed as INFO-1 | Cleanup candidate |
| BLR INFO-2 (type cast) | No new finding | Cast is correct for the stub type |
| — | **New: LOW-2** (missing awaits) | Not in BLR scope (module boundary issue) |
| — | **New: LOW-4** (Omit type lie) | Not in BLR scope (type-level concern) |
| — | **New: INFO-3** (dual WorkflowBudget) | Not in BLR scope (naming hazard) |

---

## Verdict

**PASS** — Module boundaries are structurally sound. The async signature migration is internally consistent (all orchestrator-internal callers correctly await). The three missing awaits in `index.ts` are a quality gap but not a correctness failure: in-memory state transitions are synchronous and always reflected correctly in responses. The persist-on-disk path has a small window for silent failure on edge-case disk errors, bounded by the session's in-memory correctness. All seven issues are LOW or INFO, none must-fix.
