---
"@zhushanwen/pi-ask-user": minor
---

Fix arrow key leak in ask-user editor (chars like `[C` leaking into input text). Refactor key parsing to whitelist architecture using SDK parseKey, migrate editorText to QuestionState.draftText, split handleInput router, add UX hint line.
