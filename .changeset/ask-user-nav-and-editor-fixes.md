---
"@zhushanwen/pi-ask-user": patch
---

Fix multi-question navigation key conflict, narrow Other editor, and Other freeform number prefix.

- Rebind tab navigation off shift+tab (conflicts with Pi global `app.thinking.cycle`). Question tabs now use Left/Right; Submit tab keeps Left/Right for Submit/Cancel focus.
- Other freeform/comment editor renders at full width instead of the split-pane left column (~42%), fixing premature wrapping.
- Other row shows its number prefix in freeform mode (`> [ ] N. <input>`), matching regular options.
