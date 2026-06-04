---
phase: plan
verdict: pass
absorbed: false
topic: "2026-06-04-todo-loop-improvements"
harness_issues:
  - "plan_review v1 had 2 MUST_FIX that could have been caught by self-review (verifyAttempts condition, TUI vs AI context ambiguity)"
  - "Subagent review YAML frontmatter continues to have quoting issues from spec_review v1 — still needs manual markdown table format workaround"
---

# Plan Retrospect — todo-loop-improvements

## 1. Phase Execution Review

### Summary
Phase 2 produced all required deliverables: plan.md (9 tasks, L1 complexity), e2e-test-plan.md (7 scenarios), test_cases_template.json (17 test cases), use-cases.md (4 UC with AC coverage map), and non-functional-design.md (5 dimensions). All documents aligned with the approved spec.

The complexity assessment correctly identified L1 (single file, no frontend/backend split), avoiding unnecessary sub-document overhead.

### Problems Encountered
1. **Review round needed**: 2 MUST_FIX issues were correctly identified by the plan review subagent:
   - Task 5 verifyAttempts condition was `=== 0` instead of `< MAX_VERIFY_ATTEMPTS`, preventing retry after first failure
   - Task 6 context injection vs TUI display ambiguity needed clearer comments
   Both were straightforward fixes.

2. **No new ADR needed**: The plan didn't introduce new architectural decisions beyond what was already covered by ADR 017 (independent lightweight loop).

### What Would You Do Differently
- The verifyAttempts condition bug (`=== 0` instead of `< MAX`) is exactly the kind of edge case that a focused self-review should catch. Spend more time on the verification flow's failure paths.
- The plan's implementation code for Task 5 and 6 could have had more complete test code for the verification retry scenario.

### Key Risks for Later Phases
- The verifyText data chain has three touchpoints (data model → context injection → list output). Implementation must test all three.
- The `agent_end` handler's interaction with existing `before_agent_start` handler — need to ensure no conflicting context injections.
- Session restore: when a session resumes, todos need to be reconstructed with all new fields (verifyText, verifyAttempts).

## 2. Harness Usability Review

### Flow Friction
- The L1/L2 complexity assessment was clear and straightforward for this single-file extension. The template made it easy to skip unnecessary sub-documents.
- The Execution Groups template was helpful even for a single group — it forced explicit subagent configuration and dependency thinking.

### Gate Quality
- Phase 2 gate correctly validated 10 separate checks (plan.md verdict + complexity, e2e-test-plan, test_cases JSON, use-cases, non-functional-design, plan_review, L1 skip for bl_review). Comprehensive and accurate.
- Same "untracked files fail first" pattern as Phase 1 — requires commit before first gate pass, which is slightly awkward but consistent.

### Prompt Clarity
- The writing-plans skill's "No Placeholders" section was effective — I caught myself writing placeholders and corrected them.
- The Interface Contracts template was clear. For L1, the simplified methods table + AC coverage matrix was the right level of detail.

### Automation Gaps
- Plan review subagent still suffers from the same YAML quoting issue as spec review. The review output uses YAML `issues:` block sequences with nested titles containing unescaped double quotes. This was caught and fixed manually in Phase 1, but persists. The subagent prompt should be updated to say "use markdown table format for issues" instead of YAML list format.

### Time Sinks
- Writing 5 deliverables (plan + e2e + test_cases + use-cases + non-functional) sequentially took most of the phase time. For L1 this is fine — the total output is substantial but each document is focused.
- The 2-round review cycle added ~5 minutes of fix+resubmit overhead. Acceptable for quality assurance.
