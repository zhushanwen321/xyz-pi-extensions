---
"@zhushanwen/pi-subagents": minor
---

Model resolution falls back to the main agent's current model. The category-based
5-level fallback system has been removed.

## Breaking changes

**Tool parameter schema** — the `subagent` tool moved from positional params to an
`action` discriminator. Old `{ task, backgroundId?, poll? }` → new
`{ action, startParam?, listParam?, cancelParam? }`. All callers (LLMs, scripts)
must switch to the action-based schema.

**Config schema** — `~/.pi/agent/subagents/config.json` now only reads `version`
and `maxConcurrent`. Legacy fields (`categories`, `fallback`, `yoloByDefault`,
`agentCategoryOverrides`) are ignored on load. Delete them from your config —
they no longer affect anything.

**Removed source files** (internal, not re-exported from package entry — no
compile-time impact on consumers):
- `src/core/event-bridge.ts` + test
- `src/core/session-factory.ts`
- `src/tui/config-wizard.ts`
- `src/tui/format-helpers.ts`

**Removed types** (internal, not re-exported from package entry):
- `QueryResult`, `backgroundId` (old query surface)
- `SessionModelState` (categoryConfirmed/categoryModels/agentModels/yoloMode — all dead fields)
- `CategoryDefinition` (categories config retired)

## New model resolution order (top wins)

1. `paramOverride.model` (explicit tool param) — registry lookup + auth, throws on miss
2. `agentConfig.model` (agent .md frontmatter) — registry lookup + auth, throws on miss
3. `ctx.model` (main agent's current model) — direct passthrough, zero-config default

Explicit overrides no longer silently fall back to the main model — if you ask
for a model that's missing or unauthed, you get an error.

## Internal notes

Version is 0.0.1 (pre-1.0 semver): minor is allowed to carry breaking changes.
Deleted types/files were never re-exported from `index.ts`, so compile-time
impact is confined to the package itself. The runtime breaking change that
affects all consumers is the tool parameter schema reshape.
