---
"@zhushanwen/pi-unified-hooks": patch
---

`tool_execution_end` error handler now extracts and persists the underlying
error text.

## Behavior changes

- **New `errorText` field** on the `unified-hooks:tool-error` session entry:
  `string | null`. Previously only `toolName` + `toolCallId` were stored; the
  real cause (e.g. `"hub disposed"`) was lost. Consumers reading the entry
  stream must tolerate the added field (it is additive — old readers ignore it).
- **Notify message format change**: the warning shown via `ctx.ui.notify` now
  appends `: <errorText>` when extractable. Any consumer matching the exact
  notify string will no longer match. The `[unified-hooks] <toolName> error
  (callId=...)` prefix is unchanged.
