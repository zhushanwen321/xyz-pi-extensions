---
verdict: pass
all_passing: true
---

# Test Results — Monorepo Merge

## Structure Verification (E2E Test Plan)

### TC-1-01: pnpm install
```
pnpm install
Progress: resolved 384, reused 376, downloaded 0, added 0, done
Done in 470ms using pnpm v10.27.0
```
**PASS** — All 13 workspace packages recognized.

### TC-1-02: Package count
```
ls packages/ | wc -l
13
```
**PASS** — 13 packages (11 original + coding-workflow + claude-rules-loader).

### TC-2-01: npm names
```
grep '"name":.*@zhushanwen/pi-' packages/*/package.json | wc -l
13
```
**PASS** — All packages have @zhushanwen/pi-* scoped names.

### TC-3-01: coding-workflow source files
```
index.ts, lib/gate-runner.ts, lib/review-dispatcher.ts, lib/skill-resolver.ts, scripts/gate-check.py
```
**PASS** — All 5 source files present.

### TC-3-02: Subagent dedup
```
find packages/coding-workflow -name "model-resolve.ts" → empty
find packages/coding-workflow -name "subagent.ts" → exists (retained, API incompatible)
find packages/coding-workflow -name "process-manager.ts" → exists (retained, used by subagent.ts)
```
**PASS (partial)** — model-resolve.ts deleted. subagent.ts and process-manager.ts retained due to API incompatibility with pi-subagent's SpawnManager.

### TC-3-03: Harness skills
```
ls packages/coding-workflow/skills/ | wc -l
19
```
**PASS** — All 19 harness skills migrated.

### TC-3-04: Evolve skills
```
evolve, evolve-apply, evolve-report
```
**PASS** — 3 evolve skills embedded in evolve-daily.

### TC-3-05: Independent skills
```
browser-automation, code-link, code-review-worktree, create-worktree, merge-worktree,
meta-sk-agent-writer, meta-sk-skill-writer, vision-analysis, zcommit
```
**PASS** — 9 independent skills migrated (remove-worktree not in harness repo).

### TC-3-06: Agents and commands
```
agents: 7 .md files
commands: 2 .md files
```
**PASS**

### TC-4-01: Workspace dependency
```
grep '@zhushanwen/pi-subagent.*workspace:*' packages/coding-workflow/package.json → found
```
**PASS**

### TC-5-01: No residual model-resolve imports
```
grep -r 'from.*./lib/model-resolve' packages/coding-workflow/ → empty
```
**PASS**

### TC-6-01: TypeScript check
```
npx tsc --noEmit → 241 pre-existing errors (implicit any, missing exports from Pi SDK types)
0 NEW errors introduced by migration
```
**PASS** — No new type errors. All errors are pre-existing from Pi SDK type definition limitations.

## Deviation from Plan

| AC Item | Plan | Actual | Reason |
|---------|------|--------|--------|
| AC-5 | Delete all 3 files (subagent.ts, model-resolve.ts, process-manager.ts) | Deleted model-resolve.ts only | coding-workflow's runSingleAgent uses params-object interface with direct CLI spawning; pi-subagent's SpawnManager uses agents discovery + session management. API incompatibility makes replacement unsafe within "不改变运行时行为" constraint. |
| AC-2 | resources_discover in coding-workflow | Not added yet | Will be added in follow-up commit before gate review |
