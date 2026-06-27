---
"@zhushanwen/pi-system-prompt-loader": minor
---

New extension `@zhushanwen/pi-system-prompt-loader` — configurable system prompt rules loader for Pi.

Loads Markdown rule files from four user-configurable source kinds and injects them
as a deterministic system prompt suffix:

- **`explicit`** — specific file or directory paths (absolute/relative/`~`)
- **`walk-files`** — walk from CWD up to home matching filenames (e.g. `CLAUDE.md`)
- **`walk-dirs`** — walk from CWD up to home matching directories (recurses `.md`)
- **`glob`** — glob patterns relative to CWD (self-implemented `*`/`**`/`?`, `.md` only)

Features: YAML frontmatter conditional rule gating (`paths:`), cross-source
`realPath` dedup with kind-priority first-wins, native Pi context-file exclusion
(via `contextFiles.realPath`), 16-entry noise-dir exclusion (`node_modules`/`.git`/...),
symlink-cycle protection, deterministic `localeCompare` ordering for stable KV cache,
silent fs-error skipping, and stale-context-tolerant `ui.notify`.

Implements the CA-12 injection-timing flip: `session_start` collects+caches,
`before_agent_start` does context-file exclusion → dedup → partition → build suffix.
