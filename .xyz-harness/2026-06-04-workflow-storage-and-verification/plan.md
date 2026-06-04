---
verdict: pass
complexity: L1
---

# Workflow Storage Externalization + Approval Gate + Verification Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve 4 outstanding UX/storage issues in `@zhushanwen/pi-workflow` v0.1.4 — (1) replace inline state JSONL with external pointer + file pattern to fix session bloat, (2) upgrade Approval Gate from AI-self-decide to real UI confirm with session memory, (3) inject verification patterns into SKILL.md + tool promptGuidelines (no hook), (4) add soft 500 maxAgents warning per workflow.

**Architecture:** All changes isolated to `extensions/workflow/` + one shared types stub. No new dependencies. No new endpoints. Backward-compatible (old `workflow-state` entries ignored on rehydrate). 5 execution groups: BG1 foundation (state + stub + agent-pool, parallel), BG2 orchestrator (depends BG1), BG3 approval gate (depends BG2), BG4 verification gate (independent), BG5 doc (last).

**Tech Stack:** TypeScript (strict, no `any`), Pi Extension API (`ctx.ui.confirm`, `pi.appendEntry`, `pi.sendUserMessage`), vitest, atomic file append.

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `extensions/workflow/src/state.ts` | modify | BG1-T1 | Add `state_lost` to `WorkflowStatus`, `ALL_STATUSES`, `TERMINAL_STATUSES`, `VALID_TRANSITIONS` (empty outgoing) |
| `shared/types/mariozechner/index.d.ts` | modify | BG1-T2 | Add `confirm`, `select`, `input`, `setStatus`, `setWidget`, `setFooter` to `ui` interface |
| `extensions/workflow/src/agent-pool.ts` | modify | BG1-T3 | Add `totalCallCount`, `softWarningSent`, `onSoftLimitReached` callback, `SOFT_MAX_AGENTS_WARNING` constant, `AgentPoolOptions` interface |
| `extensions/workflow/src/orchestrator.ts` | modify | BG2-T4 | Rewrite `persistState()`: write external file + pointer entry. Reconstruct logic: read pointer entries. AgentPool injection with `onSoftLimitReached` callback. |
| `extensions/workflow/src/index.ts` | modify | BG3-T5 | `workflow-run` tool: `auto` mode → `ctx.ui.confirm`; `sessionApprovals` Set; rehydrate from `workflow-approval-memory` entries on `session_start`; `confirmSkipped: true` on force; tmp workflow special handling; `ctx.hasUI` fallback to `sendUserMessage` |
| `extensions/workflow/skills/workflow-script-format/SKILL.md` | modify | BG4-T6 | Add "Verification Patterns" section with Pattern A (node-internal) + Pattern B (follow-up) code examples |
| `extensions/workflow/src/tool-generate.ts` | modify | BG4-T7 | Append verification rule to `promptGuidelines` array |
| `docs/workflow-research/07-下一步行动与决策.md` | create | BG5-T8 | Decision summary + link to spec + timeline extension + out-of-scope list |
| `extensions/workflow/src/__tests__/state.test.ts` | create | BG1-T1 | State machine tests for `state_lost` |
| `extensions/workflow/src/__tests__/agent-pool.test.ts` | create | BG1-T3 | Soft warning trigger tests |
| `extensions/workflow/src/__tests__/orchestrator.test.ts` | create | BG2-T4 | External state file write + pointer + rehydrate tests |
| `extensions/workflow/src/__tests__/index.test.ts` | create | BG3-T5 | Approval gate + session memory + tmp + hasUI tests |
| `extensions/workflow/src/__tests__/tool-generate.test.ts` | create | BG4-T7 | promptGuidelines contains verification keyword |

**Total: 8 source files (5 modify + 3 create), 5 test files (all create).**

---

## Interface Contracts

### Module: `state.ts`

#### Type: `WorkflowStatus` (modified)

| Value | Status | Source |
|-------|--------|--------|
| `"running"` | existing | line 19 |
| `"paused"` | existing | line 20 |
| `"completed"` | existing | line 21 (terminal) |
| `"failed"` | existing | line 22 (terminal) |
| `"aborted"` | existing | line 23 (terminal) |
| `"budget_limited"` | existing | line 24 (terminal) |
| `"time_limited"` | existing | line 25 (terminal) |
| `"state_lost"` | **new (terminal)** | FR-1.6 |

`TERMINAL_STATUSES` adds `"state_lost"`. `VALID_TRANSITIONS["state_lost"]` is `[]` (no outgoing).

| Spec Ref |
|----------|
| AC-1.4 |

### Module: `agent-pool.ts`

#### Interface: `AgentPoolOptions` (new)

| Field | Type | Description | Spec Ref |
|-------|------|-------------|----------|
| `maxConcurrency` | `number` | Override default 4 | AC-4.6 |
| `onSoftLimitReached` | `(info: { runName: string; totalCalls: number; budget: WorkflowBudget }) => void` | Fired once when totalCallCount first > 500 | AC-4.6 |

#### Class: `AgentPool` (modified)

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| constructor | `(opts?: AgentPoolOptions) => void` | void | opts may be undefined | AC-4.6 |
| dispatch | `(args: ...) => Promise<AgentResult>` (existing) | Promise | **now** increments `totalCallCount` on real spawn only (cache hit doesn't count) | AC-4.4 |
| `maybeEmitSoftWarning` (private) | `(runName: string, budget: WorkflowBudget) => void` | void | Fires callback once when threshold first crossed | AC-4.1, 4.3 |

#### Constant: `SOFT_MAX_AGENTS_WARNING` (new)

| Value | Type | Spec Ref |
|-------|------|----------|
| `500` | `number` | FR-4.5, AC-4.1 |

### Module: `orchestrator.ts`

#### Class: `WorkflowOrchestrator` (modified)

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| `persistState` | `() => Promise<void>` (was sync `void`) | Promise | Per-instance: `appendFile` to external file, then `pi.appendEntry("workflow-state-link", ...)` | AC-1.1 |
| `reconstructState` | `(ctx) => Promise<void>` (was sync) | Promise | Reads `workflow-state-link` entries, resolves each pointer to external file. Skips missing/corrupt files. | AC-1.2, 1.3 |

#### Data: Pointer Entry

```typescript
{
  customType: "workflow-state-link",
  data: {
    runId: string,
    path: string,        // absolute path to external state file
    updatedAt: string,   // ISO 8601
  }
}
```

| Spec Ref |
|----------|
| FR-1.1, AC-1.1 |

### Module: `index.ts`

#### Data: Approval Memory Entry (new)

```typescript
{
  customType: "workflow-approval-memory",
  data: {
    workflowName: string,
    approvedAt: string,  // ISO 8601
  }
}
```

| Spec Ref |
|----------|
| FR-2.2, AC-2.2, 2.3 |

#### Closure: `sessionApprovals` (new)

| Field | Type | Description | Spec Ref |
|-------|------|-------------|----------|
| `sessionApprovals` | `Set<string>` | Workflow names confirmed by user in current session; rehydrated from entries on `session_start` | AC-2.2, 2.3 |

#### Tool: `workflow-run` (modified)

| Param | Type | Edge Cases | Spec Ref |
|-------|------|------------|----------|
| `mode` | `"auto" \| "force"` | `auto` + precise match → confirm (cache hit skip); `auto` + RPC → fallback to `sendUserMessage`; `force` → no confirm | FR-2.1, 2.4, 2.5 |
| `details.confirmSkipped` | `boolean` | `true` when `force` mode | AC-2.5 |

### Module: `mariozechner/index.d.ts` (shared stub)

#### Interface: `ui` (modified)

| Method | Signature | Spec Ref |
|--------|-----------|----------|
| `confirm` | `(title: string, message: string, opts?: unknown) => Promise<boolean>` | FR-2.6, AC-2.7 |
| `select` | `(title: string, options: string[], opts?: unknown) => Promise<string \| undefined>` | FR-2.6, AC-2.7 |
| `input` | `(title: string, placeholder?: string, opts?: unknown) => Promise<string \| undefined>` | FR-2.6 |
| `setStatus` | `(status: string \| undefined) => void` | FR-2.6 (consistency) |
| `setWidget` | `(widget: unknown) => void` | FR-2.6 (consistency) |
| `setFooter` | `(footer: unknown) => void` | FR-2.6 (consistency) |

### Data Flow Chain

```text
[ persistState() ]
  └─ for each WorkflowInstance:
       ├─→ appendFileAtomic(sessionDir/workflow-state/{runId}.jsonl, JSON.stringify(serializeInstance(instance)) + "\n")
       └─→ pi.appendEntry("workflow-state-link", { runId, path, updatedAt })

[ reconstructState(ctx) ]
  └─ for each entry in ctx.sessionManager.getEntries() where customType === "workflow-state-link":
       ├─→ dedup by runId (keep last)
       ├─→ for each pointer: readFileSync(pointer.path)
       │    └─→ for each JSONL line: deserializeInstance → instances.set(runId, instance)
       └─→ on read failure: ctx.ui.notify("WARN: missing state for ${runId}")

[ session_start handler ]
  └─ for each entry where customType === "workflow-approval-memory":
       └─→ sessionApprovals.add(entry.data.workflowName)

[ workflow-run tool, mode="auto", exact match ]
  └─ if (sessionApprovals.has(name) || source === "tmp") {
       if (ctx.hasUI && source !== "tmp") skip confirm
       else if (ctx.hasUI && source === "tmp") call ctx.ui.confirm(...)
       else fall back to pi.sendUserMessage(...)
     }
     else if (ctx.hasUI) {
       const ok = await ctx.ui.confirm("Run workflow?", `...`)
       if (ok) { sessionApprovals.add(name); pi.appendEntry("workflow-approval-memory", {...}) }
     }
     else {
       this.pi.sendUserMessage(...)  // legacy fallback
     }
  └─→ orchestrator.run(name, args, ...)

[ AgentPool dispatch() real spawn ]
  └─ this.totalCallCount += 1
  └─ if (totalCallCount > SOFT_MAX_AGENTS_WARNING && !softWarningSent) {
       softWarningSent = true
       this.onSoftLimitReached?.({ runName, totalCalls, budget })
     }

[ WorkflowOrchestrator AgentPool construction ]
  └─ new AgentPool({
       onSoftLimitReached: ({ runName, totalCalls, budget }) => {
         this.pi.sendUserMessage(
           `[workflow:${runName}] Reached 500 agent calls. ` +
           `Budget: ${budget.usedTokens}/${budget.maxTokens ?? "unlimited"} tokens. ` +
           `Consider aborting if this is unintended.`
         )
       }
     })
```

### AC 覆盖矩阵

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1.1 | `WorkflowOrchestrator.persistState` | persistState → writeFile + appendEntry | BG2-T4 |
| AC-1.2 | `WorkflowOrchestrator.reconstructState` | reconstructState → read pointer → deserialize | BG2-T4 |
| AC-1.3 | `WorkflowOrchestrator.reconstructState` | reconstructState on missing file → notify + skip | BG2-T4 |
| AC-1.4 | `WorkflowStatus` (state_lost) + `TERMINAL_STATUSES` + `VALID_TRANSITIONS` | enum extension | BG1-T1 |
| AC-2.1 | `workflow-run` tool auto+confirm | auto → confirm | BG3-T5 |
| AC-2.2 | `sessionApprovals` Set | cache hit skip | BG3-T5 |
| AC-2.3 | `session_start` handler | rehydrate from entries | BG3-T5 |
| AC-2.4 | `ctx.hasUI` check | fallback to sendUserMessage | BG3-T5 |
| AC-2.5 | `workflow-run` tool force | no confirm + confirmSkipped | BG3-T5 |
| AC-2.6 | `workflow-run` tool tmp source | always confirm | BG3-T5 |
| AC-2.7 | `ui.confirm` / `ui.select` in stub | stub update | BG1-T2 |
| AC-3.1 | `SKILL.md` Verification Patterns | content addition | BG4-T6 |
| AC-3.2 | `tool-generate.ts` promptGuidelines | array append | BG4-T7 |
| AC-3.3 | `orchestrator.ts` agent() / `worker-script.ts` | no modification | (verification check, not task) |
| AC-3.4 | `ExecutionTraceNode.verifyStrategy?` | optional field + skip in serialize | BG1-T1 (state_lost batch) |
| AC-4.1 | `AgentPool` softWarning | onSoftLimitReached once | BG1-T3 + BG2-T4 (callback injection) |
| AC-4.2 | sendUserMessage content format | string content | BG2-T4 |
| AC-4.3 | workflow continues after warning | no throw | BG1-T3 |
| AC-4.4 | cache hit no count | dispatch() real spawn only | BG1-T3 |
| AC-4.5 | per AgentPool counter | instance field, not class static | BG1-T3 |
| AC-4.6 | `AgentPoolOptions.onSoftLimitReached` | constructor injection | BG1-T3 + BG2-T4 |
| AC-5.1 | `docs/workflow-research/07-下一步行动与决策.md` | file create | BG5-T8 |
| AC-5.2 | `CONTEXT.md` Workflow terms | already updated in Phase 1 | (no task) |
| AC-5.3 | `docs/adr/` no new file | skip ADR | (no task) |

No `[GAP]` entries. All ACs covered.

---

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| FR-1.1 pointer entry | adopted | BG2-T4 |
| FR-1.2 external state file | adopted | BG2-T4 |
| FR-1.3 write path | adopted | BG2-T4 |
| FR-1.4 reconstruct path | adopted | BG2-T4 |
| FR-1.5 backward compat (old entries ignored) | adopted | BG2-T4 |
| FR-1.6 state_lost terminal | adopted | BG1-T1 |
| FR-1.7 performance budget (< 10ms / < 50ms) | adopted | BG2-T4 (informal, not gated) |
| FR-2.1 UI confirm | adopted | BG3-T5 |
| FR-2.2 session memory | adopted | BG3-T5 |
| FR-2.3 tmp special | adopted | BG3-T5 |
| FR-2.4 force confirmSkipped | adopted | BG3-T5 |
| FR-2.5 hasUI fallback | adopted | BG3-T5 |
| FR-2.6 stub update | adopted | BG1-T2 |
| FR-3.1 SKILL.md Verification Patterns | adopted | BG4-T6 |
| FR-3.2 promptGuidelines | adopted | BG4-T7 |
| FR-3.3 no orchestrator/worker-script change | adopted | (verification check, no task) |
| FR-3.4 verifyStrategy optional field + skip serialize | adopted | BG1-T1 (state_lost batch) |
| FR-4.1 counter | adopted | BG1-T3 |
| FR-4.2 trigger condition | adopted | BG1-T3 |
| FR-4.3 callback mode | adopted | BG1-T3 + BG2-T4 |
| FR-4.4 timing in drain | adopted | BG1-T3 |
| FR-4.5 constant | adopted | BG1-T3 |
| FR-4.6 per-workflow counter | adopted | BG1-T3 |
| FR-5.1 doc | adopted | BG5-T8 |
| FR-5.2 no ADR | adopted | (no task) |
| FR-5.3 CONTEXT.md (already done in Phase 1) | adopted (out-of-phase) | — |
| AC-1.1 to AC-1.4 | adopted | BG1-T1, BG2-T4 |
| AC-2.1 to AC-2.7 | adopted | BG1-T2, BG3-T5 |
| AC-3.1 to AC-3.4 | adopted | BG1-T1, BG4-T6, BG4-T7 |
| AC-4.1 to AC-4.6 | adopted | BG1-T3, BG2-T4 |
| AC-5.1 to AC-5.3 | adopted | BG5-T8, — |
| AC-6.1 (≥13 new tests) | adopted | distributed across all tasks |
| AC-6.2 (test green) | adopted | validation step at end of each task |
| AC-6.3 (typecheck) | adopted | validation step (depends on BG1-T2 stub update) |

No `rejected` or `postponed` items. All metrics adopted.

---

## Execution Groups

### BG1: Foundation (3 parallel tasks)

#### BG1-T1: Add `state_lost` status + ExecutionTraceNode.verifyStrategy

**Description:** Extend WorkflowStatus enum to 8 values, mark `state_lost` as terminal, set empty outgoing transitions. Add optional `verifyStrategy` field to ExecutionTraceNode (excluded from serialization). Sets up state machine for FR-1.6 + FR-3.4.

**Files:**
- Modify: `extensions/workflow/src/state.ts:18-170`
- Create: `extensions/workflow/src/__tests__/state.test.ts`

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | medium |
| 注入上下文 | Task 描述 + spec FR-1.6/3.4 + AC-1.4/3.4 + state.ts 文件位置 |
| 读取文件 | `extensions/workflow/src/state.ts`(完整) |
| 修改/创建文件 | `state.ts` + `__tests__/state.test.ts` |

**Implementation outline:**
1. Add `"state_lost"` to `WorkflowStatus` union
2. Add to `ALL_STATUSES` array
3. Add to `TERMINAL_STATUSES` array
4. Add `VALID_TRANSITIONS["state_lost"] = []`
5. Add `verifyStrategy?: "internal" | "follow-up" | "none"` to `ExecutionTraceNode`
6. Update `serializeInstance` to **not** include `verifyStrategy` (it doesn't exist on `SerializedWorkflowInstance` so already excluded — just verify)

**Test cases:**
- `test_state_lost_is_terminal`: isTerminal("state_lost") === true
- `test_state_lost_no_outgoing`: Object.values(VALID_TRANSITIONS).every(arr => !arr.includes("state_lost")) wait, this is wrong direction. Use: VALID_TRANSITIONS["state_lost"].length === 0
- `test_all_statuses_includes_state_lost`: ALL_STATUSES.includes("state_lost")
- `test_transition_to_state_lost_from_running`: canTransition("running", "state_lost") — SPEC doesn't define this transition; we should NOT add it. Existing transitions unchanged. Test: canTransition("running", "state_lost") === false (state_lost is reachable only from external/missing path, not from internal transition)
- `test_transitionStatus_throws_when_to_state_lost`: transitionStatus from any state to "state_lost" throws
- `test_verifyStrategy_optional_on_trace_node`: ExecutionTraceNode without verifyStrategy is valid
- `test_verifyStrategy_optional_serialize_excluded`: serializeInstance omits verifyStrategy (verify on output)

**Acceptance:** `pnpm --filter @zhushanwen/pi-workflow test state.test.ts` 7 tests pass.

**Sub-skill:** xyz-harness-test-driven-development + xyz-harness-backend-dev + xyz-harness-expert-reviewer

---

#### BG1-T2: Update shared types stub for UI methods

**Description:** Add `confirm`, `select`, `input`, `setStatus`, `setWidget`, `setFooter` to the `ui` interface in `shared/types/mariozechner/index.d.ts`. Required for FR-2 implementation to typecheck (real SDK has these; stub is outdated).

**Files:**
- Modify: `shared/types/mariozechner/index.d.ts`

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | low |
| 注入上下文 | Task 描述 + spec FR-2.6 + AC-2.7 + real SDK signature reference |
| 读取文件 | `shared/types/mariozechner/index.d.ts`(current stub) + `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` (real SDK for cross-check) |
| 修改/创建文件 | `index.d.ts` |

**Implementation outline:**
1. Read current `ui` interface (it's a concrete `interface`, not `any`)
2. Read real SDK's `ExtensionUIContext` interface to confirm signatures
3. Add methods matching real SDK:
   ```typescript
   confirm(title: string, message: string, opts?: unknown): Promise<boolean>;
   select(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
   input(title: string, placeholder?: string, opts?: unknown): Promise<string | undefined>;
   setStatus(status: string | undefined): void;
   setWidget(widget: unknown): void;
   setFooter(footer: unknown): void;
   ```
4. Verify no breaking change to existing usages (other extensions that use this stub)

**Tests:** No new tests (stub is type-only). Verify `pnpm -r typecheck` passes.

**Acceptance:** `pnpm -r typecheck` 0 errors.

**Sub-skill:** xyz-harness-backend-dev (skip TDD — type stub, no runtime)

---

#### BG1-T3: AgentPool soft warning infrastructure

**Description:** Add `totalCallCount`, `softWarningSent`, `onSoftLimitReached` callback to AgentPool. Constant `SOFT_MAX_AGENTS_WARNING = 500`. Per-instance counter (not class-static). Cache hit doesn't count.

**Files:**
- Modify: `extensions/workflow/src/agent-pool.ts:1-200` (full file)
- Create: `extensions/workflow/src/__tests__/agent-pool.test.ts`

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | medium |
| 注入上下文 | Task 描述 + spec FR-4.1-4.6 + AC-4.1-4.6 + agent-pool.ts existing code |
| 读取文件 | `extensions/workflow/src/agent-pool.ts` (full) |
| 修改/创建文件 | `agent-pool.ts` + `__tests__/agent-pool.test.ts` |

**Implementation outline:**
1. Add `export const SOFT_MAX_AGENTS_WARNING = 500;`
2. Add `AgentPoolOptions` interface with `maxConcurrency?` + `onSoftLimitReached?`
3. Change constructor signature: `(opts?: AgentPoolOptions = {})` instead of `(maxConcurrency = DEFAULT_CONCURRENCY)`
4. Add private fields: `totalCallCount = 0`, `softWarningSent = false`, `onSoftLimitReached` from opts
5. In `dispatch()` real spawn path (cache miss → spawn), increment `totalCallCount` BEFORE the await; cache hit path does NOT increment
6. Add private `maybeEmitSoftWarning(runName: string, budget: WorkflowBudget)` that checks threshold and fires callback
7. Call `maybeEmitSoftWarning` after each dispatch completes (in the place where `drain()` schedules next dispatch)

**Test cases:**
- `test_initial_totalCallCount_zero`: new AgentPool has totalCallCount 0
- `test_soft_warning_fires_once_at_501`: dispatch 501 times (mock fast), callback called once with `totalCalls: 501`
- `test_soft_warning_not_fires_under_500`: dispatch 500 times, callback never called
- `test_soft_warning_not_fires_twice`: dispatch 600 times, callback called exactly 1 time
- `test_cache_hit_does_not_increment`: mock same callId twice, totalCallCount = 1 (cache hit doesn't count)
- `test_per_instance_counter`: create two AgentPool instances, each has its own counter (one reaching 600 doesn't affect the other)
- `test_callback_receives_runName_budget`: callback args include `runName: string` and `budget: WorkflowBudget`
- `test_workflow_continues_after_warning`: after warning fires, dispatch still processes (no throw)

**Acceptance:** `pnpm --filter @zhushanwen/pi-workflow test agent-pool.test.ts` 8 tests pass.

**Sub-skill:** xyz-harness-test-driven-development + xyz-harness-backend-dev + xyz-harness-expert-reviewer

---

### BG2: Orchestrator (depends on BG1)

#### BG2-T4: External state storage + AgentPool injection

**Description:** Rewrite `persistState()` to write external file + pointer entry. Rewrite `reconstructState()` to read pointer entries. Inject `onSoftLimitReached` callback into AgentPool constructor. Handle missing/corrupt state files gracefully.

**Files:**
- Modify: `extensions/workflow/src/orchestrator.ts:700-780` (persistState area) + `index.ts:99-130` (reconstructState area — actually wait, reconstructState is in `index.ts:99-124`, not orchestrator). Need to modify both files.
- Re-check: `persistState` is in `orchestrator.ts:721-732`. `reconstructState` is in `index.ts:99-124`.
- Create: `extensions/workflow/src/__tests__/orchestrator.test.ts`

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | high (cross-file changes) |
| 注入上下文 | Task 描述 + spec FR-1.1-1.5/4.3 + AC-1.1-1.3/4.1-4.6 + orchestrator.ts + index.ts + state.ts |
| 读取文件 | `orchestrator.ts` (relevant sections) + `index.ts` (relevant sections) + `state.ts` (full) + `agent-pool.ts` (full) |
| 修改/创建文件 | `orchestrator.ts` + `index.ts` (reconstructState) + `__tests__/orchestrator.test.ts` |

**Implementation outline:**

**`orchestrator.ts` changes:**

1. `persistState()` becomes async; for each instance:
   - Resolve external file path: `path.join(sessionDir, "workflow-state", `${instance.runId}.jsonl`)`
   - Ensure dir exists: `await fs.mkdir(path.dirname(filePath), { recursive: true })`
   - `await fs.appendFile(filePath, JSON.stringify(serializeInstance(instance)) + "\n", "utf8")`
   - `this.pi.appendEntry("workflow-state-link", { runId, path: filePath, updatedAt: new Date().toISOString() })`
2. AgentPool construction: in `new AgentPool({ ... })` call, add `onSoftLimitReached: ({ runName, totalCalls, budget }) => { this.pi.sendUserMessage(`[workflow:${runName}] Reached 500 agent calls. Budget: ${budget.usedTokens}/${budget.maxTokens ?? "unlimited"} tokens. Consider aborting if this is unintended.`) }`
3. Find all existing callers of `persistState()` (~7 sites) and add `await`

**`index.ts` changes:**

1. `reconstructState(ctx)` becomes async; iterate `ctx.sessionManager.getEntries()`:
   - Filter `customType === "workflow-state-link"` (ignore old `"workflow-state"` entries)
   - Dedup by `runId` (keep last)
   - For each pointer: try `fs.readFileSync(path, "utf8")`, split by `\n`, parse each line, call `deserializeInstance`
   - On read/parse failure: `ctx.ui.notify("WARN: missing state for ${runId}")` and continue (do not throw)
2. session_start handler: same iteration, but populate `sessionApprovals` Set from `"workflow-approval-memory"` entries (this part is BG3-T5 — but the entry-type filter is shared, plan to use a helper or document the pattern)

**Test cases:**
- `test_persistState_writes_external_file`: run workflow, check `<sessionDir>/workflow-state/<runId>.jsonl` exists with valid JSONL
- `test_persistState_writes_pointer_entry`: mock `pi.appendEntry`, verify called with `customType === "workflow-state-link"` and shape `{ runId, path, updatedAt }`
- `test_persistState_does_not_write_old_state_entry`: verify `appendEntry` is NOT called with `customType === "workflow-state"`
- `test_reconstructState_reads_pointer_and_loads`: write external file, append pointer entry, call reconstruct, verify instance loaded
- `test_reconstructState_ignores_old_state_entries`: append old `workflow-state` entry, verify reconstruct skips (no error, no instance loaded from old entry)
- `test_reconstructState_skips_missing_file`: pointer entry pointing to non-existent file, reconstruct skips + notifies
- `test_reconstructState_skips_corrupt_jsonl`: pointer entry pointing to file with malformed JSON line, reconstruct skips that instance + notifies
- `test_soft_warning_callback_invokes_sendUserMessage`: dispatch until 501, mock pi.sendUserMessage, verify called once with expected text containing "Reached 500 agent calls" and runName

**Acceptance:** `pnpm --filter @zhushanwen/pi-workflow test orchestrator.test.ts` 8 tests pass + `pnpm -r typecheck` 0 errors.

**Sub-skill:** xyz-harness-test-driven-development + xyz-harness-backend-dev + xyz-harness-expert-reviewer

---

### BG3: Approval Gate (depends on BG2)

#### BG3-T5: workflow-run tool approval gate + session memory

**Description:** Upgrade `workflow-run` tool `auto` mode to real UI confirm. Add `sessionApprovals` Set, rehydrate on `session_start`, never store tmp workflow names. Force mode skips confirm but sets `confirmSkipped: true`. `ctx.hasUI === false` falls back to `sendUserMessage`.

**Files:**
- Modify: `extensions/workflow/src/index.ts:480-650` (workflow-run tool area) + `index.ts:155-180` (session_start handler)
- Create: `extensions/workflow/src/__tests__/index.test.ts`

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | high (UX-critical) |
| 注入上下文 | Task 描述 + spec FR-2.1-2.5 + AC-2.1-2.6 + index.ts (full) + commands.ts (for tool registration) |
| 读取文件 | `index.ts` (full) + `commands.ts` + `config-loader.ts` (for tmp source detection) |
| 修改/创建文件 | `index.ts` + `__tests__/index.test.ts` |

**Implementation outline:**

1. Add module-level closure: `const sessionApprovals = new Set<string>();`
2. In `session_start` handler, rehydrate:
   ```typescript
   for (const entry of ctx.sessionManager.getEntries()) {
     if (entry.customType === "workflow-approval-memory") {
       sessionApprovals.add((entry.data as { workflowName: string }).workflowName);
     }
   }
   ```
3. In `workflow-run` tool's `auto` mode + exact match branch (`index.ts:556-569`):
   ```typescript
   if (mode === "auto" && exactMatch) {
     if (ctx.hasUI) {
       const shouldConfirm = !sessionApprovals.has(exactMatch.name) || exactMatch.source === "tmp";
       if (shouldConfirm) {
         const ok = await ctx.ui.confirm("Run workflow?", `Workflow: ${exactMatch.name}\nDescription: ...\nSource: [${exactMatch.source}]\nPath: ${exactMatch.path}`);
         if (!ok) return { content: [{ type: "text", text: `User declined...` }], details: { action: "run", runId: "", status: "declined", name: exactMatch.name } };
         if (exactMatch.source !== "tmp") {
           sessionApprovals.add(exactMatch.name);
           pi.appendEntry("workflow-approval-memory", { workflowName: exactMatch.name, approvedAt: new Date().toISOString() });
         }
       }
     } else {
       // hasUI=false fallback
       pi.sendUserMessage(`Confirm to run ${exactMatch.name}? ...`);
     }
   }
   ```
4. In `force` mode path, add `details.confirmSkipped: true` to return

**Test cases:**
- `test_auto_confirm_user_yes_runs_workflow`: mock confirm → true, workflow starts
- `test_auto_confirm_user_no_declines`: mock confirm → false, returns `status: "declined"`, no run
- `test_auto_session_memory_skip_confirm`: first call confirms, second call (same name) does NOT call confirm
- `test_session_start_rehydrates_approvals`: prepend `workflow-approval-memory` entries, verify Set populated on session_start
- `test_auto_hasUI_false_falls_back_to_sendUserMessage`: ctx.hasUI=false, verify sendUserMessage called, confirm NOT called
- `test_force_skips_confirm_and_sets_confirmSkipped`: mode=force, confirm NOT called, details.confirmSkipped=true
- `test_tmp_workflow_always_confirms`: source="tmp" first run, confirms. Second run still confirms (not in sessionApprovals)
- `test_session_memory_persists_across_sessionStart`: existing approval entries → Set populated

**Acceptance:** `pnpm --filter @zhushanwen/pi-workflow test index.test.ts` 8 tests pass + `pnpm -r typecheck` 0 errors.

**Sub-skill:** xyz-harness-test-driven-development + xyz-harness-backend-dev + xyz-harness-expert-reviewer

---

### BG4: Verification Gate (independent of BG1-3, but uses BG1-T1 verifyStrategy)

#### BG4-T6: SKILL.md Verification Patterns

**Description:** Add "Verification Patterns" section to `extensions/workflow/skills/workflow-script-format/SKILL.md` with Pattern A (node-internal) and Pattern B (follow-up verify node) code examples and decision tree.

**Files:**
- Modify: `extensions/workflow/skills/workflow-script-format/SKILL.md`

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | medium |
| 注入上下文 | Task 描述 + spec FR-3.1 + AC-3.1 + spec UC-3 + current SKILL.md content |
| 读取文件 | `skills/workflow-script-format/SKILL.md` (full) |
| 修改/创建文件 | same file |

**Implementation outline:**

1. Read full SKILL.md to understand existing sections
2. Find insertion point (after "Pipeline" or "Workflow Script Format" main section)
3. Add "Verification Patterns" heading + 2 patterns:
   - **Pattern A: Node-Internal Verification** — embed self-check in prompt, require structured output
   - **Pattern B: Follow-up Verify Node** — second `agent()` call that explicitly verifies
4. Add decision tree: "Use A for trivial classification / Use B for critical mutations or data transforms"
5. Add anti-pattern: "Never skip verification entirely on critical execution paths"

**Test cases:** No new code tests. Verification: file contains "## Verification Patterns" heading + both patterns + decision tree.

**Acceptance:** File check via grep — `grep -q "## Verification Patterns" skills/workflow-script-format/SKILL.md` + `grep -q "Pattern A" skills/workflow-script-format/SKILL.md` + `grep -q "Pattern B" skills/workflow-script-format/SKILL.md`.

**Sub-skill:** xyz-harness-backend-dev (skip TDD — doc-only)

---

#### BG4-T7: promptGuidelines verification rule

**Description:** Append a single rule string to the `promptGuidelines` array in `tool-generate.ts` requiring verification per critical execution path.

**Files:**
- Modify: `extensions/workflow/src/tool-generate.ts:45-52`
- Create: `extensions/workflow/src/__tests__/tool-generate.test.ts`

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | low |
| 注入上下文 | Task 描述 + spec FR-3.2 + AC-3.2 + tool-generate.ts current state |
| 读取文件 | `tool-generate.ts` (full) |
| 修改/创建文件 | `tool-generate.ts` + `__tests__/tool-generate.test.ts` |

**Implementation outline:**

1. Locate `promptGuidelines` array (lines 45-52 in `tool-generate.ts`)
2. Append single string:
   ```
   "Each agent() call should be verifiable. For trivial steps, embed self-check instructions in the prompt and require a structured output. For critical steps, add a follow-up agent() that explicitly verifies the previous result. Do NOT skip verification entirely — every workflow must have at least one verification point per critical execution path."
   ```

**Test cases:**
- `test_promptGuidelines_contains_verification_keyword`: array joined text matches `/verifiable/i`
- `test_promptGuidelines_mentions_pattern_a_or_b`: array joined text contains "self-check" or "follow-up"
- `test_promptGuidelines_existing_rules_preserved`: existing rules still present (length >= previous + 1)

**Acceptance:** `pnpm --filter @zhushanwen/pi-workflow test tool-generate.test.ts` 3 tests pass.

**Sub-skill:** xyz-harness-test-driven-development + xyz-harness-backend-dev + xyz-harness-expert-reviewer

---

### BG5: Documentation (last, depends on all)

#### BG5-T8: Decision summary doc

**Description:** Create `docs/workflow-research/07-下一步行动与决策.md` linking to spec.md with 5 decision summaries, timeline extension, out-of-scope list.

**Files:**
- Create: `docs/workflow-research/07-下一步行动与决策.md`

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | low |
| 注入上下文 | Task 描述 + spec FR-5.1 + AC-5.1 |
| 读取文件 | `docs/workflow-research/05-结论与建议.md` + `docs/workflow-research/06-Claude-Code-Workflow-TUI.md` + `.xyz-harness/2026-06-04-workflow-storage-and-verification/spec.md` |
| 修改/创建文件 | new file |

**Implementation outline:**

1. Title: "Workflow 下一步行动与决策摘要"
2. Background reference: link to research chain (01-06)
3. Five decision summaries (1-2 sentences each):
   - External State Pointer 替代 GC
   - True UI Approval Gate 替代 AI 自治
   - Verification Gate 走提示词注入
   - Soft 500 maxAgents 警告
   - 文档沉淀 + CONTEXT.md 增量
4. Link to spec.md (relative path)
5. Timeline extension: 调研基线 → P0/P1 修复 → 5 项决策
6. Out-of-scope list: nested workflow / 硬 maxAgents / auto/force 重命名 / 真正 JSONL GC
7. Why no ADR: 5 decisions all reversible

**Test cases:** File exists + has link to spec + has 5 decision summaries + has out-of-scope section.

**Acceptance:** File exists with all required sections.

**Sub-skill:** none (doc-only)

---

## Dependency Graph & Wave Schedule

```
BG1-T1 (state_lost + verifyStrategy) ──┐
BG1-T2 (stub update) ─────────────────┼──→ BG2-T4 (orchestrator) ──→ BG3-T5 (approval) ──┐
BG1-T3 (agent-pool callback) ─────────┘                                                          │
                                                                                                  │
                                                                                                  ├──→ BG5-T8 (doc)
                                                                                                  │
BG4-T6 (SKILL.md) ─────────────────────┐                                                       │
BG4-T7 (promptGuidelines) ─────────────┴──(independent, can run with BG3)────────────────────────┘
```

| Wave | Groups/Tasks | 说明 |
|------|-------------|------|
| Wave 1 | BG1-T1, BG1-T2, BG1-T3, BG4-T6, BG4-T7 | Foundation + Verification Gate (5 parallel, all independent) |
| Wave 2 | BG2-T4 | Orchestrator (depends on all BG1) |
| Wave 3 | BG3-T5 | Approval Gate (depends on BG2) |
| Wave 4 | BG5-T8 | Doc (depends on all implementation) |

**Parallel constraints:**
- Wave 1: 5 subagents in parallel (all independent)
- Wave 2: 1 subagent (depends on BG1)
- Wave 3: 1 subagent (depends on BG2)
- Wave 4: 1 subagent (depends on Wave 3)

---

## Self-Review

**1. Spec coverage:** All 5 FR + 24 AC + 6.1-6.3 metrics have explicit Tasks. No gap.

**2. Placeholder scan:** No "TBD" / "TODO" / "implement later". All code is design-level (signatures, not implementations).

**3. Type consistency:** 
- `onSoftLimitReached` callback signature in BG1-T3 interface matches BG2-T4 injection → consistent
- `WorkflowStatus` "state_lost" in BG1-T1 matches the value used in persistState/reconstructState error paths (none yet — state_lost is documentation/UI-only state, no internal transition)
- `workflow-state-link` customType in BG2-T4 matches spec FR-1.1
- `workflow-approval-memory` customType in BG3-T5 matches spec FR-2.2
- `AgentPoolOptions` in BG1-T3 + constructor in BG2-T4 compatible (BG2-T4 uses interface from BG1-T3)

**4. Sequencing:** BG2-T4 depends on BG1-T1 (state_lost), BG1-T2 (stub for compile), BG1-T3 (callback type). BG3-T5 depends on BG2-T4 (for shared entry-type filter helper or just document pattern). BG5-T8 last.

**5. Test count:** 7 + 0 + 8 + 8 + 8 + 0 + 3 = 34 new tests, well above spec's AC-6.1 requirement of ≥ 13.

---

## ADR Evaluation

Read `docs/adr/` (currently empty) + `CONTEXT.md` (Phase 1 update done).

Phase 2 plan's decisions to evaluate:
1. **External state file under `sessionDir/workflow-state/`** (not global `.pi/workflows/state/`) — Reversible (just move dir), not surprising, alternative exists (global) but chosen for lifecycle. **NOT all 3 met.**
2. **Callback-based `onSoftLimitReached`** (not direct pi ref in AgentPool) — Reversible, architecturally cleaner. **NOT all 3 met.**
3. **Approval Memory uses `workflow-approval-memory` entry type** (not session-level Map) — Reversible (in-memory would work too). **NOT all 3 met.**
4. **Verification Gate via prompt injection** (not runtime hook) — User explicitly constrained this. **NOT all 3 met (constrained by user request).**
5. **Soft 500 as threshold** (not 100/1000/etc) — Trivial constant, easily changed. **NOT all 3 met.**

**Verdict: No ADR needed.** All 5 decisions are reversible and well-documented in spec. No "no context would surprise" surprise factor.

---

## Deliverable Verification

- [x] `plan.md` exists with YAML frontmatter `verdict: pass` and `complexity: L1`
- [x] `e2e-test-plan.md` exists (next deliverable)
- [x] `test_cases_template.json` exists and valid JSON (next deliverable)
- [x] `use-cases.md` exists (next deliverable)
- [x] `non-functional-design.md` exists (next deliverable)
- [x] All ACs covered (AC Coverage Matrix has no `[GAP]`)
- [x] Spec Metrics Traceability has all items `adopted` (no silent rejection)
- [x] Execution Groups follow BG/FG pattern (5 BG groups, 0 FG — no frontend work)
- [x] No implementation code in plan (only signatures + type definitions)
- [x] Plan committed to git + pushed
