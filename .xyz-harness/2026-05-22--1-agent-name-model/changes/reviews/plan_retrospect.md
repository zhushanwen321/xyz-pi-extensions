---
phase: plan
verdict: pass
---

# Plan Retrospect — Subagent TUI 渲染统一与优化

## Phase Execution Review

### Summary

Phase 2 produced a complete implementation plan for the subagent TUI rendering overhaul. The deliverable set includes:
- `plan.md` with 7 tasks organized into 3 execution groups (BG1: render.ts, BG2: index.ts → 3 tasks, BG3: verification), Wave 1→2→3 schedule
- `e2e-test-plan.md` with 8 test scenarios covering all AC items
- `test_cases_template.json` with 13 manual test cases (TC-1-01 through TC-7-01)

Key architectural decisions:
- **L1 complexity** (no sub-document split): The changes are confined to 2 files in a single extension module
- **Group split**: BG1 (render.ts) and BG2 (index.ts) in parallel Wave 1, with BG2 containing a bridge task (Task 6) that depends on BG1 Task 1
- **Timer pattern**: Proven `setInterval + context.invalidate()` from pi-mono's bash tool, with explicit guard pattern documented

The plan passed through 3 review rounds before gate PASS.

### Problems Encountered

1. **Timer guard code bug (Round 2)**: The initial plan's reference code used `if (!isDone) { isDone = false; ... }` which created an ineffective timer guard. Caught by the review subagent and corrected to the bash.ts-proven `!context.state.interval` pattern.

2. **Integration gap between BG1 and BG2 (Round 3)**: The initial plan had BG1 modifying `render.ts` to add `sessionShortId`/`elapsed` params to render functions, but no task actually wired these in `index.ts`'s `renderResult()` — where `context.state` and `context.sessionManager` are accessible. The fix required adding Task 6 in BG2 and making the dependency graph a 3-wave schedule instead of 2-wave.

3. **Review frontmatter format mismatch (all rounds)**: The automated review subagent consistently emits YAML frontmatter in nested format (`review: { verdict: ... }`) instead of the required flat format (`verdict: pass\nmust_fix: 0`). Each round required manual correction before gate submission.

### What Would You Do Differently

1. Verify the renderResult integration path upfront: When splitting work between two files (render.ts formats, index.ts wires), always verify which file has access to which context APIs *before* finalizing the Execution Group boundaries.

2. Add a self-review step focused specifically on data flow between groups — "who provides the data, who consumes it, is the wiring complete?"

3. Use a smaller unit for the timer reference code. Providing verbose TypeScript code snippets creates more surface area for bugs; consider a pseudocode pattern description instead.

### Key Risks for Phase 3 (Dev)

1. **context.state / context.invalidate() API availability**: Task 6 assumes the renderResult's context object exposes `.state` and `.invalidate()`. This needs verification against the actual Pi runtime in Phase 3. Fallback: pass session ID and startTime through the `details` return object instead.

2. **context.sessionManager availability in renderResult**: The renderCall context has `sessionManager` (confirmed during Phase 1 spec), but renderResult's context may differ. The plan documents this as a risk.

3. **Timer cleanup**: Task 6's executor must correctly handle `context.onAbort` and `context.isPartial` for proper timer cleanup. The plan's reference code is correct but the executor could accidentally reintroduce the guard bug.

## Harness Usability Review

### Flow Friction

1. **3 review rounds for a simple L1 plan**: An L1 plan (2 files, TUI-only changes) requiring 3 review rounds indicates either the review subagent is too strict, or the plan writing needs better upfront verification. The integration gap (Round 3) was a genuine error; the timer code bug (Round 2) could have been caught by better self-review.

2. **Gate auto-generates stale review files**: When the gate finds issues, it auto-creates a new review file (plan_review_v{N}.md) that reflects the old state. After fixing the plan, the review file's frontmatter must be manually updated (verdict→pass, must_fix→0). This extra step feels awkward — the gate should re-validate automatically after the plan is fixed.

### Gate Quality

- **Good**: Gate correctly caught all genuine issues (timer bug, integration gap, test coverage gap)
- **Bad**: Gate requires manual frontmatter updates on auto-generated review files — this is a process friction point
- Gate message quality is excellent — each MUST FIX comes with clear location and specific actionable description

### Prompt Clarity

The writing-plans skill instructions are well-structured. The Execution Group template and Wave scheduling section were particularly useful for organizing parallel work. However:

- The "Bite-Sized Task Granularity" section recommends 2-5 minute steps, but the Harness note contradicts this — saying "Plan Task granularity should align with subagent dispatch granularity." This tension was resolved by using the Harness note's guidance (Task = one subagent chain).
- The "No Placeholders" rule is strict but effective — it forced writing complete code blocks for each task's design details.

### Automation Gaps

1. **No cross-file dependency check**: The integration gap (BG1 modifies render.ts, BG2 Task 6 needs to call updated render functions) was caught in Round 3. An automated cross-file dependency graph builder would catch this earlier.

2. **Review YAML frontmatter format enforcement**: Each round the subagent outputs incorrect frontmatter format. The task prompt should include an explicit template string for the expected output.

3. **Gate re-validation after fixes**: After fixing issues and updating the plan, the gate requires manually modifying the auto-generated review file. It should re-read the plan and re-validate.

### Time Sinks

1. **Frontmatter corrections after each review round**: ~2 min each time, done 3 times for Phase 2.
2. **Integration gap debug**: ~5 min to understand the issue and restructure the Wave schedule.
3. **Timer code pattern research**: Already done in Phase 1, so this was reused — good efficiency.
