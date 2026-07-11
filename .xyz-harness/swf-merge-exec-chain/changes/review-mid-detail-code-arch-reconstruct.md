# Mid-Detail Code-Arch Reconstruction Review — swf-merge-exec-chain

> Independent reviewer (mid-detail-plan / code-arch contract + test-matrix blind reconstruction).  
> Step 0 machine check: PASS (read `.xyz-harness/swf-merge-exec-chain/changes/machine-check-code-arch.md`).  
> This review: (1) reconstruct test cases from §4 sequence-diagram alt/else branches + NFR mitigation rollbacks (without reading §6 first), (2) compare with §6 test-matrix, (3) check signature table vs skeletons, (4) wiring-level annotations, (5) skeleton quality, (6) decision consistency.

---

## 1. Reconstructed Test Matrix (from §4 + NFR)

### 1.1 Reconstruction rules

- Layers follow the mid-detail schema: **mock** (≈ unit) for source-A functional cases, **unit/integration/e2e** for source-B NFR mitigations (see `test-case-schema.md` mapping: `unit`≈pure-function mock; `integration`≈real subprocess/state; `e2e`≈full workflow-script execution).
- `dependsOn`/`parallelGroup` are inferred from execution order and resource constraints. Cases with no dependency are root; `parallelGroup` groups cases that can share the same mock environment.

### 1.2 UC-3: workflow orchestrated agent execution (source A)

Reconstructed from §4 UC-3 sequence diagram + method signature table.

| ID | Type | Layer | Scenario | dependsOn | parallelGroup |
|----|------|-------|----------|-----------|---------------|
| T3.1 | normal | mock | SAR delegates to executeAndAwait; result.content = ok | — | g-uc3-mock |
| T3.2 | normal | mock | parsedOutput passes through (structured-output contract) | — | g-uc3-mock |
| T3.3 | error | mock | executeAndAwait internal failure returns `{success:false,error}`; SAR returns AgentResult.error | — | g-uc3-mock |
| T3.4 | boundary | mock | cwd passes through to ExecuteOptions (non-git worktree) | — | g-uc3-mock |
| T3.5 | boundary | mock | model fallback: opts.model undefined → ctxModel | — | g-uc3-mock |
| T3.6 | error | mock | timeoutMs merges into AbortSignal; abort → AgentResult.error | — | g-uc3-mock |
| T3.7 | normal | mock | onEvent bridge: AgentEvent delivered to workflow liveRecord | — | g-uc3-mock |
| T3.8 | error | mock | nesting depth > MAX → ForkDepthExceededError → SAR catch → AgentResult.error | — | g-uc3-mock |
| T3.9 | boundary | mock | schemaEnv passes through to ExecuteOptions | — | g-uc3-mock |
| T3.10 | state | mock | executeAndAwait does not trigger followUp/sendMessage | — | g-uc3-mock |
| T3.11 | boundary | mock | schemaEnv absent → childEnv has no PI_WORKFLOW_SCHEMA | — | g-uc3-mock |
| T3.12 | normal | e2e | Full chain: real spawn pi via workflow script agent() | T3.1 | g-uc3-real |

### 1.3 UC-4: subagent tool direct execution (regression path)

Reconstructed from §4 UC-4 sequence diagram (sync/background alt).

| ID | Type | Layer | Scenario | dependsOn | parallelGroup |
|----|------|-------|----------|-----------|---------------|
| T4.1 | normal | mock | tool execute(sync) unchanged | — | g-uc4-mock |
| T4.2 | normal | mock | tool execute(background) unchanged | — | g-uc4-mock |
| T4.3 | boundary | mock | tool layer ExecuteOptions.schemaEnv is undefined | — | g-uc4-mock |

### 1.4 UC-5: pi.__workflowRun downstream (penetration to UC-3)

Reconstructed from §4 UC-5 sequence diagram.

| ID | Type | Layer | Scenario | dependsOn | parallelGroup |
|----|------|-------|----------|-----------|---------------|
| T5.1 | normal | mock | pi.__workflowRun signature + return shape unchanged | T3.1 | g-uc5-mock |
| T5.2 | error | mock | agent throws inside script → reason=failed | T3.1 | g-uc5-mock |
| T5.3 | state | mock | pending:register/unregister paired | T3.1 | g-uc5-mock |

### 1.5 Source B: NFR mitigation → test case mapping

Reconstructed from non-functional-design.md §缓解项回灌登记表.

| ID | Layer | Mitigation | dependsOn | parallelGroup |
|----|-------|------------|-----------|---------------|
| T3.13 | integration | executeAndAwait exception branches call finalizeFailed (no record leak) | T3.3 | g-nfr-integr |
| T3.14 | unit | AgentResult mapping: text→content, !success→error, usage/toolCalls/parsedOutput pass through | — | g-nfr-unit |
| T3.15 | integration | executeAndAwait emits pending:register/unregister | T3.1 | g-nfr-integr |
| T3.16 | unit | schemaEnv absent → childEnv has no PI_WORKFLOW_SCHEMA | T3.11 | g-nfr-unit |
| T3.17 | integration | mergeTimeoutSignal cleans listeners after timeout | T3.6 | g-nfr-integr |
| T3.18 | integration | dispose kills all workflow-spawned children (spawnedChildren coverage) | T3.1 | g-nfr-integr |
| T3.19 | unit | AgentCallOpts→ExecuteOptions mapping fidelity (systemPromptFiles skip, skillPath/cwd pass, model fallback) | T3.5 | g-nfr-unit |
| T3.20 | integration | withSlot does not independently acquire pool slots (abort thin wrapper) | T3.1 | g-nfr-integr |
| T3.21 | integration | projectLiveProgress migration retained (WorkflowsView live render) | T3.7 | g-nfr-integr |
| T5.4 | integration | coding-workflow import forms + tsc green | T5.1 | g-nfr-integr |

---

## 2. Comparison with §6 Test-Matrix

| Finding | Type | Detail | Verdict |
|---------|------|--------|---------|
| §6 Source A (UC-3/4/5) and Source B (NFR) case IDs and coverage match reconstruction | — | T3.1–T3.12, T4.1–T4.3, T5.1–T5.3, T3.13–T3.21, T5.4 are all present and consistent | ✅ OK |
| §6 tables omit `dependsOn` and `parallelGroup` columns | MISSING | MidDetailSchema requires these fields for workflow test scheduling; no dependency or concurrency grouping is recorded in the markdown tables. They are only implied by UC ordering. | ⚠️ Mismatch |
| §6 Source A uses `mock`/`real`; Source B uses `unit`/`integration` | — | Matches `test-case-schema.md` guidance for mid-detail (Source A = mock/real, Source B = unit/integration/e2e/perf-chaos) | ✅ OK |
| §6 Source 0 (existing test reuse) is not a new test case inventory | — | Existing tests to rewrite/keep are correctly listed as a separate reuse table, not mixed with new cases. | ✅ OK |
| T3.12 (e2e real) is in §6 but not strictly derivable from §4 alt/else alone | PHANTOM-ish | It is a coverage addition derived from the "每个 UC 的正常/边界/异常/状态 4 类齐全" self-check and the `e2e` real-layer requirement, not from an alt/else branch. It is reasonable. | ℹ️ Not a defect |

### Summary of §6 comparison

- **No MISSING cases** relative to §4 + NFR reconstruction.
- **No PHANTOM cases** that cannot be traced back to §4 sequence-diagram branches, NFR mitigations, or the mid-detail coverage checklist.
- **One MISMATCH**: §6 tables do not include `dependsOn`/`parallelGroup`. These are required by the mid-detail test-case schema and the workflow test scheduler (ADR-029). They should be added as explicit columns or a separate schedule block before the plan is handed to execution.

---

## 3. Signature Table vs Skeleton Files

| §3 Signature | Skeleton File | Line | Status | Note |
|--------------|---------------|------|--------|------|
| `SubagentService.executeAndAwait` | `code-skeleton/execution/subagent-service-extend.ts` | 8 | ✅ Defined | Exported interface + `executeAndAwaitImpl` function; merge-time class insertion required. |
| `SubagentService.runAndFinalize` (schemaEnv pass-through) | `code-skeleton/execution/session-runner-extend.ts` | `buildRunOptionsPatch` | ✅ Defined | RunOptions patch carries `schemaEnv` + external `onEvent`. |
| `SubprocessAgentRunner.constructor` | `code-skeleton/execution/subprocess-agent-runner.ts` | 18 | ✅ Defined | Per-session deps `{subagentService, ctxModel}` match D-008. |
| `SubprocessAgentRunner.run` | `code-skeleton/execution/subprocess-agent-runner.ts` | 24 | ✅ Defined | Calls `mergeTimeoutSignal`, `mapToExecuteOptions`, `executeAndAwait`, `bridgeOnEvent`. |
| `mergeTimeoutSignal` | `code-skeleton/execution/execute-options-mapper.ts` | 38 | ✅ Defined | Returns merged AbortSignal with listener cleanup. |
| `mapToExecuteOptions` | `code-skeleton/execution/execute-options-mapper.ts` | 8 | ✅ Defined | Maps fields per D-A2/D-008/D-A6. |
| `mapToWorkflowAgentResult` | `code-skeleton/execution/agent-result-mapper.ts` | 6 | ✅ Defined | Pure DTO mapping D-A10. |
| `session-runner.runSpawn` (schemaEnv) | `code-skeleton/execution/session-runner-extend.ts` | `applySchemaEnvToChildEnv` | ✅ Defined | Injects `PI_WORKFLOW_SCHEMA` conditionally. |
| `AgentRunner.run` (port onEvent upgrade) | `code-skeleton/orchestration/models/ports.ts` | 16 | ✅ Defined | `onEvent?: (e: AgentEvent) => void`. |
| `error-recovery.dispatchAgentCall onEvent` | `code-skeleton/orchestration/error-recovery-onevent.ts` | 8 | ✅ Defined | Calls `updateFromEvent(liveRecord, event)`. |

### Orphan methods

- **No orphan methods** in §3 relative to skeletons. All public/contract methods listed in the signature table are present in the skeleton files.
- The inverse also holds: no skeleton method is unaccounted for in §3.

---

## 4. Wiring-Level Annotation Check

| Module | Annotation in §3 | Skeleton annotation | Assessment |
|--------|------------------|---------------------|------------|
| `execution/subagent-service.ts` | [模块内直调] | `this.runAndFinalize`, `this.resolveIdentity`, `this.createRecordForMode`, `mapToWorkflowAgentResult` | ✅ Consistent: same-class / same-package calls. |
| `execution/subprocess-agent-runner.ts` | [模块内直调] + [跨模块 port] | implements `AgentRunner`; calls `mapToExecuteOptions`, `mergeTimeoutSignal`, `this.subagentService.executeAndAwait` | ✅ Consistent: port is cross-layer; internal calls are within execution. |
| `execution/execute-options-mapper.ts` | [模块内直调] / [adapter 真引 SDK] | Uses `AbortController`, `setTimeout`, `addEventListener` | ✅ Consistent: AbortSignal adapter is real Web API. |
| `execution/session-runner.ts` | [模块内直调] | `applySchemaEnvToChildEnv` sets `childEnv.PI_WORKFLOW_SCHEMA` | ✅ Consistent. |
| `execution/agent-result-mapper.ts` | [模块内直调] | Pure DTO mapping | ✅ Consistent. |
| `orchestration/models/ports.ts` | [跨模块 port] | `interface AgentRunner` | ✅ Consistent. |
| `orchestration/error-recovery.ts` | [模块内直调] | `updateFromEvent(liveRecord, event)` | ✅ Consistent. |

**No mis-labeled wiring** found. The dependency-direction locks in §1/§2 are respected by the skeleton imports:
- `execution` imports `orchestration/models/ports.ts` only for types (cross-layer port).
- `orchestration` imports `execution/execution-record.ts` and `shared/agent-event.ts` for types/values, which is allowed by the "port + shared types" exception.
- No import from `execution` back into `orchestration` business logic.

---

## 5. Skeleton Code Quality

| Check | Machine-check claim | Skeleton reality | Finding |
|-------|---------------------|------------------|---------|
| `TODO` / `FIXME` | none | none | ✅ OK |
| `any` / `type-ignore` / `nolint` | none | none | ✅ OK |
| Placeholder comments | none | `subagent-service-extend.ts` contains `const _parentNesting = undefined; // = this.execCtxAls.getStore();` and `const nestingDepth = _parentNesting ? 1 : 0; // = parentNesting.depth + 1 : 0` | ⚠️ Placeholder present in nesting-depth guard (BC-12). Must be replaced with actual `execCtxAls.getStore()` during merge. |
| Type assertions | none | `execute-options-mapper.ts` line `} as ExecuteOptions & { schemaEnv?: string };` | ⚠️ Temporary `as` assertion because `schemaEnv` is declared as an incremental field in `shared/types.ts` but not yet merged into the real `ExecuteOptions`. Must be removed after the merge adds the field. |
| Function length | ≤ 300 lines | All skeleton functions < 80 lines | ✅ OK |
| File length | ≤ 1000 lines | Largest file ~147 lines | ✅ OK |

### Summary of skeleton quality

- No `TODO`/`FIXME`/`any`/`type-ignore`/eslint-disable.
- **Two merge-time placeholders** need to be closed before implementation is complete:
  1. `_parentNesting` placeholder in `subagent-service-extend.ts` (BC-12 guard).
  2. `as ExecuteOptions & { schemaEnv?: string }` in `execute-options-mapper.ts` (type field merge).

Both are expected skeleton artifacts, but they should be tracked as implementation tasks or the machine-check "PASS" is misleading.

---

## 6. Decision Consistency Check

| Decision | Contract | Skeleton/Code-Arch Position | Verdict |
|----------|----------|------------------------------|---------|
| D-000 | Merge into one package | Single `extensions/subagents-workflow/` layout in §1/§7 | ✅ OK |
| D-001 | T1 scope = merge + execution chain only | §7 defers T2 (sync removal, pool, notifications) and T3 (scripts, docs) | ✅ OK |
| D-002 | New package version 1.0.0 | Package metadata in §1/§7 | ✅ OK |
| D-003 | Unified AgentRegistry | §7 deletes `orchestration/agent-discovery.ts`, uses `execution/agent-registry.ts` | ✅ OK |
| D-004 | Old packages untouched | §7/§12 state old packages remain | ✅ OK |
| D-005 | Typed onEvent, delete jsonl-to-agent-event | `ports.ts` onEvent AgentEvent; `error-recovery-onevent.ts` removes JSONL translation | ✅ OK |
| D-006 | timeoutMs in SAR via AbortSignal, not ExecuteOptions | `mergeTimeoutSignal` in `execute-options-mapper.ts` | ✅ OK |
| D-007 / D-A10 | AgentResult shape mapping | `agent-result-mapper.ts` maps text→content, !success→error | ✅ OK |
| D-008 | Model fallback via ctxModel, no resolveModel in executeAndAwait | `subprocess-agent-runner.ts` injects `ctxModel`; `mapToExecuteOptions` does `opts.model ?? ctxModel?.id` | ✅ OK |
| D-009 | Double bookkeeping deferred to T2 | §5 states no state-machine change; T1 normal path only | ✅ OK |
| D-A1 | executeAndAwait independent method | `subagent-service-extend.ts` adds new method, does not reuse `execute(sync)` | ✅ OK |
| D-A2 | AgentCallOpts→ExecuteOptions mapping in SAR | `execute-options-mapper.ts` called from `subprocess-agent-runner.ts` | ✅ OK |
| D-A3 | resolveAgentOpts stays in orchestration | Not directly in skeleton, but SAR receives pre-resolved `skillPath`/`schemaEnv` | ✅ OK |
| D-A4 | Pending emit kept in executeAndAwait | `subagent-service-extend.ts` mentions `emitPendingRegister` (commented) | ℹ️ Implementation must enable; not a conflict. |
| D-A6 | schemaEnv bridge via childEnv | `session-runner-extend.ts` + `execute-options-mapper.ts` | ✅ OK |
| D-A7 | Duplicate code elimination boundaries | §7 classification table matches | ✅ OK |
| D-A8 | onEvent bridge | `subprocess-agent-runner.ts` directly passes `onEvent` | ✅ OK |
| D-A9 | timeoutMs merges signal | `mergeTimeoutSignal` | ✅ OK |

**No decision conflicts found.** All confirmed decisions are reflected in code-architecture and skeletons.

---

## 7. Classification of Findings

| # | Finding | Category | Severity | Reversible? | Rationale |
|---|---------|----------|----------|-------------|-----------|
| 1 | §6 test-matrix lacks `dependsOn`/`parallelGroup` columns | **D-reversible** | Low | Yes | Documentation/planning gap. Fix by adding two columns to the Source A/B tables. Does not alter architecture or decisions. |
| 2 | `subagent-service-extend.ts` nesting-depth placeholder (`_parentNesting = undefined`) | **F** if not closed | Medium | Yes (implementation-stage) | Skeleton artifact. If left in production code, BC-12 nesting guard becomes a no-op → fork-depth overflow. Must be resolved during implementation. |
| 3 | `execute-options-mapper.ts` temporary `as ExecuteOptions & { schemaEnv?: string }` | **D-reversible** | Low | Yes (implementation-stage) | Type assertion pending ExecuteOptions merge. If left in, it masks type safety for schemaEnv. Should be removed after `ExecuteOptions` is updated. |

There are no D-irreversible findings. Decisions D-000~D-009 are all confirmed and correctly reflected; no new irreversible decision is needed.

---

## 8. Verdict

**Status: CONDITIONALLY APPROVED** — code-architecture and skeletons are structurally sound and consistent with confirmed decisions, but the test matrix must be amended to include `dependsOn` and `parallelGroup`, and the two skeleton placeholders must be tracked as implementation tasks.

### Required actions before execution

1. Add `dependsOn` and `parallelGroup` columns to `code-architecture.md` §6 Source A and Source B tables (or a separate test-schedule block). This is mandatory for the mid-detail workflow test scheduler.
2. Replace the `_parentNesting` placeholder in `subagent-service-extend.ts` with real `execCtxAls.getStore()` logic during implementation; create a verification task (BC-12 nesting guard) to assert it works.
3. Remove the temporary `as ExecuteOptions & { schemaEnv?: string }` assertion in `execute-options-mapper.ts` once `ExecuteOptions` is merged with the `schemaEnv` field; add a typecheck verification task.

### Report metadata

- Reviewer role: independent mid-detail / code-arch reviewer
- Machine check: PASS
- Decision conflicts: none
- D-irreversible findings: 0
- D-reversible findings: 2 (test-matrix columns, type assertion)
- Functional findings: 1 (nesting guard placeholder, if not closed)
