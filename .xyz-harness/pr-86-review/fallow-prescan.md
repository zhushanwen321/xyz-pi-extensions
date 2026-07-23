# Fallow Static Pre-Scan — PR #86

Run: `fallow audit --base main --format json --quiet`
Base: `main` → HEAD `bb86ee97d` (21 changed files)

## Attribution Summary

| Category | Introduced | Inherited | Total |
|----------|-----------|-----------|-------|
| Dead code | 1* | 9 | 10 |
| Complexity | 0 | 8 | 8 |
| Duplication | 0 | 0 | 0 |

\* `dead_code_introduced: 1` is an artifact of fallow's attribution algorithm — it flags issues located in *changed files* as "introduced" regardless of whether the PR actually added the dead code. Cross-checked below: all flagged exports already exist on `main`; the 3 exports this PR actually added (`InputQuestion`, `validateInput`, `SLUG_MAX_LENGTH`) are all in active use.

## Dead-code flags in changed files (7) — verified

| Symbol | File | Real refs | Verdict |
|--------|------|-----------|---------|
| `OptionSchema` | ask-user/src/types.ts | 3 | **false positive** — referenced by `InputSchema` (`Type.Array(OptionSchema)` + `Union([OptionSchema, string])`) and `Option` type. Fallow does not trace TypeBox runtime object graphs. |
| `WorkflowAction` | tool-workflow.ts | 4 | **false positive** — used in schema/action handling |
| `ToolResult` | tool-workflow.ts | 8 | **false positive** |
| `SURROGATE_HIGH_MASK` | ask-user/src/types.ts | 1 | **false positive** (same-file use fallow missed) |
| `SURROGATE_HIGH_START` | ask-user/src/types.ts | 1 | **false positive** |
| `ResultSchema` | ask-user/src/types.ts | 0 | **pre-existing unused** (exists on main) |
| `SdkLike` | subagent-workflow/.../types.ts | 0 | **pre-existing unused** (exists on main) |

## Conclusion

No dead code introduced by this PR. 5 false positives (TypeBox blind spot), 2 pre-existing unused exports outside this PR's scope. Complexity: 0 introduced (max cyclomatic 19 is inherited). No duplication.

**Recommendation**: `ResultSchema` and `SdkLike` are pre-existing debt — safe to clean up in a follow-up, not a blocker for PR #86.
