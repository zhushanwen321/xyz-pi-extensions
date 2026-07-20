---
"@zhushanwen/pi-ask-user": patch
---

Remove `allowComment` feature. Users needing to add free-text context should use the "Other" option (which already opens a freeform editor) or reply in the next turn.

### Changes

- `Question.allowComment` field removed from the input schema
- `QuestionMode` no longer includes `"comment"` (now `"options" | "freeform"` only)
- `QuestionState.commentValue` removed
- `formatAnswer(parts)` / `parseAnswerParts(answer, labels)` no longer accept or return a comment
- `ANSWER_COMMENT_SEPARATOR` constant removed
- `toProtoQuestions` no longer passes `allowComment` to the protocol layer
- `channel-handler` no longer encodes `__comment` keys

### Rationale

`allowComment` overlapped semantically with `Other` (both let the user input free text beyond the preset options), caused interaction friction (an extra editor step even when the user had nothing to add), and encouraged LLMs to enable it "just in case". The default `allowOther: true` already covers the "user has something to add" case — users type their extra context via Other or in their next message.
