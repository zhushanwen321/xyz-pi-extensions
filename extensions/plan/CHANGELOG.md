# @zhushanwen/pi-plan

## 0.2.3

### Patch Changes

- 9169119: Migrate all Pi SDK references from the deprecated `@mariozechner/pi-*` namespace to the active `@earendil-works/pi-*` namespace. This eliminates the five deprecation warnings emitted during `pnpm install` (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@mariozechner/pi-ai`, transitive `@mariozechner/pi-agent-core`, and transitive `node-domexception`).

  **Changes:**

  - **package.json**: all `peerDependencies` / `peerDependenciesMeta` referencing `@mariozechner/pi-*` updated to `@earendil-works/pi-*` (versions unchanged: `*`)
  - **TypeScript sources**: all `import ... from "@mariozechner/pi-*"` updated to `import ... from "@earendil-works/pi-*"` across 98 files (438 import occurrences including `declare module` and dynamic `import()` types)
  - **`tsconfig.json` paths**: removed `@mariozechner/pi-*` dual-alias entries; kept only `@earendil-works/pi-*`
  - **`vitest.config.ts` aliases**: removed `@mariozechner/pi-*` entries; updated stub path targets to `./shared/types/earendil-works/index`
  - **`shared/types/mariozechner/` → `shared/types/earendil-works/`**: stub directory renamed, `declare module` names updated, `shared/types/package.json` `main` and `files` fields updated
  - **Monorepo cross-package references**: `extensions/ask-user` (`@zhushanwen/pi-subagent-workflow`) and `extensions/subagent-workflow` (`@zhushanwen/pi-structured-output`) switched from `*` to `workspace:*` so local development uses the just-edited sources instead of pulling deprecated versions from npm
  - **`pnpm.allowedDeprecatedVersions.node-domexception = "1.0.0"`**: silences the remaining unavoidable transitive deprecation (`@earendil-works/pi-ai` → `@google/genai` → `google-auth-library` → `gaxios@7` → `node-fetch@3` → `node-domexception`); `node-domexception` is a Node 22+ redundant polyfill, not a functional issue

  **No functional changes** to extension behavior, types, or APIs. `pnpm install`, `pnpm -r typecheck`, and `pnpm -r test` all pass cleanly with zero deprecation warnings.

  **Follow-up hardening (no functional impact):**

  - **`.githooks/validate-no-mariozechner-pi`** (new): standalone grep-based scanner that errors when `@mariozechner/pi-` appears in staged files or in workspace path checks. Can also be called manually for ad-hoc audits (`bash .githooks/validate-no-mariozechner-pi [<files>]`).
  - **`.githooks/pre-commit`** (`-0.` namespace check): wired `validate-no-mariozechner-pi` as a pre-manifest gate. Any staged file in `extensions/` or `shared/` (including `package.json`, `vitest.config.ts`, `.d.ts`) containing the deprecated namespace blocks the commit. `SKIP_NAMESPACE_CHECK=1` hotfix bypass must be justified in the PR description and tracked with an issue.
  - **`.githooks/pre-commit`** (`0b` peerDep check): the package.json deep check now requires `@earendil-works/pi-coding-agent` and explicitly rejects `@mariozechner/pi-coding-agent` (was incorrectly accepting the deprecated name as the success signal).
  - **AGENTS.md** new section "禁止使用已废弃的 Pi SDK namespace [MANDATORY]": documents the namespace rule, the gate script location, and what to do if Pi renames the namespace again.
  - **docs/standards.md / docs/monorepo-conventions.md / docs/quality-gates.md**: updated example `package.json`, import snippets, and `peerDependencies` descriptions to use `@earendil-works/pi-*`. Old historical docs (`docs/evolution/`, `docs/third-party-extensions/`, `docs/research/`) retain the deprecated references as factual record of past investigations.
  - **Bonus fix**: `pre-commit` had a latent bash bug `${#TEST_PKGS[@]:-}` (not a valid parameter expansion). Fixed to `${#TEST_PKGS[@]}` while validating the new gate.

## 0.2.2

### Patch Changes

- 96aed1d: Fix test infrastructure broken by workflow directory removal: give plan and structured-output their own self-contained mocks/ dirs (previously aliased the now-deleted ../workflow/mocks/\*). Update coding-workflow README to reference @zhushanwen/pi-subagent-workflow (replacing deprecated @zhushanwen/pi-workflow).

## 0.2.1

### Patch Changes

- b868113: Architecture rewrite + Codex-parity behavior model for `@zhushanwen/pi-goal`.

  **Round 1 — 6-layer ports/adapters architecture:**

  - Layered split: `engine/` (zero Pi deps, pure state machines) → `ports.ts`
    (machine-checkable boundary) → `service.ts` (dual entry) → `adapters/` →
    `projection/` → `index.ts` (thin factory)
  - Deleted 9 legacy god-files (state/budget/widget/templates/tool-handler/
    action-handlers/command-handler/agent-end-handler/before-agent-start-handler)
  - Engine never imports `@mariozechner/*`; budget decisions and persistence are
    pure and independently tested
  - FR-5: strict serialize/deserialize (no legacy format compat — clean break)
  - FR-6.2: token/time budget warning flags are independent (4 flags)
  - FR-6.5: time accumulation extracted to a pure `tick()` (no double-write)
  - FR-6.7: ESC is a pure interrupt via `ctx.signal.aborted`; removed
    `pendingPause` field and module-level `lastCtx`

  **Round 2 — Codex-parity behavior model (FR-1…FR-7):**

  - FR-1: goal reuses `pi-todo` as its task model. `pi-todo` upgraded to a
    four-state model (`pending`/`in_progress`/`completed`/`cancelled`) with an
    optional `isVerification` flag and legacy migration
  - FR-2: new lightweight `goal_control` tool (`create`/`complete`/
    `report_blocked`); `goal_manager` task CRUD retired
  - FR-3: **7-state goal machine** per ADR-002
    (`active | paused | blocked | complete | budget_limited | time_limited |
cancelled`). Pi adds `time_limited` + `cancelled` vs Codex and deliberately
    omits `usage_limited` (Extension model doesn't own session-level quotas).
    `paused` is retained — `/goal pause` + `/goal resume` (recovers
    `paused|blocked → active`) work as before
  - FR-4: staleness reminder via `lastUpdatedTurn`; `agent_end` is warning-only
    with a single budget checkpoint
  - FR-5: budget auto-trigger on the event path (`persistAndUpdate` fallback,
    fires only for `active`)
  - FR-6: prompt-driven completion audit — `complete` is a soft suggestion, not
    a hard tool action; prerequisites enforced
  - FR-7: plan↔goal automatic linkage; goal↔todo dependency is `optional`
    (degrades gracefully when todo is missing)

  `pi-coding-workflow` / `pi-plan` receive a patch: their inline `GoalInitFn`
  type alias is updated to mirror goal's new required-`ctx` signature (no runtime
  change; callers already pass `ctx`).

  See `docs/adr/002-goal-7-state-machine.md` for the 7-state rationale.

## 0.2.0

### Minor Changes

- b280872: Add new @zhushanwen/pi-plan extension: lightweight plan mode with brainstorming + writing-plans capabilities
