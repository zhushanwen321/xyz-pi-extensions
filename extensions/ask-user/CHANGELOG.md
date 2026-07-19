# @zhushanwen/pi-ask-user

## 1.0.0

### Patch Changes

- 988497d: Wire ask-user into the subagent-workflow channel registry so subagent children can route `ask_user` requests back to the parent UI.

  - New `channel-handler.ts`: `createAskUserChannelHandler(ctx)` registers ask-user as a channel consumer. Mode split — RPC forwards via `askUserInteract`; TUI renders `AskUserComponent`. Returns `{value: JSON.stringify(answers)}` matching the child decode contract.
  - New `channel-registry-access.ts`: cross-extension stable public API for the channel registry (no cross-package import; shares the registry via `globalThis[Symbol.for(...)]`, load-order independent).
  - `package.json`: optional peerDep on `@zhushanwen/pi-subagent-workflow` (degrades gracefully when subagent-workflow is absent).
  - `extension-dependencies.json`: ask-user optional dep on pi-subagent-workflow.

  End-to-end verified: subagent child → host TUI `AskUserComponent` → user answers → child receives answer.

- Updated dependencies [4fe4906]
- Updated dependencies [bd68203]
  - @zhushanwen/pi-subagent-workflow@0.3.0

## 0.2.0

### Minor Changes

- de5d7a3: Add RPC mode support via @xyz-agent/extension-protocol: ask_user now works in xyz-agent GUI through askUserInteract (select channel + ASK_USER_MARKER), while preserving TUI ctx.ui.custom behavior.

## 0.1.0

### Minor Changes

- 986ec30: Fix arrow key leak in ask-user editor (chars like `[C` leaking into input text). Refactor key parsing to whitelist architecture using SDK parseKey, migrate editorText to QuestionState.draftText, split handleInput router, add UX hint line.

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
