---
"@zhushanwen/pi-ask-user": minor
---

New inline adaptive `ask_user` tool — replaces the third-party `pi-ask-user` extension.

- **Adaptive layout**: single question (no tab bar) or 1-4 questions (tabbed view + Submit tab)
- **Split-pane preview** (≥84 cols): option list left, selected option details right
- **Inline free-text editor**: select "Other" → Space/Tab → type custom answer
- **Optional comments**: `allowComment: true` → after selection, prompt for a comment
- **Multi-select**: `multiSelect: true` → toggle checkboxes, Enter to confirm
- **Headless-safe**: disables the tool and returns `isError` when no interactive UI
- **Signal abort**: respects `ctx.signal` for cancellation
- Tool name `ask_user` preserved so existing skills (spec-clarify, coding-workflow, plan) work without modification
