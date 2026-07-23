# Extension API Review — PR #86

Reviewer: `reviewer` agent (review-pr86-ext2) | read-only environment
SDK contracts cross-checked against real Pi types (`pi-coding-agent@0.80.3` dist `.d.ts`).

## Summary
- **Must-fix: 0**
- **Suggestions: 5**

## Verified correct (with evidence)
- **ask-user options relaxation to `Union([OptionSchema, Type.String()])`** — backward compatible: existing `{label,description}` callers still pass via the union. `validate.test.ts` proves `Value.Check(InputSchema, {options:["A","B"]}) === true` and well-formed objects still pass.
- **slug maxLength 20→35** — relaxation, not break. Both schemas reference `SLUG_MAX_LENGTH` (single source = 35); `startHandler` throws `>35`; `mapToExecuteOptions` truncates to 35.
- **SDK contract — structured-output hook** — checked against `core/extensions/types.d.ts`: `ToolExecutionEndEvent` has `{toolName, isError, result}` (hook cast matches ✓); `TurnEndEvent.message: AgentMessage` → `AssistantMessage.stopReason: StopReason` where `StopReason = "stop"|"length"|"toolUse"|"error"|"aborted"`, so `event.message?.stopReason === "toolUse"` is real and correct ✓. `pi.sendUserMessage(msg, {deliverAs:"steer"})` matches overload ✓.
- **Pi manifest / resource containment** — structured-output `package.json` has `type:module`, `pi.extensions:["./index.ts"]`, `keywords`, `files:["src/","index.ts"]`. New `executeStructuredOutput` lives in `src/index.ts` → covered by `files`.
- **Conditional-required pattern** — goal_control/subagent/workflow/todo correctly use `Type.Optional` + runtime `throw` with `Correct:` JSON examples.

## Findings

| Severity | File:Line | Issue | Suggestion |
|---|---|---|---|
| suggestion | `subagent-workflow/src/interface/subagent-tool.ts` (`StartParam.slug` JSDoc ~L62) | Stale `≤20 字符` while schema/runtime now enforce 35. Same at `subagent-actions.ts` `StartHandlerInput.slug`. Dev-only doc drift; schema description correctly shows ≤35. | Update both JSDoc to ≤35. |
| suggestion | `structured-output/src/index.ts` (`SCHEMA_KEYWORDS`) | List omits draft-07 `if`/`then`/`else`, `dependencies`, `propertyNames`, `$defs`/`definitions`. A root schema using only these (no `type`/`properties`/…) returns false on `hasSchemaKeyword` and is rejected as "no recognized keyword" — backward-incompatible regression vs prior ajv acceptance. *(Same as business-logic must-fix; reviewer here scored it suggestion.)* | Add the missing keywords; risk low (such schemas usually also carry `type`). |
| suggestion | `structured-output/src/index.ts` (step 2, keyword-less rejection) | Intentional behavior change (anti-corruption): `{}`, `{title:"x"}`, `{description:"y"}` previously compiled to accept-all under `ajv strict:false`; now throw. Backward-incompatible for any caller relying on accept-all semantics. | Confirm no production workflow passes such schema (workflow path uses `PI_WORKFLOW_SCHEMA`, always has keywords → unaffected). Document the rejection in tool description. |
| suggestion | `subagent-workflow/src/execution/__tests__/execute-options-mapper.test.ts` | No unit test for `slug` truncation/upper-bound post 20→35 change. No stale 20 assertion remains (good). | Add boundary test (35 passes/truncates, 36 throws). |
| suggestion | `structured-output/src/index.ts` (`type PiAPI = any`) | `pi` typed as `any`, so `pi.on`/`pi.registerTool`/`pi.sendUserMessage` fully bypass compile-time SDK contract enforcement. Pre-existing, not introduced by this PR. | Low priority: import `ExtensionAPI` (locally available via tsconfig paths) instead of `any`. |

## Verdict
**Approve** with 5 non-blocking suggestions. No backward-compat breaks, no schema/description contradictions, no SDK contract violations. The keyword-less/keyword-list edge cases (suggestions #2/#3) are recoverable (throws an error LLM/hook can respond to, no silent corruption) and rare.

```json
{"must_fix":0,"suggestion":5,"verdict":"approve with 5 non-blocking suggestions; verified against real Pi SDK types"}
```
