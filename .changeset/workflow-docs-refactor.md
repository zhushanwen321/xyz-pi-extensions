---
"@zhushanwen/pi-workflow": patch
---

Refactor: extract workflow/workflow-run/workflow-lint tools from src/index.ts into src/interface/ (index.ts 790→158 lines, pure Factory). Fix README/SKILL doc drift: correct phantom file-structure table, fix $BUDGET API (was {usedTokens,...}, actual {total,spent(),remaining()}), fix example script (double-IIFE, JSON.parse anti-pattern), add Tools/Commands/state-machine/budget-soft-limit/structured-output/cross-session-recovery sections. Fix install path violation. Remove workflow-run _render dead field. No behavior change — 403 tests green.
