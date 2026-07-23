# Test Coverage Review — PR #86

Reviewer: `reviewer` agent (review-pr86-test2) | read-only environment
⚠️ Could not run `pnpm test` — assertions verified by manual cross-check against source. Test suites run separately by coordinator (see aggregated.md).

## Summary
- **Must-fix: 0**
- **Suggestions: 9**

All 4 new prompt-quality test files' assertions cross-checked against sources and **match correctly**. 13 structured-output execute tests are sound (swap / keyword-less / compile-fail / validation-fail + should-not-trigger regression guard). 3 ask-user integration tests genuinely prove schema-relaxation→`validateInput` mechanism via real `Value.Check` (not mocks). Stale `STRUCTURED_OUTPUT_SCHEMA` test deletion is justified (real env is `PI_WORKFLOW_SCHEMA`).

**Dominant finding — coverage asymmetry:** `structured-output` extracted `executeStructuredOutput` and got behavioural tests (trigger + no-trigger); subagent / workflow / todo detectors got **source-text regression locks only**, with no behavioural trigger/no-trigger coverage.

## Findings

| Severity | File:Line | Issue | Suggestion |
|---|---|---|---|
| suggestion | `subagent-workflow/.../subagent-tool-prompt.test.ts:79-83` | `hasFlattenedStartFields` has only a source-text lock. Logic never exercised; refactor that inverts condition still passes if literal survives. No trigger/no-trigger test. | Extract guard to pure exported helper; add behavioural tests both directions. |
| suggestion | `subagent-workflow/.../workflow-tool-prompt.test.ts:46-49` | **Highest priority.** `KNOWN_ARG_KEYS` flat detection (P0-labeled in source) has only `toContain("KNOWN_ARG_KEYS")` + `toContain("Correct:")`. Second assertion satisfied by *any* `Correct:` in the 400-line file (≥7). Untested edge: key at both top-level and inside `args` is **not** flagged. | Extract flat-detection predicate; test trigger / no-trigger / duplicate edge. If team treats P0 detectors as requiring behavioural coverage, escalate to must-fix. |
| suggestion | `todo/.../tool-prompt.test.ts:62-71` | `text`/`texts` + `id`/`ids` dual-form detection handlers not exported, can't be unit-tested in isolation. | Export `handleAdd`/`handleDelete` (or extract guards); add trigger/no-trigger tests. |
| suggestion | cross-cutting | **Coverage asymmetry.** structured-output demonstrates the intended pattern (extract → 13 behavioural tests incl. no-trigger guard); other three didn't follow it. | Apply same pattern to the three detectors for consistency. |
| suggestion | `structured-output/tests/structured-output.test.ts` | Malformed-JSON-string `schema` (e.g. `"{invalid"`) not directly tested. `tryParseJson` returns raw string → fails `isPlainObject` → Ajv compile fail. Compile-fail covered but not the malformed-string→raw-passthrough route. | Add case asserting `/Invalid JSON Schema/`. |
| suggestion | `structured-output/tests/structured-output.test.ts` | `null`/`undefined`/array `schema` untested. Skip swap+keyword-less guards, hit Ajv compile fail. Only indirectly covered. | Add explicit cases. |
| suggestion | `structured-output/tests/structured-output.test.ts` ("echoes received schema/data in swap error") | Regex `/Received schema=.*Received data=\|data=/` misleading — swap msg is `Received schema=…, data=…`; no literal `Received data=`. First alt never matches; passes only via loose `data=`. | Tighten to `/Received schema=.*data=/s`. |
| suggestion | `todo/.../tool-prompt.test.ts:30-37` | `extractDescriptionRegion` uses `indexOf("description:")` whose first hit is the schema field description (`tool.ts:38`), not the tool description. Tests pass (substrings unique) but helper mis-named/fragile. | Anchor on tool description specifically. |
| suggestion | `ask-user/.../validate.test.ts` | 3 integration tests prove schema-relaxation + validateInput-catch in isolation but not that `index.ts` `execute()` actually invokes `validateInput` and surfaces error via `cancelledResult(...,true)`. Wiring visible in source but untested end-to-end. | Consider one test driving `execute` with stubbed `ctx`. |

### Notes (informational)
- **Test execution not performed by reviewer** — read-only env. Coordinator ran 5 suites: all green (see aggregated.md).
- vitest location: structured-output uses `tests/` not `src/__tests__/` — **pre-existing**; vitest config picks both up.

## Verdict
**Approve with suggestions.** PR achieves its goal — prompt-quality regression locks preventing deletion of `Correct:` examples / JSON 正例 / anti-pattern phrasing across all 5 tools. structured-output execute tests and ask-user integration tests are genuinely valuable. One substantive weakness: **behavioural-test asymmetry** — subagent/workflow/todo detectors protected against string deletion but not logic regressions. Address suggestion #2 (workflow `KNOWN_ARG_KEYS`, P0 detector) first.
