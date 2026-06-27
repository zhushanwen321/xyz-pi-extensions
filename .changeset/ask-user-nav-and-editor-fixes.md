---
"@zhushanwen/pi-ask-user": patch
---

Fix multi-question navigation key conflict, narrow Other editor, and Other freeform number prefix.

- Rebind tab navigation off shift+tab (conflicts with Pi global `app.thinking.cycle`). Navigation keys are now consistent across all tabs: Left/Right always move between tabs (Right enters Submit from the last question; Left backs with no wrap at the first; on the Submit tab Left goes to the last question, Right wraps to the first). Tab toggles Submit/Cancel focus on the Submit tab. No shift+tab dependency anywhere.
- Other freeform/comment editor renders at full width instead of the split-pane left column (~42%), fixing premature wrapping. Split-pane is bypassed in editor modes since the right-side preview is useless while typing a custom answer.
- Other row shows its number prefix in freeform mode (`> [ ] N. <input>`), matching regular options.
