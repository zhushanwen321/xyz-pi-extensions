---
"@zhushanwen/pi-plan": patch
"@zhushanwen/pi-structured-output": patch
"@zhushanwen/pi-coding-workflow": patch
---

Fix test infrastructure broken by workflow directory removal: give plan and structured-output their own self-contained mocks/ dirs (previously aliased the now-deleted ../workflow/mocks/*). Update coding-workflow README to reference @zhushanwen/pi-subagent-workflow (replacing deprecated @zhushanwen/pi-workflow).
