# @zhushanwen/pi-ask-user

## 0.0.4

### Patch Changes

- 7b4d775: Fix Other option marker misalignment (single-select freeform, multi-select non-freeform, freeText preview indent) and strip bracketed-paste escape sequences (`\x1b[200~` / `\x1b[201~`) that leaked into the Other/comment editor text.

## 0.0.3

### Patch Changes

- 1684bde: Companion changes shipped alongside the subagents spawn/fork rework:

  - `pi-ask-user`: fix paste truncation for emoji / astral-plane surrogate pairs and "Others" option alignment; add component paste regression tests.
  - `pi-taste-lint`: new rule additions supporting the subagents refactor.
  - `pi-types`: extend the `mariozechner` SDK type stubs with the new APIs consumed by the spawn execution model.

## 0.0.2

### Patch Changes

- 803414f: Fix multi-question navigation key conflict, narrow Other editor, and Other freeform number prefix.

  - Rebind tab navigation off shift+tab (conflicts with Pi global `app.thinking.cycle`). Navigation keys are now consistent across all tabs: Left/Right always move between tabs (Right enters Submit from the last question; Left backs with no wrap at the first; on the Submit tab Left goes to the last question, Right wraps to the first). Tab toggles Submit/Cancel focus on the Submit tab. No shift+tab dependency anywhere.
  - Other freeform/comment editor renders at full width instead of the split-pane left column (~42%), fixing premature wrapping. Split-pane is bypassed in editor modes since the right-side preview is useless while typing a custom answer.
  - Other row shows its number prefix in freeform mode (`> [ ] N. <input>`), matching regular options.
