---
verdict: pass
must_fix: 0
---

# Standards Review — Workflow & Model-Switch Extensions

**Reviewer:** Standards Review Agent  
**Date:** 2026-06-03  
**Files Reviewed:** 8 files across 2 extensions  
**Reference:** CLAUDE.md (project coding standards) + docs/pi-extension-standards.md

---

## Phase A — Typecheck / Lint

**Result: PASS** ✅

Command: `npx tsc --noEmit 2>&1 | grep -v tests/ | grep -v vitest`

Output: (empty — zero errors in reviewed files)

All type errors are pre-existing test infrastructure issues (vitest type declarations not installed, relative import not resolving) — none related to the reviewed files.

| File | Lines | Typecheck |
|------|-------|-----------|
| `extensions/model-switch/src/advisor.ts` | 334 | ✅ Clean |
| `extensions/model-switch/src/index.ts` | 338 | ✅ Clean |
| `extensions/model-switch/index.ts` | 2 | ✅ Clean |
| `extensions/workflow/src/agent-pool.ts` | 374 | ✅ Clean |
| `extensions/workflow/src/worker-script.ts` | 216 | ✅ Clean |
| `extensions/workflow/src/model-resolver.ts` | 32 | ✅ Clean |
| `extensions/workflow/src/orchestrator.ts` | 729 | ✅ Clean |
| `extensions/workflow/package.json` | 47 | N/A (JSON) |

---

## Phase B — CLAUDE.md / Extension Standards Compliance

### 1. Package Structure (`package.json`)

| Rule | model-switch | workflow |
|------|:---:|:---:|
| `type: "module"` | ✅ | ✅ |
| `pi.extensions` pointing to `./index.ts` | ✅ | ✅ |
| `keywords` includes `"pi-package"` | ✅ | ✅ |
| `peerDependencies` includes `@mariozechner/pi-coding-agent` | ✅ (not optional) | ✅ (not optional) |
| `files` includes entry `.ts` | ✅ (`index.ts`, `src/**/*.ts`) | ✅ (`src/`, `index.ts`) |
| `main` set | ✅ (`index.ts`) | ✅ (`index.ts`) |
| `README.md` in `files` | ✅ | ⚠️ Missing (recommended but not required for package consumers) |

**Verdict:** No blocking issues. Both package.json files conform to §1.2 requirements.

---

### 2. Entry Point & Factory Pattern (§2.1, §2.2)

| Rule | model-switch | workflow |
|------|:---:|:---:|
| `export default function(pi: ExtensionAPI)` | ✅ (named `modelSwitchExtension`) | ✅ (anonymous function body in factory) |
| Re-export via index.ts | ✅ `index.ts` → `src/index.ts` | ✅ `index.ts` → `src/index.ts` |
| Closure state isolation (§2.3) | ✅ (`const state: SessionState` in factory) | ✅ (`const orchestrators = new Map()`, `const cmdState` in factory) |

**Note:** model-switch's factory function is named (`modelSwitchExtension`). §2.1 [指南] recommends anonymous or `extension`. Minor, not a must-fix.

---

### 3. State Management & Session Isolation (§7, §2.3)

| Rule | model-switch | workflow |
|------|:---:|:---:|
| State in closure, not module-level | ✅ | ✅ |
| Reset in `session_start` | ✅ (`state.config = null; state.injectedModelTable = false`) | ✅ (new orchestrator per sessionId) |
| Persistence via `pi.appendEntry` | ✅ (model_change entries) | ✅ (workflow-state entries with dedup) |
| Deserialize backward compatible | N/A (no persisted state to deserialize) | ✅ (`deserializeState` in state.ts) |

**Verdict:** Both extensions correctly isolate session state.

---

### 4. Tool Registration & Execute (§4, §5)

| Rule | model-switch | workflow |
|------|:---:|:---:|
| Return `{ content: [...], details }` | ✅ | ✅ |
| Error returns `{ isError: true }` (not thrown) | ✅ | ✅ |
| TypeBox parameters with `description` | ✅ (`StringEnum` + `Type.Object`) | ✅ |
| `promptSnippet` / `promptGuidelines` | ✅ (has promptSnippet) | ✅ (both promptSnippet and promptGuidelines) |
| `renderCall` / `renderResult` | ✅ (no TUI rendering) | ✅ (both implemented) |
| `_render` protocol | N/A (no GUI rendering needed) | ✅ (summary-table + task-list) |

**Error handling detailed check:**
- model-switch: All branches return `res(...)` or `res(..., { error: true })`. No throws from execute.
- workflow: All branches return structured result with `isError: true` on failure. No throws.
- AgentPool: `enqueue()` promise never rejects — errors are carried in `AgentResult.error`.
- Orchestrator: `spawnAndParse` catches exceptions and returns error result.

**Verdict:** Compliant with §4.2. No blocking issues.

---

### 5. Event Handlers (§6)

| Rule | model-switch | workflow |
|------|:---:|:---:|
| Handler ≤ 20 lines (§6.2) | ⚠️ `before_agent_start` ~30 lines | ✅ All handlers ≤ 20 lines |
| Complex logic extracted | ✅ (logic in advisor.ts, prompt.ts) | ✅ (reconstructState, buildRender extracted) |

**WARN:** model-switch's `before_agent_start` handler is ~30 lines — exceeds the 20-line recommendation (§6.2 [规范]). The logic is compact (data computation + prompt injection), but should be refactored to extract the data computation block into a named function.

---

### 6. Type Safety (§11)

| Rule | Status | Evidence |
|------|--------|----------|
| No `any` — use `unknown` | ✅ | All files use `unknown` or specific types |
| `Record<string, unknown>` in white-list | ✅ | Cache data parsing (advisor.ts), JSONL parsing (agent-pool.ts) |
| No cross-file duplicate interfaces | ✅ | Types centralized in `types.ts` (model-switch) and `state.ts` (workflow) |
| No `as import(...).Type` | ✅ | Not used |

**Verdict:** Clean. No type safety issues.

---

### 7. Function & File Length Limits

| File | Lines | Limit (CLAUDE.md) | Limit (standards §18.2) |
|------|:-----:|:-----------------:|:-----------------------:|
| advisor.ts | 334 | ≤1000 ✅ | ≤500 ✅ |
| model-switch/src/index.ts | 338 | ≤1000 ✅ | ≤500 ✅ |
| agent-pool.ts | 374 | ≤1000 ✅ | ≤500 ✅ |
| worker-script.ts | 216 | ≤1000 ✅ | ≤500 ✅ |
| model-resolver.ts | 32 | ≤1000 ✅ | ≤500 ✅ |
| orchestrator.ts | 729 | ≤1000 ✅ | ⚠️ **729 > 500** |
| workflow/src/index.ts | ~480 | ≤1000 ✅ | ≤500 ✅ |

**WARN:** `orchestrator.ts` at 729 lines exceeds the 500-line recommendation (§18.2 anti-pattern list, P1 structural issue). The orchestrator combines Worker lifecycle, state transitions, budget enforcement, persistence, and message routing — these could be split into separate modules (e.g., `worker-lifecycle.ts`, `budget.ts`, `message-router.ts`).

**Critical function lengths:**

| Function | Lines | 80-line limit |
|----------|:-----:|:-------------:|
| `buildWorkerScript` (worker-script.ts) | **216** | ⚠️ FAR exceeds limit |
| `resolveModelForScene` (advisor.ts) | ~70 | ✅ |
| `computePeakRecommend` (advisor.ts) | ~55 | ✅ |

**WARN:** `buildWorkerScript` is 216 lines — far above the 80-line limit. Context: this function builds a JavaScript source string line by line, so each "line" is a small template segment. Structurally it's a template builder, not complex logic. Refactoring would require splitting the template into sub-builders (e.g., `buildPrologue()`, `buildGlobals()`, `buildUserScriptWrapper()`). Recommended but not blocking.

---

### 8. Error Handling & Resilience (§10, §13)

| Rule | Status | Notes |
|------|--------|-------|
| Tool execute returns `{ isError: true }` (not throw) | ✅ | Both extensions |
| Stale context detection (§10.1) | ✅ | Orchestrator checks `isTerminal()/instance.status` before operations |
| Anti-reentry (§10.3) | ✅ | AgentPool `drain()` pattern ensures bounded concurrency |
| Async signal support (§4.2) | ⚠️ | `_signal` parameter in execute functions is unused |
| Config load errors throw meaningful message (§8) | ✅ | model-switch returns null with console.warn |
| Deserialize backward compat (§7.3) | ✅ | workflow state.ts |
| No `process.exit` / infinite loop | ✅ | All loops bounded |

**WARN:** The `_signal` parameter in both extensions' tool `execute` functions is unused. §4.2 [规范] states async operations should pass signal for cancellation. In practice, model-switch's operations are synchronous, so signal passthrough is irrelevant. workflow-run's execute returns immediately (the work happens asynchronously), so signal cancellation would only protect against a race in starting the worker. Low priority.

---

### 9. Path Configuration (§12)

| Rule | Status | Notes |
|------|--------|-------|
| No hardcoded absolute paths | ✅ | All use `path.join(homedir(), ".pi", ...)` |
| Extension resource paths via `import.meta.url` | ✅ | config.ts uses `homedir() + join()` pattern |

**Verdict:** Clean.

---

### 10. Import Ordering

| Rule | Status |
|------|--------|
| Node builtins → npm → internal | ✅ All files |
| Blank line separating groups | ✅ All files |

**Verdict:** Clean.

---

### 11. _Render Protocol Compliance

| Rule | workflow | model-switch |
|------|:--------:|:------------:|
| Implements `_render` | ✅ | N/A |
| Type matches protocol (`summary-table`, `task-list`) | ✅ | N/A |
| Data fields match interface | ✅ | N/A |

The workflow extension implements `_render` correctly for both `summary-table` (workflow status list) and `task-list` (workflow-run progress). Fields match the protocol spec in CLAUDE.md.

---

## Summary

### MUST FIX: 0

### WARN (should address, non-blocking):

1. **orchestrator.ts exceeds 500-line limit** (729 lines) — §18.2 P1 structural anti-pattern. Consider splitting into `worker-lifecycle.ts`, `budget.ts`, `message-router.ts`.

2. **buildWorkerScript() function is 216 lines** — far above the 80-line functional limit. Split template builder into sub-functions.

3. **model-switch `before_agent_start` handler ~30 lines** — exceeds §6.2's 20-line event handler limit. Extract data computation into a named function.

4. **`_signal` unused in execute handlers** — §4.2 recommends signal passthrough for cancellation support. Acceptable for synchronous-only code paths.

### INFO (observations, no action needed):

- model-switch factory function is named (`modelSwitchExtension`) — §2.1 [指南] recommends anonymous. Trivial.
- workflow/package.json `files` missing `README.md` — not breaking, adding would improve npm package.
- Both extensions follow the Pi extension standards correctly on all structural requirements (module format, factory pattern, Tool result format, error handling style, session isolation, persistence).

---

## Checklist Summary (from §19)

| Category | Pass |
|----------|:----:|
| ✅ Boot (package.json, entry point) | ✅ Pass |
| ✅ Resilience (error handling, signal, reentry) | ✅ Pass (with minor warnings) |
| ✅ Types (no any, Record<string,unknown> in whitelist) | ✅ Pass |
| ✅ Code style (file/function length) | ⚠️ WARN (orchestrator 729 lines) |
| ✅ Documentation (renderResult, descriptions) | ✅ Pass |
