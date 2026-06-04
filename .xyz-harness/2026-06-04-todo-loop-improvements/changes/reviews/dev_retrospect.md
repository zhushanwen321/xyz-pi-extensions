---
phase: dev
verdict: pass
absorbed: false
topic: "2026-06-04-todo-loop-improvements"
harness_issues:
  - "BLR v1 found 3 MUST_FIX that required 3 additional rounds (v2→v3) to resolve — two rounds because edits didn't match file content (whitespace/tab issues)"
  - "subagent timeouts on longer-running review tasks (180s timeout hit for parallel taste+integration)"
  - "Integration review had to be written manually due to subagent timeout"
---

# Dev Retrospect — todo-loop-improvements

## 1. Phase Execution Review

### Summary
Phase 3 implemented all 9 planned tasks across 5 sequential subagent dispatches + 3 fix cycles + 5 specialized reviews. Delivered 5 source file changes (index.ts, model.ts, test.ts, vitest.config.ts, package.json) with 35 unit tests, all passing.

### Problems Encountered
1. **BLR rounds (3)** — The business logic review identified 3 legitimate MUST_FIX issues that required multiple fix rounds:
   - Double userMessageCount increment (simple removal)
   - verifyAttempts auto-increment in agent_end (needed redesign: move to update handler)
   - batch status validation (simple addition)
   Fix v2 failed because two of the edits didn't match file content (whitespace/tab encoding differences in the edit tool). Required manual python-based fix for v3.

2. **Subagent timeout on review tasks** — The parallel taste+integration dispatch hit 180s timeout. Integration review was written manually. Root cause: subagent reads the large index.ts file (~750 lines).

3. **`any` → `unknown` type conversion fragmentation** — The first bulk edit for event handler types didn't apply due to whitespace mismatch, leaving 5 `_event: any` instances unfixed until the final cleanup pass.

4. **Test for verifyAttempts behavior** — The initial test tested old behavior (agent_end auto-increment). Had to be rewritten after the design change.

### Key Risks for Later Phases
- Session restore: when session resumes with old todo entries, the `migrateTodo` function handles backward compat. Verify this in Phase 4 E2E testing.
- `allCompletedAtCount` semantics: when session resumes, this resets to null, meaning auto-clear timer starts fresh. This is intentional but needs to be documented.
- `verifyText` in `<todo_context>` is markdown-safe? No, but AI reads it as plain text in context injection, not rendered in TUI. No risk.

### What Would You Do Differently
- Use Python-based string replacement from the start for bulk edits (avoiding edit tool whitespace issues)
- The verifyAttempts design change (agent_end auto-increment → update handler) should have been caught in the plan review. The original plan had a blind spot around "who increments verifyAttempts" — this should have been surfaced in Phase 2.

## 2. Harness Usability Review

### Flow Friction
- Complex path (subagent-driven-development) with 9 tasks → 5 dispatches was efficient but every dispatch added queue time. Average subagent turn was 2-3 minutes.
- The "per task TDD → executor → reviewer" pattern was relaxed in practice: the subagent wrote tests and implementation in a single dispatch (TDD within the subagent's own context). This was more efficient.

### Gate Quality
- Five-review pipeline (BLR, Standards, Taste, Robustness, Integration) was thorough but heavy for a single-file extension. BLR and Taste found real issues; Standards and Robustness were confirmatory.
- BLR's simulated data paths (UC-1 through UC-4) were the most valuable review — caught the verifyAttempts lifecycle bug.

### Prompt Clarity
- The "context diet" rule (pass only minimum context) was effective. Each subagent task prompt included only the methods/signatures/ACs relevant to their task.
- The "Pre-Dispatch Checklist" (method signatures, enum values, constraints, prohibitions, output files) was critical for quality but added overhead per dispatch.

### Automation Gaps
- The edit tool's whitespace handling (tab vs space) caused silent edit failures. This is a known Pi platform limitation.
- Subagent timeout handling: 180s timeout hit for complex reviews. Need configurable timeout per task type.

### Time Sinks
- BLR fix rounds (3 total) consumed ~15 minutes of back-and-forth that could have been reduced by using python-based text replacement from the start.
- Setting up vitest infrastructure for the todo extension was a one-time cost that's now paid.
