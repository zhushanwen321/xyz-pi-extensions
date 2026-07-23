# Monorepo Impact Review — PR #86

Reviewer: `reviewer` agent (review-pr86-mono2) | read-only environment

## Summary
- **Must-fix: 0**
- **Suggestions: 3**

No monorepo-level blockers. No new cross-package code imports, no circular deps, no breaking public-API changes, changeset covers all affected packages correctly.

## Findings

| Severity | File:Line | Issue | Suggestion |
|---|---|---|---|
| suggestion | `subagent-workflow/src/interface/subagent-tool.ts:36` | Stale doc comment `≤20 字符` on `StartParam.slug`. Actual limit is 35. Same stale `≤20` at `subagent-actions.ts:56`. PR goal was "single source SLUG_MAX_LENGTH; eliminate two hardcoded 20s". Code achieved it — both schemas + runtime guard reference 35. But **two doc comments still hardcode "20"**. *(3/5 reviewers flagged this — high consensus.)* | Update both comments to ≤35. |
| suggestion | `structured-output/index.ts:1` | New `executeStructuredOutput` exported from `src/index.ts` but **NOT re-exported from package root** (`index.ts` only does `export { default }`). Test reaches it via relative deep import. PR brief/changeset frame this as "公共 API 变更" — it is **not** reachable by external consumers. | Either re-export from root (if public) or stop calling it a public-API change. Functionally harmless. (Intent per changeset: "for direct unit testing" → internal.) |
| suggestion | `.changeset/weak-model-tool-robustness.md` | `@zhushanwen/pi-goal` bumped `minor`, but goal's changes are **only** description examples + `Correct:` hints on *existing* throws. No schema structural change, no new accepted input shape, no new runtime detection guard. Under strict semver this is `patch`. | Consider downgrading goal to `patch`. Not blocking — `minor` defensible for prompt-quality work. |

## Verified clean (no action)
1. **No new cross-package code imports.** None of 5 packages added `workspace:*` or code import of another changed package. `ask-user` already declares `@zhushanwen/pi-subagent-workflow` as optional peerDep (unchanged). `InputSchema` loosening has **zero cross-package code impact**: ask-user↔subagent-workflow coupling is purely `globalThis` Symbol handshake, no static import of `InputSchema` outside ask-user.
2. **No circular deps introduced.** subagent-workflow→structured-output remains runtime peerDep (tool-name reference, no code import). ask-user↔subagent-workflow edge is handshake-only, non-cyclic at import layer.
3. **No public-API breaking changes.** (a) ask-user `InputSchema.options` loosened to superset — backward-compatible; internal `Question`/`Option` stay strict. (b) subagent-workflow types.ts changes comment-only. (c) `executeStructuredOutput` purely additive.
4. **`extension-dependencies.json` needs no update.** No inter-extension dependency relationship changed. ask-user's optional runtime dep already declared.
5. **Changeset coverage complete & correct.** Lists exactly the 5 changed packages. `shared/types` is `private: true` (correctly excluded). `shared/quota-providers`/`taste-lint` publishable but not imported by any of 5 packages at code level — no changes expected. `updateInternalDependencies: "patch"` will **not cascade**: none of 5 packages carry `workspace:*` dep on each other (cross-relationships use peerDep `"*"`).
6. **`SLUG_MAX_LENGTH` single source — code confirmed.** Constant lives only in `execute-options-mapper.ts` (=35). Both tool schemas + runtime guard reference it. Original "two hardcoded `maxLength:20`" duplication eliminated in code — only 2 stale **comments** retain "20".

## Verdict
**APPROVE WITH SUGGESTIONS** — no must-fix. PR is monorepo-clean: no new workspace deps, no cycles, no breaking API, changeset coverage complete, `extension-dependencies.json` correctly untouched. 3 suggestions are doc/semver polish.
