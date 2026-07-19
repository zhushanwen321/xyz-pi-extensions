---
"@zhushanwen/pi-ask-user": patch
---

Wire ask-user into the subagent-workflow channel registry so subagent children can route `ask_user` requests back to the parent UI.

- New `channel-handler.ts`: `createAskUserChannelHandler(ctx)` registers ask-user as a channel consumer. Mode split — RPC forwards via `askUserInteract`; TUI renders `AskUserComponent`. Returns `{value: JSON.stringify(answers)}` matching the child decode contract.
- New `channel-registry-access.ts`: cross-extension stable public API for the channel registry (no cross-package import; shares the registry via `globalThis[Symbol.for(...)]`, load-order independent).
- `package.json`: optional peerDep on `@zhushanwen/pi-subagent-workflow` (degrades gracefully when subagent-workflow is absent).
- `extension-dependencies.json`: ask-user optional dep on pi-subagent-workflow.

End-to-end verified: subagent child → host TUI `AskUserComponent` → user answers → child receives answer.
