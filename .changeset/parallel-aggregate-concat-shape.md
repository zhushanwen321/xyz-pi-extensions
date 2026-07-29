---
"@zhushanwen/pi-subagent-workflow": patch
---

Change parallel builtin workflow aggregate output shape from object to string.

The `parallel` workflow's aggregate phase no longer calls an LLM with a `{overallScore, topIssues, consensus}` object schema. Instead it produces a pure-code concatenation of per-perspective findings as a single string (`[perspective] finding1; finding2\n...`). The `aggregate` field of the workflow result is now a plain string rather than the previous structured object.

Rationale: removing the LLM aggregate call makes the parallel workflow deterministic and cost-bounded; downstream consumers of `aggregate` must read it as a string.
