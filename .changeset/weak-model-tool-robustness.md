---
"@zhushanwen/pi-subagent-workflow": patch
"@zhushanwen/pi-goal": patch
"@zhushanwen/pi-todo": patch
"@zhushanwen/pi-ask-user": patch
"@zhushanwen/pi-structured-output": patch
---

Harden 5 tool descriptions + runtime validation against weak-model first-call parameter misuse.

Triggered by a real session where a flash-tier model (step-3.7-flash) called the `subagent` tool with `task`/`slug` flattened to the top level (missing the `startParam` envelope) and needed a round-trip to self-correct. Root cause analysis found a systemic debt pattern across 5 tools: conditional-required fields expressed as `Type.Optional`, zero JSON call examples in descriptions, no parameter-structure anti-patterns, dry runtime error messages with no Correct example, and no prompt-quality regression tests.

Three-layer fix applied uniformly to all 5 tools (subagent + workflow + goal_control + todo + ask-user + structured-output):

- **Runtime friendly correction**: required-field throws now append a copy-pasteable `Correct: {full JSON}` example; common-misuse detectors catch the highest-frequency errors and return a corrected shape (subagent `startParam` flattening; workflow `args` sub-field flattening — a P0 silent failure; todo `text`/`texts` + `id`/`ids` dual-shape trap; ask-user string `options` array).
- **Description examples + structural anti-patterns**: each tool now ships complete JSON call examples for every high-risk action and a Don't section listing parameter-structure mistakes.
- **Prompt-quality regression tests**: new source-text assertion test per tool locks the examples / anti-patterns / Correct-usage strings so they cannot silently regress.

Notable silent-failure closures (worse than the original throw-based failure because they did not error at all):

- **structured-output**: `schema`/`data` swap detection + keyword-less schema rejection. Previously `Type.Unknown()` + `ajv strict:false` compiled a keyword-less object (e.g. `{}`, `{a:1}`) into an accept-anything validator — swapping schema and data then passed validation and stored garbage silently. Now detected and rejected with a Correct hint.
- **workflow**: flattened `args` sub-fields (task/items/...) previously fell through to `args = params.args ?? {}`, silently launching a run missing its parameters.

Other changes:

- **subagent + workflow**: `slug` `maxLength` relaxed 20 → 35 (single source `SLUG_MAX_LENGTH`; both schemas now reference the constant). Descriptive kebab-case slugs like `fix-subagent-wf-tools` (21) no longer collide; over-limit error now suggests a shorter label.
- **ask-user**: `InputSchema.options` element intentionally loosened to `OptionSchema | string` so a mistyped string-array `options` reaches `validateInput` (friendly Correct error) instead of being killed by the schema layer's raw ajv error before `execute` runs. Internal `Question`/`Option` types stay strict.
- **structured-output**: extracted `executeStructuredOutput()` for direct unit testing (internal test helper — not re-exported from the package root, so not part of the public API); deleted stale `STRUCTURED_OUTPUT_SCHEMA` env-name + tool_call block tests (0.3.0 changed to unconditional registration, real env name is `PI_WORKFLOW_SCHEMA`).

Review follow-up (addressed in the same PR after a 6-dimension multi-agent code review):

- **structured-output**: `SCHEMA_KEYWORDS` completed with the remaining draft-07 validation keywords (`if`/`then`/`else`/`dependencies`/`propertyNames`/`contains`/`$defs`/`definitions`) so a conditional root schema is no longer wrongly rejected as keyword-less; `executeStructuredOutput` return type widened from `Record<string,unknown>` to `unknown` (data may be a primitive/array per its own tests); `getOrCompileValidator` now accepts `object | boolean` (boolean root schemas are valid draft-07), eliminating an unsafe cast; `tool_execution_end` handler uses a runtime type guard instead of a bare cast; `echo()` now tolerates `undefined` (`JSON.stringify(undefined)` returns undefined and previously crashed `.length` — a latent bug surfaced by the new edge-case tests).
- **subagent-workflow + todo**: detectors (`hasFlattenedStartFields`, workflow `findFlattenedArgKeys`, todo `handleAdd`/`handleDelete`) now exported to enable behavioural trigger/no-trigger tests — the P0 workflow flatten detector previously had only a fragile source-text lock. Added slug boundary tests (35/36) and a workflow-side runtime slug guard matching subagent's.
- goal_control `hasGoalDetails` guard tightened to validate the `details` value is an object (not just that the key exists).

All five packages are bumped `patch`: no breaking API changes, no new public exports forming a supported API contract (the exported detectors are test helpers, not a stable surface), and the ask-user schema loosening + structured-output keyword-less rejection only surface clearer errors for inputs that were already malformed (previously silently corrupted or raw-ajv-rejected). This is defensive hardening + prompt-quality work, conservatively versioned as patch.
