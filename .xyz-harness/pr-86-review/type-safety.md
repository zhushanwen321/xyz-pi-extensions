# Type Safety Review — PR #86

Reviewer: `reviewer` agent (review-pr86-type2) | read-only environment
⚠️ Could not run `pnpm -r typecheck` / `grep` — verified by full file reads. Typecheck run separately by coordinator (see aggregated.md).

## Summary
- **Must-fix: 1**
- **Suggestions: 3**

## Findings

| Severity | File:Symbol | Issue | Suggestion |
|---|---|---|---|
| **must-fix** | `structured-output/src/index.ts` — `executeStructuredOutput` return type + `details: data as Record<string, unknown>` | New exported function declares `details: Record<string, unknown>` but `data` is `unknown` and is cast to it. Cast is unsound: primitive-root schemas are valid and tested — `tests/structured-output.test.ts` asserts `expect(result.details).toEqual(42)`, `.toEqual(true)`, `.toEqual(["a","b","c"])`. Return type contradicts its own tests; any consumer trusting `Record<string,unknown>` (`Object.keys(result.details)`, `result.details.foo`) is type-unsafe. | Widen return type to `details: unknown` (and `createToolDefinition.execute`'s return accordingly). Drop the cast. |
| suggestion | `structured-output/src/index.ts` — `getOrCompileValidator(schema as Record<string, unknown>)` (step 3) | `schema` is `unknown` here (after `tryParseJson` could be boolean/string/number — boolean roots `true`/`false` are valid draft-07). Cast to `Record<string,unknown>` is unsound. Runtime is safe (WeakMap tolerates primitives; ajv accepts boolean) but the cast bypasses the type system. | Type `getOrCompileValidator` param as `object \| boolean` (or `unknown` + narrow internally) instead of casting the caller. |
| suggestion | `goal/src/adapters/goal-control-adapter.ts` — `hasGoalDetails(r)` | Guard asserts `r is { details?: GoalControlDetails }` but only checks `typeof === "object" && !== null && "details" in r` — never validates the *value* of `r.details`. Over-asserts inner type. If `details` is a string, consumers read `d.status`/`d.action` as `undefined` (render-only, no crash). | Narrow to `{ details?: unknown }` and validate shape, or tighten to `typeof r.details === "object"`. Improvement over prior `as {details?}` regardless. |
| suggestion | `structured-output/src/index.ts` — `setupWorkflowHook`, `tool_execution_end` handler | `event as { toolName: string; isError: boolean; result?: unknown }` is a direct cast on `unknown` with no runtime guard — inconsistent with the same file's `turn_end` handler which correctly uses the new `isTurnEndEvent` guard. PR's stated direction was "replace casts with guards"; this departs from that pattern. | Introduce an `isToolExecutionEndEvent` guard mirroring `isTurnEndEvent` for consistency. |

## Verified sound (no action)
- ask-user Union schema + narrowing (`inputOptionElement = Type.Union([OptionSchema, Type.String()])`): `InputQuestion.options` correctly derives `(Option | string)[]`; `typeof opt === "string"` correctly narrows in `validate.ts`.
- subagent guards: `hasFlattenedStartFields` returns plain boolean; `hasStartParam` checks `"startParam" in a`; `isModelOverrideObj` only optional fields — all sound.
- structured-output `isTurnEndEvent` — technically over-asserts (only checks object) but all fields optional and accessed via `?.` — harmless.
- No new `any`: `type PiAPI = any` is pre-existing with eslint-disable.
- `as unknown as never` removed from test — confirmed correct (test now drives real extension entrypoint).
- No `as any`/`as never`/`as unknown as T` introduced.

## Verdict
Approve with **1 must-fix** — `executeStructuredOutput`'s `details: Record<string, unknown>` return type is incorrect (contradicted by its own primitive-root tests). Other 3 are cast-hygiene/guard-consistency items. ⚠️ typecheck not run by reviewer — coordinator confirmed 0 TS errors.

```json
{"must_fix": 1, "suggestion": 3, "verdict": "approve-with-1-must-fix"}
```
