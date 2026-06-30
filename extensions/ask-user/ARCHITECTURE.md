# ask-user — Architecture

Internals reference for maintainers. For the usage contract (what the tool does, when an agent should call it), see [README.md](./README.md). This document covers how the code is structured, the state machine, the defensive execute flow, and where each design invariant is enforced — so a change does not silently break an invariant.

Source: 6 files in `src/`, ~1320 lines total.

## File dependency graph

```
                          ┌─────────────┐
                          │  types.ts   │  ← shared leaf; imports only typebox
                          │ Schema +    │     holds QuestionState / ThemeLike /
                          │ shared      │     createQuestionState here (NOT in
                          │ state types │     component.ts) to break the cycle
                          └──────▲──────┘
                                 │ imported by all
              ┌──────────────────┼──────────────────┐
              │                  │                  │
       ┌──────┴──────┐    ┌──────┴──────┐    ┌──────┴──────┐
       │ validate.ts │    │question-view│    │ submit-view │
       │ pure check  │    │ pure render │    │ pure render │
       └──────▲──────┘    └──────▲──────┘    └──────▲──────┘
              │                  │                  │
              │           ┌──────┴──────────────────┘
              │           │
       ┌──────┴───────────┴──┐
       │   component.ts      │  ← state machine + input routing + race guards
       │                      │     imports question-view + submit-view
       └──────────▲──────────┘
                  │
           ┌──────┴──────┐
           │  index.ts   │  ← Tool factory + execute (6-step flow) + renderCall/renderResult
           └─────────────┘     imports component + validate + types
```

**No cycles.** All imports flow one direction; `types.ts` is the single leaf depended on by everyone.

**Why `QuestionState` / `ThemeLike` live in `types.ts`, not `component.ts`** (see the comment in `types.ts`): `question-view.ts` and `submit-view.ts` are pure render functions that read/write `QuestionState` and need the `ThemeLike` interface. If those types lived in `component.ts`, the render views would import `component.ts`, and `component.ts` imports the render views — a cycle. Sinking the shared types to the dependency-free leaf keeps every arrow monotone. **Do not move these types back** without reintroducing the cycle.

## `execute` defensive flow (6 steps)

`execute` in `src/index.ts` runs six ordered checks. Order is not arbitrary — each early step is cheaper than the next and some have side effects that must precede the rest.

| Step | Check | Returns | Why this order |
|------|-------|---------|----------------|
| 1 | `validateInput(questions)` | `isError:true` + fix hint | Pure function, no side effects — cheapest gate. Reject before any UI/state work. |
| 2 | `!ctx.hasUI` (headless) | `isError:true` + **`setActiveTools` removes ask_user** | Must run before the agent can retry. Physically removing the tool breaks a function-calling retry loop that plain `isError` cannot. |
| 3 | `signal?.aborted` | `cancelled:true` | O(1) short-circuit before the expensive blocking `ctx.ui.custom` call. |
| 4 | `try { ctx.ui.custom(...) } catch` | `isError:true` + `{ error }` | `ctx.ui.custom` is the only call that runs user interaction / editor construction / theme reads — the largest blast radius, so it is the only thing wrapped. |
| 5 | `result === null \|\| result.cancelled` | `cancelled:true` | Component resolved to cancel. |
| 6 | normal | `{ answers }` | Compose the summary. |

**The order is load-bearing**: swapping 1↔2 wastes a UI check on invalid params; swapping 2↔3 lets an aborted agent enter a blocking UI; moving 4's try/catch wider catches nothing extra. The headless branch's `setActiveTools` is the key insight — returning `isError` alone does not stop an LLM from calling the tool again in the same turn, so the tool is removed from the session's active set and the error text says "do not retry".

## `QuestionState` machine

Each question has a `QuestionState` (`types.ts`). Its `mode` field is a three-state machine:

```
                       Enter (on Other row)
            ┌────────────────────────────────────┐
            ▼                                     │
     ┌─────────────┐   Enter (normal opt,          ┌──────────────┐
     │   options   │   allowComment=true) ────────▶│   comment    │
     │  (default)  │                               │ (note input) │
     └─────┬───▲───┘◀────────────────── afterConfirm└──────┬───▲───┘
           │   │                                     Enter │   │ Esc
   Enter   │   │ Esc (discard)              (save note)    │   │ (AC-17: skip,
   (Other) │   │                                          │   │  keep old value)
           ▼   │                                          ▼   │
     ┌─────────────┐   Enter (text → save)          ┌─────────────┐
     │  freeform   │───────────────────────────────▶│   options   │
     │ (Other edit)│                                │ (back to list)│
     └─────┬───▲───┘                                └─────────────┘
           │   │
           ▼   │ Esc (discard)
     Enter (empty → clear freeTextValue)
           │
           ▼
        options
```

Transitions live in `component.ts`: `options → freeform` (Enter on Other), `freeform → options` (Enter saves / Enter empty clears / Esc discards), `options → comment` (via `afterConfirm` when `allowComment`), `comment → options` (Enter saves / Esc skips per AC-17).

### `confirmed` invariant

> **`confirmed === true` ⟹ the question has at least one answer.**
> I.e. `multiSelect ? selectedIndices.size > 0 : selectedIndex !== null`, **or** `freeTextValue !== null`.

This invariant is what makes the Submit gate (`allConfirmed()`) sound — if it ever fails, Submit lets through a question whose answer is missing, and the LLM receives `(no answer)`.

Four assignment sites maintain it (`component.ts`):

| Site | Sets | Why safe / necessary |
|------|------|----------------------|
| `afterConfirm()` | `true` | Safe: caller has already set `selectedIndex` / `selectedIndices` / `freeTextValue`. |
| `autoConfirmIfAnswered()` | `true` | Safe: guarded by `if (hasAnswer)` — never sets `true` without an answer. |
| `toggleIndex()` when multi-select empties | `false` | Necessary: un-checking the last option must drop `confirmed` to preserve the contrapositive. |
| `handleEditorInput` freeform empty-Enter | `false` | Necessary: clearing `freeTextValue` with no other answer must drop `confirmed`. |

If you add a new path that changes the answer set, audit both directions of this invariant.

### `autoConfirmIfAnswered` trigger

Called only from `gotoTab()` — when the user navigates between tabs via Tab/Shift+Tab without pressing Enter. It promotes an implicitly-answered tab (toggled but not confirmed) to `confirmed`. It deliberately **skips the comment input** (a Tab navigation intent should not force a comment prompt); only the Enter path enters comment mode via `afterConfirm`.

## Race guards

Three independent guards protect against three different races. They are dimensionally orthogonal but easy to confuse — keep them distinct.

| Guard | Kind | Location | Prevents | Mechanism |
|-------|------|----------|----------|-----------|
| `_resolved` | `boolean` field | `component.ts` | **Double `done()`**: user already submitted/cancelled, then a signal-abort listener or a late keypress fires `done` again → Pi receives two resolves. | `submit()`/`cancel()` set `_resolved = true` before `done(...)`; **both `handleInput` and `cancel()` itself early-return if already set** — so a signal-abort firing after resolution (the listener calls `comp.cancel()`) is a no-op (see `execute` step 4). |
| `pendingCancel` | `boolean` field | `component.ts` | **Accidental cancel losing answers**: Esc on the first question (or single question) cancelling outright would discard everything. | Two-step confirm: first Esc sets `pendingCancel = true` and shows an overlay; a second Esc truly cancels; any other key exits the overlay and keeps the form. The Submit-tab Cancel button bypasses this (already at the terminus). |
| `autoConfirmIfAnswered` | **method** (not a field) | `component.ts` | **Zombie unanswered tab**: in multi-question mode, toggling an option then Tab-ing away leaves a tab "answered but not confirmed", so the Submit gate (`allConfirmed()`) stays false and the user cannot tell why Submit is blocked. | `gotoTab()` calls it before switching; if the current state has an answer but `!confirmed`, it sets `confirmed = true`. |

## Three-layer rendering

Three independent render paths with non-overlapping jobs. Changing one layer never affects the others (unless you change the `details` schema, which feeds `renderResult`).

| Layer | When | Location | Job | Returns |
|-------|------|----------|-----|---------|
| `renderCall` | tool invoked, while `execute` is running (during interaction) | `index.ts` | Compact title: `ask_user <headers>` — tells the user what the agent is asking. | one `TruncatedText` |
| inline render (execute) | after `ctx.ui.custom` returns the component, the runtime loops `comp.render(width)` | factory in `index.ts`, render in `component.ts` | The live interactive TUI: option list / editor / tab bar / button bar / cancel overlay. | `string[]` (one per line) |
| `renderResult` | after `execute` returns | `index.ts` | Final result display. Compact: `✓ header: answer`; when `options.expanded`: all options with `●`/`○` selection marks. | `Box` of `TruncatedText`s |

## Split-pane adaptive layout

`getSplitPaneWidths(width)` in `question-view.ts` is a pure function with three-level degradation:

```
width < 84                                    → null  (single column)
available = width - len(" │ ")                // separator overhead
available < 32 + 28 (= 60)                    → null  (too narrow)
preferredLeft = floor(available * 0.42)
left  = clamp(preferredLeft, 32, available - 28)
right = available - left
right < 28                                    → null  (fallback)
```

So the **left column (option list) takes 42%, the right column (option detail) takes 58%**, with floors of 32 and 28 respectively, and a total split threshold of 84 columns. `buildSplitPane` pads the shorter column to `max(leftLines, rightLines, 8)` so the two stay aligned row-for-row.

Constants: `SPLIT_PANE_MIN_WIDTH = 84`, `SPLIT_PANE_LEFT_MIN = 32`, `SPLIT_PANE_RIGHT_MIN = 28`, `SPLIT_PANE_SEPARATOR = " │ "` (all in `types.ts`).

## Spec cross-reference

Design spec: `.xyz-harness/2026-06-15-ask-user/spec.md` (FR = functional requirement, AC = acceptance criterion). Implementation anchors:

| Spec | Implemented in |
|------|----------------|
| FR-2 (param schema/validation) | `types.ts` schema + `validate.ts` |
| FR-3 (inline render, no overlay) | `execute` → `ctx.ui.custom` without `options` |
| FR-4 (question view) | `question-view.ts` `renderQuestionView` |
| FR-6 (input handling) | `component.ts` `handleInput` / `handleEditorInput` |
| FR-8 (headless disable) | `execute` step 2 |
| FR-9 (custom render) | `renderCall` / `renderResult` |
| FR-10 (signal abort) | `execute` step 3 + step 4 abort listener |
| FR-12 (re-entry guard) | `_resolved` field + `cancel()` shared by abort listener |
| FR-13 (error catch-all) | `execute` step 4 try/catch |
| AC-17 (Esc in comment skips, keeps value) | `handleEditorInput` comment-mode Esc branch |

When you change one of these behaviors, update both the code comment (which cites the FR/AC) and this table.

## Resolved gaps

Previously surfaced by review, now fixed (kept as a maintenance trail):

- **Abort-vs-cancel text collision** (FR-10) — resolved: `execute` step 3 now returns `"Agent aborted..."`, distinct from step 5's user-cancel text. — `src/index.ts`.
- **`question` length limit not in schema** — resolved: the `QuestionSchema` description now states "≤1000 chars". — `src/types.ts`.
- **`header` >12 chars silently truncated** — resolved: `validate.ts` now rejects headers over `HEADER_MAX_CHARS` instead of silently truncating in the UI. — `src/validate.ts`.
- **`cancel()` re-entry race** (FR-12) — resolved: `cancel()` now guards with `_resolved`; a signal abort firing after submit/cancel no longer calls `done` twice. — `src/component.ts`.
