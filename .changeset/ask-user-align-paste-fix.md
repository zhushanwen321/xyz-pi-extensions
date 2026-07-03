---
"@zhushanwen/pi-ask-user": patch
---

Fix Other option marker misalignment (single-select freeform, multi-select non-freeform, freeText preview indent) and strip bracketed-paste escape sequences (`\x1b[200~` / `\x1b[201~`) that leaked into the Other/comment editor text.
