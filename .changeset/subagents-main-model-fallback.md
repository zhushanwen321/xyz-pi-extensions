---
"@zhushanwen/pi-subagents": minor
---

Model resolution falls back to the main agent's current model. The category-based
5-level fallback system has been removed.

**Breaking (config schema)**: `~/.pi/agent/subagents/config.json` now only reads
`version` and `maxConcurrent`. Legacy fields (`categories`, `fallback`,
`yoloByDefault`, `agentCategoryOverrides`) are ignored on load. Delete them from
your config — they no longer affect anything.

**New model resolution order** (top wins):
1. `paramOverride.model` (explicit tool param) — registry lookup + auth, throws on miss
2. `agentConfig.model` (agent .md frontmatter) — registry lookup + auth, throws on miss
3. `ctx.model` (main agent's current model) — direct passthrough, zero-config default

Explicit overrides no longer silently fall back to the main model — if you ask
for a model that's missing or unauthed, you get an error.
