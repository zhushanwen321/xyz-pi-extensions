# @zhushanwen/pi-evolve-daily

## 0.2.2

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

## 0.2.1

### Patch Changes

- 2b0cb54: Fix stale skill-state prompts after navigate/fork + improve background subagent notifications.

  **evolve-daily**: Stop spurious "skills being tracked" prompts after navigate/fork/clone. Three root causes fixed:

  - Cross-branch state bleed: `reconstructState` now reads only the current branch path (`getBranch()`) instead of all entries from every branch.
  - Immediate injection on fork: `handleSessionRestore` no longer triggers a turn on session switch; `before_agent_start` injects on the user's next message instead.
  - Abandoned-item zombie prompts: abandoned items are no longer surfaced in the prompt list (only loaded/error).

  **subagents**: Background completion notification improvements:

  - Fix background color break after ellipsis (truncLine's `\x1b[0m` global reset was clearing the purple background mid-line).
  - Shorten head line: use `shortId` instead of full job id, truncate model name.
  - Add rounded purple border (`╭─╮│╰─╯`) matching the workflow notify visual style.

## 0.2.0

### Minor Changes

- 5681ddd: Replace passive skill tracking with `use_skill` active declaration. The tracker now requires agents to explicitly declare skill execution intent, eliminating false positives from SKILL.md reads. State machine simplified to 6 states (`loaded`, `completed`, `error`, `cancelled`, `recorded`, `abandoned`) with `cancelled` replacing the old `dismissed` state. Added `skill-registry.ts` for skill name validation and updated steering prompts to reference `use_skill`.

## 0.1.12

### Patch Changes

- 92ce2a7: Reduce skill-execution tracker false positives. Improve trigger matching and dedup logic so unrelated skill loads are not miscounted as execution of a tracked skill.

## 0.1.11

### Patch Changes

- Fix off-by-one date comparison, empty report lockout, and goal deduplication bugs in evolve-daily analyzer

## 0.1.10

### Patch Changes

- 896e85b: Fix session JSONL loader to flatten nested message events for extractors

## 0.1.9

### Patch Changes

- 15b68f6: Fix evolve analyzer to find session files in project subdirectories, unify pi.extensions to ./index.ts

## 0.1.8

### Patch Changes

- Audit and fix all 11 extensions against project specifications

## 0.1.7

### Patch Changes

- 4de6d3a: i18n adaptation: replace all hardcoded Chinese strings with English across 7 extensions

## 0.1.6

### Patch Changes

- e19ed88: fix: remove hardcoded models and paths from review agents; fix Pi SDK type compat in evolve-daily and workflow

## 0.1.5

### Patch Changes

- Fix GATE_SCRIPT_PATH path for npm packaging, module-level state encapsulation, execute error handling compliance, peerDependencies cleanup, ANSI escaping removal, and directory restructuring

## 0.1.4

### Patch Changes

- ba20dca: bump patch version for evolve
