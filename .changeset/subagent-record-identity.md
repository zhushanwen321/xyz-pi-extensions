---
"@zhushanwen/pi-subagent-workflow": minor
---

Decouple subagent execution record identity from transcript lifecycle (ADR-035):

- Record id uses `crypto.randomUUID()` for global uniqueness across restarts
- Atomic manifest persistence (`<uuid>.json`) carrying sessionFile, status, timestamps
- RPC `get_state` handshake after spawn to resolve sessionFile/sessionId robustly
- Orphan session detection + tmp residue recovery on startup
- PID alive timeout narrowed (24h → 1h) to bound stale-record window
- Manifest write failures surface as errors (no silent swallow)
- Manifest status enum expanded from 3-state to 4-state (add cancelled; crashed stays as reconstruction-derived state, not persisted in manifest)
