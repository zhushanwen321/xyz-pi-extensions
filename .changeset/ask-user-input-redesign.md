---
"@zhushanwen/pi-ask-user": minor
---

Refine `ask_user` input model — only Tab navigates tabs; Other free-text editor is in-place; Submit tab has explicit Submit/Cancel focus.

- **Tab nav**: only `Tab` / `Shift+Tab` switch tabs (←/→ no longer switch tabs — reserved for Submit tab focus)
- **Other free-text editor**: `Enter` on Other row opens the editor **in-place** — the Other row transforms into `[ ] <input>█` (multiSelect) or `<input>█` (singleSelect) instead of opening a separate editor block below
- **Submit tab focus**: `←` / `→` toggle focus between `[ Submit ]` and `[ Cancel ]`; `Enter` triggers the focused action. `Cancel` cancels directly without a second confirmation overlay (you're already at the final tab)
- **Help-line update**: Other row now shows `Enter open editor` (was `Space open editor`)
- **Multi-select toggle unchanged**: `Space` still toggles individual options; `Enter` still adds the cursor option to selection and confirms (consistent with singleSelect Enter semantics)
