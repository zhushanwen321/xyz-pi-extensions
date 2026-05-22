---
phase: spec
verdict: pass
---

# Spec Retrospect — Subagent TUI 渲染统一与优化

## Phase Execution Review

### Summary

Phase 1 produced a complete, review-passed spec for the subagent TUI rendering overhaul. Key accomplishments:
- Codebase scan identified the `setInterval + context.invalidate()` pattern from pi-mono's bash tool, providing a proven real-time timer mechanism
- User requirements were clarified through 5 targeted questions, with rapid mockup iterations for each of the 4 execution modes
- The spec covers 8 functional requirements (F1-F8), 6 acceptance criteria groups (30+ checkpoints), 7 constraints, and an explicit Out of Scope section
- Six-element completeness check caught the missing Out of Scope section and an ambiguous "N=3-5" value
- Spec review passed in 2 rounds (1 MUST FIX resolved: F5/AC3 collapsible count conflict)

### Problems Encountered

1. **Out of Scope missing in initial write**: The first spec draft had no explicit "Out of Scope" section. The six-element check caught this — adding it prevented scope creep during implementation.
2. **F3 ambiguous range**: "show first N lines (N=3-5)" was marked as ambiguous during completeness check. Resolved to `TEXT_PREVIEW_LINES = 3`.
3. **Review frontmatter format mismatch**: The spec review subagent consistently output nested YAML (`review: { verdict: ... }`) instead of the required top-level `verdict:` / `must_fix:` format. Required manual correction.
4. **AC2 lastActivityTime undefined**: Spec review Round 2 found this term was used without definition. Fixed by removing the term and relying on elapsed duration instead.

### What Would You Do Differently

1. Write Out of Scope section during initial spec writing, not as a completeness check patch.
2. Review subagent task prompt should include an explicit YAML template string for the output frontmatter (`verdict: pass\nmust_fix: 0`) to enforce format consistency.
3. The Terminology/ADR step was near-empty — while legal, the `collect_subagent` removal decision has a real trade-off (losing a monitoring tool) that could warrant an ADR if this were a larger project.

### Key Risks for Later Phases

1. **Timer guard pattern**: The `setInterval` must use `!context.state.interval` for duplicate protection (not module-level `isDone`), otherwise Phase 3 executors may introduce timer stacking bugs.
2. **Session ID availability**: `context.sessionManager.getSessionId()` is confirmed available, but the render functions' `context` object shape differs from `execute`'s `ctx`. Verify in Phase 3.
3. **Collect_subagent removal scope**: Spec constrains this to "tool registration only, keep cleanup methods." Phase 3 executor must not accidentally delete `SpawnManager` cleanup logic.

## Harness Usability Review

### Flow Friction

1. **Step 2 (questions) vs Step 3-4 (mockups)**: The boundary between "asking clarifying questions" and "presenting design with mockups" was fluid. User approval per section worked well, but the skill's rigid separation between Steps 2, 3, and 4 felt artificial for this project where questions naturally merged into mockup proposals.
2. **Gate script not found locally**: `skills/xyz-harness-gate/scripts/check_gate.py` doesn't exist on this system. The gate check was done via `coding-workflow-gate(phase=1)` tool call instead, which worked but bypassed the skill's intended flow.
3. **Spec review dispatch failed once** due to API rate limit (429). Had to manually write the spec_retrospect for the initial version.

### Gate Quality

Gate correctly identified that the spec was complete with a PASS verdict. The initial gate call succeeded on first try with verdict=pass, must_fix=0.

### Prompt Clarity

- The skill's "Ask one question at a time" constraint was effective — it kept the conversation focused and prevented overwhelming the user.
- The pre-built question hierarchy (Layer 1→2→3) subtly guided the questioning toward deeper topics without being prescriptive.
- However, the brainstrorming skill's "Step 3: Propose 2-3 approaches" felt unnecessary for this project — the user had clear requirements from the start, so there weren't truly 2-3 distinct approaches to propose.

### Automation Gaps

1. No automated check for review frontmatter format alignment with template.
2. No automated tool to validate "Are all F/AC from spec.md covered in plan.md tasks" — currently a manual self-review step.
3. The "Terminology Step" (embedded in Step 2-4) has no automated way to scan for ambiguous terms. Relies entirely on the agent's vigilance.

### Time Sinks

1. **Spec review format correction** (~5 min): Manually fixing the review output's YAML frontmatter each round.
2. **Checking review output quality**: After each subagent dispatch, had to read the full review output and assess whether `must_fix` count was accurate. The reviewer subagent was generally reliable.
