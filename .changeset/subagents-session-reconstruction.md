---
"@zhushanwen/pi-subagents": minor
---

Completed/background subagents are reconstructed from `session.jsonl` instead of
lingering in memory. `history.jsonl` and `HistoryStore` are removed; `session.jsonl`
(the Pi SDK append-only file, real-time flush) is now the single source of truth.

## Breaking changes

**Completed records no longer retained in memory** — terminal records are evicted
immediately on `archive()` and reconstructed from disk on the next `list`/`collect`
call. Previously they lingered via an arbitrary sync-expire timer and a background
FIFO. In-memory state now only holds records that are still running.

**`HistoryStore` removed** — `runtime/execution/history-store.ts` and its test are
deleted. `RecordStore` constructor now takes `sessionsDir: string` instead of a
`HistoryStore`. The separate `history.jsonl` persistence layer is gone.

**`PersistedAgentRecord` type removed** — `ExecutionRecord.toPersisted()` and
`truncatePreview`/`PREVIEW_MAX` helpers are deleted (no more history-row shaping).

**No migration** — records persisted to `history.jsonl` before this change will not
be reconstructed (that format is unreadable by the new reconstructor). Only records
with a `session.jsonl` that contains a `subagent-identity` custom entry are visible.

## New persistence model

- **`core/session-reconstructor.ts`** — reads `session.jsonl` line-by-line and
  rebuilds `turns[]`/`eventLog`/`result`/`error`/`status`. Identity (id/agent/mode/
  task) comes from a `subagent-identity` custom entry written at session creation.
  Status is derived from the last assistant message `stopReason`
  (`error`/`aborted` → `failed`, else `done`); `lastError` clears on a clean stop.
  Degrades to `undefined` on any file/format failure.
- **`runtime/execution/tombstone-store.ts`** — `.cancelled` sidecar tombstone
  persists cancelled state, since `session.abort()` truncates `session.jsonl`
  mid-run with no final marker.
- **`collectRecords(limit, statusFilter)`** — status filtering is now a service/
  store core capability. Merges in-memory running records with disk
  reconstruction (cached, invalidated on change). Tombstone sidecar overrides
  status to `cancelled`.

## Why

The 5s memory linger and the background FIFO were arbitrary (no design doc), and
`history.jsonl` duplicated content already present in `session.jsonl`. The
extension never read `session.jsonl` back. Making `session.jsonl` the single
source of truth removes the duplication, the expiry timers, and the FIFO
enforcement — and means `/subagents` and the `subagent` tool `list` action reuse
the exact same reconstruction path with only a different status filter.
