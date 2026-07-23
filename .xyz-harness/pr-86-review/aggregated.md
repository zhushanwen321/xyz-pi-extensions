# PR #86 Aggregated Review

6-dimension review: 5 parallel `reviewer` subagents + 1 fallow static pre-scan.
Reviewer env was read-only (no bash/write); coordinator ran typecheck + tests and independently re-verified both must-fix findings against source.

## Verdict: APPROVE WITH 2 MUST-FIX (both trivial, low-risk)

- **typecheck**: 0 TS errors ✅
- **tests**: 2020 passed / 0 failed (5 packages) ✅
- **fallow**: 0 introduced dead code / complexity / duplication ✅

## Must-fix (2) — verified real by coordinator

| # | File | Issue | Fix |
|---|------|-------|-----|
| **1** | `structured-output/src/index.ts` `SCHEMA_KEYWORDS` | Omits draft-07 validation keywords `if`/`then`/`else`/`dependencies`/`propertyNames`/`contains`/`definitions`/`$defs`. A root schema using *only* these (no `type`/`properties`/…) is rejected as "no recognized keyword" — backward-incompatible regression (ajv previously compiled it). Violates the tool's stated "draft-07 object" contract. *(Flagged by business-logic as must-fix, extension-api as suggestion — escalated.)* | Add the 8 keywords to the array. ~1 line. |
| **2** | `structured-output/src/index.ts` `executeStructuredOutput` return type | Declares `details: Record<string, unknown>` but casts `data` (typed `unknown`) to it. Primitive/array roots are valid and tested: `toEqual(42)`, `toEqual(true)`, `toEqual(["a","b","c"])`. Return type contradicts its own tests; `Object.keys(result.details)` would be type-unsafe. | Widen return type to `details: unknown`; drop the cast. ~2 lines. |

## High-consensus suggestion (3/5 reviewers)

| File | Issue |
|------|-------|
| `subagent-workflow/src/interface/subagent-tool.ts` (`StartParam.slug` JSDoc) + `subagent-actions.ts` (`StartHandlerInput.slug`) | Stale `≤20 字符` doc comments while `SLUG_MAX_LENGTH=35`. Code is correct (both schemas + runtime guard reference 35); only comments lag. Flagged by business-logic + monorepo + extension-api. |

## Other suggestions (non-blocking, by value)

**Test coverage (strongest substantive finding — asymmetry):**
- workflow `KNOWN_ARG_KEYS` flat detection is **P0-labeled in source** but has the weakest test (only `toContain("KNOWN_ARG_KEYS")` + `toContain("Correct:")` — second matches any of ≥7 `Correct:` in the 400-line file). No behavioural trigger/no-trigger test. *(test-coverage reviewer: "if team treats P0 detectors as requiring behavioural coverage, escalate to must-fix")*
- Same pattern for subagent `hasFlattenedStartFields` and todo `text`/`texts` dual-form: source-text locks only, no behavioural coverage. structured-output did it right (extracted `executeStructuredOutput` → 13 behavioural tests); the other three didn't follow.
- structured-output edge cases untested: malformed-JSON-string schema, `null`/`undefined`/array schema; swap-error regex is misleading (first alternative never matches).

**Type safety (cast hygiene):**
- `tool_execution_end` handler uses direct `event as {...}` cast — inconsistent with new `isTurnEndEvent` guard pattern.
- `getOrCompileValidator(schema as Record<string,unknown>)` — boolean roots are valid draft-07.
- `hasGoalDetails` over-asserts (checks `"details" in r` but asserts `details?: GoalControlDetails`).

**Business logic:**
- workflow `actionRun` slug has no runtime length guard (subagent does — asymmetry).
- workflow flatten error `"task": <value>` placeholder unquoted (subagent uses quoted).

**Monorepo / semver:**
- goal changeset arguably `patch` not `minor` (only description examples + Correct hints, no new guard/schema shape).
- `executeStructuredOutput` not re-exported from package root → "public API change" framing inaccurate (intent is internal test helper).

## Per-dimension scores

| Dimension | must-fix | suggestion | verdict |
|-----------|---------|-----------|---------|
| Business logic | 1 | 4 | approve w/ 1 must-fix |
| Type safety | 1 | 3 | approve w/ 1 must-fix |
| Extension API | 0 | 5 | approve |
| Test coverage | 0 | 9 | approve w/ suggestions |
| Monorepo impact | 0 | 3 | approve w/ suggestions |
| Fallback (static) | 0 | 0 | clean |

After dedup: **2 must-fix, ~14 suggestions** (3 reviewers agreed on the stale-≤20 comments).

## Recommendation
Fix the 2 must-fix + the high-consensus stale-≤20 comments in a small follow-up commit on this branch (~10 lines, all in structured-output + subagent-workflow). Re-run typecheck + the 2 affected test suites, then push. The test-coverage asymmetry (behavioural tests for workflow/subagent/todo detectors) is valuable but larger — better as a separate follow-up issue/PR.
