---
"@zhushanwen/pi-subagent-workflow": patch
---

Fix subagent ask_user end-to-end unavailability and generalize UI transit to a two-dimension orthogonal architecture (method interaction model + channel registry).

Root causes fixed:
- Protocol format error (expected JSON-RPC 2.0 but Pi emits flattened `{type, method, ...}`)
- Handler injection completely missing (index.ts session_start did not pass uiRequestHandler)
- No method/channel dispatch (all UI requests merged into single handler)
- No TUI/GUI/headless mode dispatch (W4 prompt injected unconditionally)
- Silent failure when handler missing (no observability)
- No cross-subprocess concurrency queue (multiple ask_user flood parent UI)

Architecture (ADR-033): two orthogonal dimensions:
- Transit + queue strategy determined by method interaction model (dialog classes transit + L2 queue; fire-and-forget not transited under TUI)
- Business routing determined by channel registry (ask_user / gui_widget / future)
