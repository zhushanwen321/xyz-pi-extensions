---
"@zhushanwen/pi-todo": minor
---

Simplify the todo state model from 4 states (pending / in_progress / verifying / failed) to 3 states (pending / in_progress / completed) and remove the verification interception. The dual-column TUI widget is now CJK-aware via `pi-tui`'s `visibleWidth`, and a completion steer is injected when every todo is done.

**Breaking changes**

- Removed `verifying` and `failed` states; `verifyText` / `verifyAttempts` / `evidence` fields are gone
- Removed the `verify` action and the `verifyTexts` / `verified` / `evidence` parameters on `update` actions
- `migrateTodo` now maps `verifying → in_progress` and `failed → pending` on legacy state load

**Additions**

- Dual-column widget layout (active list on the left, completed list on the right) with a vertical divider
- CJK-aware column sizing using `pi-tui`'s `visibleWidth` (replaces custom `visualLen` that ignored east-asian width)
- Completion steer: when every todo is `completed`, a one-shot summary check is injected into the next agent turn
- Reduced reminder interval (3 → 2) and switched to a minimal reminder that mentions only the next pending task
