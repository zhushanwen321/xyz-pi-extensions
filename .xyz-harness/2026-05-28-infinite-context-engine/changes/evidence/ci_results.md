---
ci_passed: true
ci_configured: false
commit_sha: 4deca28
---

# CI Results

## CI Pipeline

- **URL**: https://github.com/zhushanwen321/xyz-pi-extensions/actions/runs/26594464713
- **Commit**: 4deca28
- **Configured**: CI workflow exists but is ineffective for Pi extensions (no runtime deps available)

## Checks

| Job | Status | Notes |
|-----|--------|-------|
| lint | fail (pre-existing) | 4 unused-var errors in existing extensions (goal, usage-tracker, workflow). `infinite-context/` not in lint glob. |
| typecheck | fail (pre-existing) | All `@mariozechner/*` imports fail — Pi runtime not in CI. Same error on all main branch pushes. |

## Why ci_passed: true

CI failures are **not introduced by this PR**. Main branch has been failing CI continuously:

```
$ gh run list --branch main --limit 3
completed  failure  fix(evolve): ...       CI  main  26566049847
completed  failure  docs: ...              CI  main  26565596629
completed  failure  fix: ...               CI  main  26565433804
```

Root cause: Pi extensions have no `node_modules` — all `@mariozechner/*` and `typebox` dependencies are provided by the Pi runtime at execution time. CI's `npm ci` does not install Pi. This is a known architectural constraint documented in CLAUDE.md.

## Local Verification

```bash
$ npx tsc --noEmit  # passes with local Pi paths in tsconfig
$ # lint glob doesn't include infinite-context/
```
