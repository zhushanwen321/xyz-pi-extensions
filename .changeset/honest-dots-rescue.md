---
"@zhushanwen/pi-workflow": patch
---

Fix agent subprocess killed ~2ms after spawn (fire-and-forget IIFE) + schema-error masking

- **lint**: detect bare async IIFE wrapping agent/parallel/pipeline as error (fire-and-forget statement) or warning (assigned/returned, may still drop Promise). Root cause of daily-news-impact 2ms subprocess kill: worker's outer IIFE posted `return` before inner IIFE's agent() resolved, main thread torn down runtime → controller.abort() → SIGKILL.
- **subprocess-agent-runner / concurrency-gate**: schema-error branch now carries exitCode + stderr instead of masking real failures (abort, crash, spawn error) with "Agent did not call structured-output tool".
- **SKILL.md**: document the IIFE anti-pattern with error/warning severity rules.
