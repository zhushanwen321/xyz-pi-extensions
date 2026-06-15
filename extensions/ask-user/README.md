# @zhushanwen/pi-ask-user

Inline adaptive `ask_user` tool for Pi coding agent. Single question (no tabs) or 1-4 questions (tab view + submit). Split-pane Markdown preview on wide terminals, inline free-text editor, optional comments.

## Install

```bash
pi install npm:@zhushanwen/pi-ask-user
```

## Tool

`ask_user` — structured clarifying questions with 2-4 options each. Users can always pick "Other" for free-text input. Supports `multiSelect` and optional per-question comments.

## Features

- **Adaptive layout**: single question → no tab bar; 1-4 questions → tabbed view + Submit tab
- **Split-pane preview** (≥84 cols): option list left, selected option details right
- **Inline free-text editor**: select "Other" → Space/Tab → type custom answer
- **Optional comments**: `allowComment: true` → after selection, prompt for a comment
- **Multi-select**: `multiSelect: true` → toggle checkboxes, Enter to confirm
- **Headless-safe**: disables the tool and returns `isError` when no UI available
