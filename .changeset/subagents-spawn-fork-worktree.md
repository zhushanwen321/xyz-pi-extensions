---
"@zhushanwen/pi-subagents": minor
---

Subagent execution moves from in-process to a spawned child `pi` process, and gains fork/worktree isolation. Several public types gain required fields and `ExecutionStatus` gains a `crashed` member.

## Breaking changes

**Execution model rewritten (in-process → spawn)** — sync/background subagents now run in an isolated spawned `pi` child process (via `child_process.spawn`) instead of in the host extension process. This is a behavior-level breaking change: the child owns its own tool/runtime lifecycle, signals are propagated via SIGTERM/SIGKILL, and a watchdog governs shutdown. See commits `d29c27676`, `6ec1e687d`.

**`ExecutionStatus` gains `"crashed"`** — the status union adds a new terminal state `crashed` to distinguish un-graceful termination (kill -9 / OOM / power loss) from normal failure. Detected at startup via the absence of a `.finalized` sidecar (D-006). Downstream consumers switching on status must handle the new branch.

**New required fields on public records** — `SubagentRecord`/`ExecutionRecord` gain required fields: `task`, `rootSessionId`, `parentRecordId`, `depth`, and `displayItems`. Existing code constructing these records must populate the new fields; `deserializeState`/reconstruction paths default them for backward compatibility with on-disk records.

**New `ExecuteOptions.fork` / `ExecuteOptions.worktree` and new errors** — `ExecuteOptions` exposes `fork?: boolean` (inherit parent conversation context) and `worktree?: boolean` (file-system isolation via a dedicated git worktree). New error types `ForkDepthExceededError` and `DirtyWorktreeError` are thrown from the corresponding failure paths.

## Non-breaking additions

- `subagent` tool gains an optional `cwd?: string` param (absolute path) to override the subagent's working directory (priority: worktreePath > explicit cwd > mainCwd).
- Fork depth is capped at `MAX_FORK_DEPTH` (10); nested spawning is now authorized (legacy anti-recursion bans in `agents/*.md` removed — D-031).
- Sync subagents no longer enter the concurrency pool; only background subagents are pool-limited (D-032) — fixes a nested-sync deadlock.
