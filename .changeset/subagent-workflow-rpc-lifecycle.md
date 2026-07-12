---
"@zhushanwen/pi-subagent-workflow": minor
---

Add RPC-mode lifecycle control to /subagents and /workflows command handlers so xyz-agent GUI can trigger cancel/pause/resume/abort via slash command (e.g. `client.prompt("/subagents cancel <id>")`) without LLM round-trip. TUI paths unchanged; headless (print/json) guard tightened from `!ctx.hasUI` to `ctx.mode !== "tui"`.
