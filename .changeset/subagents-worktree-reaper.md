---
"@zhushanwen/pi-subagents": patch
---

Rewrite worktree reaper with a global `WorktreeRegistry` + pid-liveness judgment.

Replaces per-cwd `git rev-parse` scan + `.session`/`.finalized`/`.cancelled` sidecar state machine. Fixes:
- Reaper crashed when pi started in a non-git dir (workspace root, `/tmp`)
- Crashed worktrees leaked (terminal markers never written on crash)
- Worktrees from other repos were unreachable (scan only hit current repo)
- `cleanup()` failed worktree-remove skipped `branch -D`, leaking the branch
