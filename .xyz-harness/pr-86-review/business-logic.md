# Business Logic Review — PR #86

Reviewer: `reviewer` agent (review-pr86-biz2) | read-only environment

## Summary
- **Must-fix: 1**
- **Suggestions: 4**

Verified against actual source code (not just comments). All five defensive detections (flatten, swap, dual-form, string-options precheck) checked out; no false-positive regressions on legitimate calls.

## Findings

| Severity | File:Line | Issue | Suggestion |
|---|---|---|---|
| **must-fix** | `structured-output/src/index.ts` (SCHEMA_KEYWORDS ~L33-52; check #2 ~L140) | `SCHEMA_KEYWORDS` omits several legitimate JSON Schema draft-07 validation keywords: `if`, `then`, `else`, `dependencies`, `propertyNames`, `contains`, `definitions`/`$defs`. Check #2 (`if isPlainObject(schema) && !hasSchemaKeyword(schema) throw`) therefore rejects any schema using *only* omitted keywords — e.g. a root `{if:{...},then:{...},else:{...}}` (no `type`) is rejected as "no recognized keyword" though it's valid draft-07. Before this PR `ajv strict:false` compiled it fine; now it is rejected. Violates the tool's own stated "JSON Schema draft-07 object" contract. Low trigger probability today but a latent defect; fix is trivial. | Add the missing draft-07 keywords. A pure `{definitions:{...}}` root should also count as schema-like. |
| suggestion | `subagent-workflow/src/interface/subagent-tool.ts` (~L41) + `subagent-actions.ts` (`StartHandlerInput.slug` ~L91) | Doc comments still say `短标签（≤20 字符）` while `SLUG_MAX_LENGTH` is 35. Mismatch between comments and schema/handler. | Update both comments to ≤35. |
| suggestion | `subagent-workflow/src/interface/tool-workflow.ts` (actionRun flatten error ~L393) | "Correct" example emits `"task": <value>` — an **unquoted** placeholder. If a weak model copies literally the JSON won't parse. subagent's flatten error uses safer quoted placeholders. | Use quoted placeholder (`"<value>"`). |
| suggestion | `subagent-workflow/src/interface/subagent-tool.ts` (`hasFlattenedStartFields` ~L150) | Detection covers only `task`/`slug` flattened to top. If a model flattens only `agent`/`model` it hits generic "startParam is required". If both `startParam` AND top-level `slug` are passed, the flat slug is silently ignored. Scope narrower than stated intent. | Consider extending to any `startParam` sub-field; decide error-vs-merge policy for simultaneous pass. Low priority. |
| suggestion | `subagent-workflow/src/interface/tool-workflow.ts` (actionRun ~L415, `slug: params.slug` → `runWorkflow`) | workflow `slug` length enforced **only** via schema `maxLength: 35` — no runtime guard. subagent's `startHandler` has explicit runtime `slug.length > SLUG_MAX_LENGTH` check (defense in depth). | Add matching runtime length check in `actionRun` for symmetry. |

## Verified correct (no action)
- subagent `hasFlattenedStartFields` — no false positives on legitimate single-field calls; correctly skipped when `startParam` present.
- workflow `KNOWN_ARG_KEYS` flatten detection — list has no overlap with legitimate `WorkflowParams` fields; no regression (flattened args previously launched a run with `args={}`, so no legitimate caller depended on old behavior).
- structured-output swap detection — minimal schema `{type:"object"}` not rejected (`type` is in keyword list); swap check fires only when schema lacks keywords AND data has them; `tryParseJson` correctly keeps malformed JSON as raw string for ajv to reject.
- todo `text`/`texts` + `id`/`ids` dual-form — accurate; legitimate `add`/`delete`/`update` unaffected.
- ask-user string-options precheck — sound; full `OptionSchema[]` calls pass through; any string element triggers friendly error; render paths never touch raw option strings (early return).
- All "Correct" JSON examples are schema-valid (except the unquoted `<value>` placeholder noted above).
- slug maxLength 35 consistent across constant, both schemas, and startHandler runtime check (only doc comments stale).

## Verdict
Approve with **one trivial must-fix** (add missing draft-07 keywords to `SCHEMA_KEYWORDS`). All defensive detections logically sound, no regressions on legitimate calls, all traps handled with valid `Correct` examples.
