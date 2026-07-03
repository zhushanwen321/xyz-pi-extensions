---
"@zhushanwen/pi-ask-user": patch
"@zhushanwen/pi-taste-lint": patch
"@zhushanwen/pi-types": patch
---

Companion changes shipped alongside the subagents spawn/fork rework:

- `pi-ask-user`: fix paste truncation for emoji / astral-plane surrogate pairs and "Others" option alignment; add component paste regression tests.
- `pi-taste-lint`: new rule additions supporting the subagents refactor.
- `pi-types`: extend the `mariozechner` SDK type stubs with the new APIs consumed by the spawn execution model.
