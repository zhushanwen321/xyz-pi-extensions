---
"@zhushanwen/pi-subagents": patch
---

ExecutionRecord consolidated as the single source of truth for execution data.
Scattered storage (eventLog slices / _currentTurnText buffer / closure accumulators /
session.messages reads) is replaced by `turns: Turn[]`. eventLog / currentActivity /
result text are now derived from turns[] (getEventLog / getCurrentActivity / getFullText).

## Breaking changes (types.ts public API)

**`AgentEventLogEntry.type`** — removed `"text_output"` and `"thinking"` variants.
eventLog now carries only discrete semantic events (tool_start / tool_end / turn_end /
error). Streaming text/thinking content lives in `record.turns[].text` / `.thinking`
(full content, not 100-char slices). Consumers reading eventLog for streaming text
should read `currentActivity.label` (running) or `result` (terminal) instead.

**`RecordSnapshot`** — removed `eventLog` field. Snapshot consumers that read eventLog
should use `project()` → `SubagentToolDetails.eventLog` instead. The `SubagentRecord`
(TUI list merge) still carries eventLog.

**`AgentUsageTotal`** — added `cost: number` field (accumulated from
`SdkEvent.message.usage.cost.total`). Previously cost was accumulated at runtime but
not declared on the type; now the type and runtime are consistent.

**`ToolCall`** — removed internal `_status` field. It moved to `InternalToolCall`
(ToolCall + _status + startedTs), used only inside `ExecutionRecord.turns[].toolCalls`.
`getAllToolCalls()` strips internal fields when exporting, so `AgentResult.toolCalls`
no longer leaks the running/done/failed state machine.

## Bug fixes

- **compact view `text: }` tail fragment** — the root cause (eventLog stored 100-char
  text slices with residual tail entries) is eliminated. Text is now accumulated in
  full in `turns[].text`; `getCurrentActivity()` derives the label from the text
  **start**, never a tail fragment.
- **phantom empty turn on `message_end` after `turn_end`** — usage now accumulates
  field-wise into `turn.usageDelta` instead of overwriting, and `message_end` writes
  to the last turn directly (no ghost turn creation).
- **transient error recovery** — `turn_end` now clears `lastError`, so a transient
  error that recovers no longer flips a successful run to `success=false`.
- **lagged `tool_end` after `turn_end`** — tool_end matching now scans across all
  turns (not just current), preventing phantom ToolCall duplication.
- **derived eventLog timestamps** — `getEventLog` now uses real wall-clock timestamps
  (tool: `startedTs`, turn_end: `closedTs`) instead of synthetic `ts += 1` increments.
- **tool label truncation** — restored truncation (`TOOL_LABEL_MAX = 100`) in
  `extractLabelFromArgs` to keep TUI column-width stable (a 10KB bash command no
  longer inflates the compact view).
