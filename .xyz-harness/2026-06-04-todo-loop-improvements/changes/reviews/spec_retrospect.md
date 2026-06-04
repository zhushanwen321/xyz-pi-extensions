---
phase: spec
verdict: pass
absorbed: false
topic: "2026-06-04-todo-loop-improvements"
harness_issues:
  - "Subagent-generated spec_review YAML frontmatter has unescaped double quotes, causing gate check parse failure"
  - "pre-commit hook tsc check has pre-existing failure (TS2688: node types not found) unrelated to docs changes, requiring SKIP_LINT workaround"
---

# Spec Retrospect — todo-loop-improvements

## 1. Phase Execution Review

### Summary
Phase 1 started with a user-initiated analysis request comparing two extensions (todo vs goal). Through session data analysis of 1039 session files, we identified todo's core problems: no `agent_end` loop, broken reminder mechanism, and lack of verification support. The user provided detailed requirements, and through 4 design sections (data model, agent loop, verification flow, batch update + prompts), we produced a complete spec.md covering FR-1 through FR-7, AC-1 through AC-7, and UC-1 through UC-4.

Key decisions:
- Todo gets its own lightweight agent loop (ADR 017), independent from goal
- verifyText for structured task verification with 2-attempt retry limit
- Batch update via `updates[]` parameter
- Context injection via `<todo_context>` with `display: false`
- Prompt guidelines updated to clarify todo vs goal usage boundaries

### Problems Encountered
1. **Spec review YAML formatting**: The subagent-generated spec_review files used Chinese-style double quotes inside YAML double-quoted strings, causing gate check parse failures. Had to rewrite both v1 and v2 review files with markdown table format to avoid YAML quoting issues.
2. **Pre-existing tsc failure**: Pre-commit hook runs `tsc --noEmit` which fails with `TS2688: Cannot find type definition file for 'node'`. This is a pre-existing issue unrelated to docs changes, but still blocks commits.

### What Would You Do Differently
- Validate the subagent's YAML output immediately after generation rather than discovering it at gate check time
- The initial analysis phase (before coding-workflow init) was very thorough but not part of the formal process — it established context that made the brainstorming phase much more efficient

### Key Risks for Later Phases
- The verifyText data chain has three touchpoints (FR-1 data model, FR-4 context injection, FR-3b list output). Implementation must ensure all three are consistent.
- Backward compatibility for existing todo entries without verifyText field
- The `<todo_context>` injection format needs to be consistent with goal's `<goal_context>` to avoid AI confusion

## 2. Harness Usability Review

### Flow Friction
- The brainstorming skill checklist items (quick overview, clarifying questions, propose approaches, present design sections) progressed naturally. No friction.
- The user had already done most of the requirements exploration before phase init, which blurred the boundary between "pre-work" and "Phase 1". The formal phase steps became more of a validation/replay than an exploration.

### Gate Quality
- Gate check correctly identified untracked files (critical) and YAML parse errors. Accurate and actionable.
- The "untracked files" check could be more graceful — it reports as FAIL before commit, which means you can never pass gate on the first run if you haven't committed yet. This is by design but feels slightly awkward.

### Prompt Clarity
- The brainstorming skill instructions are comprehensive. The "one question at a time" guideline and progressive questioning hierarchy were helpful.
- The detailed template for spec.md and the six-element completeness check were clear and easy to follow.

### Automation Gaps
- The retrospect step was triggered by an external steer message after gate PASS, rather than being automated within the workflow. Slight context switch.
- Subagent review generation doesn't validate YAML output format before writing, causing downstream gate failures.

### Time Sinks
- Fixing the YAML quoting in subagent-generated review files took ~5 minutes of manual editing. A subagent prompt adjustment ("use markdown tables instead of YAML lists for issues") would prevent this.
- The `SKIP_LINT=1` workaround for pre-existing tsc issues is a recurring distraction. This should be fixed in the project's tsconfig.json.
