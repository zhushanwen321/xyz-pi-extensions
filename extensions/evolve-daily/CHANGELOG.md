# @zhushanwen/pi-evolve-daily

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
